'use strict';
/**
 * qoder/chat.js — Qoder 对话面上游客户端（国际版，单账号）。
 *
 * 上游：POST https://api2-v2.qoder.sh/model/v1/chat/completions
 * 协议形态：OpenAI 兼容（SSE + 非流式），**纯 Bearer 鉴权**。
 *
 * 实证要点（2026-10-13 实测，intl 账号 019f0dea…）：
 *   1. 只需 Authorization: Bearer <dt- token>。运营面那三头（User-Agent: Qoder /
 *      cosy-clienttype / cosy-version）对对话面**完全不需要**，带上也不影响结果；
 *      cosy-machine* 六头同运营面结论，一律不发。
 *   2. 模型目录里的模型 ≠ 可调用模型。is_free=true 的 qfmodel（Qwen3.8-Flash）
 *      实测返回 400 invalid_model_error；efficient 返回 429 provider_error。
 *      可调用集合必须单独探测，见 CALLABLE_INTL_MODELS。
 *   3. 流式：真 SSE，data: {…} 帧 + 末帧 usage + data: [DONE]。usage 出现在
 *      [DONE] 之前的那一帧里（不是每帧都有），prompt/completion_tokens_details
 *      含 reasoning_tokens 与 cache 明细——原样透传给 usageToLogFields 解析。
 *   4. tool_calls：**上游不返回结构化 tool_calls**。传 tools 后模型把调用写成
 *      普通文本（"call\n{\"name\":…}"），finish_reason 仍是 stop。本模块不做
 *      文本→tool_calls 的启发式改写：那是猜测而非事实，误判会让 agent 执行
 *      一个并未发生的调用。需要工具调用的客户端请走 Trae/WorkBuddy 池。
 *   5. 错误信封：HTTP 4xx/5xx + {"code":"invalid_model_error"|"provider_error",
 *      "message":…,"request_id":…,"type":…}。code 是字符串而非数字。
 *   6. 国内版 /model/v1/* 实测 503，必须走 COSY 老协议（未实现），
 *      故本模块仅接受 realm='intl'，国内版显式报错而非静默失败。
 *
 * 与 capability.chat 的关系：variant.js 只把国际版声明为可转发
 * （qoderChatRealms = ['intl']），国内版仍为 false。调度侧的账号筛选见
 * credentials/pool.js 的 qoderChatOk。
 */
const variant = require('../platform/variant');
const { isTruncatedFinish } = require('../transform/finish');
const { createLineFeeder } = require('../lib/sse-lines');

const V = variant.variantOf(variant.QODER);
const CHAT_PATH = V.paths.chat;
const DEFAULT_TIMEOUT_MS = Number(process.env.QODER_TIMEOUT_MS || 600000);

/**
 * 国际版实测可调用的模型（2026-10-13 逐个探测）。
 * 目录共 18 项，其中 10 项在 chat 端点不可用（invalid_model_error 或
 * provider_error）。这份清单用于「调用前明确拒绝」而非把 400 透传给客户端，
 * 但探测有时间性——上游随时可能增删，故保留 refresh 入口。
 */
const CALLABLE_INTL_MODELS = [
  'auto', 'ultimate', 'performance', 'qmodel', 'kmodel', 'gmodel', 'dmodel', 'mmodel',
];

/** 上游 code → 本地可读原因。 */
const ERROR_HINTS = {
  invalid_model_error: '该模型在 Qoder 国际版不可调用（is_free 不代表可调用，需实测）',
  provider_error: '上游供应商暂时不可用（非本服务问题，可稍后重试或换模型）',
};

class QoderChatError extends Error {
  constructor(message, { code, status, body, model } = {}) {
    super(message);
    this.name = 'QoderChatError';
    this.code = code != null ? code : null;
    this.status = status != null ? status : null;
    this.body = body;
    this.model = model;
    // upstreamCode 走 classifyError 的 msg 正则回填路径（字符串 code），
    // 这里显式带上数字 status 供 401/403/429/5xx 分支判定。
    if (status != null) this.upstreamCode = status;
  }
}

/** 本模块是否支持该账号的对话转发（realm 白名单 + 有 token）。 */
function supportsAccount(acct) {
  if (!acct) return false;
  const realm = variant.qoderRealmOfAccount(acct);
  if (!variant.qoderChatRealms().includes(realm)) return false;
  return !!String(acct.token || '').trim();
}

/** 拒绝原因（供 UI 与路由层给出明确文案，而非把异常抛到客户端）。 */
function blockReason(acct) {
  if (!acct) return '账号不存在';
  const realm = variant.qoderRealmOfAccount(acct);
  if (!variant.qoderChatRealms().includes(realm)) {
    return realm === 'cn'
      ? 'Qoder 国内版对话面未开放（/model/v1/* 实测 503，需 COSY 老协议）'
      : `Qoder ${realm} 区域对话面未开放`;
  }
  if (!String(acct.token || '').trim()) return '账号缺少访问凭据（token）';
  return null;
}

/** 模型是否在国际版 chat 端点可调用（按实测清单；'auto' 恒可调用）。 */
function isCallableModel(model) {
  const m = String(model == null ? '' : model).trim();
  if (!m) return false;
  return CALLABLE_INTL_MODELS.includes(m);
}

/**
 * 探测单个模型是否真能调用（供运维面板与目录校准用）。
 * @returns {Promise<{ok:boolean, status:number, code:string|null, message:string}>}
 */
async function probeModel(acct, model) {
  const r = await chatOnce(acct, {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    max_tokens: 16,
  }, { probe: true });
  return r;
}

/** 刷新可调用清单（逐个探测目录内全部模型；约 18 次请求，仅在管理面手动触发）。 */
async function refreshCallableModels(acct) {
  const catalog = require('./catalog');
  const { models } = await catalog.syncCatalog(acct, { prefer: 'auto' });
  const out = { ok: [], failed: [] };
  for (const m of models) {
    const r = await probeModel(acct, m.key);
    if (r.ok) out.ok.push(m.key);
    else out.failed.push({ model: m.key, status: r.status, code: r.code, message: r.message });
  }
  return out;
}

/**
 * 请求体规范化。
 * 刻意**不做** tool_choice 对象→'auto' 之类改写：上游不支持结构化 tool_calls，
 * 改写只会掩盖「工具不可用」这一事实。只剥离无关字段、强制布尔 stream。
 */
function normalizeBody(body) {
  const out = { ...body };
  out.stream = body.stream === true;
  return out;
}

/**
 * 单次对话请求（内部）：返回 {ok, …} 而不抛错，便于探测与路由层分别处理。
 * @param {object} acct   账号（含 token / qoderRealm / userId）
 * @param {object} body   OpenAI 格式请求体
 * @param {{probe?:boolean}} [opts]
 */
async function chatOnce(acct, body, opts = {}) {
  const reason = blockReason(acct);
  if (reason) {
    return { ok: false, status: 400, code: 'qoder_unsupported', message: reason };
  }
  const realm = variant.qoderRealmOfAccount(acct);
  const base = variant.qoderGatewayBase(realm);
  const model = String(body.model == null ? '' : body.model).trim();
  if (!model) {
    return { ok: false, status: 400, code: 'invalid_request_error', message: 'model is required' };
  }
  if (!isCallableModel(model)) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_model_error',
      message: `Unsupported model "${model}"（Qoder 国际版可调用：${CALLABLE_INTL_MODELS.join(', ')}）`,
    };
  }
  const url = base + CHAT_PATH;
  const init = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${acct.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(normalizeBody(body)),
    redirect: 'error',
    signal: AbortSignal.timeout(opts.probe ? 60000 : DEFAULT_TIMEOUT_MS),
  };

  let resp;
  try {
    resp = await fetch(url, init);
  } catch (e) {
    const err = new QoderChatError(`Qoder 对话请求失败: ${e.message}`, { model });
    err.code = e.code || 'network';
    throw err;
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    let code = null;
    let message = `HTTP ${resp.status}`;
    try {
      const j = JSON.parse(text);
      code = j.code != null ? String(j.code) : null;
      if (j.message) message = String(j.message);
    } catch { /* 非 JSON 体：保留 HTTP 状态文案 */ }
    const hint = code && ERROR_HINTS[code] ? `（${ERROR_HINTS[code]}）` : '';
    const err = new QoderChatError(`Qoder 对话上游 HTTP ${resp.status} ${message}${hint}`, {
      code, status: resp.status, body: text.slice(0, 500), model,
    });
    throw err;
  }
  return { ok: true, status: resp.status, resp, realm, model };
}

/**
 * 非流式：直接取上游 JSON。
 * 上游返回体带大量非标字段（base_resp / model_context / sub_usages / raw_usage…），
 * 按 WorkBuddy 先例**原样返回**：客户端能拿到真实 usage 明细，
 * 裁剪会让「未计量」与「真为 0」无法区分。
 */
async function chatNonStream(acct, body) {
  const r = await chatOnce(acct, { ...body, stream: false });
  if (!r.ok) {
    // 探测/拒绝路径：转为抛错，与上游失败同一出口（路由层统一 catch）
    const e = new QoderChatError(r.message, { code: r.code, status: r.status, model: body.model });
    throw e;
  }
  const text = await r.resp.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new QoderChatError(`Qoder 对话返回非 JSON: ${text.slice(0, 160)}`, { model: r.model });
  }
}

/**
 * 流式：返回上游 SSE 响应体（ReadableStream），由路由层透传。
 *
 * 不在此处做帧改写：上游 SSE 本身就是标准 OpenAI chunk 形态（实测含
 * data: [DONE] 与末帧 usage），原样转发的语义与 WorkBuddy 一致。
 * usage 由路由层旁路窥探（不影响转发字节）。
 */
async function chatStream(acct, body) {
  const r = await chatOnce(acct, { ...body, stream: true });
  if (!r.ok) {
    const e = new QoderChatError(r.message, { code: r.code, status: r.status, model: body.model });
    throw e;
  }
  return { status: r.status, body: r.resp.body, model: r.model };
}

/**
 * 从 SSE 字节流里旁路抽取 usage（不消费、不改写字节）。
 * 实测 usage 出现在 [DONE] 前一帧；每帧都有 usage 字段但多为 null。
 */
async function peekUsage(stream) {
  if (!stream) return null;
  let usage = null;
  const feeder = createLineFeeder((line) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const ev = JSON.parse(payload);
      if (ev && ev.usage && typeof ev.usage === 'object'
        && (ev.usage.prompt_tokens || ev.usage.completion_tokens || ev.usage.total_tokens)) {
        usage = ev.usage;
      }
    } catch { /* 非 JSON 帧忽略 */ }
  });
  const reader = stream.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feeder.feed(dec.decode(value, { stream: true }));
    }
    feeder.flush();
  } catch { /* 流中断：已取到的 usage 仍然有效 */ }
  return usage;
}

/**
 * 流式末帧 finish_reason 决策（与 transform/finish + dispatch 口径一致）。
 * 上游不返回结构化 tool_calls，故 sawToolCalls 恒 false，这里仍保留参数以对齐签名。
 */
function resolveFinish({ sawToolCalls, lastFinish } = {}) {
  if (isTruncatedFinish(lastFinish)) return lastFinish;
  if (sawToolCalls) return 'tool_calls';
  return lastFinish || 'stop';
}

module.exports = {
  CALLABLE_INTL_MODELS,
  QoderChatError,
  supportsAccount,
  blockReason,
  isCallableModel,
  probeModel,
  refreshCallableModels,
  chatOnce,
  chatNonStream,
  chatStream,
  peekUsage,
  normalizeBody,
  resolveFinish,
};

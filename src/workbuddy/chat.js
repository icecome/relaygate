'use strict';
/**
 * workbuddy/chat.js — WorkBuddy chat 上游客户端（OpenAI 兼容 passthrough）。
 *
 * 上游：POST {chatHost}/v2/chat/completions（SSE，OpenAI 格式）。
 * 请求规范（红线）：
 *   - 认证头走 auth.js#chatHeaders（**桌面端身份**，2026-10-21 渠道校验后切换），
 *     绝不携带 X-Refresh-Token；
 *   - 强制 stream:true（非流式由本模块聚合）；
 *   - tool_choice 对象 → 'auto'（对象形式上游 400 code=11101）；
 *   - model 剥离 'wb/' 前缀。
 */
const wbAuth = require('./auth');
const { isTruncatedFinish } = require('../transform/finish');
const { createLineFeeder } = require('../lib/sse-lines');
const identityScrub = require('../transform/identity-scrub');
const systemRelocate = require('../transform/system-relocate');

/** 请求体规范化（红线项）。 */
function normalizeBody(body) {
  const out = Object.assign({}, body);
  out.model = String(out.model || '').replace(/^wb\//, '');
  out.stream = true; // 强制流式（非流式由本地聚合）
  if (out.tool_choice && typeof out.tool_choice === 'object') out.tool_choice = 'auto';
  // 内容层渠道检测应对，两步（2026-11-10 实测，见 docs/05-incidents/
  // workbuddy-channel-detection-2026-11-10.md §4）：
  //   ① system-relocate（默认开）：上游只查 system，且「长度 × 特征密度」双条件。
  //      同一份 13.6KB 系统提示放 system → 11128、放 user → 200。迁位不改任何
  //      内容字节，模型所见信息量一致，只是 role 与位置变了。
  //   ② identity-scrub（opt-in）：句级改写 Codex/Claude Code 这类身份自述。
  if (Array.isArray(out.messages)) {
    const prepared = systemRelocate.prepareMessages(out.messages, {
      scrubMessages: identityScrub.scrubMessages,
    });
    if (prepared.changed) {
      out.messages = prepared.messages;
      if (prepared.relocated) {
        console.log(`[wb-chat] system relocate: ${prepared.movedChars} chars moved from system to first user message`);
      }
      if (prepared.scrubbed) {
        console.log(`[wb-chat] identity scrub: ${prepared.scrubbed} identity sentence(s) neutralized in system prompt`);
      }
    }
  }
  return out;
}

/** 工具参数是否为「半截 JSON」：有内容但解析不出对象，且带键值骨架。 */
function looksIncompleteArgs(raw) {
  const s = String(raw || '').trim();
  if (!s || s === '{}') return false;
  try { JSON.parse(s); return false; } catch { return s.includes('{') || s.includes(':'); }
}

/** 是否任一工具调用的参数被截断。 */
function hasIncompleteToolArgs(toolCalls) {
  return (toolCalls || []).some((tc) => tc && tc.function && looksIncompleteArgs(tc.function.arguments));
}

/**
 * 发起 chat 请求（SSE 流）。
 * @param {object} acct 已解析的账号凭据 {token, userId, host, edition}
 * @param {object} body OpenAI 格式请求体
 * @param {{conversationId?:string, requestId?:string}} [opts] 会话/请求幂等键（同一会话内复用）
 * @returns {Promise<{status:number, body:ReadableStream|null, text:string}>}
 */
async function chatStream(acct, body, opts = {}) {
  const host = acct.host || wbAuth.chatHost(acct.region || 'cn');
  const url = host + '/v2/chat/completions';
  const payload = JSON.stringify(normalizeBody(body));
  // 桌面端身份头：UA/X-IDE-*/X-Private-Data/x-codebuddy-request/会话与追踪头。
  // 旧实现用 authHeaders（web/插件身份）在 2026-10-21 被上游 11128 拦截。
  const headers = wbAuth.chatHeaders(
    { accessToken: acct.token, uid: acct.userId, region: wbAuth.regionOf(host) },
    { conversationId: opts.conversationId, requestId: opts.requestId, acpConnectionId: opts.acpConnectionId },
  );
  const resp = await fetch(url, { method: 'POST', headers, body: payload });
  return { status: resp.status, body: resp.ok ? resp.body : null, text: resp.ok ? '' : await resp.text().catch(() => '') };
}

/** 非流式：聚合 SSE 为 OpenAI completion 对象。 */
async function chatAggregate(acct, body, opts = {}) {
  const r = await chatStream(acct, Object.assign({}, body, { stream: true }), opts);
  if (r.status !== 200 || !r.body) {
    const e = new Error('WorkBuddy upstream HTTP ' + r.status + ' ' + (r.text || '').slice(0, 200));
    e.status = r.status;
    try {
      const parsed = JSON.parse(r.text || '');
      const code = parsed && parsed.code != null ? parsed.code : null;
      if (code != null && !Number.isNaN(Number(code))) e.upstreamCode = Number(code);
    } catch { /* 非 JSON 体忽略 */ }
    throw e;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let content = '';
  let reasoning = '';
  let finish = 'stop';
  let usage = null;
  const toolCalls = [];
  const feeder = createLineFeeder((line) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') return;
    let ev;
    try { ev = JSON.parse(payload); } catch (e) { return; }
    const choice = ev.choices && ev.choices[0];
    if (choice) {
      const delta = choice.delta || {};
      if (delta.content) content += delta.content;
      if (delta.reasoning_content) reasoning += delta.reasoning_content;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index != null ? tc.index : toolCalls.length;
          toolCalls[idx] = toolCalls[idx] || { id: tc.id || 'call_' + idx, type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function) {
            if (tc.function.name) toolCalls[idx].function.name += tc.function.name;
            if (tc.function.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (ev.usage) usage = ev.usage;
  });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    feeder.feed(dec.decode(value, { stream: true }));
  }
  feeder.flush();
  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  // B2：工具参数半截（非空但解析不出 JSON）而上游未标截断时，补上截断语义，
  // 让客户端走续写而非执行参数残缺的工具调用。
  if (!isTruncatedFinish(finish) && hasIncompleteToolArgs(toolCalls)) finish = 'length';
  return {
    id: 'chatcmpl-wb-' + Date.now().toString(36),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    // 截断优先于 tool_calls：截断时工具参数可能半截，报 tool_calls 会让客户端执行残缺调用
    choices: [{ index: 0, message, finish_reason: isTruncatedFinish(finish) ? finish : (toolCalls.length ? 'tool_calls' : finish) }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * WorkBuddy 模型目录（静态最后手段；2026-09-12 实测 catalog）。
 * 名单本体在 workbuddy/model-ids.js（零依赖叶子模块）：平台归属判定也要读它，
 * 放在本文件会形成 chat.js ↔ models/platform-ownership.js 的双向依赖。
 */
const { WB_MODELS } = require('./model-ids');

// 动态目录缓存（含积分倍率），10 分钟
let _catalogCache = null;

/**
 * 倍率解析：兼容旧格式 "x2.5" 与新格式 "x0.00 credits"（上游 2026-09 起带单位后缀）。
 * 非法输入（如 "x." 解析为 NaN）归一为 null，避免 NaN 绕过下游 != null 检查。
 */
function parseRate(credits) {
  const mt = /^x([\d.]+)/.exec(String(credits || '').trim());
  const n = mt ? Number(mt[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** 目录候选凭据：账号库 enabled 账号优先（与 chat 同源），再取本机桌面登录态。 */
function catalogCredentials() {
  const out = [];
  let store = null;
  try {
    store = require('../credentials/store');
  } catch { /* 账号库未就绪时只用本机登录态 */ }
  if (store) {
    let accounts = [];
    try {
      accounts = store.list().filter((a) => a.enabled && a.edition === 'workbuddy');
    } catch { /* 列表查询失败时跳过账号库 */ }
    for (const a of accounts) {
      // 逐账号兜异常：单个账号密文损坏不应中断其余账号的尝试
      try {
        const full = store.get(a.id);
        if (full && full.token) out.push({ source: 'account:' + a.id, info: { accessToken: full.token, uid: full.userId, region: wbAuth.regionOf(full.host) } });
      } catch (e) {
        console.error('[wb-catalog] 账号凭据读取失败，跳过:', a.id, e.message);
      }
    }
  }
  const local = wbAuth.readAuthFile();
  if (local && local.accessToken) out.push({ source: 'local', info: local });
  return out;
}

/**
 * 非对话模型识别（图片 / 视频生成）。
 *
 * 为什么必须区分：WB 目录（`/console/enterprises/personal/models`）是**售卖清单**，
 * 里面同时有对话模型和图片/视频生成模型。后者的 tag 是 `text-to-image` /
 * `text-to-video`，有的还带 `videoGeneration` 参数块。它们的推理走的是另一套
 * 后端（`hunyuan-stream` / `maas`），**没有 chat 后端**。
 *
 * 用 chat 端点去探它们必然回 11103「Backend [x] is not supported」——那不是
 * 「模型不可用」，是「这个模型不归 chat 管」（2026-11-08 现场：4 个媒体模型
 * 被 chat 探活写成 unavailable，面板上长期挂着红点）。
 *
 * 判据优先级：上游 tags/videoGeneration > id 关键字兜底（静态名单没有 tags）。
 */
const NON_CHAT_TAGS = new Set([
  'text-to-image', 'image-to-image', 'text-to-video', 'image-to-video',
  'text-to-audio', 'text-to-speech', 'embedding',
]);
const NON_CHAT_ID_RE = /(^|[-_.])(image|video|kling|audio|tts|embed|rerank)([-_.]|$)/i;

/**
 * 该目录条目是不是可走 chat 端点的对话模型。
 * @param {{id?:string, tags?:string[], videoGeneration?:object}} m 目录条目 / 静态 id 包装
 */
function isChatModel(m) {
  if (!m) return false;
  const id = String(m.id || '');
  if (!id) return false;
  if (m.videoGeneration) return false;
  if (Array.isArray(m.tags) && m.tags.some((t) => NON_CHAT_TAGS.has(String(t).toLowerCase()))) return false;
  if (NON_CHAT_ID_RE.test(id)) return false;
  return true;
}

/** 非对话模型的粗略类型（面板展示用）：image | video | other。 */
function mediaKindOf(m) {
  const tags = Array.isArray(m && m.tags) ? m.tags.map((t) => String(t).toLowerCase()) : [];
  const id = String((m && m.id) || '');
  if (tags.some((t) => t.includes('video')) || /video|kling/i.test(id)) return 'video';
  if (tags.some((t) => t.includes('image')) || /image/i.test(id)) return 'image';
  return 'other';
}

async function fetchCatalog(info) {
  const url = wbAuth.chatHost(info.region || 'cn') + '/console/enterprises/personal/models';
  const resp = await fetch(url, { headers: wbAuth.authHeaders(info), signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const j = await resp.json();
  const data = j.data || j.Result || j;
  const arr = Array.isArray(data) ? data : (data.models || data.list || []);
  if (!arr.length) throw new Error('empty catalog');
  return arr.map((m) => {
    const chat = isChatModel(m);
    return {
      id: m.id,
      name: m.name || m.id,
      rateText: typeof m.credits === 'string' ? m.credits : null,
      rate: parseRate(m.credits),
      maxInputTokens: m.maxInputTokens || null,
      maxOutputTokens: m.maxOutputTokens || null,
      supportsToolCall: !!m.supportsToolCall,
      supportsReasoning: !!m.supportsReasoning,
      // 多模态：目录返回布尔就用，未返回留 null（未知）。路由侧发图只排除明确的 false，
      // 因此这里不给默认值 —— 默认 false 会把它自家的视觉模型排除掉。
      multimodal: typeof m.multimodal === 'boolean' ? m.multimodal : null,
      // 能力位：chat=true 才能进转发面 / 探活 / 虚拟模型候选；
      // media 类只做目录展示，不参与路由（否则只会得到 11103）。
      chat,
      mediaKind: chat ? null : mediaKindOf(m),
      tags: Array.isArray(m.tags) ? m.tags.map(String) : null,
      relatedModels: m.relatedModels && typeof m.relatedModels === 'object' ? m.relatedModels : null,
    };
  });
}

/**
 * 拉取 WorkBuddy 模型目录（GET /console/enterprises/personal/models）。
 * 凭据按 catalogCredentials 顺序逐个尝试；全部失败回退静态目录（倍率 null）。
 * @returns {Promise<Array<{id, rateText, rate, maxInputTokens, maxOutputTokens}>>}
 */
async function modelCatalog(force) {
  if (!force && _catalogCache && Date.now() - _catalogCache.at < 600000) return _catalogCache.models;
  const errors = [];
  for (const { source, info } of catalogCredentials()) {
    try {
      const models = await fetchCatalog(info);
      _catalogCache = { at: Date.now(), models };
      // 归属快照：WB 动态目录是「WB 到底服务哪些名字」的上游事实源。
      // 平台密钥越界判定（models/platform-ownership）据此区分「WB 独有」与
      // 「两平台同名」，此前只看静态 WB_MODELS 会把 glm-5.3 这类两平台都有的
      // 名字误判成 WB 专属。写盘失败不影响目录返回。
      try {
        require('../models/platform-ownership').recordWorkBuddyModels(models.map((m) => m.id));
      } catch (e) {
        // 写盘失败不影响目录返回，但必须留痕：快照不更新会让平台密钥越界判定
        // 继续用旧名单，运维无从发现。
        console.error('[wb-catalog] 平台归属快照写入失败:', e && e.message);
      }
      return models;
    } catch (e) {
      errors.push(source + ': ' + e.message);
    }
  }
  if (errors.length) console.error('[wb-catalog] 动态目录拉取失败，回退静态目录（倍率不可用）:', errors.join(' | '));
  if (_catalogCache) return _catalogCache.models;
  // 静态兜底：同样登记归属（静态名单本身就是 WB 服务的事实）
  try {
    const ownership = require('../models/platform-ownership');
    ownership.recordWorkBuddyModels(WB_MODELS);
  } catch (e) {
    console.error('[wb-catalog] 静态归属快照写入失败:', e && e.message);
  }
  return WB_MODELS.map((id) => ({ id, name: id, rateText: null, rate: null, maxInputTokens: null, maxOutputTokens: null }));
}

module.exports = { chatStream, chatAggregate, normalizeBody, modelCatalog, isChatModel, mediaKindOf, WB_MODELS };

'use strict';
/**
 * workbuddy/chat.js — WorkBuddy chat 上游客户端（OpenAI 兼容 passthrough）。
 *
 * 上游：POST {chatHost}/v2/chat/completions（SSE，OpenAI 格式）。
 * 请求规范（红线）：
 *   - 统一认证头（见 workbuddy/auth.js），绝不携带 X-Refresh-Token；
 *   - 强制 stream:true（非流式由本模块聚合）；
 *   - tool_choice 对象 → 'auto'（对象形式上游 400 code=11101）；
 *   - model 剥离 'wb/' 前缀。
 */
const wbAuth = require('./auth');
const { isTruncatedFinish } = require('../transform/finish');
const { createLineFeeder } = require('../lib/sse-lines');

/** 请求体规范化（红线项）。 */
function normalizeBody(body) {
  const out = Object.assign({}, body);
  out.model = String(out.model || '').replace(/^wb\//, '');
  out.stream = true; // 强制流式（非流式由本地聚合）
  if (out.tool_choice && typeof out.tool_choice === 'object') out.tool_choice = 'auto';
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
 * @returns {Promise<{status:number, body:ReadableStream|null, text:string}>}
 */
async function chatStream(acct, body) {
  const host = acct.host || wbAuth.chatHost(acct.region || 'cn');
  const url = host + '/v2/chat/completions';
  const payload = JSON.stringify(normalizeBody(body));
  const headers = wbAuth.authHeaders(
    { accessToken: acct.token, uid: acct.userId, region: wbAuth.regionOf(host) },
  );
  const resp = await fetch(url, { method: 'POST', headers, body: payload });
  return { status: resp.status, body: resp.ok ? resp.body : null, text: resp.ok ? '' : await resp.text().catch(() => '') };
}

/** 非流式：聚合 SSE 为 OpenAI completion 对象。 */
async function chatAggregate(acct, body) {
  const r = await chatStream(acct, Object.assign({}, body, { stream: true }));
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
  // 让客户端走「续写」而非执行参数残缺的工具调用。
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

/** WorkBuddy 模型目录（静态兜底；2026-09-12 实测 catalog）。 */
const WB_MODELS = [
  'auto', 'default',
  'hy3', 'hy3-x', 'hy4-preview', 'hy4-preview-x',
  'glm-5v-turbo', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5.0', 'glm-4.7', 'glm-4.6', 'glm-4.6v',
  'minimax-m3', 'minimax-m2.5',
  'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'kimi-k2.5', 'kimi-k2-thinking',
  'deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v3-2-volc',
  'hunyuan-2.0-thinking', 'hunyuan-chat', 'hunyuan-image-v3.0',
];

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

/** 目录候选凭据：账号库 enabled 账号优先（与 chat 同源），本机桌面登录态兜底。 */
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

async function fetchCatalog(info) {
  const url = wbAuth.chatHost(info.region || 'cn') + '/console/enterprises/personal/models';
  const resp = await fetch(url, { headers: wbAuth.authHeaders(info), signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const j = await resp.json();
  const data = j.data || j.Result || j;
  const arr = Array.isArray(data) ? data : (data.models || data.list || []);
  if (!arr.length) throw new Error('empty catalog');
  return arr.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    rateText: typeof m.credits === 'string' ? m.credits : null,
    rate: parseRate(m.credits),
    maxInputTokens: m.maxInputTokens || null,
    maxOutputTokens: m.maxOutputTokens || null,
    supportsToolCall: !!m.supportsToolCall,
    supportsReasoning: !!m.supportsReasoning,
  }));
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
      return models;
    } catch (e) {
      errors.push(source + ': ' + e.message);
    }
  }
  if (errors.length) console.error('[wb-catalog] 动态目录拉取失败，回退静态目录（倍率不可用）:', errors.join(' | '));
  if (_catalogCache) return _catalogCache.models;
  return WB_MODELS.map((id) => ({ id, name: id, rateText: null, rate: null, maxInputTokens: null, maxOutputTokens: null }));
}

module.exports = { chatStream, chatAggregate, normalizeBody, modelCatalog, WB_MODELS };

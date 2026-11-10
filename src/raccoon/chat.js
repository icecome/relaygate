'use strict';
/**
 * raccoon/chat.js —— Raccoon 对话面（OpenAI 兼容直通）。
 *
 * ## 为什么可以直通
 *
 * 实测 `POST /api/web/llm/v2/chat/completions` 是**标准 OpenAI 兼容 + 标准 SSE**
 * （`chat.completion.chunk` + `data: [DONE]`，无加密、无信封、无格式转换），
 * 与 WorkBuddy 的直通路径同形。所以这里**不做任何协议改写** ——
 * 只补上游要的身份头、按需补 `extra_body.thinking`，然后把响应流原样转发。
 * 这是本仓库成本最低的一条对话面（对比 ZCode 那条 Anthropic Messages + 身份块）。
 *
 * ## 两个必须真的做到的点
 *
 * 1. **`tools` 必须留在请求体顶层** —— 参考项目里 Qoder 与 TRAE 都因漏发而让
 *    模型在正文里臆造 XML 工具调用、harness 认不出 → 任务终止。这里逐字透传，
 *    不做任何字段白名单裁剪。
 * 2. **思考档位只有 `extra_body.thinking` 有效**（provider 级方言，与模型无关）：
 *    `{type:'disabled'}` 实测**真关闭**（8/8 全为 0 思考）；`{type:'enabled'}` 与
 *    默认等价。**无效**写法（都实测过）：`extra_body.enable_thinking`、
 *    双层 `extra_body.extra_body.*`、把 `thinking` 放顶层（不在 `extra_body` 内）。
 *
 * ## 与参考项目的差异（刻意的）
 *
 * 参考项目把图片按字节目标缩放后再发（其网关按**请求体字节**卡，10MB 上限，
 * 两张 2560×1600 截图即 413）。本实现**不做图片缩放**：那需要一套独立的图像
 * 处理与预算逻辑，而 RelayGate 的客户端是否发图、发多大由调用方决定。
 * 现状记入 docs/01-architecture/known-limitations.md；超限时上游回 413，错误会如实透传。
 */
const client = require('./client');
const product = require('./product');
const { normalizeEffort, parseThinking } = require('../lib/effort');

/**
 * 对话面错误（供路由映射用户文案）。
 *
 * ⚠️ `body` 必须保留**上游原始报文的文本**，不要只留一句可读 message：
 * `raccoon/limiter.js#classifyThrottle` 要靠它读 `error.code`
 * （`user_model_rate_limited` / `200103`）来决定冷 5 分钟还是冷 15 秒。
 * 早期实现把它截到 300 字仍然够用，但**不能**在抛出前丢掉。
 */
class RaccoonChatError extends Error {
  constructor(message, { status, model, body, headers } = {}) {
    super(message);
    this.name = 'RaccoonChatError';
    this.status = status;
    this.model = model;
    this.body = body;
    // 上游限流头保留在错误对象上，供 routes 的 Retry-After 取值链消费。
    this.headers = headers && typeof headers === 'object' ? headers : {};
  }
}

/**
 * 解析「思考」意图，产出要写进 `extra_body` 的对象。
 *
 * 只翻译**调用方明确表达的意图**，不设服务端默认档：
 * 客户端什么都不说时返回 undefined（一个字节都不改）。理由与批 3 的思考档位
 * 一致 —— 输出只占 token 体量的一小部分，压输出收益近零，反有截断风险。
 *
 * 接受的输入（按优先级）：
 *   - `extra_body.thinking`：已经是上游方言，原样透传（不猜测、不改写）；
 *   - `reasoning_effort`（OpenAI 风格）；
 *   - `thinking`（Anthropic 风格 `{type,budget_tokens}`）。
 *
 * @returns {{type:'disabled'|'enabled'}|undefined}
 */
function resolveThinking(body) {
  if (body && body.extra_body && typeof body.extra_body === 'object'
    && body.extra_body.thinking && typeof body.extra_body.thinking === 'object') {
    return body.extra_body.thinking;
  }
  const fromEffort = normalizeEffort(body && body.reasoning_effort);
  const fromThinking = parseThinking(body && body.thinking);
  const level = fromThinking ? fromThinking.level : fromEffort;
  if (!level) return undefined;
  // `none` 是唯一能真正关闭思考的档位；其余档位上游只分「开/关」两档，
  // 故显式要思考时发 enabled（与默认等价，但语义明确）。
  return { type: level === 'none' ? 'disabled' : 'enabled' };
}

/**
 * 构造上游请求体：逐字透传调用方字段，只补 `extra_body`。
 *
 * ⚠️ `extra_body` 里若调用方已给了别的键，保留它们（我们只写 `thinking`）。
 */
function buildUpstreamBody(body) {
  const thinking = resolveThinking(body);
  const out = { ...body };
  // 中文档字段不进上游（是我们自己的方言输入）
  delete out.thinking;
  if (thinking) {
    const prev = body.extra_body && typeof body.extra_body === 'object' ? body.extra_body : {};
    out.extra_body = { ...prev, thinking };
  }
  return out;
}

/**
 * 对话面请求头。
 *
 * ⚠️ 与积分端点的头**不同**（照抄参考实现）：这里带 `X-Client-Platform`，
 * 但**不带** `X-Client-Version`，也不带 `User-Agent`；`Accept` 是
 * `text/event-stream`。别图省事复用 `desktopHeaders`。
 */
function chatHeaders(acct) {
  const credential = client.credentialOf(acct);
  const variant = require('../platform/variant');
  const V = variant.variantOf(variant.RACCOON);
  return {
    ...product.headers(credential, { platform: V.identity.clientPlatform }),
    Accept: 'text/event-stream',
  };
}

/**
 * 发起流式对话，返回**原始响应**（由调用方读 body 转发）。
 * ⚠️ 不走 `client.request()`：那个函数会把响应体读成文本，流式就被破坏了。
 *
 * `signal`（可选）：调用方传客户端断开信号。**必须透传**——否则用户按了停止，
 * 上游仍会把整轮 token 生成完，积分照扣。与请求自带的超时信号用 `any` 合并，
 * 任一触发都中止。
 */
async function chatStream(acct, body, opts = {}) {
  const url = client.urlFor('chat');
  const timeout = AbortSignal.timeout(product.REQUEST_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  const init = client.withDispatcher({
    method: 'POST',
    headers: chatHeaders(acct),
    body: JSON.stringify(buildUpstreamBody(body)),
    redirect: 'error',
    signal,
  });
  let resp;
  try {
    resp = await fetch(url.toString(), init);
  } catch (e) {
    // 客户端主动取消不是「网络失败」：用 499 语义（与 routes 的既有口径一致），
    // 否则日志里会出现一堆假的 502，把真实的网络问题淹掉。
    if (opts.signal && opts.signal.aborted) {
      const err = new RaccoonChatError('raccoon 请求已被调用方取消', { model: body && body.model });
      err.status = 499;
      err.aborted = true;
      throw err;
    }
    throw new RaccoonChatError(`Raccoon 网络请求失败: ${e.message}`, { model: body && body.model });
  }
  if (!resp.ok) {
    let detail = '';
    try {
      detail = (await resp.text()).slice(0, 800);
    } catch { /* 错误体读不到不影响状态码判定 */ }
    // 限流时把上游的 retry-after / 限流相关头一并带出：上游目前**不发**
    // Retry-After（实测 429 只回 content-type），但一旦开始发，这里就能用上，
    // 不必再改一次链路。取不到就是空对象。
    const limitHeaders = {};
    for (const k of ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
      const v = resp.headers.get(k);
      if (v != null) limitHeaders[k] = v;
    }
    const err = new RaccoonChatError(`Raccoon 对话上游 HTTP ${resp.status}${detail ? `: ${detail}` : ''}`, {
      status: resp.status,
      model: body && body.model,
      body: detail,
      headers: limitHeaders,
    });
    // 上游一旦开始下发 Retry-After，routes/openai.js 与 routes/raccoon.js
    // 现有的 err.retryAfterMs 取值链就能直接用上，不必再改一次链路。
    const raRaw = limitHeaders['retry-after'];
    const raSeconds = Number(raRaw);
    if (Number.isFinite(raSeconds) && raSeconds > 0) {
      err.retryAfterMs = raSeconds * 1000;
    } else if (raRaw) {
      const at = Date.parse(raRaw);
      if (Number.isFinite(at) && at > Date.now()) err.retryAfterMs = at - Date.now();
    }
    throw err;
  }
  return resp;
}

/** 发起非流式对话，返回解析后的 JSON。 */
async function chatNonStream(acct, body, opts = {}) {
  const resp = await chatStream(acct, body, opts);
  const text = await resp.text();
  if (!text.trim()) {
    throw new RaccoonChatError('Raccoon 对话上游返回空响应', { status: resp.status, model: body && body.model });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RaccoonChatError(`Raccoon 对话上游响应非 JSON: ${text.slice(0, 200)}`, {
      status: resp.status,
      model: body && body.model,
    });
  }
}

module.exports = {
  RaccoonChatError,
  resolveThinking,
  buildUpstreamBody,
  chatHeaders,
  chatStream,
  chatNonStream,
};

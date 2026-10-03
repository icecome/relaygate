'use strict';
/**
 * upstream/client.js — 唯一上游通道：与 Trae `llm_utils_chat` 通信。
 * 复用 src/lib/auth.js 的 header/设备构造，错误处理走 errors.js 分类重试。
 * SSE 调试：TRAE_DEBUG_SSE=true 时记录上游原始 SSE 事件到 logs/<date>/sse-debug.jsonl（T2）。
 */
const config = require('../config');
const auth = require('../auth');
const libAuth = require('../lib/auth');
const { v4: uuidv4 } = require('../lib/uuid');
const { retryWithBackoff } = require('./errors');
const { createStreamHandler } = require('../transform/sse');
const fs = require('fs');
const path = require('path');

// ===== T2 SSE 调试：可选写入原始事件 =====
const SSE_DEBUG = () => process.env.TRAE_DEBUG_SSE === 'true';
let sseDebugSeq = 0;

function sseDebugWrite(requestId, accountId, model, event) {
  if (!SSE_DEBUG()) return;
  try {
    sseDebugSeq += 1;
    const dir = path.join(config.ROOT, 'logs', new Date().toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      seq: sseDebugSeq,
      requestId: requestId || null,
      accountId: accountId || null,
      model: model || null,
      event,
    });
    fs.appendFileSync(path.join(dir, 'sse-debug.jsonl'), line + '\n', 'utf-8');
  } catch { /* best-effort */ }
}

// 模型名 → 上游 model_name（__dev 后缀）映射。
// 规则对齐 TraeWorkAssistant 对 batch_get_detail_param 的实测表（2026-09）；
// 未命中表项的模型回退 `config_name + '__dev'`。
const MODEL_DEV_NAME = {
  'doubao-seed-evolving': 'Doubao-Seed-Evolving__dev',
  'doubao-seed-2.1-pro': 'Doubao-Seed-2.1-Pro__dev',
  'seed-code-pro-0430': 'Doubao-Seed-2.1-Pro__dev',
  'doubao-seed-2.1-turbo': 'Doubao-Seed-2.1-Turbo__dev',
  'doubao-seed-code': 'Doubao-Seed-Code__dev',
  'glm-5.3-flash': 'glm-5.3-flash__dev',
  'qwen3.8-flash': 'qwen3.8-flash__dev',
  'glm-5.2': 'glm-5.2__dev',
  'glm-5.3': 'glm-5.3__dev',
  'glm-5': 'glm-5__dev',
  'glm-5-turbo': 'glm-5-turbo__dev',
  'deepseek-v4-flash': 'deepseek_v4_flash__dev',
  'deepseek-v4-flash-official': 'DeepSeek-V4-Flash-Official__dev',
  'deepseek-v4-pro': 'deepseek_v4_pro__dev',
  'deepseek-v4-pro-official': 'DeepSeek-V4-Pro-Official__dev',
  'kimi-k2.6': 'kimi-k2.6__dev',
  'kimi-k2.7-code': 'kimi-k2.7-code__dev',
  'kimi-k3': 'kimi-k3__dev',
  'minimax-m3': 'minimax-m3__dev',
  'qwen3.8-max': 'qwen3.8-max__dev',
  'qwen-3.7-plus': 'qwen-3.7-plus__dev',
};

function upstreamModelName(cfgName, model) {
  const key = String(model || '').toLowerCase();
  return MODEL_DEV_NAME[key] || `${cfgName}__dev`;
}

// 代理 agent：多个模块共用，按需从环境变量创建
let _httpsAgent = null;
let _socksAgent = null;

function applyProxy(options) {
  const HTTPS_PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  const HTTP_PROXY = process.env.HTTP_PROXY || process.env.http_proxy || '';
  const ALL_PROXY = process.env.ALL_PROXY || process.env.all_proxy || '';
  const proxyUrl = HTTPS_PROXY || HTTP_PROXY || ALL_PROXY;
  if (!proxyUrl) return options;
  try {
    if (proxyUrl.startsWith('socks')) {
      if (!_socksAgent) {
        const { SocksProxyAgent } = require('socks-proxy-agent');
        _socksAgent = new SocksProxyAgent(proxyUrl);
      }
      options.agent = _socksAgent;
    } else {
      if (!_httpsAgent) {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        _httpsAgent = new HttpsProxyAgent(proxyUrl);
      }
      options.agent = _httpsAgent;
    }
  } catch (e) {
    console.error(`[proxy] failed to create agent: ${e.message}`);
  }
  return options;
}

/**
 * 组装发往 llm_utils_chat 的请求体。
 * @param {object|null} authInfo ensureAuth 返回的账号（用于请求体增强字段），单测可省略
 */
function buildBody(messages, model, stream, options, authInfo) {
  const modelOpts = config.resolveModelOptions(model, options?.config_name);
  // TraeWork 身份：TRAE_WORK_IDENTITY=on 时 function 用 solo_work_lite（真机 Work 值），
  // options.function 显式指定时优先；inline_chat（auto）协议不同不切换。
  const workOn = process.env.TRAE_WORK_IDENTITY === 'on';
  const baseFunc = options?.function
    || config.upstreamFunction
    || modelOpts.function
    || 'chat_v3';
  const funcName = options?.function
    || (workOn && baseFunc !== 'inline_chat' ? 'solo_work_lite' : baseFunc);

  const body = {
    messages,
    function: funcName,
    stream: stream !== false,
  };

  // 原生 tools 透传（native 协议）
  if (Array.isArray(options?.tools) && options.tools.length > 0) {
    body.tools = options.tools.map((t) => {
      const fn = (t && (t.function || t)) || {};
      // Anthropic 形态用 input_schema 承载 JSON Schema；不映射会让 parameters
      // 退化成空对象，客户端拿到的工具参数定义全部丢失。
      const schema = fn.parameters || fn.input_schema || { type: 'object', properties: {} };
      return {
        type: 'function',
        function: {
          name: fn.name || 'unnamed_tool',
          description: fn.description || '',
          parameters: typeof schema === 'string' ? schema : JSON.stringify(schema),
        },
      };
    });
  }

  // llm_utils_chat 不认识 config_name，只认 model 字段
  const cfgName = options?.config_name || modelOpts?.config_name;
  if (cfgName && funcName !== 'inline_chat') {
    body.model = cfgName;
    // 请求体增强：对齐官方客户端指纹（文档见 docs/TRADEWORK-ASSISTANT-COMPARISON.md §2.2）。
    // 保留 model 字段（chat_v3 通道依赖），额外补充 config_name/model_name 及会话/设备字段。
    if (process.env.TRAE_BODY_ENRICH !== 'off') {
      body.config_name = cfgName;
      body.model_name = upstreamModelName(cfgName, model);
      body.conversation_id = uuidv4();
      body.session_id = uuidv4();
      body.project_id = uuidv4();
      body.prompt_max_tokens = 168000;
      body.mode = 'FunctionCall';
      body.ide_version = libAuth.getIdeVersion();
      body.ide_version_code = libAuth.getIdeVersionCode();
      body.app_id = process.env.TRAE_APP_ID || '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
      body.package_type = 'stable_cn';
      if (authInfo) {
        body.user_id = String(authInfo.userId || '');
        const dev = authInfo.devices || {};
        body.device_id = dev.deviceId || '';
        body.machine_id = dev.machineId || '';
      }
    }
  } else {
    const modelName = options?.model_name || (model && model !== 'auto' ? model : null);
    if (modelName) body.model = modelName;
  }

  if (options?.max_tokens && typeof options.max_tokens === 'number') {
    body.max_tokens = options.max_tokens;
  }
  for (const p of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'seed']) {
    if (options?.[p] != null && typeof options[p] === 'number') body[p] = options[p];
  }
  if (Array.isArray(options?.stop)) body.stop = options.stop;
  if (options?.tool_choice != null) body.tool_choice = options.tool_choice;
  // TraeWork 身份：common_params 对齐 SOLO 真机（product_name=lite + chat_mode=work）
  if (workOn) {
    body.common_params = { product_name: 'lite', chat_mode: 'work' };
  }
  return body;
}

/**
 * 调用 llm_utils_chat 主端点。
 * stream=true 返回 { body: ReadableStream, function, logId }；
 * stream=false 返回 { data, function, logId }。
 */
async function llmUtilsChat(messages, model, stream, options = {}) {
  return retryWithBackoff(async () => {
    const authInfo = await auth.ensureAuth(options.accountId);
    const headers = auth.headersFor(authInfo, options.requestId, options.lastEventId);
    const body = buildBody(messages, model, stream, options, authInfo);
    const endpoint = `${auth.getApiHost(authInfo)}${config.upstreamChatPath}`;

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      tag: 'upstream',
      path: config.upstreamChatPath,
      function: body.function,
      model: body.model || null,
      stream: stream !== false,
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
      account: options.accountId || null,
    }));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    let resp;
    try {
      resp = await fetch(endpoint, applyProxy({
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      }));
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        const e = new Error(`llm_utils_chat timed out after ${Math.round(config.requestTimeoutMs / 1000)}s`);
        e.code = 'ETIMEDOUT';
        throw e;
      }
      throw err;
    }
    clearTimeout(timer);

    if (!resp.ok) {
      const text = await resp.text();
      const err = new Error(`${config.upstreamChatPath} failed: ${resp.status} ${text}`);
      err.status = resp.status;
      err.bodyText = text;
      // 从 JSON 错误体提取业务码（如 {"code":4001}），供 isModelConfigError / classifyError 使用
      try {
        const parsed = JSON.parse(text);
        const code = parsed && (parsed.code ?? parsed.error_code);
        if (code != null && !Number.isNaN(Number(code))) err.upstreamCode = Number(code);
      } catch { /* non-json body */ }
      throw err;
    }

    if (stream !== false) return { body: resp.body, function: body.function };

    // 非流式：上游有时仍返回 SSE（Content-Type 或正文以 event:/data: 开头）
    const contentType = String(resp.headers.get('content-type') || '');
    const raw = await resp.text();
    if (contentType.includes('text/event-stream') || looksLikeSse(raw)) {
      const data = await aggregateSseToCompletion(raw, {
        model: body.model || model || 'auto',
        userText: options.userText || '',
      });
      return { data, function: body.function };
    }
    const data = JSON.parse(raw);
    return { data, function: body.function };
  }, { maxRetries: config.maxRetries, baseDelay: config.retryBaseDelay });
}

/**
 * 获取模型配置详情（用于 /v1/models/detail）。
 */
async function getModelDetailParam(functionName) {
  const authInfo = await auth.ensureAuth();
  const headers = auth.headersFor(authInfo);
  const body = {
    function: functionName || 'chat_v3',
    config_names: null,
    need_prompt: false,
    current_config_info: null,
    poly_prompt: true,
    mode_type: null,
    agent_type: null,
  };
  const endpoint = `${auth.getApiHost(authInfo)}/api/ide/v1/get_detail_param`;
  const resp = await fetch(endpoint, applyProxy({
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  if (!resp.ok) {
    const e = new Error(`get_detail_param failed: ${resp.status}`);
    e.status = resp.status;
    throw e;
  }
  return resp.json();
}

/** 粗判正文是否为 SSE（兼容 event: / data: 开头）。 */
function looksLikeSse(text) {
  if (!text) return false;
  const head = text.slice(0, 64).trimStart();
  return head.startsWith('event:') || head.startsWith('data:') || head.startsWith(':');
}

/**
 * 把上游 SSE 正文聚合成 OpenAI 非流式 completion 对象。
 * 复用 transform/sse 的 createStreamHandler，保证与流式路径工具语义一致。
 */
async function aggregateSseToCompletion(rawText, { model, userText } = {}) {
  let content = '';
  let reasoning = '';
  let finishReason = 'stop';
  let streamError = null;
  let streamErrorCode = null;
  let usage = null; // 上游 token_usage 事件（真实 token 消耗）
  const toolCalls = [];

  const handler = createStreamHandler((evt) => {
    switch (evt.type) {
      case 'text':
        if (evt.content) content += evt.content;
        if (evt.reasoning) reasoning += evt.reasoning;
        break;
      case 'tool_call':
        toolCalls.push(evt.call);
        break;
      case 'done':
        finishReason = evt.finish_reason || 'stop';
        break;
      case 'error':
        streamError = evt.message || 'upstream stream error';
        streamErrorCode = evt.code;
        break;
      case 'token_usage':
        usage = evt.data;
        break;
      default:
        break;
    }
  }, { userText });

  const lines = String(rawText || '').split('\n');
  for (const line of lines) handler.feedLine(line);
  handler.flushToolAccum();

  if (streamError) {
    const e = new Error(streamError);
    e.code = 'UPSTREAM_STREAM_ERROR';
    if (streamErrorCode != null) e.upstreamCode = streamErrorCode;
    throw e;
  }

  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.arguments || '{}' },
    }));
  }

  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'auto',
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length ? 'tool_calls' : finishReason,
    }],
    usage: {
      prompt_tokens: (usage && usage.prompt_tokens) || 0,
      completion_tokens: (usage && usage.completion_tokens) || 0,
      total_tokens: (usage && usage.total_tokens) || 0,
      reasoning_tokens: (usage && usage.reasoning_tokens) || 0,
    },
  };
}

/**
 * 消费上游流，逐块回调（兼容 Web ReadableStream / Node stream）。
 * @param {import('stream').Readable | ReadableStream} body
 * @param {(chunk: string)=>void} onText
 * @param {{requestId?:string, accountId?:string, model?:string}} [debugCtx] T2 SSE 调试上下文
 */
async function consumeStream(body, onText, debugCtx) {
  // Web ReadableStream 可异步迭代
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (SSE_DEBUG()) sseDebugWrite(debugCtx && debugCtx.requestId, debugCtx && debugCtx.accountId, debugCtx && debugCtx.model, { type: 'chunk', chunk: chunk.slice(0, 2000) });
      onText(chunk);
    }
    return;
  }
  // Node stream
  for await (const chunk of body) {
    if (chunk) {
      const s = typeof chunk === 'string' ? chunk : chunk.toString();
      if (SSE_DEBUG()) sseDebugWrite(debugCtx && debugCtx.requestId, debugCtx && debugCtx.accountId, debugCtx && debugCtx.model, { type: 'chunk', chunk: s.slice(0, 2000) });
      onText(s);
    }
  }
}

module.exports = { llmUtilsChat, getModelDetailParam, buildBody, upstreamModelName, consumeStream };
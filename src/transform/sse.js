'use strict';
/**
 * transform/sse.js — 上游 SSE 流解析 + tool_use 文本块转 tool_calls（核心资产）。
 *
 * 参考 server.js handleLlmUtilsStream 的行为，抽成有状态处理器，便于路由层复用。
 * 需要处理的三种上游工具形态：
 *   1. 原生结构化 tool_calls (function_call:{name,arguments})
 *   2. <tool_use>{json}</tool_use> 文本块（可能跨 chunk 拆分）
 *   3. 裸 {name, arguments} JSON 对象
 * 全部归一化为标准 OpenAI tool_calls delta。
 */
/**
 * 创建一个有状态 SSE 处理器。
 * @param {(chunk: object)=>void} emit 输出回调，收到归一化 chunk：
 *   {type:'text', content?, reasoning?} | {type:'tool_call', call} | {type:'done', finish_reason} | {type:'error', code, message} | {type:'token_usage', data}
 * @param {{userText?:string}} opts 用户请求原文，用于空参数工具调用补偿
 */
function createStreamHandler(emit, opts = {}) {
  const userText = opts.userText || '';
  // 是否在残缺参数里注入 __incomplete/__raw 诊断标记（默认关闭，见 config.markIncompleteToolArgs）
  const markIncomplete = opts.markIncomplete === true;
  let currentEvent = '';
  let toolUseAccum = ''; // 跨 chunk 缓冲未闭合的 tool JSON 文本
  /**
   * 原生 tool_calls 按 index 累积。
   * Trae 会分片下发参数：首片带 name+id，后续片 name/id 为空、仅追加 arguments 片段。
   * @type {Map<number,{id:string,name:string,raw:string,emitted:boolean}>}
   */
  const pendingNative = new Map();
  let lastToolIndex = -1;
  /** 是否出现过参数被截断（半截 JSON）的工具调用；聚合层据其把末帧定为 length（B2）。 */
  let sawIncompleteToolArgs = false;

  // 从用户文本提取路径/模式，用于缺参补偿
  function compensateToolArgs(toolName) {
    if (!userText) return null;
    const n = String(toolName || '').toLowerCase();

    if (/glob|pattern/.test(n)) {
      const m = userText.match(/(\*\*?\/[^\s"']+|\*\.\w+|[A-Za-z0-9_./\\-]+\.\w+)/);
      if (m) return { pattern: m[1] };
    }
    if (/search|find/.test(n) && !/file|read|path/.test(n)) {
      const m = userText.match(/([A-Za-z0-9_./\\-]+\.\w+|\*\*?\/[^\s"']+)/);
      if (m) return { query: m[1], pattern: m[1] };
    }
    if (/file|read|edit|write|open|path|dir|folder|list/.test(n)) {
      const quoted = userText.match(/["']((?:[A-Za-z]:[\\/][^"']+)|(?:\/[^"']+)|([^"'/\\][^"']*\.\w+))["']/);
      const anyPath = userText.match(/((?:[A-Za-z]:[\\/][^\s"']+)|(?:\/[^\s"']+\.\w+)|([A-Za-z0-9_.-]+\/[^\s"']+\.\w+)|([A-Za-z0-9_.-]+\.\w+))/);
      const path = (quoted && (quoted[1] || quoted[3])) || (anyPath && (anyPath[1] || anyPath[3] || anyPath[4])) || null;
      if (!path) return null;
      if (/glob|dir|folder|list/.test(n) && !/read|file/.test(n)) return { path, pattern: path };
      return { file_path: path, path };
    }
    return null;
  }

  /**
   * 判断 JSON 字符串是否为「被截断的半截对象」：有内容但解析不出合法对象，
   * 且已出现键值骨架（含冒号）。区别于「上游本就发了空对象 `{}`」。
   */
  function looksIncomplete(raw) {
    const s = String(raw || '').trim();
    if (!s) return false;
    if (s === '{}' || s === '[]') return false;
    if (safeParse(s)) return false;
    return s.includes('{') || s.includes(':');
  }

  /**
   * 规范化工具参数。返回 { args, incomplete }：
   * - args 为交给客户端的参数对象；incomplete 标记原始参数是否为「半截 JSON」。
   * - 判定与服务解耦：无论是否注入 __incomplete 标记，incomplete 都会如实返回，
   *   供聚合层把末帧定为 length（B2）。
   * - markIncomplete 为 true 时才在 args 里注入 __incomplete/__raw，便于排查；
   *   默认关闭，避免严格 schema 校验的客户端不认额外键。
   */
  function finalizeArgs(name, args) {
    const plain = (v) => ({ args: v, incomplete: false });
    if (args == null || args === '') {
      return plain(compensateToolArgs(name) || {});
    }
    if (typeof args === 'object' && !Array.isArray(args)) {
      const keys = Object.keys(args);
      if (!keys.length) return plain(compensateToolArgs(name) || {});
      return plain(args);
    }
    if (typeof args === 'string') {
      const parsed = safeParse(args.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (!Object.keys(parsed).length) return plain(compensateToolArgs(name) || {});
        return plain(parsed);
      }
      const compensated = compensateToolArgs(name);
      if (compensated) return plain(compensated);
      if (looksIncomplete(args)) {
        if (!markIncomplete) return { args: {}, incomplete: true };
        // __raw 截断到 500 字符：够看出形态即可，避免半截大文件正文塞进 SSE 帧
        return { args: { __incomplete: true, __raw: String(args).slice(0, 500) }, incomplete: true };
      }
      return plain({});
    }
    return plain(compensateToolArgs(name) || {});
  }

  /** 优先完整 arguments，否则 partial_arguments。续传分片勿 trim，否则会丢掉空格。 */
  function pickArgsText(fc, { keepWs = false } = {}) {
    const a = fc.arguments;
    const p = fc.partial_arguments;
    const norm = (v) => {
      if (typeof v === 'string') return keepWs ? v : v.trim();
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) return JSON.stringify(v);
      return '';
    };
    const fromA = norm(a);
    if (fromA) return fromA;
    return norm(p);
  }

  function emitNativeTool(item) {
    const { args, incomplete } = finalizeArgs(item.name, item.raw);
    item.emitted = true;
    // 参数残缺时置位，供聚合层把末帧 finish_reason 定为 length（B2）：
    // 让客户端走「续写」而非执行一个参数不完整的工具。
    if (incomplete) sawIncompleteToolArgs = true;
    emit({
      type: 'tool_call',
      call: {
        id: item.id,
        name: item.name,
        arguments: JSON.stringify(args || {}),
      },
    });
  }

  function tryEmitIfComplete(item) {
    if (!item || item.emitted) return;
    if (!item.raw) return;
    const parsed = safeParse(item.raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      emitNativeTool(item);
      pendingNative.delete(item.index);
    }
  }

  function flushNativeTools(force) {
    for (const [idx, item] of [...pendingNative]) {
      if (!force && item.emitted) {
        pendingNative.delete(idx);
        continue;
      }
      if (!force && !item.raw) continue;
      emitNativeTool(item);
      pendingNative.delete(idx);
    }
  }

  /**
   * 处理上游原生 tool_calls（含分片续传）。
   * 分片形态：首片带 name+id，后续片 name 为空、仅追加 arguments 片段。
   */
  function handleNativeToolCalls(toolCalls) {
    for (const tc of toolCalls || []) {
      const fc = tc.function_call || tc.function || {};
      const hasName = typeof fc.name === 'string' && fc.name.length > 0;
      const frag = pickArgsText(fc, { keepWs: !hasName });
      const index = Number.isFinite(tc.index) ? Number(tc.index) : (lastToolIndex >= 0 ? lastToolIndex : 0);

      if (hasName) {
        const id = tc.id || pendingNative.get(index)?.id || ('call_' + Math.random().toString(36).slice(2, 10));
        const prev = pendingNative.get(index);
        pendingNative.set(index, {
          index,
          id,
          name: fc.name,
          raw: frag || (prev && !prev.emitted ? prev.raw : ''),
          emitted: false,
        });
        lastToolIndex = index;
        tryEmitIfComplete(pendingNative.get(index));
        continue;
      }

      // 续传分片：无 name，按 index 或最近一次 tool 追加参数
      let target = pendingNative.get(index);
      if (!target && lastToolIndex >= 0) target = pendingNative.get(lastToolIndex);
      if (!target) continue;
      if (frag) target.raw += frag;
      if (tc.id && !target.id) target.id = tc.id;
      tryEmitIfComplete(target);
    }
  }

  const isToolJson = (o) => o && typeof o === 'object' && typeof o.name === 'string' && o.name && o.arguments !== undefined;

  // 从 pos 起找下一个平衡 {…} 对象，若为工具对象则返回 {json,obj,end}
  function findToolJsonAt(s, pos) {
    let start = -1, depth = 0, str = false, esc = false;
    for (let i = pos; i < s.length; i++) {
      const c = s[i];
      if (str) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') str = false;
        continue;
      }
      if (c === '"') { str = true; continue; }
      if (c === '{') { if (depth === 0) start = i; depth++; continue; }
      if (c === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          const raw = s.slice(start, i + 1);
          try {
            const obj = JSON.parse(raw);
            if (isToolJson(obj)) return { json: raw, obj, end: i + 1 };
          } catch (e) { /* 非合法 JSON，继续扫描 */ }
        }
      }
    }
    return null;
  }

  function normalizeChunk(parsed) {
    if (!parsed || typeof parsed !== 'object') return;
    // 原生事件名驱动的对象
    if (parsed._type === 'event_name') { currentEvent = parsed.value; return; }
    if (parsed.done) { flushNativeTools(true); emit({ type: 'done', finish_reason: 'stop' }); return; }

    // Trae output 事件里可直接带原生 tool_calls（实测 DeepSeek/seed-code）
    if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length) {
      handleNativeToolCalls(parsed.tool_calls);
      if (!parsed.response && !parsed.content && !parsed.reasoning_content && !parsed.reasoning) return;
    }

    const ev = currentEvent;
    if (ev === 'output' || (!ev && (parsed.response != null || parsed.content != null))) {
      const out = { type: 'text' };
      if (parsed.response && (parsed.response.startsWith('Building prompt:') || parsed.response.startsWith('Completed building prompt'))) {
        emit({ type: 'progress', data: parsed.response });
        return;
      }
      if (parsed.response) out.content = (out.content || '') + parsed.response;
      if (parsed.content) out.content = (out.content || '') + parsed.content;
      if (parsed.reasoning_content) out.reasoning = (out.reasoning || '') + parsed.reasoning_content;
      if (parsed.reasoning) out.reasoning = (out.reasoning || '') + parsed.reasoning;
      if (out.content == null && out.reasoning == null) return;
      // 文本 content 可能夹带 <tool_use>{json}</tool_use> → 提取为 tool_call，剩余作纯文本
      const text = out.content != null ? String(out.content) : '';
      if (text) {
        const rest = processToolUseContent(text);
        if (rest) emit({ type: 'text', content: rest });
        else if (out.reasoning == null) return; // 全文都是工具，不再发空文本
      }
      if (out.reasoning) emit({ type: 'text', reasoning: out.reasoning });
      return;
    }
    if (ev === 'done') { flushNativeTools(true); emit({ type: 'done', finish_reason: parsed.finish_reason || 'stop' }); return; }
    if (ev === 'error') {
      // message 为空时用 code 拼可读文案（如 1005 PlanLimit），避免仅 "upstream stream error"
      let message = parsed.message;
      if (!message) {
        if (parsed.code === 1005) message = 'PlanLimit: 套餐额度不足 (1005)';
        else if (parsed.code != null) message = `upstream error code ${parsed.code}`;
        else message = 'upstream stream error';
      }
      emit({ type: 'error', code: parsed.code, message });
      return;
    }
    if (ev === 'token_usage') { emit({ type: 'token_usage', data: parsed }); return; }
  }

  /**
   * 处理纯文本 content：提取 <tool_use>{json}</tool_use> / 裸工具 JSON 为 tool_call，
   * 返回剩余纯文本。
   */
  function processToolUseContent(segment) {
    toolUseAccum += segment;
    let out = '';
    let idx = 0;
    for (;;) {
      const hit = findToolJsonAt(toolUseAccum, idx);
      if (!hit) break;
      out += toolUseAccum.slice(idx, hit.start);
      const name = hit.obj.name;
      const { args, incomplete } = finalizeArgs(name, hit.obj.arguments);
      if (incomplete) sawIncompleteToolArgs = true;
      if (args) {
        emit({
          type: 'tool_call',
          call: {
            id: 'call_' + Math.random().toString(36).slice(2, 10),
            name,
            arguments: typeof args === 'string' ? args : JSON.stringify(args),
          },
        });
      }
      idx = hit.end;
    }
    out += toolUseAccum.slice(idx);
    // 若尾部像是工具对象的开头（未闭合且含 "name" 关键字），缓冲等下一块
    const tail = out.match(/(\{[^}]*)$/);
    if (tail && tail[1].includes('"name"')) {
      toolUseAccum = tail[1];
      out = out.slice(0, out.length - tail[1].length);
    } else {
      toolUseAccum = '';
    }
    return out;
  }

  /**
   * 逐行喂入 SSE 原始行。
   * @param {string} line
   */
  function feedLine(line) {
    const trimmed = (line || '').trim();
    if (!trimmed) return;
    let parsed = null;
    if (trimmed.startsWith('event:')) { currentEvent = trimmed.substring(6).trim(); return; }
    if (trimmed.startsWith('data:')) {
      const data = trimmed.substring(5).trim(); // 兼容 "data:" 无空格
      if (data === '[DONE]') { emit({ type: 'done', finish_reason: 'stop' }); return; }
      try { parsed = JSON.parse(data); } catch (e) { return; }
    } else {
      try { parsed = JSON.parse(trimmed); } catch (e) { return; }
    }
    normalizeChunk(parsed);
  }

  /** 归一化后的原始 chunk 入口（供路由层调用）。 */
  function ingest(parsed) {
    if (parsed && parsed.tool_calls && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length) {
      handleNativeToolCalls(parsed.tool_calls);
      return;
    }
    normalizeChunk(parsed);
  }

  function flushToolAccum() {
    flushNativeTools(true);
    if (toolUseAccum) {
      emit({ type: 'text', content: toolUseAccum });
      toolUseAccum = '';
    }
  }

  return {
    feedLine,
    ingest,
    flushToolAccum,
    /** 是否出现过参数残缺的工具调用（B2：据此把末帧 finish_reason 定为 length）。 */
    sawIncompleteToolArgs: () => sawIncompleteToolArgs,
  };
}

/** 解析 JSON 字符串，失败返回 null。 */
function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

module.exports = { createStreamHandler };
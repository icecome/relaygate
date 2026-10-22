'use strict';
/**
 * transform/identity-scrub.js — 内容层渠道检测应对（opt-in）。
 *
 * 背景：2026-10-20 社区情报（linux.do/t/3051650 等）实锤 WorkBuddy 上游在
 * 请求头校验之外开始查**内容**：请求头完全合规的请求，system prompt 携带
 * Codex / Claude Code 等第三方 harness 的身份声明时仍被 11128 拒绝；官方
 * 系客户端（Hermes/OpenCode/Pi）的声明放行。检测目标不是通用文本，而是
 * 「这个请求来自哪个工具」的身份指纹。
 *
 * 定位：头族身份（auth.js#chatHeaders）解决「形状关」，本模块解决「内容关」，
 * 二者叠加。改写仅命中身份声明语句（句级，带保留原文的注释），不碰其余内容；
 * 默认关闭，WB_IDENTITY_SCRUB=false 显式关、true 显式开。涉及改变模型所见
 * 内容，与 RTK 同级处理：有总闸、有日志、有逐次观测字段。
 *
 * 不做的事：不隐藏「网关转发」这一事实本身（上游还能从 TLS/JA3、行为节奏
 * 识别）；不做翻译/摘要级改写；对非 system 消息一律不动（误伤面收敛到最小）。
 */

/** 句子切分：中英文句号/问叹号/分号/换行，保留分隔符。 */
const SENTENCE_SPLIT = /(?<=[。！？；;.!?\n])/;

/**
 * 身份声明指纹：匹配「我是/这是 XX 客户端/工具/代理」类语句的正则组。
 * 每组 = 平台别名 + 可选的 harness/agent/CLI/版本语境词。
 * 设计取向：宁可漏（改不动就原样放行）不可滥（改掉正常句子）——漏掉的
 * 后果是这一次请求可能被拦，滥改的后果是静默污染所有对话内容。
 */
const IDENTITY_PATTERNS = [
  // Codex：OpenAI Codex CLI / Codex agent…
  /\b(?:i am|this is|i'm)\s+(?:running (?:in|within|inside)\s+)?(?:openai\s+)?codex\b/i,
  /\bcodex\s+(?:cli|agent|code|powered|models?|engine)\b/i,
  /(?:你是|你是)?(?:openai\s+)?codex\s*(?:命令行|代码助手|智能体|代理|模型)/i,
  // 系统提示标准开头（Codex 官方 system prompt 的第一句就是「You are Codex…」）：
  /\byou(?:'re| are)\s+(?:openai\s+)?codex\b/i,
  // Claude Code：Anthropic Claude Code / claude-code…
  /\b(?:i am|this is|i'm)\s+(?:running (?:in|within|inside)\s+)?claude\s*code\b/i,
  /\bclaude\s*code\s+(?:cli|agent|powered|models?|engine|hook)\b/i,
  /\banthropic'?s? claude/i,
  /(?:你是)?claude\s*code\s*(?:命令行|代码助手|智能体|代理|模型)/i,
  // 「You are Claude Code, Anthropic's official CLI for Claude」标准开头：
  /\byou(?:'re| are)\s+claude\s*code\b/i,
  // Gemini CLI / Gemini Agent
  /\bgemini\s+(?:cli|agent|code)\b/i,
  /\byou(?:'re| are)\s+gemini\s+(?:cli|agent|code)\b/i,
  // 通用 harness 自述：DeepSeek Harness / DSH
  /\bdeepseek\s+harness\b/i,
  /\bdsh\b(?=\s+(?:harness|agent|gateway|proxy))/i,
  // 泛化自述：「作为一个 AI 编码代理/命令行工具运行」——只匹配自述句式，
  // 不匹配普通提及（如「用 claude code 打开这个项目」是用户指令，不能动）。
  /\b(?:i am|this is|i'm)\s+(?:an?\s+)?(?:ai[- ](?:coding\s+)?(?:agent|assistant)|agentic\s+(?:coding\s+)?(?:tool|cli))\b/i,
  /\byou(?:'re| are)\s+(?:an?\s+)?(?:ai[- ](?:coding\s+)?(?:agent|assistant)|agentic\s+(?:coding\s+)?(?:tool|cli))\b/i,
];

/**
 * 改写为中性等义句（平台别名 → 「编码助手」），保留语义信息量：
 * 模型不需要知道「我是 Codex」也能干活，但删掉整句可能丢上下文
 * （比如「你是 Codex CLI，请使用 apply_patch 工具」里的工具指引）。
 */
const REWRITE_MAP = [
  // 系统提示标准开头整句改写（必须先于单词级替换跑，否则 "You are Claude Code"
  // 中的 Claude 先被替成 coding assistant，整句锚定就失效了）。
  // i 标志替换后句首大写会丢，followUp 修正（仅当改写结果位于句首时）。
  {
    re: /\byou(?:'re| are)\s+(?:openai\s+)?codex\b/gi,
    to: "You are a coding assistant",
    keepCase: true,
  },
  {
    re: /\byou(?:'re| are)\s+claude\s*code\b/gi,
    to: 'You are a coding assistant',
    keepCase: true,
  },
  {
    re: /\byou(?:'re| are)\s+gemini\s+(?:cli|agent|code)\b/gi,
    to: 'You are a coding assistant',
    keepCase: true,
  },
  // "Anthropic's official CLI for Claude" 这类同位语尾巴：整段属身份声明，
  // 一起拿掉（单删 Anthropic 会留下 "official CLI for Claude" 这种半截句）。
  { re: /\b(?:openai'?s?|anthropic'?s?)\s+official\s+(?:cli|agent|tool)\s+for\s+(?:codex|claude|gemini)\b/gi, to: '', keepCase: false },
  { re: /\bopenai\s+codex\b/gi, to: 'coding assistant', keepCase: false },
  { re: /\bcodex\b/g, to: 'coding assistant', keepCase: false },
  { re: /\bclaude\s*code\b/gi, to: 'coding assistant', keepCase: false },
  { re: /\bclaude\b/g, to: 'coding assistant', keepCase: false },
  { re: /\bgemini\s+cli\b/gi, to: 'coding assistant', keepCase: false },
  { re: /\bgemini\b/g, to: 'coding assistant', keepCase: false },
  { re: /\bdeepseek\s+harness\b/gi, to: 'coding assistant', keepCase: false },
  { re: /\bdsh\b/g, to: 'coding assistant', keepCase: false },
  { re: /\banthropic'?s?\b/gi, to: '', keepCase: false },
  { re: /\bopenai\b/gi, to: '', keepCase: false },
];

/** 已官方放行的客户端身份（不要动）：出现即整条消息跳过改写。 */
const OFFICIAL_HINTS = [
  /\bhermes\b/i, /\bopencode\b/i, /\bpi\b/i,
  /\bworkbuddy\b/i, /\bcodebuddy\b/i,
];

/** 单句是否命中身份声明。 */
function sentenceHitsIdentity(sentence) {
  return IDENTITY_PATTERNS.some((re) => re.test(sentence));
}

/**
 * 消息是否为「官方客户端身份自述」——是则跳过整条消息
 * （官方身份放行，改写反而画蛇添足）。
 */
function looksOfficialIdentity(text) {
  return OFFICIAL_HINTS.some((re) => re.test(text));
}

/** 对单句应用改写映射。keepCase=true 的规则只在句首大写被吞时用于恢复大写。 */
function rewriteSentence(sentence) {
  let out = sentence;
  for (const { re, to } of REWRITE_MAP) {
    out = out.replace(re, to);
  }
  // 句首大写恢复：小写开头且原句是大写开头（改写把首词换成了小写形态）
  if (/^[a-z]/.test(out) && /^[A-Z]/.test(sentence)) {
    out = out[0].toUpperCase() + out.slice(1);
  }
  return out
    .replace(/\s{2,}/g, ' ')
    // 删除同位语（"Anthropic's official CLI for Claude"）后留下的空标点：
    // ", ." → "."、",," → ","
    .replace(/,\s*,/g, ',')
    .replace(/,\s*([。．.!？?；;])/g, '$1')
    .replace(/\s+([。,.;；！！？?])/g, '$1')
    .trim();
}

/**
 * 中和一段文本中的身份声明语句。返回 {text, changed, hits}。
 * 只处理命中 IDENTITY_PATTERNS 的句子，其余句子逐字保留。
 */
function scrubText(text) {
  const src = String(text || '');
  if (!src) return { text: src, changed: false, hits: 0 };
  const parts = src.split(SENTENCE_SPLIT);
  let hits = 0;
  const out = parts.map((p) => {
    if (!sentenceHitsIdentity(p)) return p;
    hits += 1;
    return rewriteSentence(p);
  }).join('');
  return { text: out, changed: out !== src, hits };
}

/**
 * 中和 messages 数组里 system 消息的身份声明。
 * 只处理 role === 'system'（字符串 content）；其余消息原样返回同一引用，
 * 保证未命中时零拷贝、零行为差异。
 *
 * @param {Array} messages OpenAI 格式 messages
 * @returns {{messages: Array, changed: boolean, hits: number}}
 */
function scrubMessages(messages) {
  if (!Array.isArray(messages)) return { messages, changed: false, hits: 0 };
  let hits = 0;
  let changed = false;
  const out = messages.map((m) => {
    if (!m || m.role !== 'system') return m;
    if (typeof m.content !== 'string' || !m.content) return m;
    if (looksOfficialIdentity(m.content)) return m;
    const r = scrubText(m.content);
    if (r.changed) {
      hits += r.hits;
      changed = true;
      return { ...m, content: r.text };
    }
    return m;
  });
  return { messages: out, changed, hits };
}

/**
 * 从 config 读开关（延迟读取：测试里会 reload config）。
 * WB_IDENTITY_SCRUB：'true'/'1' 开，'false'/'0' 关，默认关。
 */
function scrubEnabled() {
  const v = String(process.env.WB_IDENTITY_SCRUB || '').trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  return false; // 默认关闭：默认改模型所见内容不可接受
}

module.exports = {
  scrubMessages,
  scrubText,
  sentenceHitsIdentity,
  looksOfficialIdentity,
  scrubEnabled,
  IDENTITY_PATTERNS,
  REWRITE_MAP,
};

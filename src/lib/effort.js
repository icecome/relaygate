'use strict';
/**
 * lib/effort.js —— 把客户端**显式提出**的思考强度翻译成 `max_tokens` 预算。
 *
 * ## 为什么只能这样实现
 *
 * 上游对 `reasoning_effort` / `thinking.budget_tokens` / `enable_thinking` /
 * `thinking_budget` 四种拼写**全部接受后忽略**（参照项目在同类车道上逐档三次采样实测：
 * `low` 档产出的思考 token 反而多于 `xhigh`；未知字段还偶发 503）。
 * **唯一真正生效的控制是 `max_tokens`**（实测 64 token 上限把思考从 ~397 压到 ~63）。
 *
 * 本仓库此前**完全没读**这些字段（`grep reasoning_effort|thinking|budget_tokens` 在
 * `src/` 下零命中），即客户端明确表达的「少想一点」被静默丢弃。本模块把它翻译成
 * 唯一能生效的参数。
 *
 * ## 为什么**不**加服务端默认档
 *
 * 参照项目有 light/balanced/deep 三档并默认 balanced，但那是在它的免费车道上调出来的。
 * 本项目实测的输出只占 token 总量的 **0.3%**（输出 690 万 / 输入 24.5 亿），
 * 压输出的收益几近于零；而给客户端没要求的请求加一个默认上限，只会带来
 * 「长回答被截断」的风险。所以本模块**只在客户端明确表达意图时出手**，
 * 客户端不提就一个字节都不改——默认零行为变化。
 *
 * ## 与 Anthropic 语义的对齐
 *
 * Anthropic 要求 `max_tokens > thinking.budget_tokens`：预算是「想多久」，
 * `max_tokens` 是「想 + 答」的总量。上游既然不看预算，就把它折算成总量：
 * `预算 + ANSWER_RESERVE`，再由候选的 `maxOutputTokens` 钳制。
 */

/** 思考之外留给正文的余量：预算只约束思考，正文还得写得下。 */
const ANSWER_RESERVE = 2048;

/**
 * OpenAI 风格 `reasoning_effort` → 输出总预算。
 *
 * 数值取本项目的实测档位（`docs/06-deliverables/analysis/model-parameters-report-2026-10-06.md`：
 * Trae dev 档 max_tokens 32000、max 档 64000），而不是照抄参照项目的 2048/8192
 * （那是它免费车道的调参）。
 *
 * 注意语义上的固有折衷：上游把思考与正文算在同一个输出预算里，所以「少想」
 * 只能通过压总预算实现，这会连带压短正文。因此只认**明确表达「尽量别想」**的档位，
 * `high`/`xhigh` 与未提供一律不设上限（交回上游与候选自身的能力）。
 */
const EFFORT_BUDGET = {
  none: 1024,
  minimal: 2048,
  low: 8192,
  medium: 16384,
  high: 32000,
  xhigh: 32000,
};

/** 档位名归一化：大小写、空白、`x-high` / `extra_high` 之类写法都收。 */
function normalizeEffort(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!s) return null;
  if (s === 'xhigh' || s === 'extrahigh' || s === 'veryhigh') return 'xhigh';
  return Object.prototype.hasOwnProperty.call(EFFORT_BUDGET, s) ? s : null;
}

/**
 * 解析 Anthropic 的 `thinking` 形态：`{type:'enabled', budget_tokens:N}`。
 * `{type:'disabled'}` 表示明确不要思考 → 给一个很小的预算。
 * @returns {{level:string, budget:number}|null}
 */
function parseThinking(thinking) {
  if (!thinking || typeof thinking !== 'object') return null;
  const type = String(thinking.type || '').trim().toLowerCase();
  if (type === 'disabled') return { level: 'none', budget: EFFORT_BUDGET.none };
  const n = Number(thinking.budget_tokens ?? thinking.budgetTokens);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { level: 'budget', budget: Math.floor(n) };
}

/**
 * 求本次请求实际下发的 `max_tokens`。
 *
 * 规则（顺序即优先级）：
 *   1. 客户端**显式传了** `max_tokens` → 原样尊重，本模块不做任何事。
 *      这条很重要：B 的客户端多是 IDE，它们自己更清楚要多长的回答。
 *   2. 否则看客户端有没有表达思考强度（`reasoning_effort` 或 `thinking`）：
 *      有 → 用折算后的预算；没有 → 返回 undefined（不设上限，与改动前一致）。
 *   3. 结果按候选的 `maxOutputTokens` 钳制（候选能力是硬约束）。
 *
 * @param {{requested?:number, reasoningEffort?:string, thinking?:object,
 *          candidateMaxOutput?:number}} [input]
 * @returns {{maxTokens:number|undefined, level:string|null, reason:string}}
 *   level 为 null 表示「本模块没介入」（客户端已指定或未表达意图）。
 */
function resolveMaxTokens(input = {}) {
  const requested = Number(input.requested);
  if (Number.isFinite(requested) && requested > 0) {
    return { maxTokens: Math.floor(requested), level: null, reason: 'client_max_tokens' };
  }

  let level = normalizeEffort(input.reasoningEffort);
  let budget = level ? EFFORT_BUDGET[level] : null;
  let reason = level ? `reasoning_effort=${level}` : '';

  if (budget == null) {
    const th = parseThinking(input.thinking);
    if (th) {
      level = th.level;
      // 预算是「思考量」，总量还得容得下正文；disabled 不需要留正文余量之外的额外思考
      budget = th.level === 'none' ? th.budget : th.budget + ANSWER_RESERVE;
      reason = th.level === 'none' ? 'thinking=disabled' : `thinking.budget_tokens=${th.budget}`;
    }
  }

  if (budget == null) {
    return { maxTokens: undefined, level: null, reason: 'no_client_intent' };
  }

  const candMax = Number(input.candidateMaxOutput);
  const capped = Number.isFinite(candMax) && candMax > 0 ? Math.min(budget, candMax) : budget;
  return { maxTokens: Math.floor(capped), level, reason };
}

module.exports = { resolveMaxTokens, normalizeEffort, parseThinking, EFFORT_BUDGET, ANSWER_RESERVE };

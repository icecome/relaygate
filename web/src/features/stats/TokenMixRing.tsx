/**
 * Token 构成环形图：把「Token 总量 566.7M」拆成输入 / 缓存读 / 输出三段。
 *
 * ## 数据源与口径（不要混用）
 *
 * 取 `GET /v1/admin/stats/models` 的 `ModelStat[]`（`shared/api/stats.ts:84-99`）：
 *   - `promptTokens`：**含**缓存读的输入总量（后端 `log/stats.js:297` 直接累加
 *     原始 promptTokens，没有扣缓存）；
 *   - `cacheReadTokens`：其中被命中的部分，是 promptTokens 的**子集**；
 *   - `completionTokens`：输出。
 *
 * 因此三段必须这样切，否则会重复计入缓存：
 *
 *     非缓存输入 = promptTokens − cacheReadTokens
 *     缓存读     = cacheReadTokens
 *     输出       = completionTokens
 *
 * 直接把 `promptTokens` 与 `cacheReadTokens` 并列画进环形图，总分会虚高
 * 一个缓存命中量——本项目实测缓存占比 83%，那不是小数误差，是两倍。
 *
 * ## 为什么不从 `DailyStat` 取
 *
 * `DailyStat.byModel` 只有 requests / tokens / metered / unmetered / estimatedCost
 * （`log/stats.js` 的 daily 映射），**没有输入输出拆分**。`DailyStat` 顶层也没有。
 * 想按日拆输入输出，只能改后端；本组件刻意不去改契约，改为从同窗口的
 * models 聚合里取 —— 两者 days 参数一致，窗口相同。
 *
 * ## 「无计量」必须单独说
 *
 * `unmetered` 是「发了请求但上游没回传 usage」的行数。它们不进环形图（没有
 * token 可放），但必须显示出来：否则用户会以为「总量」覆盖了全部请求。
 */
import { useState } from 'react';
import type { ModelStat } from '../../shared/api/stats';
import { formatCompact, formatNumber } from '../../shared/lib/format';

/** 三段色。缓存读用中间明度，与输入/输出都能拉开。 */
const SEGMENTS = [
  { key: 'input', label: '非缓存输入', color: 'var(--rg-brand-600)' },
  { key: 'cache', label: '缓存读', color: 'var(--rg-brand-300)' },
  { key: 'output', label: '输出', color: 'var(--rg-grey-500)' },
] as const;

type SegKey = (typeof SEGMENTS)[number]['key'];

export function TokenMixRing({ rows }: { rows: ModelStat[] }) {
  const [active, setActive] = useState<SegKey | null>(null);

  // 单次遍历同时算出三段与「无计量」计数，避免四遍 filter
  let prompt = 0;
  let cache = 0;
  let completion = 0;
  let unmetered = 0;
  let requests = 0;
  for (const r of rows) {
    prompt += r.promptTokens || 0;
    cache += r.cacheReadTokens || 0;
    completion += r.completionTokens || 0;
    unmetered += r.unmetered || 0;
    requests += r.requests || 0;
  }
  // 缓存读是 prompt 的子集，可能因历史行缺字段而大于 prompt（脱敏缺陷）。
  // 夹一下，避免出现负的「非缓存输入」把图算崩。
  const cached = Math.min(cache, prompt);
  const values: Record<SegKey, number> = {
    input: Math.max(0, prompt - cached),
    cache: cached,
    output: completion,
  };
  const total = values.input + values.cache + values.output;

  if (total <= 0) {
    return (
      <div
        className="text-aux leading-relaxed py-6 text-center"
        style={{ color: 'var(--rg-text-tertiary)' }}
      >
        所选区间内没有可拆分的 Token 数据。
        {requests > 0 && `（${formatNumber(requests)} 次请求中有 ${formatNumber(unmetered)} 次上游未回传 usage）`}
      </div>
    );
  }

  const R = 52;
  const CIRC = 2 * Math.PI * R;
  let offset = 0;
  const arcs = SEGMENTS.map((s) => {
    const frac = values[s.key] / total;
    const arc = { ...s, frac, offset };
    offset += frac * CIRC;
    // 段间留 3px 间隙：不画间隙时相邻两段（同为品牌色阶）分不清边界
    return arc;
  });

  const picked = active ? { ...SEGMENTS.find((s) => s.key === active)!, value: values[active] } : null;

  return (
    <div className="flex items-center gap-5 flex-wrap">
      <div className="relative shrink-0" style={{ width: 136, height: 136 }}>
        <svg viewBox="0 0 136 136" width={136} height={136} aria-hidden="true">
          <circle cx="68" cy="68" r={R} fill="none" stroke="var(--rg-border)" strokeWidth="11" />
          {arcs.map((a) => (
            <circle
              key={a.key}
              cx="68"
              cy="68"
              r={R}
              fill="none"
              stroke={a.color}
              strokeWidth={active === a.key ? 14 : 11}
              strokeDasharray={`${Math.max(0.5, a.frac * CIRC - 3)} ${CIRC}`}
              strokeDashoffset={-a.offset}
              transform="rotate(-90 68 68)"
              style={{ transition: 'stroke-width 120ms' }}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="font-mono text-[19px] font-semibold tabular-nums leading-none">
            {formatCompact(picked?.value ?? total)}
          </span>
          <span className="text-unit mt-1">{picked?.label ?? 'Token 合计'}</span>
        </div>
      </div>

      <div className="flex flex-col gap-1 min-w-0 flex-1">
        {SEGMENTS.map((s) => {
          const v = values[s.key];
          const pct = (v / total) * 100;
          return (
            <button
              key={s.key}
              type="button"
              className="flex items-center gap-2 w-full text-left rounded-sm px-1 py-0.5"
              style={{
                background: active === s.key ? 'var(--rg-bg-secondary)' : 'transparent',
              }}
              onMouseEnter={() => setActive(s.key)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(s.key)}
              onBlur={() => setActive(null)}
              aria-label={`${s.label}：${formatNumber(v)} Token，占 ${pct.toFixed(1)}%`}
            >
              <i
                className="inline-block w-2 h-2 rounded-xs shrink-0"
                style={{ background: s.color }}
                aria-hidden="true"
              />
              <span className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
                {s.label}
              </span>
              <span className="ml-auto font-mono text-aux tabular-nums font-medium">
                {pct.toFixed(1)}%
              </span>
              <span
                className="font-mono text-aux tabular-nums w-[64px] text-right"
                style={{ color: 'var(--rg-text-tertiary)' }}
              >
                {formatCompact(v)}
              </span>
            </button>
          );
        })}
        <div className="mt-1 text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
          合计 {formatCompact(total)} Token
          {unmetered > 0 && ` · ${formatNumber(unmetered)} 次请求未回传 usage，未计入`}
        </div>
      </div>
    </div>
  );
}

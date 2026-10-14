/**
 * 每日趋势图。纯 SVG 绘制，不依赖第三方图表库。
 * 序列色仅取设计系统的图表色，不使用彩虹配色。
 *
 * 双 Y 轴：左轴请求量、右轴 Token，各自独立归一化。两者量级差几个数量级，
 * 共用一个轴时 Token 曲线只能看出形状、读不出数值。刻度文字用与图例一致的
 * 序列色着色，读者据此判断某一列数字属于哪一侧。
 */
import { useId, useMemo, useState } from 'react';
import { Segmented, type SegOption } from '../../shared/ui';
import type { DailyStat } from '../../shared/api/stats';

interface Props {
  rows: DailyStat[];
}

const PAD = { top: 12, right: 44, bottom: 26, left: 44 };
const HEIGHT = 200;
/** 纵轴刻度分档；两侧轴共用同一组横向网格线，故只取一套比例。 */
const TICKS = [0, 1 / 3, 2 / 3, 1];

type ViewMode = 'total' | 'model';

const VIEW_OPTIONS: readonly SegOption<ViewMode>[] = [
  { value: 'total', label: '总计' },
  { value: 'model', label: '单模型' },
];

/** 刻度缩写：六位数会把绘图区挤掉，长数字统一降为 k / m。 */
function axisLabel(v: number): string {
  const short = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  if (v >= 1_000_000) return `${short(v / 1_000_000)}m`;
  if (v >= 1000) return `${short(v / 1000)}k`;
  // 峰值只有个位数时整数刻度会全退化成 0，保留一位小数
  if (v > 0 && v < 10) return v.toFixed(1);
  return String(Math.round(v));
}

export function DailyTrendChart({ rows }: Props) {
  const gradientId = useId();
  const [mode, setMode] = useState<ViewMode>('total');
  const [picked, setPicked] = useState('');

  // 可选模型 = 各日 byModel 键的并集。老后端不返回 byModel 时为空，此时不提供单模型视图。
  const models = useMemo(() => {
    const all = new Set<string>();
    for (const r of rows) for (const m of Object.keys(r.byModel ?? {})) all.add(m);
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  if (rows.length === 0) return null;

  // 切换时间范围后原选中的模型可能已不在窗口内，回退到第一个，避免空曲线
  const model = models.includes(picked) ? picked : (models[0] ?? '');
  const single = mode === 'model' && model !== '';

  const width = 760;
  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;

  // 轴量级必须按当前视图重算：拿总计的峰值为单模型定标，曲线会被压成一条贴底的线
  const reqOf = (r: DailyStat) => (single ? (r.byModel?.[model]?.requests ?? 0) : r.requests);
  const tokOf = (r: DailyStat) => (single ? (r.byModel?.[model]?.tokens ?? 0) : r.tokens);
  const maxReq = Math.max(1, ...rows.map(reqOf));
  const maxTokens = Math.max(1, ...rows.map(tokOf));
  const maxErr = Math.max(1, ...rows.map((r) => r.errors));

  const x = (i: number) =>
    PAD.left + (rows.length === 1 ? innerW / 2 : (i / (rows.length - 1)) * innerW);
  const yReq = (v: number) => PAD.top + innerH - (v / maxReq) * innerH;
  const yTokens = (v: number) => PAD.top + innerH - (v / maxTokens) * innerH;

  // 某模型该日无请求时补 0，而不是跳过点——跳过会把两侧日期连成一条不存在的斜线
  const reqPath = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i)} ${yReq(reqOf(r))}`).join(' ');
  const tokensPath = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i)} ${yTokens(tokOf(r))}`).join(' ');
  const areaPath = `${reqPath} L${x(rows.length - 1)} ${PAD.top + innerH} L${x(0)} ${PAD.top + innerH} Z`;

  // 横轴标签抽稀，避免日期重叠；末位标签与它前一个太近时只留末位，否则两个日期会叠在一起
  const labelStep = Math.max(1, Math.ceil(rows.length / 8));
  const lastIdx = rows.length - 1;
  const showDate = (i: number) =>
    i === lastIdx || (i % labelStep === 0 && lastIdx - i >= Math.ceil(labelStep / 2));

  return (
    <div>
      {models.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <Segmented ariaLabel="趋势视图" value={mode} onChange={setMode} options={VIEW_OPTIONS} />
          {mode === 'model' && (
            // 模型可能上百个，用原生下拉而不是分段控件
            <select
              aria-label="选择模型"
              value={model}
              onChange={(e) => setPicked(e.target.value)}
              className="text-[12px] leading-5 rounded-md border px-2 py-1 max-w-[280px]"
              style={{
                borderColor: 'var(--rg-border)',
                background: 'var(--rg-bg-base)',
                color: 'var(--rg-text-primary)',
              }}
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        className="chart"
        role="img"
        aria-label={`每日趋势，共 ${rows.length} 天，${single ? `单模型 ${model}` : '全部模型合计'}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--rg-brand-600)" stopOpacity="0.14" />
            <stop offset="100%" stopColor="var(--rg-brand-600)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* 横向网格 + 左右两套刻度：颜色与图例序列一一对应 */}
        {TICKS.map((f) => {
          const y = PAD.top + innerH - f * innerH;
          return (
            <g key={f}>
              <line
                x1={PAD.left}
                y1={y}
                x2={width - PAD.right}
                y2={y}
                stroke="var(--rg-border)"
                strokeWidth="1"
              />
              <text
                x={PAD.left - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill="var(--rg-chart-1)"
                fontFamily="var(--rg-font-mono, monospace)"
              >
                {axisLabel(maxReq * f)}
              </text>
              <text
                x={width - PAD.right + 6}
                y={y + 3}
                textAnchor="start"
                fontSize="10"
                fill="var(--rg-chart-3)"
                fontFamily="var(--rg-font-mono, monospace)"
              >
                {axisLabel(maxTokens * f)}
              </text>
            </g>
          );
        })}

        {/* 请求量面积 + 折线 */}
        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path d={reqPath} fill="none" stroke="var(--rg-chart-1)" strokeWidth="1.75" />

        {/* Token 折线（次序列，虚线区分） */}
        <path
          d={tokensPath}
          fill="none"
          stroke="var(--rg-chart-3)"
          strokeWidth="1.5"
          strokeDasharray="3 3"
        />

        {/* 横轴基线 */}
        <line
          x1={PAD.left}
          y1={PAD.top + innerH}
          x2={width - PAD.right}
          y2={PAD.top + innerH}
          stroke="var(--rg-border-stronger)"
          strokeWidth="1"
        />

        {rows.map((r, i) =>
          showDate(i) ? (
            <text
              key={r.date}
              x={x(i)}
              y={HEIGHT - 8}
              textAnchor="middle"
              fontSize="10"
              fill="var(--rg-text-tertiary)"
              fontFamily="var(--rg-font-mono, monospace)"
            >
              {r.date.slice(5)}
            </text>
          ) : null,
        )}

        {/* 错误数以柱形叠加，仅在有错误时显示。
            后端 byModel 不含 errors，故单模型视图下柱子仍是当日全部模型的错误数。 */}
        {rows.some((r) => r.errors > 0) &&
          rows.map((r, i) => {
            const h = (r.errors / maxErr) * (innerH * 0.35);
            return (
              <rect
                key={`err-${r.date}`}
                x={x(i) - 1.5}
                y={PAD.top + innerH - h}
                width="3"
                height={h}
                fill="var(--rg-state-error)"
                opacity="0.5"
              >
                <title>{`${r.date} · 错误 ${r.errors}`}</title>
              </rect>
            );
          })}
      </svg>

      <div className="legend">
        <span>
          <i style={{ background: 'var(--rg-chart-1)' }} />
          请求量{single ? `（${model}）` : ''}
        </span>
        <span>
          <i style={{ background: 'var(--rg-chart-3)' }} />
          Token{single ? `（${model}）` : ''}
        </span>
        <span>
          <i style={{ background: 'var(--rg-state-error)' }} />
          错误数{single ? '（全部模型）' : ''}
        </span>
      </div>
    </div>
  );
}

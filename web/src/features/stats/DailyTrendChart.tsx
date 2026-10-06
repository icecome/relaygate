/**
 * 每日趋势图。纯 SVG 绘制，无第三方图表库。
 * 序列色仅取设计系统图表色，不引入彩虹配色。
 */
import { useId } from 'react';
import type { DailyStat } from '../../shared/api/stats';

interface Props {
  rows: DailyStat[];
}

const PAD = { top: 12, right: 12, bottom: 26, left: 44 };
const HEIGHT = 200;

export function DailyTrendChart({ rows }: Props) {
  const gradientId = useId();
  if (rows.length === 0) return null;

  const width = 760;
  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;

  const maxReq = Math.max(1, ...rows.map((r) => r.requests));
  const maxTokens = Math.max(1, ...rows.map((r) => r.tokens));

  const x = (i: number) =>
    PAD.left + (rows.length === 1 ? innerW / 2 : (i / (rows.length - 1)) * innerW);
  const yReq = (v: number) => PAD.top + innerH - (v / maxReq) * innerH;
  const yTokens = (v: number) => PAD.top + innerH - (v / maxTokens) * innerH;

  const reqPath = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i)} ${yReq(r.requests)}`).join(' ');
  const tokensPath = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i)} ${yTokens(r.tokens)}`).join(' ');
  const areaPath = `${reqPath} L${x(rows.length - 1)} ${PAD.top + innerH} L${x(0)} ${PAD.top + innerH} Z`;

  // 横轴标签抽稀，避免日期重叠
  const labelStep = Math.max(1, Math.ceil(rows.length / 8));
  const yTicks = [0, 0.5, 1].map((f) => ({
    v: Math.round(maxReq * f),
    y: yReq(maxReq * f),
  }));

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        className="chart"
        role="img"
        aria-label={`每日趋势，共 ${rows.length} 天`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--rg-brand-600)" stopOpacity="0.14" />
            <stop offset="100%" stopColor="var(--rg-brand-600)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* 横向网格与刻度 */}
        {yTicks.map((t) => (
          <g key={t.y}>
            <line
              x1={PAD.left}
              y1={t.y}
              x2={width - PAD.right}
              y2={t.y}
              stroke="var(--rg-border)"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 6}
              y={t.y + 3}
              textAnchor="end"
              fontSize="10"
              fill="var(--rg-text-tertiary)"
              fontFamily="var(--rg-font-mono, monospace)"
            >
              {t.v}
            </text>
          </g>
        ))}

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
          i % labelStep === 0 || i === rows.length - 1 ? (
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

        {/* 错误数以柱形叠加，仅在有错误时显示 */}
        {rows.some((r) => r.errors > 0) &&
          rows.map((r, i) => {
            const maxErr = Math.max(1, ...rows.map((x2) => x2.errors));
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
              />
            );
          })}
      </svg>

      <div className="legend">
        <span>
          <i style={{ background: 'var(--rg-chart-1)' }} />
          请求量
        </span>
        <span>
          <i style={{ background: 'var(--rg-chart-3)' }} />
          Token
        </span>
        <span>
          <i style={{ background: 'var(--rg-state-error)' }} />
          错误数
        </span>
      </div>
    </div>
  );
}
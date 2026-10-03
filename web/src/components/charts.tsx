import { fmtTokens, fmtInt } from '../lib/format';

/**
 * 柱状图：柱高为当日已计量 token；无数据的日子画灰柱并在轴线下标空心圈，
 * 表示「该日请求全部未计量」，与「消耗为 0」区分开。
 * viewBox 等比缩放，不设 preserveAspectRatio 以免横向拉伸变形。
 */
export function BarChart({
  series,
  aria = '柱状图',
  color = '#047857',
  showUnmeteredMark = false,
}: {
  series: { label: string; value: number; metered?: number }[];
  aria?: string;
  color?: string;
  showUnmeteredMark?: boolean;
}) {
  if (!series.length) return null;

  const w = 1000, h = 200, padL = 58, padR = 14, padT = 10, padB = 26;
  const iw = w - padL - padR, ih = h - padT - padB;
  const max = Math.max(...series.map((s) => s.value), 1);
  const bw = iw / series.length;
  const ticks = 4;

  const grid: JSX.Element[] = [];
  for (let i = 0; i <= ticks; i++) {
    const y = padT + (ih / ticks) * i;
    const v = max - (max / ticks) * i;
    grid.push(
      <g key={`g${i}`}>
        <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="#E5E7EB" strokeWidth={1} />
        <text x={padL - 10} y={y + 3.5} textAnchor="end" fontSize={11} fill="#667085">
          {fmtTokens(v)}
        </text>
      </g>,
    );
  }

  const bars = series.map((s, i) => {
    const x = padL + i * bw + bw * 0.22;
    const bwid = bw * 0.56;
    const bh = (s.value / max) * ih;
    const y = padT + ih - bh;
    const fill = s.value > 0 ? color : '#D1D5DB';
    const rows: JSX.Element[] = [
      <rect key={`b${i}`} x={x} y={y} width={bwid} height={Math.max(bh, s.value > 0 ? 2 : 1)} rx={2.5} fill={fill} />,
      <text key={`t${i}`} x={x + bwid / 2} y={h - 9} textAnchor="middle" fontSize={11} fill="#667085">
        {s.label.slice(5)}
      </text>,
    ];
    if (showUnmeteredMark && !s.metered) {
      rows.push(
        <circle key={`c${i}`} cx={x + bwid / 2} cy={padT + ih - 5} r={2.6} fill="none" stroke="#667085" strokeWidth={1.4} />,
      );
    }
    return <g key={i}>{rows}</g>;
  });

  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={aria}>
      {grid}
      {bars}
    </svg>
  );
}

/**
 * 折线图：请求量（实线，左轴）与已计量占比（虚线，右轴）叠加。
 * 虚线贴底即表示该日请求基本不带 token 数据。
 */
export function CoverageChart({ series }: { series: { date: string; requests: number; metered: number }[] }) {
  if (series.length < 2) return null;

  const w = 1000, h = 220, padL = 58, padR = 58, padT = 10, padB = 26;
  const iw = w - padL - padR, ih = h - padT - padB;
  const ord = [...series].reverse();
  const maxReq = Math.max(...ord.map((d) => d.requests), 1);
  const step = ord.length > 1 ? iw / (ord.length - 1) : iw;

  const grid: JSX.Element[] = [];
  for (let i = 0; i <= 4; i++) {
    const y = padT + (ih / 4) * i;
    const v = maxReq - (maxReq / 4) * i;
    grid.push(
      <g key={`g${i}`}>
        <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="#E5E7EB" />
        <text x={padL - 10} y={y + 3.5} textAnchor="end" fontSize={11} fill="#667085">
          {fmtInt(Math.round(v))}
        </text>
        <text x={w - padR + 10} y={y + 3.5} fontSize={11} fill="#667085">
          {Math.round(100 - 25 * i)}%
        </text>
      </g>,
    );
  }

  const px = (i: number) => padL + step * i;
  const pyReq = (d: { requests: number }) => padT + ih - (d.requests / maxReq) * ih;
  const pyCov = (d: { requests: number; metered: number }) =>
    padT + ih - (d.requests ? d.metered / d.requests : 0) * ih;

  const linePath = ord.map((d, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${pyReq(d).toFixed(1)}`).join(' ');
  const areaPath =
    linePath +
    ` L${px(ord.length - 1).toFixed(1)},${(padT + ih).toFixed(1)} L${padL},${(padT + ih).toFixed(1)} Z`;
  const covPath = ord.map((d, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${pyCov(d).toFixed(1)}`).join(' ');

  const dots = ord.map((d, i) => {
    const cov = d.requests ? d.metered / d.requests : 0;
    return (
      <g key={i}>
        <circle cx={px(i)} cy={pyReq(d)} r={3} fill="#047857" />
        <circle cx={px(i)} cy={pyCov(d)} r={2.6} fill={cov > 0 ? '#B45309' : '#B91C1C'} />
        {i % 2 === 0 && (
          <text x={px(i)} y={h - 9} textAnchor="middle" fontSize={11} fill="#667085">
            {d.date.slice(5)}
          </text>
        )}
      </g>
    );
  });

  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="请求量与已计量占比趋势">
      {grid}
      <path d={areaPath} fill="#047857" opacity={0.07} />
      <path d={linePath} fill="none" stroke="#047857" strokeWidth={2} strokeLinejoin="round" />
      <path d={covPath} fill="none" stroke="#B45309" strokeWidth={2} strokeDasharray="5 4" />
      {dots}
    </svg>
  );
}

/** 覆盖率条：区分「已计量 / 未计量」的直观表达 */
export function CoverageBar({ metered, total, width = 120 }: { metered: number; total: number; width?: number }) {
  const pct = total ? (metered / total) * 100 : 0;
  const cls = pct >= 90 ? '' : pct >= 50 ? 'bar-warn' : 'bar-danger';
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`bar ${cls}`} style={{ maxWidth: width, width: '100%' }}>
        <i style={{ width: `${pct.toFixed(1)}%` }} />
      </span>
      <span className="tnum text-[11.5px] text-ink-faint whitespace-nowrap">{pct.toFixed(1)}%</span>
    </span>
  );
}
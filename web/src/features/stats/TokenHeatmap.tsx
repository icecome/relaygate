/**
 * GitHub 风格日历热力图：最近 17 周（119 天）的每日 Token 消耗。
 *
 * 用固定像素尺寸，而不是 className="chart"：.chart 是 w-full + h-auto，
 * 会把 12px 的方格随容器宽度等比放大，格子被拉成长方形，就不再是热力图的方格。
 *
 * 必须区分「未计量」与「零消耗」：WorkBuddy 平台不回传 usage，那些天
 * requests > 0 而 tokens === 0、unmetered > 0。若画成最低档，会被读成
 * 「那天没消耗」，故这类格子用斜线纹理 + 虚线描边单独表示。
 */
import { useId } from 'react';
import type { DailyStat } from '../../shared/api/stats';
import { formatNumber } from '../../shared/lib/format';

const CELL = 12;
const GAP = 3;
const PITCH = CELL + GAP;
/** 17 列 = 17 周，7 行 = 周日到周六（GitHub 惯例，周日在该列第一行）。 */
const WEEKS = 17;
const ROWS = 7;
const GRID_X = 24;
const GRID_Y = 2;
const MONTH_LABEL_H = 16;
const WIDTH = GRID_X + WEEKS * PITCH - GAP;
const HEIGHT = GRID_Y + ROWS * PITCH - GAP + MONTH_LABEL_H;

/** 只标周一 / 周三 / 周五，七行全标会挤满左侧留白。 */
const ROW_LABELS: Record<number, string> = { 1: '一', 3: '三', 5: '五' };

/** 分档由深到浅：0=无消耗（占位灰），1 至 4 为品牌色阶。 */
const LEVEL_FILL = [
  'var(--rg-border)',
  'var(--rg-brand-100)',
  'var(--rg-brand-300)',
  'var(--rg-brand-500)',
  'var(--rg-brand-700)',
];

/** 阈值取自实测分布（0.66 / 0.4 / 0.16），相对窗口内峰值。 */
function levelOf(tokens: number, maxTokens: number): number {
  if (tokens <= 0 || maxTokens <= 0) return 0;
  const ratio = tokens / maxTokens;
  if (ratio >= 0.66) return 4;
  if (ratio >= 0.4) return 3;
  if (ratio >= 0.16) return 2;
  return 1;
}

/** 本地日期键。不能用 toISOString()：那按 UTC 切片，晚间会错到第二天。 */
function localKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface Cell {
  date: string;
  col: number;
  row: number;
  /** 本周尚未到来的日子：网格坐标保留，但不绘制 */
  future: boolean;
  stat?: DailyStat;
}

export function TokenHeatmap({ rows }: { rows: DailyStat[] }) {
  const hatchId = useId();
  // 后端按日期倒序返回；这里按日期查表，与入参顺序无关，无需先排序
  const byDate = new Map(rows.map((r) => [r.date, r]));

  const today = new Date();
  // 正午为基准，避免夏令时把加减天数后的日期推到前一天
  today.setHours(12, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - start.getDay() - (WEEKS - 1) * 7);

  const cells: Cell[] = [];
  const cursor = new Date(start);
  for (let i = 0; i < WEEKS * ROWS; i++) {
    const date = localKey(cursor);
    cells.push({
      date,
      col: Math.floor(i / ROWS),
      row: i % ROWS,
      future: cursor > today,
      stat: byDate.get(date),
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  const past = cells.filter((c) => !c.future);
  const maxTokens = Math.max(0, ...past.map((c) => c.stat?.tokens ?? 0));

  // 月份标签只出现在跨月的那一列（该列首日为周日）
  const monthLabels: { col: number; text: string }[] = [];
  for (let col = 0; col < WEEKS; col++) {
    const month = Number(cells[col * ROWS].date.slice(5, 7));
    const prev = col === 0 ? null : Number(cells[(col - 1) * ROWS].date.slice(5, 7));
    if (prev !== month) monthLabels.push({ col, text: `${month}月` });
  }

  const unmeteredHint = '虚线格＝有请求但上游未回传 usage，不代表零消耗';

  return (
    <div>
      <svg
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block"
        role="img"
        aria-label={`最近 ${WEEKS} 周每日 Token 热力图（按本地日期，${unmeteredHint}）`}
      >
        <defs>
          {/* 斜线纹理：无法用颜色表达「量级未知」时的占位语义 */}
          <pattern
            id={hatchId}
            width="4"
            height="4"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="4" height="4" fill="var(--rg-bg-base)" />
            <line x1="0" y1="0" x2="0" y2="4" stroke="var(--rg-brand-300)" strokeWidth="2" />
          </pattern>
        </defs>

        {Object.entries(ROW_LABELS).map(([row, text]) => (
          <text
            key={row}
            x={GRID_X - 6}
            y={GRID_Y + Number(row) * PITCH + CELL / 2 + 3.5}
            textAnchor="end"
            fontSize="10"
            fill="var(--rg-text-tertiary)"
          >
            {text}
          </text>
        ))}

        {cells.map((c) => {
          // 未来日期不绘制；不删占位是因为列/行坐标已按日历固定
          if (c.future) return null;
          const tokens = c.stat?.tokens ?? 0;
          const requests = c.stat?.requests ?? 0;
          const unmetered = requests > 0 && tokens === 0;
          return (
            <rect
              key={c.date}
              x={GRID_X + c.col * PITCH}
              y={GRID_Y + c.row * PITCH}
              width={CELL}
              height={CELL}
              rx="2"
              fill={unmetered ? `url(#${hatchId})` : LEVEL_FILL[levelOf(tokens, maxTokens)]}
              stroke={unmetered ? 'var(--rg-brand-500)' : undefined}
              strokeWidth={unmetered ? 1 : undefined}
              strokeDasharray={unmetered ? '2 1.5' : undefined}
            >
              <title>
                {`${c.date} · 请求 ${formatNumber(requests)} · Token ${formatNumber(tokens)}${
                  unmetered ? '（未计量）' : ''
                }`}
              </title>
            </rect>
          );
        })}

        {monthLabels.map((m) => (
          <text
            key={`${m.col}-${m.text}`}
            x={GRID_X + m.col * PITCH}
            y={HEIGHT - 4}
            fontSize="10"
            fill="var(--rg-text-tertiary)"
          >
            {m.text}
          </text>
        ))}
      </svg>

      <div className="legend">
        <span>Token 分档（相对窗口峰值）</span>
        <span>
          <i style={{ background: 'var(--rg-border)' }} />
          无消耗
        </span>
        <span className="flex items-center gap-1">
          少
          {LEVEL_FILL.slice(1).map((fill) => (
            <i key={fill} style={{ background: fill }} />
          ))}
          多
        </span>
        <span>
          <i
            style={{
              background:
                'repeating-linear-gradient(45deg, var(--rg-brand-300) 0 1.5px, var(--rg-bg-base) 1.5px 3px)',
              border: '1px dashed var(--rg-brand-500)',
            }}
          />
          未计量（有请求但上游未回传 usage）
        </span>
      </div>
    </div>
  );
}

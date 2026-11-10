/**
 * 额度占比条：把「46,347 积分」变成「谁占多少」。
 *
 * ## 为什么需要
 *
 * 总览页三张卡的卡面只有一个绝对值加一行灰字。用户看不到：这算多算少、
 * 哪个平台是大头、还有哪个平台压根没查过。而「按平台分行」的明细要点开
 * 卡片才出现——也就是说，**判断「要不要点开」所需的信息，恰好在点开之后**。
 *
 * ## 三条设计约束
 *
 * 1. **只画可相加的口径**。`creditShare` 已把 Token / 配额 / 分池积分排除。
 *    混进去会得到「WorkBuddy 占 99.9%」这种把量级差当比例的错误图。
 * 2. **未查询的平台必须单独说**。把 `known === 0` 的平台当 0 参与分母，
 *    会让有数据的平台占比虚高；用户据此判断「Trae 占 70%」而实际可能只有 30%。
 * 3. **总数为 0 时不画条**。宽度全 0 的条看起来像渲染失败，不如直接给一句话。
 */
import type { CreditShareRow } from '../../shared/lib/overview-detail';
import { formatCompact, formatNumber } from '../../shared/lib/format';

/**
 * 段色。刻意不用 `--rg-chart-*`：那套序列色相邻两项色相接近（brand-600 与
 * brand-300 同为蓝紫），堆叠后边界不可辨。这里按「深品牌 → 浅品牌 → 灰阶」
 * 交替，保证任意相邻两段都有明度差。
 */
const SEGMENT_COLORS = [
  'var(--rg-brand-600)',
  'var(--rg-brand-300)',
  'var(--rg-grey-500)',
  'var(--rg-brand-200)',
  'var(--rg-grey-300)',
];

export function ShareBar({
  parts,
  total,
  unknownPlatforms,
  unit = '积分',
}: {
  parts: CreditShareRow[];
  total: number;
  /** 有账号但一次都没查过余额的平台名；会单独提示，不参与分母 */
  unknownPlatforms: string[];
  unit?: string;
}) {
  if (!parts.length) {
    return (
      <div className="text-aux leading-relaxed" style={{ color: 'var(--rg-text-tertiary)' }}>
        还没有查过任何账号的余额。先点右上角「刷新」，或到凭据池逐个「查余额」。
      </div>
    );
  }

  return (
    <div>
      <div
        className="share-bar"
        role="img"
        aria-label={`${unit}构成：${parts.map((p) => `${p.label} ${(p.share * 100).toFixed(1)}%`).join('，')}`}
      >
        {parts.map((p, i) => (
          <i
            key={p.platform}
            style={{
              width: `${Math.max(p.share * 100, 0.5)}%`,
              background: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
            }}
            title={`${p.label}：${formatNumber(p.amount)} ${unit}（${(p.share * 100).toFixed(1)}%）`}
          />
        ))}
      </div>

      <div className="share-legend">
        {parts.map((p, i) => (
          <span key={p.platform}>
            <i style={{ background: SEGMENT_COLORS[i % SEGMENT_COLORS.length] }} aria-hidden="true" />
            {p.label}
            <b>{(p.share * 100).toFixed(1)}%</b>
            <span style={{ color: 'var(--rg-text-tertiary)' }}>{formatCompact(p.amount)}</span>
          </span>
        ))}
      </div>

      <div className="mt-1.5 text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
        合计 {formatNumber(total)} {unit}
        {unknownPlatforms.length > 0 && ` · ${unknownPlatforms.join(' / ')} 尚未查询，未计入占比`}
      </div>
    </div>
  );
}

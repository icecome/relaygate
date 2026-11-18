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
 * 1. **只画可相加的口径**。`creditShare` 已把 Token / Qoder 两段积分 / 日清积分排除。
 *    混进去会得到「WorkBuddy 占 99.9%」这种把量级差当比例的错误图。
 * 2. **未查询的平台必须单独说**。把 `known === 0` 的平台当 0 参与分母，
 *    会让有数据的平台占比虚高；用户据此判断「Trae 占 70%」而实际可能只有 30%。
 * 3. **总数为 0 时不画条**。宽度全 0 的条看起来像渲染失败，不如直接给一句话。
 */
import type { CreditShareRow } from '../../shared/lib/overview-detail';
import { formatCompact, formatNumber } from '../../shared/lib/format';

/**
 * 段色。取自全局图表序列 --rg-viz-1..5。
 *
 * 为什么不在这里自己排一套：原先本项目有三处图表各写一套取色
 * （DailyTrendChart 用 chart-*、TokenHeatmap 用 brand 五档、这里自排），
 * 做暗色主题时要改三处、且极易只改一处。现在统一定义在 global.css，
 * 这里只引用序列名。
 *
 * 序列的设计约束：相邻两段必须有明度差（深品牌 → 浅品牌 → 中性 → 更浅 → 中性），
 * 否则堆叠成条后边界不可辨 —— 这是此前拒绝沿用 --rg-chart-* 的原因，
 * 现在的 --rg-viz-* 已按该约束重排。
 */
const SEGMENT_COLORS = [
  'var(--rg-viz-1)',
  'var(--rg-viz-2)',
  'var(--rg-viz-3)',
  'var(--rg-viz-4)',
  'var(--rg-viz-5)',
];

export function ShareBar({
  parts,
  total,
  unknownPlatforms,
  unit = '积分',
  showTotal = true,
}: {
  parts: CreditShareRow[];
  total: number;
  /** 有账号但一次都没查过余额的平台名；会单独提示，不参与分母 */
  unknownPlatforms: string[];
  unit?: string;
  /**
   * 是否在条下显示「合计 N 积分」。
   *
   * 默认 true（单独使用时有意义）；紧跟明细表时应传 false ——
   * 表里已有合计行，同一数字出现两次会让人以为口径不同。
   */
  showTotal?: boolean;
}) {
  if (!parts.length) {
    return (
      <div className="text-aux leading-relaxed fg-3">
        还没有查过余额。点右上角「刷新」，或到凭据池逐个「查余额」。
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

      {/*
        合计行只在**没有外部合计行**时显示。
        总览页的占比条下方紧跟明细表，表里已有「合计」行；
        这里再写一遍「合计 46,844.87」等于同一屏同一数字出现两次，
        读者会开始怀疑两个数是不是不同口径。
      */}
      {(unknownPlatforms.length > 0 || showTotal) && (
        <div className="mt-1.5 text-aux fg-3">
          {showTotal && `合计 ${formatNumber(total)} ${unit}`}
          {showTotal && unknownPlatforms.length > 0 && ' · '}
          {unknownPlatforms.length > 0 &&
            `${unknownPlatforms.join(' / ')} 尚未查询，未计入占比`}
        </div>
      )}
    </div>
  );
}

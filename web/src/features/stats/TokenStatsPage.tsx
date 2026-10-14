/**
 * 用量与成本页。
 *
 * 信息架构按「口径」分组，而不是按数据来源堆面板：
 * - 口径卡片区：官方账单积分（主口径）与 Token / 请求（计量口径）分开呈现，
 *   数字用 metric 字体，估值与精确值不混排。
 * - 账单区：官方账单按账号行 + 行内展开模型拆分，粒度标注跟随平台。
 * - 流量区：模型 / 账号两张表，估算列集中且明确标注为对照口径。
 */
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '../../shared/api/auth';
import {
  clearClientStatsCache,
  getClientStats,
  getCreditHistory,
  getOfficialUsage,
  getPricingCalibration,
  getStatsAccounts,
  getStatsDaily,
  getStatsModels,
} from '../../shared/api/stats';
import { ApiError } from '../../shared/api/http';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { formatBytes, formatCost, formatNumber } from '../../shared/lib/format';
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Note,
  Panel,
  ProgressBar,
  Segmented,
} from '../../shared/ui';
import { PageShell, Stack } from '../../shared/ui/PageShell';
import { useToast } from '../../shared/ui/Toast';
import { DailyTrendChart } from './DailyTrendChart';
import { TokenHeatmap } from './TokenHeatmap';

type Range = '1' | '7' | '30';

/** 口径卡片：主读数 + 口径说明。数字用 metric 字体（大数不用 mono）。 */
function CaliberCard({
  label,
  value,
  unit,
  caliber,
  loading,
  children,
}: {
  label: string;
  value: string;
  unit?: string;
  /** 口径语气：exact=上游精确值（品牌色）；metered=网关计量（主文字色）；estimate=估算（置灰） */
  caliber: 'exact' | 'estimate' | 'metered';
  /** 加载中：主读数显示 — 而不是 0，避免把「还没拿到」读成「确实是零」 */
  loading?: boolean;
  /** 卡片底部的口径拆解行 */
  children?: ReactNode;
}) {
  const accent =
    caliber === 'exact'
      ? 'var(--rg-brand-600)'
      : caliber === 'metered'
        ? 'var(--rg-text-primary)'
        : 'var(--rg-text-tertiary)';
  return (
    <div
      className="rounded-lg border p-4 min-w-0"
      style={{ borderColor: 'var(--rg-border)', background: 'var(--rg-bg-base)' }}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[12px] leading-[18px]" style={{ color: 'var(--rg-text-secondary)' }}>
          {label}
        </span>
        <span
          className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: accent }}
          aria-hidden="true"
        />
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5 min-w-0">
        <span className="text-read truncate" style={{ color: accent }}>
          {loading ? '—' : value}
        </span>
        {unit && !loading && (
          <span className="text-aux shrink-0" style={{ color: 'var(--rg-text-tertiary)' }}>
            {unit}
          </span>
        )}
      </div>
      {!loading && children}
    </div>
  );
}

/** 口径小注：卡片内的分平台/分口径说明行。 */
function CaliberRow({ k, v, tone }: { k: string; v: string; tone?: 'warn' | 'muted' }) {
  const color =
    tone === 'warn' ? 'var(--rg-state-warning)'
      : tone === 'muted' ? 'var(--rg-text-tertiary)'
        : 'var(--rg-text-secondary)';
  return (
    <div className="flex items-baseline justify-between gap-3 mt-1.5 first:mt-3">
      <span className="text-[11px] leading-4 shrink-0" style={{ color: 'var(--rg-text-tertiary)' }}>
        {k}
      </span>
      <span className="font-mono text-[12px] leading-4 tabular-nums" style={{ color }}>
        {v}
      </span>
    </div>
  );
}

export default function TokenStatsPage() {
  const { key } = useAuth();
  const toast = useToast();
  const [range, setRange] = useState<Range>('7');
  const days = Number(range);
  // 展开账单明细（按账号）的行
  const [expandedBill, setExpandedBill] = useState<ReadonlySet<string>>(new Set());

  function toggleBill(accountId: string) {
    setExpandedBill((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  }

  const daily = useAsyncData((signal) => getStatsDaily(days, key, signal), [days, key], { enabled: !!key });
  // 热力图固定 17 周（119 天），不跟随顶部时间范围，故单独请求一次；180 天覆盖 119 天后仍有富余
  const heatmap = useAsyncData((signal) => getStatsDaily(180, key, signal), [key], { enabled: !!key });
  const models = useAsyncData((signal) => getStatsModels(days, key, signal), [days, key], { enabled: !!key });
  const accounts = useAsyncData((signal) => getStatsAccounts(days, key, signal), [days, key], { enabled: !!key });
  const client = useAsyncData((signal) => getClientStats(days, key, signal), [days, key], { enabled: !!key });
  const official = useAsyncData((signal) => getOfficialUsage(days, key, signal), [days, key], { enabled: !!key });
  const credit = useAsyncData((signal) => getCreditHistory(days, key, signal), [days, key], { enabled: !!key });
  const calibration = useAsyncData((signal) => getPricingCalibration(key, false, signal), [key], { enabled: !!key });

  const totals = useMemo(() => {
    const rows = daily.data?.data ?? [];
    return rows.reduce(
      (acc, r) => ({
        requests: acc.requests + r.requests,
        errors: acc.errors + r.errors,
        tokens: acc.tokens + r.tokens,
        metered: acc.metered + r.metered,
        // exact=上游真值 / estimated=tiktoken 补算 / none=完全没有 token
        exact: acc.exact + (r.exact ?? 0),
        estimated: acc.estimated + (r.estimated ?? 0),
        none: acc.none + (r.none ?? 0),
        // 历史脱敏缺陷把 token 写成 "***"，原值从未写入文件，无法逐行还原
        tokensLost: acc.tokensLost + (r.tokensLost ?? 0),
        unmetered: acc.unmetered + r.unmetered,
        cacheRead: acc.cacheRead + (r.cacheReadTokens ?? 0),
        cost: acc.cost + r.estimatedCost,
        // 官方账单按日合计（与估算同窗口，可直接对照）
        officialCredit: acc.officialCredit + (r.officialCredit ?? 0),
        officialTokens: acc.officialTokens + (r.officialTokens ?? 0),
        // 逻辑回合口径：一次客户端请求 = 一个回合。降级换候选会给同一回合写多行
        // traffic，故回合数与请求行数不是一回事（后端 stats.js#turnBuckets）。
        turns: acc.turns + (r.turns ?? 0),
        turnsFailed: acc.turnsFailed + (r.turnsFailed ?? 0),
        recoveredTurns: acc.recoveredTurns + (r.recoveredTurns ?? 0),
      }),
      {
        requests: 0, errors: 0, tokens: 0, metered: 0, exact: 0, estimated: 0, none: 0,
        tokensLost: 0, unmetered: 0, cacheRead: 0, cost: 0, officialCredit: 0, officialTokens: 0,
        turns: 0, turnsFailed: 0, recoveredTurns: 0,
      },
    );
  }, [daily.data]);

  // 工具输出压缩（RTK）节省：窗口内一行都没跑过压缩时后端返回 null，
  // 界面显示「没有压缩记录」而不是 0——「没测量」与「省了 0 字节」是两件事。
  const savings = daily.data?.savings ?? null;

  // 官方账单（积分主口径）：Trae 逐会话、WB 逐请求，都是上游精确值
  const officialTotals = useMemo(() => {
    const list = official.data?.accounts ?? [];
    const ok = list.filter((a) => a.available);
    const sum = (pred: (a: (typeof ok)[number]) => boolean) => {
      const hit = ok.filter(pred);
      return {
        credit: hit.reduce((s, a) => s + a.credit, 0),
        requests: hit.reduce((s, a) => s + a.requests, 0),
        tokens: hit.reduce((s, a) => s + (a.tokens ?? 0), 0),
        accounts: hit.length,
      };
    };
    const trae = sum((a) => a.platform === 'trae');
    const wb = sum((a) => a.platform === 'workbuddy');
    return {
      trae,
      wb,
      credit: trae.credit + wb.credit,
      accounts: ok.length,
      total: list.length,
    };
  }, [official.data]);

  const meteredRate =
    totals.metered + totals.unmetered > 0
      ? (totals.metered / (totals.metered + totals.unmetered)) * 100
      : 0;

  const ratio = calibration.data?.ratio ?? null;
  const calibCount = Object.keys(calibration.data?.models ?? {}).length;
  /**
   * 该日账单是否已完整入账。
   *
   * Trae 按会话入账，滞后 1~2 天；滞后期内该日只有 WB 侧的账单，
   * 而网关估算覆盖双平台 —— 拿全平台估算除单平台账单会算出 1000%+
   * 的假差异。窗口内统一标「入账中」，不出差异率。
   */
  const TRAE_LAG_DAYS = 2;
  const isBillSettled = (d: { date: string; officialTraeCredit?: number }) => {
    // 有 Trae 账单说明已入账；更早的日期不受滞后窗口影响
    if ((d.officialTraeCredit ?? 0) > 0) return true;
    const daysAgo = (Date.now() - new Date(`${d.date}T00:00:00`).getTime()) / 86400000;
    return daysAgo > TRAE_LAG_DAYS;
  };
  /** 标定表按「平台:模型」建键，展示时拆开，并按 R² 降序（拟合越准越靠前）。 */
  const calibRows = useMemo(
    () =>
      Object.entries(calibration.data?.models ?? {})
        .map(([k, v]) => {
          const idx = k.indexOf(':');
          return { platform: k.slice(0, idx), model: k.slice(idx + 1), ...v };
        })
        .sort((a, b) => b.r2 - a.r2 || b.n - a.n),
    [calibration.data],
  );

  async function clearCache() {
    try {
      await clearClientStatsCache(key);
      toast('客户端统计缓存已清理', 'ok');
      client.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '客户端统计缓存清理失败，可重试', 'err');
    }
  }

  const billRows = official.data?.accounts ?? [];

  return (
    <PageShell
      title="用量与成本"
      description="官方账单积分（主口径）与网关计量 Token；估算值仅作对照"
      actions={
        <>
          <Segmented
            ariaLabel="时间范围"
            value={range}
            onChange={setRange}
            options={[
              { value: '1', label: '今日' },
              { value: '7', label: '近 7 日' },
              { value: '30', label: '近 30 日' },
            ]}
          />
          <Button onClick={clearCache}>清理客户端缓存</Button>
        </>
      }
    >
      <Stack>
        {daily.error && <ErrorState message={daily.error} onRetry={daily.reload} />}

        {/* 口径卡片区：花了多少积分（成本）+ 用了多少 token（用量）。
            成本两张卡并列（官方=主读数，估算=对照），用量与换算各一张，四卡一行。 */}
        <div className="grid gap-4 grid-cols-2 xl:grid-cols-5">
          {/* 成本主读数：官方账单 */}
          <CaliberCard
            label="官方账单积分"
            value={formatNumber(officialTotals.credit)}
            unit="积分"
            caliber="exact"
            loading={official.loading && !official.data}
          >
            <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--rg-border)' }}>
              <CaliberRow k={`Trae · ${officialTotals.trae.accounts} 账号`} v={formatNumber(officialTotals.trae.credit)} />
              <CaliberRow k={`WorkBuddy · ${officialTotals.wb.accounts} 账号`} v={formatNumber(officialTotals.wb.credit)} />
              <CaliberRow
                k="本地估算对照"
                v={
                  officialTotals.credit > 0 && totals.cost > 0
                    ? `${formatCost(totals.cost)} · ${((totals.cost / officialTotals.credit) * 100).toFixed(0)}%`
                    : formatCost(totals.cost)
                }
                tone="muted"
              />
              {/* 主口径的可信度前提：Trae 按会话入账有 1~2 天滞后，最近一两日必然偏低。
                  该警告只放在读数旁边，不重复出现在页面底部。 */}
              <CaliberRow k="入账滞后" v="Trae 1 至 2 天" tone="muted" />
            </div>
          </CaliberCard>

          {/* 用量主读数：Token 总量 + 来源拆解 + 丢失提示 */}
          <CaliberCard
            label="Token 总量"
            value={formatNumber(totals.tokens)}
            caliber="metered"
            loading={daily.loading && !daily.data}
          >
            <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--rg-border)' }}>
              {/* 以下三行是「请求数」而非 Token 数，单位必须写明，
                  否则会被读成上方大数字的构成拆解 */}
              <CaliberRow k="上游精确值请求" v={`${formatNumber(totals.exact)} 次`} />
              <CaliberRow k="tiktoken 补算请求" v={`${formatNumber(totals.estimated)} 次`} />
              <CaliberRow k="无 Token 请求" v={`${formatNumber(totals.none)} 次`} />
              {totals.cacheRead > 0 && totals.tokens > 0 && (
                <CaliberRow
                  k="其中缓存读 Token"
                  v={`${((totals.cacheRead / totals.tokens) * 100).toFixed(1)}% · ${formatNumber(totals.cacheRead)}`}
                />
              )}
              {totals.tokensLost > 0 && (
                <CaliberRow
                  k="Token 已丢失（历史脱敏缺陷）"
                  v={`${formatNumber(totals.tokensLost)} 行`}
                  tone="warn"
                />
              )}
            </div>
          </CaliberCard>

          {/* 换算比：token ↔ 积分的关系，账单实测均值 */}
          <CaliberCard
            label="换算比（账单实测）"
            value={ratio ? `${ratio.tokensPerCredit.toLocaleString('zh-CN')}` : '—'}
            unit={ratio ? 'Token / 积分' : undefined}
            caliber="exact"
            loading={calibration.loading && !calibration.data}
          >
            <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--rg-border)' }}>
              {ratio ? (
                <>
                  <CaliberRow k="积分 / 千 Token" v={ratio.creditsPer1k.toFixed(6)} />
                  <CaliberRow k="账单日" v={ratio.asOf ?? '—'} />
                  <CaliberRow k="样本" v={`${formatNumber(ratio.tokens)} Token · ${formatNumber(ratio.credits)} 积分`} />
                </>
              ) : (
                <CaliberRow k="状态" v="暂无账单样本" />
              )}
            </div>
          </CaliberCard>

          {/* 计量覆盖率：网关侧 usage 回传情况 */}
          <CaliberCard
            label="计量覆盖率"
            value={`${meteredRate.toFixed(1)}%`}
            caliber="metered"
            loading={daily.loading && !daily.data}
          >
            <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--rg-border)' }}>
              <CaliberRow k="总请求（上游请求行）" v={formatNumber(totals.requests)} />
              <CaliberRow k="错误行" v={formatNumber(totals.errors)} />
              {/* 回合口径：降级换候选会给同一客户端请求写多行，只按行算成功率会把
                  「降级后成功」记成失败。回合数通常小于请求行数，故必须写明口径。 */}
              {totals.turns > 0 && (
                <>
                  <CaliberRow
                    k="逻辑回合（客户端请求）"
                    v={`${formatNumber(totals.turns)} · 成功率 ${(((totals.turns - totals.turnsFailed) / totals.turns) * 100).toFixed(1)}%`}
                  />
                  {totals.recoveredTurns > 0 && (
                    <CaliberRow
                      k="其中降级后成功"
                      v={`${formatNumber(totals.recoveredTurns)} 回合`}
                      tone="warn"
                    />
                  )}
                </>
              )}
              <CaliberRow
                k="估算口径"
                v={calibCount > 0 ? `账单标定 · ${calibCount} 模型` : '内置费率表推算'}
                tone="muted"
              />
            </div>
          </CaliberCard>

          {/* 工具输出压缩（RTK）节省。口径是 **UTF-8 字节**，不是 Token：
              分词后两者不成比例，故单位必须写明，不能与上方 Token 卡并读。
              caliber 用 metered——这是网关侧的测量值，不是账单值。 */}
          <CaliberCard
            label="工具输出压缩节省"
            value={savings ? formatBytes(savings.savedBytes) : '—'}
            unit={savings ? `/${formatBytes(savings.bytesBefore)}` : undefined}
            caliber="metered"
            loading={daily.loading && !daily.data}
          >
            <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--rg-border)' }}>
              {savings ? (
                <>
                  <div className="mt-2 mb-1">
                    <ProgressBar ratio={savings.percent / 100} tone="brand" />
                  </div>
                  <CaliberRow k="节省比例（字节）" v={`${savings.percent.toFixed(1)}%`} />
                  <CaliberRow k="压缩请求" v={`${formatNumber(savings.calls)} 次 · 覆盖 ${savings.days} 天`} />
                  <CaliberRow k="压缩块" v={`${formatNumber(savings.blocks)} 块`} />
                  {savings.partial && (
                    <CaliberRow k="部分行数据不完整" v="节省量为下界" tone="warn" />
                  )}
                </>
              ) : (
                <CaliberRow k="状态" v="所选区间内没有压缩记录" />
              )}
            </div>
          </CaliberCard>
        </div>

                <Panel
          title="每日积分对照"
          description="官方账单为权威口径，网关估算仅作对照"
          flush
          footer="网关估算基于已计量 Token：历史日期因 Token 缺失显示 0 属数据丢失，不是零消耗；官方账单与估算不可相加。"
        >
          {daily.loading && !daily.data ? (
            <LoadingBlock />
          ) : (daily.data?.data ?? []).length === 0 ? (
            <EmptyState
              label="所选区间内没有统计数据。"
              hint="产生转发请求后即会出现；官方账单通常还有 1 至 2 天的入账滞后。"
            />
          ) : (
            <table className="card-table w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">日期</th>
                  <th className="th cell-num">官方账单积分</th>
                  <th className="th cell-num">网关估算积分</th>
                  <th className="th cell-num">差异</th>
                </tr>
              </thead>
              <tbody>
                {/* 差异只在账单「已完整入账」的日子才有意义：
                  Trae 按会话入账有 1~2 天滞后，滞后期内账单只覆盖 WB 一侧，
                  而网关估算覆盖双平台，拿全平台估算除单平台账单会算出
                  1000%+ 的假差异。故近 TRAE_LAG_DAYS 天不出差异，标「入账中」。 */}
                {(daily.data?.data ?? []).map((d) => {
                  const hasBill = typeof d.officialCredit === 'number' && d.officialCredit > 0;
                  const est = d.estimatedCost;
                  const upper = (d.costUpper ?? 0) > 0;
                  const unpriced = (d.priced ?? 0) === 0;
                  const settled = isBillSettled(d);
                  // 差异率：两侧都 > 0 且账单已完整入账才有意义
                  const diff =
                    hasBill && est > 0 && settled
                      ? ((est - d.officialCredit!) / d.officialCredit!) * 100
                      : null;
                  return (
                    <tr key={d.date} className="row-hover">
                      <td className="td font-mono text-[12px]" data-label="日期">{d.date.slice(5)}</td>
                      <td className="td cell-num font-medium" data-label="官方账单积分">
                        {hasBill ? formatNumber(d.officialCredit) : '—'}
                      </td>
                      <td className="td cell-num" data-label="网关估算积分">
                        {/* est=0 且无 priced 行 = token 数据丢失；有 priced 行但含上界 = 估算偏高 */}
                        {est > 0 ? (
                          <span title={upper ? '该日部分请求缺缓存读信息，按全未缓存计价，估算偏高' : undefined}>
                            {formatCost(est)}
                            {upper && <span className="ml-0.5 text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>↑</span>}
                          </span>
                        ) : unpriced ? (
                          <span style={{ color: 'var(--rg-text-tertiary)' }} title="该日 Token 数据缺失，无法估算">数据缺失</span>
                        ) : (
                          <span style={{ color: 'var(--rg-text-tertiary)' }}>0</span>
                        )}
                      </td>
                      <td className="td cell-num" data-label="差异">
                        {diff == null ? (
                          !settled && hasBill ? (
                            <span style={{ color: 'var(--rg-text-tertiary)' }} title="Trae 账单按会话入账有 1 至 2 天滞后，该日账单尚未完整">入账中</span>
                          ) : (
                            <span style={{ color: 'var(--rg-text-tertiary)' }}>—</span>
                          )
                        ) : (
                          <span style={{ color: Math.abs(diff) > 50 ? 'var(--rg-state-warning)' : 'var(--rg-text-secondary)' }}>
                            {diff > 0 ? '+' : ''}
                            {diff.toFixed(0)}%
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title="每日趋势"
          description="请求量、错误数与 Token 走势"
        >
          {daily.loading && !daily.data ? (
            <LoadingBlock />
          ) : (daily.data?.data ?? []).length === 0 ? (
            <EmptyState
              label="所选区间内没有请求记录。"
              hint="产生转发请求后即会出现。"
            />
          ) : (
            <DailyTrendChart rows={daily.data?.data ?? []} />
          )}
        </Panel>

        <Panel
          title="Token 热力图"
          description="最近 17 周 · 按本地日期；虚线格＝有请求但上游未回传计量，不代表零消耗"
        >
          {/* 用 180 天单独取数，老后端若不接受该参数，错误只落在本面板内，不影响页面其余部分 */}
          {heatmap.error ? (
            <ErrorState message={heatmap.error} onRetry={heatmap.reload} />
          ) : heatmap.loading && !heatmap.data ? (
            <LoadingBlock />
          ) : (heatmap.data?.data ?? []).length === 0 ? (
            <EmptyState
              label="最近 17 周内没有 Token 记录。"
              hint="产生转发请求后即会出现；本图不随顶部时间范围切换。"
            />
          ) : (
            <TokenHeatmap rows={heatmap.data?.data ?? []} />
          )}
        </Panel>

        {/* 官方账单：主口径，行内展开模型拆分 */}
        <Panel
          title="官方账单积分"
          description="上游精确值 · Trae 逐会话聚合 / WorkBuddy 逐请求"
          flush
        >
          {official.loading && !official.data ? (
            <LoadingBlock />
          ) : billRows.length === 0 ? (
            <EmptyState
              label="还没有官方账单记录。"
              hint="官方账单按 Trae 会话 / WorkBuddy 请求从上游同步，通常在请求后 1 至 2 天出现。"
            />
          ) : (
            <table className="card-table w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">账号</th>
                  <th className="th">平台 / 粒度</th>
                  <th className="th">状态</th>
                  <th className="th cell-num">明细行</th>
                  <th className="th cell-num">Token</th>
                  <th className="th cell-num">积分</th>
                </tr>
              </thead>
              <tbody>
                {billRows.map((a) => {
                  const open = expandedBill.has(a.accountId) && (a.byModel ?? []).length > 0;
                  const breakdown = a.byModel ?? [];
                  return (
                    <Fragment key={`${a.platform ?? ''}-${a.accountId}`}>
                      <tr className="row-hover">
                        <td className="td" data-label="账号">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {a.available && breakdown.length > 0 && (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm shrink-0"
                                aria-expanded={open}
                                onClick={() => toggleBill(a.accountId)}
                              >
                                {open ? '收起' : '拆分'}
                              </button>
                            )}
                            <span className="text-[13px] truncate">{a.label || a.accountId}</span>
                          </div>
                          {!a.available && a.error && (
                            <div className="text-[11px] mt-0.5 break-all" style={{ color: 'var(--rg-state-error)' }}>
                              {a.error}
                            </div>
                          )}
                        </td>
                        <td className="td" data-label="平台 / 粒度">
                          <div className="flex items-center gap-1.5">
                            <Chip tone={a.platform === 'trae' ? 'brand' : 'neutral'}>
                              {a.platform === 'trae' ? 'Trae' : 'WorkBuddy'}
                            </Chip>
                          </div>
                          <div className="text-[11px] mt-0.5" style={{ color: 'var(--rg-text-tertiary)' }}>
                            {a.granularity === 'session' ? '逐会话' : '逐请求'}
                          </div>
                        </td>
                        <td className="td" data-label="状态">
                          {a.available ? (
                            <Chip tone="ok" dot="dot-ok">已入账</Chip>
                          ) : (
                            <Chip tone="danger" dot="dot-error">不可用</Chip>
                          )}
                        </td>
                        <td className="td cell-num" data-label="明细行">{a.available ? formatNumber(a.requests) : '—'}</td>
                        <td className="td cell-num" data-label="Token">
                          {a.available && a.tokens != null ? formatNumber(a.tokens) : '—'}
                        </td>
                        <td className="td cell-num font-semibold" data-label="积分">
                          {a.available ? formatNumber(a.credit) : '—'}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td className="td" colSpan={6} style={{ background: 'var(--rg-bg-secondary)' }} data-label="账号">
                            <div className="grid gap-x-8 gap-y-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
                              {breakdown.map((m) => (
                                <div key={m.model} className="flex items-baseline justify-between gap-3 py-1">
                                  <span className="font-mono text-[12px] truncate" style={{ color: 'var(--rg-text-secondary)' }}>
                                    {m.model}
                                  </span>
                                  <span className="font-mono text-[12px] tabular-nums shrink-0">
                                    {formatNumber(m.credits)}
                                    <span className="ml-1" style={{ color: 'var(--rg-text-tertiary)' }}>
                                      / {formatNumber(m.requests)}
                                    </span>
                                  </span>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        {/* 网关计量：模型 / 账号两张表 */}
        <Panel title="模型用量" description="按模型聚合的请求与 Token" flush>
          {models.loading && !models.data ? (
            <LoadingBlock />
          ) : (models.data?.data ?? []).length === 0 ? (
            <EmptyState
              label="所选区间内没有模型用量。"
              hint="产生转发请求后即会出现。"
            />
          ) : (
            <table className="card-table w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">模型</th>
                  <th className="th cell-num">请求</th>
                  <th className="th cell-num">错误</th>
                  <th className="th cell-num">Token</th>
                  <th className="th cell-num">计量 / 未计量</th>
                  <th className="th cell-num">平均延迟</th>
                  <th className="th cell-num">估算成本*</th>
                </tr>
              </thead>
              <tbody>
                {(models.data?.data ?? []).map((m) => (
                  <tr key={m.model} className="row-hover">
                    <td className="td font-mono text-[12px] break-all" data-label="模型">{m.model}</td>
                    <td className="td cell-num" data-label="请求">{formatNumber(m.requests)}</td>
                    <td className="td cell-num" data-label="错误" style={{ color: m.errors > 0 ? 'var(--rg-state-error)' : undefined }}>
                      {formatNumber(m.errors)}
                    </td>
                    <td className="td cell-num font-medium" data-label="Token">{formatNumber(m.tokens)}</td>
                    <td className="td cell-num" data-label="计量 / 未计量">
                      {formatNumber(m.metered)}
                      <span style={{ color: 'var(--rg-text-tertiary)' }}> / </span>
                      {m.unmetered > 0 ? (
                        <span style={{ color: 'var(--rg-state-warning)' }}>{formatNumber(m.unmetered)}</span>
                      ) : (
                        <span style={{ color: 'var(--rg-text-tertiary)' }}>0</span>
                      )}
                      {(m.estimated ?? 0) > 0 && (
                        <span
                          className="ml-1 text-[11px]"
                          title="其中 tiktoken 补算的请求数"
                          style={{ color: 'var(--rg-text-tertiary)' }}
                        >
                          ({m.estimated} 估)
                        </span>
                      )}
                    </td>
                    <td className="td cell-num" data-label="平均延迟">
                      {m.avgDurationMs == null ? '—' : `${Math.round(m.avgDurationMs)}ms`}
                    </td>
                    <td className="td cell-num" style={{ color: 'var(--rg-text-tertiary)' }} data-label="估算成本*">
                      {formatCost(m.estimatedCost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="账号用量" description="按账号聚合的请求与 Token 占比" flush>
          {accounts.loading && !accounts.data ? (
            <LoadingBlock />
          ) : (accounts.data?.data ?? []).length === 0 ? (
            <EmptyState
              label="所选区间内没有账号用量。"
              hint="产生转发请求后即会出现。"
            />
          ) : (
            <table className="card-table w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">账号</th>
                  <th className="th cell-num">请求</th>
                  <th className="th">错误率</th>
                  <th className="th">Token 占比</th>
                  <th className="th cell-num">估算成本*</th>
                </tr>
              </thead>
              <tbody>
                {(accounts.data?.data ?? []).map((a) => (
                  <tr key={a.accountId} className="row-hover">
                    <td className="td font-mono text-[12px]" data-label="账号">{a.accountId}</td>
                    <td className="td cell-num" data-label="请求">{formatNumber(a.requests)}</td>
                    <td className="td" data-label="错误率">
                      <div className="flex items-center gap-2 min-w-[110px]">
                        <div className="flex-1 min-w-[64px]">
                          <ProgressBar
                            ratio={a.errorRate / 100}
                            tone={a.errorRate > 5 ? 'danger' : a.errorRate > 0 ? 'warn' : 'brand'}
                          />
                        </div>
                        <span className="font-mono text-[11px] tabular-nums w-[52px] text-right" style={{ color: 'var(--rg-text-secondary)' }}>
                          {a.errorRate.toFixed(2)}%
                        </span>
                      </div>
                    </td>
                    <td className="td" data-label="Token 占比">
                      <div className="flex items-center gap-2 min-w-[110px]">
                        <div className="flex-1 min-w-[64px]">
                          <ProgressBar ratio={a.tokenShare / 100} tone="soft" />
                        </div>
                        <span className="font-mono text-[11px] tabular-nums w-[52px] text-right" style={{ color: 'var(--rg-text-secondary)' }}>
                          {a.tokenShare.toFixed(1)}%
                        </span>
                      </div>
                    </td>
                    <td className="td cell-num" style={{ color: 'var(--rg-text-tertiary)' }} data-label="估算成本*">
                      {formatCost(a.estimatedCost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <div className="grid gap-4 grid-cols-1 xl:grid-cols-2">
          <Panel
            title="本机客户端"
            description="扫描本机 WorkBuddy 会话日志，与网关转发记录并列但来源不同"
          >
            {client.error ? (
              <ErrorState message={client.error} onRetry={client.reload} />
            ) : client.loading && !client.data ? (
              <LoadingBlock />
            ) : !client.data?.available ? (
              <Note>
                本机统计不可用：{client.data?.reason || '网关未返回原因'}。该数据依赖本机会话日志文件，网关转发数据不受影响。
              </Note>
            ) : (
              <table className="card-table w-full border-collapse text-[13px]">
                <tbody>
                  {(
                    [
                      ['状态', <Chip tone="ok" dot="dot-ok">可用</Chip>],
                      ['扫描文件 / 已解析', `${formatNumber(client.data.files)} / ${formatNumber(client.data.parsedFiles)}`],
                      ['请求数', formatNumber(client.data.totals.requests)],
                      ['Token', formatNumber(client.data.totals.tokens)],
                      ['缓存命中', `${(client.data.totals.cacheHitRate * 100).toFixed(1)}%`],
                      ['积分', formatNumber(client.data.totals.credit)],
                    ] as [string, ReactNode][]
                  ).map(([k, v]) => (
                    <tr key={k}>
                      <td className="td text-[12px] w-[110px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                        {k}
                      </td>
                      <td className="td font-mono text-[12px]">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title="积分快照消耗" description="相邻余额快照差分（下界估计，供交叉验证）" flush>
            {credit.loading && !credit.data ? (
              <LoadingBlock />
            ) : (credit.data?.data ?? []).length === 0 ? (
              <EmptyState
                label="还没有积分快照差分记录。"
                hint="余额自动刷新任务运行过至少两轮后，这里会出现按账号的消耗估计。"
              />
            ) : (
              <table className="card-table w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className="th">账号</th>
                    <th className="th cell-num">今日消耗</th>
                  </tr>
                </thead>
                <tbody>
                  {(credit.data?.data ?? []).map((c, i) => (
                    <tr key={`${c.label ?? i}`} className="row-hover">
                      <td className="td" data-label="账号">{c.label || '—'}</td>
                      <td className="td cell-num" data-label="今日消耗">{formatNumber(c.usedTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>

        {/* 标定系数：估算成本的来源与可信度，全部公开 */}
        <Panel
          title="积分标定系数"
          description={
            calibCount > 0
              ? `由官方账单最小二乘回归得出 · ${calibCount} 个「平台:模型」组合 · ${calibration.data?.calibratedAt ? `标定于 ${calibration.data.calibratedAt.slice(0, 16).replace('T', ' ')}` : ''}`
              : '尚无标定：无账单数据时，估算成本按内置费率表推算'
          }
          flush
        >
          {calibration.loading && !calibration.data ? (
            <LoadingBlock />
          ) : calibRows.length === 0 ? (
            <EmptyState
              label="还没有积分标定样本。"
              hint="官方账单同步过来之后会自动生成；在那之前估算成本使用内置费率表。"
            />
          ) : (
            <table className="card-table w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">平台</th>
                  <th className="th">模型</th>
                  <th className="th cell-num">样本</th>
                  <th className="th cell-num">R²</th>
                  <th className="th cell-num">未缓存输入 /1k</th>
                  <th className="th cell-num">输出 /1k</th>
                  <th className="th cell-num">缓存读 /1k</th>
                </tr>
              </thead>
              <tbody>
                {calibRows.map((c) => (
                  <tr key={`${c.platform}:${c.model}`} className="row-hover">
                    <td className="td" data-label="平台">
                      <Chip tone={c.platform === 'wb' ? 'neutral' : 'brand'}>
                        {c.platform === 'wb' ? 'WorkBuddy' : 'Trae'}
                      </Chip>
                    </td>
                    <td className="td font-mono text-[12px] break-all" data-label="模型">{c.model}</td>
                    <td className="td cell-num" data-label="样本">{formatNumber(c.n)}</td>
                    <td className="td cell-num font-mono" data-label="R²">
                      <span style={{ color: c.r2 >= 0.99 ? 'var(--rg-state-success)' : c.r2 >= 0.9 ? 'var(--rg-text-secondary)' : 'var(--rg-state-warning)' }}>
                        {c.r2.toFixed(6)}
                      </span>
                    </td>
                    <td className="td cell-num font-mono" data-label="未缓存输入 /1k">{(c.uncached * 1000).toFixed(5)}</td>
                    <td className="td cell-num font-mono" data-label="输出 /1k">{(c.output * 1000).toFixed(5)}</td>
                    <td className="td cell-num font-mono" style={{ color: 'var(--rg-text-tertiary)' }} data-label="缓存读 /1k">
                      {(c.cacheRead * 1000).toFixed(5)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Note>
          官方账单积分是上游精确值；带 * 的估算成本是网关推算值，仅供对照，官方账单与估算不可相加。
        </Note>
      </Stack>
    </PageShell>
  );
}

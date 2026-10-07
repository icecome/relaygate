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
  getStatsAccounts,
  getStatsDaily,
  getStatsModels,
} from '../../shared/api/stats';
import { ApiError } from '../../shared/api/http';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { formatCost, formatNumber } from '../../shared/lib/format';
import {
  Button,
  Chip,
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

type Range = '1' | '7' | '30';

/** 口径卡片：主读数 + 口径说明。数字用 metric 字体（TraeWork：大数不用 mono）。 */
function CaliberCard({
  label,
  value,
  unit,
  caliber,
  children,
}: {
  label: string;
  value: string;
  unit?: string;
  /** 口径语气：exact=上游精确值（品牌色）；metered=网关计量（主文字色）；estimate=估算（置灰） */
  caliber: 'exact' | 'estimate' | 'metered';
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
          {value}
        </span>
        {unit && (
          <span className="text-aux shrink-0" style={{ color: 'var(--rg-text-tertiary)' }}>
            {unit}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/** 口径小注：卡片内的分平台/分口径说明行。 */
function CaliberRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 mt-1.5 first:mt-3">
      <span className="text-[11px] leading-4 shrink-0" style={{ color: 'var(--rg-text-tertiary)' }}>
        {k}
      </span>
      <span className="font-mono text-[12px] leading-4 tabular-nums" style={{ color: 'var(--rg-text-secondary)' }}>
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
  const models = useAsyncData((signal) => getStatsModels(days, key, signal), [days, key], { enabled: !!key });
  const accounts = useAsyncData((signal) => getStatsAccounts(days, key, signal), [days, key], { enabled: !!key });
  const client = useAsyncData((signal) => getClientStats(days, key, signal), [days, key], { enabled: !!key });
  const official = useAsyncData((signal) => getOfficialUsage(days, key, signal), [days, key], { enabled: !!key });
  const credit = useAsyncData((signal) => getCreditHistory(days, key, signal), [days, key], { enabled: !!key });

  const totals = useMemo(() => {
    const rows = daily.data?.data ?? [];
    return rows.reduce(
      (acc, r) => ({
        requests: acc.requests + r.requests,
        errors: acc.errors + r.errors,
        tokens: acc.tokens + r.tokens,
        metered: acc.metered + r.metered,
        unmetered: acc.unmetered + r.unmetered,
        cost: acc.cost + r.estimatedCost,
      }),
      { requests: 0, errors: 0, tokens: 0, metered: 0, unmetered: 0, cost: 0 },
    );
  }, [daily.data]);

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

  async function clearCache() {
    try {
      await clearClientStatsCache(key);
      toast('客户端统计缓存已清理', 'ok');
      client.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '清理失败', 'err');
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

        {/* ---- 口径卡片区：精确值优先，估算值置灰 ---- */}
        <div className="grid gap-4 grid-cols-2 xl:grid-cols-4">
          <CaliberCard
            label="官方账单积分"
            value={formatNumber(officialTotals.credit)}
            unit="credits"
            caliber="exact"
          >
            <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--rg-border)' }}>
              <CaliberRow k={`Trae · ${officialTotals.trae.accounts} 账号`} v={formatNumber(officialTotals.trae.credit)} />
              <CaliberRow k={`WorkBuddy · ${officialTotals.wb.accounts} 账号`} v={formatNumber(officialTotals.wb.credit)} />
            </div>
          </CaliberCard>
          <CaliberCard
            label="Token 总量"
            value={formatNumber(totals.tokens)}
            caliber="metered"
          >
            <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--rg-border)' }}>
              <CaliberRow k="上游真实 usage" v={`${totals.metered} 请求`} />
              <CaliberRow k="补算（tiktoken）" v={`${totals.unmetered} 请求`} />
            </div>
          </CaliberCard>
          <CaliberCard
            label="计量覆盖率"
            value={`${meteredRate.toFixed(1)}%`}
            caliber="metered"
          >
            <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--rg-border)' }}>
              <CaliberRow k="总请求" v={formatNumber(totals.requests)} />
              <CaliberRow k="错误" v={formatNumber(totals.errors)} />
            </div>
          </CaliberCard>
          <CaliberCard
            label="本地估算成本"
            value={formatCost(totals.cost)}
            caliber="estimate"
          >
            <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--rg-border)' }}>
              <CaliberRow k="口径" v="费率表推算" />
              <CaliberRow k="用途" v="仅作对照" />
            </div>
          </CaliberCard>
        </div>

        <Panel
          title="每日趋势"
          description="请求量、错误数与 Token 走势"
          footer="Token = 上游真实 usage（优先）+ tiktoken 补算（usage 缺失时）；补算值与上游分词器存在偏差，仅供趋势参考。"
        >
          {daily.loading && !daily.data ? (
            <LoadingBlock />
          ) : (daily.data?.data ?? []).length === 0 ? (
            <div className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              区间内无数据
            </div>
          ) : (
            <DailyTrendChart rows={daily.data?.data ?? []} />
          )}
        </Panel>

        {/* ---- 官方账单：主口径，行内展开模型拆分 ---- */}
        <Panel
          title="官方账单积分"
          description="上游精确值 · Trae 逐会话聚合 / WorkBuddy 逐请求"
          flush
          footer="Trae 一行 = 一次完整会话的积分与 token 汇总；WorkBuddy 一行 = 单次模型调用。上游按会话落库有滞后，近一两天数据可能尚未入账。"
        >
          {official.loading && !official.data ? (
            <LoadingBlock />
          ) : billRows.length === 0 ? (
            <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              暂无账单数据
            </div>
          ) : (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">账号</th>
                  <th className="th">平台 / 粒度</th>
                  <th className="th">状态</th>
                  <th className="th cell-num">明细行</th>
                  <th className="th cell-num">Token</th>
                  <th className="th cell-num">Credit</th>
                </tr>
              </thead>
              <tbody>
                {billRows.map((a) => {
                  const open = expandedBill.has(a.accountId) && (a.byModel ?? []).length > 0;
                  const breakdown = a.byModel ?? [];
                  return (
                    <Fragment key={`${a.platform ?? ''}-${a.accountId}`}>
                      <tr className="row-hover">
                        <td className="td">
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
                        <td className="td">
                          <div className="flex items-center gap-1.5">
                            <Chip tone={a.platform === 'trae' ? 'brand' : 'neutral'}>
                              {a.platform === 'trae' ? 'Trae' : 'WorkBuddy'}
                            </Chip>
                          </div>
                          <div className="text-[11px] mt-0.5" style={{ color: 'var(--rg-text-tertiary)' }}>
                            {a.granularity === 'session' ? '逐会话' : '逐请求'}
                          </div>
                        </td>
                        <td className="td">
                          {a.available ? (
                            <Chip tone="ok" dot="dot-ok">已入账</Chip>
                          ) : (
                            <Chip tone="danger" dot="dot-error">不可用</Chip>
                          )}
                        </td>
                        <td className="td cell-num">{a.available ? formatNumber(a.requests) : '—'}</td>
                        <td className="td cell-num">
                          {a.available && a.tokens != null ? formatNumber(a.tokens) : '—'}
                        </td>
                        <td className="td cell-num font-semibold">
                          {a.available ? formatNumber(a.credit) : '—'}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td className="td" colSpan={6} style={{ background: 'var(--rg-bg-secondary)' }}>
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

        {/* ---- 网关计量：模型 / 账号两张表 ---- */}
        <Panel title="模型用量" description="按模型聚合的请求与 Token（含估算成本对照列）" flush>
          {models.loading && !models.data ? (
            <LoadingBlock />
          ) : (models.data?.data ?? []).length === 0 ? (
            <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              暂无模型数据
            </div>
          ) : (
            <table className="w-full border-collapse text-[13px]">
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
                    <td className="td font-mono text-[12px] break-all">{m.model}</td>
                    <td className="td cell-num">{formatNumber(m.requests)}</td>
                    <td className="td cell-num" style={{ color: m.errors > 0 ? 'var(--rg-state-error)' : undefined }}>
                      {formatNumber(m.errors)}
                    </td>
                    <td className="td cell-num font-medium">{formatNumber(m.tokens)}</td>
                    <td className="td cell-num">
                      {formatNumber(m.metered)}
                      <span style={{ color: 'var(--rg-text-tertiary)' }}> / </span>
                      {m.unmetered > 0 ? (
                        <span style={{ color: 'var(--rg-state-warning)' }}>{formatNumber(m.unmetered)}</span>
                      ) : (
                        <span style={{ color: 'var(--rg-text-tertiary)' }}>0</span>
                      )}
                    </td>
                    <td className="td cell-num">
                      {m.avgDurationMs == null ? '—' : `${Math.round(m.avgDurationMs)}ms`}
                    </td>
                    <td className="td cell-num" style={{ color: 'var(--rg-text-tertiary)' }}>
                      {formatCost(m.estimatedCost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="账号用量" description="按账号聚合的请求与 Token 占比（估算成本为对照口径）" flush>
          {accounts.loading && !accounts.data ? (
            <LoadingBlock />
          ) : (accounts.data?.data ?? []).length === 0 ? (
            <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              暂无账号数据
            </div>
          ) : (
            <table className="w-full border-collapse text-[13px]">
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
                    <td className="td font-mono text-[12px]">{a.accountId}</td>
                    <td className="td cell-num">{formatNumber(a.requests)}</td>
                    <td className="td">
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
                    <td className="td">
                      <div className="flex items-center gap-2 min-w-[110px]">
                        <div className="flex-1 min-w-[64px]">
                          <ProgressBar ratio={a.tokenShare / 100} tone="soft" />
                        </div>
                        <span className="font-mono text-[11px] tabular-nums w-[52px] text-right" style={{ color: 'var(--rg-text-secondary)' }}>
                          {a.tokenShare.toFixed(1)}%
                        </span>
                      </div>
                    </td>
                    <td className="td cell-num" style={{ color: 'var(--rg-text-tertiary)' }}>
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
            description="扫描本机 WorkBuddy 会话日志，与网关转发并列但来源不同"
          >
            {client.error ? (
              <ErrorState message={client.error} onRetry={client.reload} />
            ) : client.loading && !client.data ? (
              <LoadingBlock />
            ) : !client.data?.available ? (
              <Note>
                本机统计不可用：{client.data?.reason || '未返回原因'}。该数据依赖本机会话日志文件，网关转发数据不受影响。
              </Note>
            ) : (
              <table className="w-full border-collapse text-[13px]">
                <tbody>
                  {(
                    [
                      ['可用状态', <Chip tone="ok" dot="dot-ok">可用</Chip>],
                      ['扫描 / 已解析', `${formatNumber(client.data.files)} / ${formatNumber(client.data.parsedFiles)}`],
                      ['请求数', formatNumber(client.data.totals.requests)],
                      ['Token', formatNumber(client.data.totals.tokens)],
                      ['缓存命中', `${(client.data.totals.cacheHitRate * 100).toFixed(1)}%`],
                      ['Credit', formatNumber(client.data.totals.credit)],
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
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">账号</th>
                  <th className="th cell-num">今日消耗</th>
                </tr>
              </thead>
              <tbody>
                {(credit.data?.data ?? []).map((c, i) => (
                  <tr key={`${c.label ?? i}`} className="row-hover">
                    <td className="td">{c.label || '—'}</td>
                    <td className="td cell-num">{formatNumber(c.todayUsed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>

        <Note>
          口径说明：官方账单积分（Trae 逐会话 / WorkBuddy 逐请求）为上游精确值，是积分主口径；
          带 * 的估算成本由费率表推算，仅作 Trae 历史数据与无账单场景的对照，不建议与官方值相加。
        </Note>
      </Stack>
    </PageShell>
  );
}

/**
 * 总览页：凭据池健康度 + 运行时状态。
 * 数据源为SummaryProvider（单一 /summary）与 /v1/admin/runtime。
 */
import { useCallback, useMemo } from 'react';
import type { Account } from '../../shared/api/types';
import { useAuth } from '../../shared/api/auth';
import { getRuntime } from '../../shared/api/admin';
import { getCreditHistory } from '../../shared/api/stats';
import { useSummaryStore } from '../../shared/api/SummaryProvider';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { useBalanceAutoRefresh } from '../../shared/hooks/useBalanceAutoRefresh';
import { creditTotals } from '../accounts/accountPacks';
import {
  accountState,
  coolRemaining,
  formatBoolean,
  formatNumber,
  formatTime,
  formatUptime,
  STATE_DOT_CLASS,
  STATE_LABEL,
  STATE_PILL_CLASS,
} from '../../shared/lib/format';
import {
  Button,
  Chip,
  ErrorState,
  KeyValue,
  LoadingBlock,
  MetricGrid,
  Panel,
} from '../../shared/ui';
import { PageShell, Stack } from '../../shared/ui/PageShell';

export default function OverviewPage() {
  const { key } = useAuth();
  const { data: summary, loading, error, reload } = useSummaryStore();

  const runtime = useAsyncData(
    (signal) => getRuntime(key, signal),
    [key],
    { enabled: !!key },
  );

  const credits = useAsyncData(
    (signal) => getCreditHistory(1, key, signal),
    [key],
    { enabled: !!key },
  );

  // 页面可见时每60 秒触发一次真实余额查询，刷新后重读汇总与消耗统计。
  // reload 均为 useCallback 稳定引用，因此本回调只随它们变化。
  const { reload: reloadCredits } = credits;
  const refreshAll = useCallback(() => {
    reload();
    reloadCredits();
  }, [reload, reloadCredits]);
  useBalanceAutoRefresh(key, refreshAll);

  // 派生值不落state，随 summary 变化即时算出
  const accounts = useMemo<Account[]>(() => summary?.accounts ?? [], [summary]);
  const credit = useMemo(() => creditTotals(accounts), [accounts]);
  // 逐账号额度预先算好，避免在表格每行里重复遍历权益包
  const perAccountCredits = useMemo(() => {
    const map = new Map<string, ReturnType<typeof creditTotals>>();
    for (const a of accounts) map.set(a.id, creditTotals([a]));
    return map;
  }, [accounts]);

  const metrics = [
    { key: '凭据总数', value: formatNumber(summary?.total), delta: '含 Trae 与 WorkBuddy' },
    { key: '可用账号', value: formatNumber(summary?.enabled) },
    { key: '冷却中', value: formatNumber(summary?.cooling) },
    {
      // 后端 expiring3d/7d 是「即将到期的积分额度」，不是账号数
      key: '3日内到期积分',
      value: formatNumber(summary?.expiring3d),
      delta: `7 日内 ${formatNumber(summary?.expiring7d)}`,
    },
  ];

  return (
    <PageShell
      title="总览"
      description="凭据池健康度与网关运行状态"
      actions={
        <Button onClick={() => { reload(); runtime.reload(); }}>刷新</Button>
      }
    >
      <Stack>
        <MetricGrid items={metrics} />

        {error && <ErrorState message={error} onRetry={reload} />}

        <Panel
          title="积分额度"
          description="来自各账号权益包快照，已用尽与已过期的包不计入"
          actions={
            <>
              <Chip tone="brand" dot="dot-ok">
                每 60 秒自动刷新
              </Chip>
              <Button
                size="sm"
                onClick={refreshAll}
                disabled={credits.loading}
              >
                {credits.loading ? '刷新中…' : '立即刷新'}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 grid-cols-2 items-start">
              <div
                className="rounded-lg border px-3.5 py-3 min-w-0"
                style={{ borderColor: 'var(--rg-border)' }}
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-aux font-medium" style={{ color: 'var(--rg-text-secondary)' }}>
                    可用额度
                  </span>
                  <span className="h-px flex-1" style={{ background: 'var(--rg-border)' }} />
                </div>
                <div className="font-metric text-[28px] leading-tight">
                  {formatNumber(credit.total)}
                </div>
                <div className="mt-1 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                  覆盖 {credit.accounts} 个账号 · {credit.packs} 个可用权益包
                </div>
              </div>

              <div
                className="rounded-lg border px-3.5 py-3 min-w-0"
                style={{ borderColor: 'var(--rg-border)' }}
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-aux font-medium" style={{ color: 'var(--rg-text-secondary)' }}>
                    今日消耗
                  </span>
                  <span className="h-px flex-1" style={{ background: 'var(--rg-border)' }} />
                  {credit.expiring > 0 && (
                    <Chip tone="warn" dot="dot-cool">
                      7 日内到期 {formatNumber(credit.expiring)}
                    </Chip>
                  )}
                </div>
                <div className="font-metric text-[28px] leading-tight">
                  {formatNumber(credits.data?.totalUsed)}
                </div>
                <div className="mt-1 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                  {credit.unlimited > 0
                    ? `另有 ${credit.unlimited} 个不限量包`
                    : '按各账号快照差分统计'}
                </div>
              </div>
            </div>

            <div className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              不限量包不计入金额，仅按个数统计；消耗量来自余额刷新时写入的快照差分，未刷新过的账号不计入。
            </div>
          </div>
        </Panel>

        <Panel title="账号池" description="按账号标识与最近操作排序" flush>
          {loading && !summary ? (
            <LoadingBlock />
          ) : accounts.length === 0 ? (
            <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              暂无账号数据
            </div>
          ) : (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">账号</th>
                  <th className="th">状态</th>
                  <th className="th">来源</th>
                  <th className="th cell-num">可用积分</th>
                  <th className="th">最近选用</th>
                  <th className="th">最近签到</th>
                  <th className="th cell-num">错误数</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const state = accountState(a);
                  const cooling = state === 'cool' ? coolRemaining(a.coolUntil) : null;
                  // 单账号可用额度：与上方汇总同口径（已用尽/已过期不计），无包时回退 balance
                  const perAccount = perAccountCredits.get(a.id);
                  const hasPacks = !!perAccount && (perAccount.packs > 0 || perAccount.unlimited > 0);
                  return (
                    <tr key={a.id} className="row-hover">
                      <td className="td font-mono text-[12px]">{a.label || a.id}</td>
                      <td className="td">
                        <Chip tone="neutral" dot={STATE_DOT_CLASS[state]}>
                          {STATE_LABEL[state]}
                        </Chip>
                        {cooling && (
                          <span className="ml-1.5 text-[11px] font-mono" style={{ color: 'var(--rg-state-warning)' }}>
                            {cooling}
                          </span>
                        )}
                      </td>
                      <td className="td">{a.source || a.edition || '—'}</td>
                      <td className="td cell-num">
                        {hasPacks ? (
                          <>
                            {formatNumber(perAccount.total)}
                            {perAccount.unlimited > 0 && (
                              <span className="ml-1 text-[11px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                                +{perAccount.unlimited}不限量
                              </span>
                            )}
                          </>
                        ) : (
                          formatNumber(a.balance)
                        )}
                      </td>
                      <td className="td font-mono text-[12px]">{formatTime(a.lastPickedAt)}</td>
                      <td className="td font-mono text-[12px]">{formatTime(a.lastCheckinAt)}</td>
                      <td className="td cell-num">{formatNumber(a.errorCount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="运行状态" description="来自 /v1/admin/runtime">
          {runtime.error ? (
            <ErrorState message={runtime.error} onRetry={runtime.reload} />
          ) : !runtime.data ? (
            <LoadingBlock />
          ) : (
            <KeyValue
              rows={[
                {
                  k: '调度器',
                  v: (
                    <span className="inline-flex items-center gap-1.5">
                      <i className={`dot ${runtime.data.status?.scheduler?.enabled ? 'dot-ok' : 'dot-off'}`} />
                      {runtime.data.status?.scheduler?.enabled ? '开启' : '关闭'}
                    </span>
                  ),
                },
                { k: '下次签到', v: <span className="font-mono">{formatTime(runtime.data.status?.scheduler?.nextCheckinAt)}</span> },
                { k: '粘性条目', v: <span className="font-mono">{formatNumber(runtime.data.status?.sticky?.entries)}</span> },
                { k: '不可用模型', v: <span className="font-mono">{formatNumber(runtime.data.status?.models?.unavailable)}</span> },
                { k: '运行时长', v: <span className="font-mono">{formatUptime(runtime.data.status?.uptimeSec)}</span> },
                { k: '节点', v: <span className="font-mono">{runtime.data.status?.node || '—'}</span> },
                { k: '池化策略', v: <span className="font-mono">{runtime.data.status?.pool?.strategy || '—'}</span> },
                { k: '通知', v: formatBoolean(runtime.data.notify?.enabled) },
                { k: '管理密钥分离', v: formatBoolean(runtime.data.keys?.adminSeparated) },
              ]}
            />
          )}
        </Panel>
      </Stack>
    </PageShell>
  );
}

/** 供其他模块复用的状态映射，避免各处重复定义映射表。 */
export { STATE_PILL_CLASS };

/**
 * 总览页：今天的额度、账号健康与待处理事项。
 *
 * 约束（勿违背）：本页不复制凭据池的账号表格，也不复制运维页的运行状态——
 * 两者在各自页面都是完整版本。发现异常请链接过去处理。
 */
import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Account } from '../../shared/api/types';
import { useAuth } from '../../shared/api/auth';
import { getCreditHistory } from '../../shared/api/stats';
import { useSummaryStore } from '../../shared/api/SummaryProvider';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { useBalanceAutoRefresh } from '../../shared/hooks/useBalanceAutoRefresh';
import { creditTotals, keepaliveOf } from '../accounts/accountPacks';
import { accountState, formatNumber } from '../../shared/lib/format';
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  LoadingBlock,
  MetricGrid,
  Panel,
} from '../../shared/ui';
import { PageShell, Stack } from '../../shared/ui/PageShell';

export default function OverviewPage() {
  const { key } = useAuth();
  const navigate = useNavigate();
  const { data: summary, loading, error, reload } = useSummaryStore();

  const credits = useAsyncData(
    (signal) => getCreditHistory(1, key, signal),
    [key],
    { enabled: !!key },
  );

  // 页面可见时每 60 秒触发一次真实余额查询，刷新后重读汇总与消耗统计。
  // reload 均为 useCallback 稳定引用，因此本回调只随它们变化。
  const { reload: reloadCredits } = credits;
  const refreshAll = useCallback(() => {
    reload();
    reloadCredits();
  }, [reload, reloadCredits]);
  useBalanceAutoRefresh(key, refreshAll);

  // 派生值不落 state，随 summary 变化即时算出
  const accounts = useMemo<Account[]>(() => summary?.accounts ?? [], [summary]);
  const credit = useMemo(() => creditTotals(accounts), [accounts]);

  /** 需要主人处理的异常：需要重新登录、冷却中、已停用。 */
  const issues = useMemo(() => {
    let needLogin = 0;
    let cooling = 0;
    let disabled = 0;
    for (const a of accounts) {
      if (keepaliveOf(a).tone === 'danger') needLogin += 1;
      const st = accountState(a);
      if (st === 'cool') cooling += 1;
      else if (st === 'off') disabled += 1;
    }
    return { needLogin, cooling, disabled, total: needLogin + cooling + disabled };
  }, [accounts]);

  const metrics = [
    { key: '凭据总数', value: formatNumber(summary?.total), delta: '含 Trae / WorkBuddy / ZCode' },
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
      description="今天的额度、账号健康与待处理事项"
      actions={<Button onClick={refreshAll}>刷新</Button>}
    >
      <Stack>
        <MetricGrid items={metrics} />

        {error && <ErrorState message={error} onRetry={reload} />}

        <Panel
          title="积分额度"
          description="来自各账号权益包快照；已用尽与已过期的包不计入"
          actions={
            <>
              <Chip tone="brand" dot="dot-ok">
                每 60 秒自动刷新
              </Chip>
              <Button size="sm" onClick={refreshAll} disabled={credits.loading}>
                {credits.loading ? '刷新中…' : '立即刷新'}
              </Button>
            </>
          }
        >
          {credits.loading && !credits.data ? (
            <LoadingBlock />
          ) : (
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
                  {credit.unlimited > 0 ? ` · 另有 ${credit.unlimited} 个不限量包` : ''}
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
                  按各账号余额刷新时写入的快照差分统计
                </div>
              </div>
            </div>
          )}
          <div className="mt-3 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
            不限量包不计入金额，仅按个数统计；ZCode 的 token 额度与积分是两套口径，不并入本页。
          </div>
        </Panel>

        {loading && !summary ? (
          <Panel title="待处理">
            <LoadingBlock />
          </Panel>
        ) : accounts.length === 0 ? (
          <Panel title="待处理">
            <EmptyState
              label="还没有接入任何账号。"
              hint="接入至少一个上游账号后，这里会显示需要处理的事项。"
              action={{ label: '接入第一个账号', onClick: () => navigate('/credentials') }}
            />
          </Panel>
        ) : (
          <Panel
            title="待处理"
            description={issues.total === 0 ? '当前没有需要处理的异常' : undefined}
            actions={
              <>
                {issues.needLogin > 0 && (
                  <Chip tone="danger" dot="dot-error">
                    {issues.needLogin} 个账号需重新登录
                  </Chip>
                )}
                {issues.cooling > 0 && (
                  <Chip tone="warn" dot="dot-cool">
                    {issues.cooling} 个账号冷却中
                  </Chip>
                )}
                {issues.disabled > 0 && (
                  <Chip tone="neutral" dot="dot-off">
                    {issues.disabled} 个账号已停用
                  </Chip>
                )}
                <Button size="sm" onClick={() => navigate('/credentials')}>
                  去凭据池处理
                </Button>
              </>
            }
          >
            {issues.total === 0 ? (
              <EmptyState
                label={`全部 ${accounts.length} 个账号都在正常调度。`}
                hint="账号掉线或额度临期时会在这里出现提示。"
              />
            ) : (
              <div className="text-[12px]" style={{ color: 'var(--rg-text-secondary)' }}>
                「需重新登录」的账号无法自动恢复，需要重新导入凭据或重新登录；
                冷却中的账号会在冷却结束后自动回到调度池。
              </div>
            )}
          </Panel>
        )}

        <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
          <button
            type="button"
            className="underline"
            style={{ color: 'var(--rg-brand-600)' }}
            onClick={() => navigate('/ops')}
          >
            查看运行状态
          </button>
          <span>·</span>
          <button
            type="button"
            className="underline"
            style={{ color: 'var(--rg-brand-600)' }}
            onClick={() => navigate('/token-stats')}
          >
            查看用量与成本
          </button>
        </div>
      </Stack>
    </PageShell>
  );
}
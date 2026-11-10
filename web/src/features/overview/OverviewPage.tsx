/**
 * 总览页：今天的额度、账号健康与待处理事项。
 *
 * 约束：本页不复制凭据池的账号表格，也不复制运维页的运行状态——两者在各自页面
 * 都是完整版本，发现异常请链接过去处理。
 *
 * 三个额度指标都可展开看构成（2026-11-09 需求）：
 *   - 可用额度 → 按平台各自的总额度（四套计量分别展示，不相加）
 *   - 今日消耗 → 按平台 → 按账号
 *   - 即将到期 → 哪些账号、到期多少积分（可切 3 / 7 / 30 天窗口）
 *
 * 「今日消耗」只覆盖积分口径。后端从 2026-10 起刻意不把 ZCode 的 token、
 * Qoder 的配额、Raccoon 的分池写进 credit_history（曾把今日消耗抬高 4 个数量级），
 * 所以这三类平台在这里标「未纳入统计」，而不是编一个 0 出来。
 *
 * 「即将到期」需要完整 packs，列表端点是 slim（只有聚合值），
 * 因此展开时才按账号拉详情（GET /v1/credentials/:id），并做并发上限。
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Account } from '../../shared/api/types';
import { useAuth } from '../../shared/api/auth';
import { getAccount } from '../../shared/api/credentials';
import { getCreditHistory } from '../../shared/api/stats';
import { useSummaryStore } from '../../shared/api/SummaryProvider';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { useBalanceAutoRefresh } from '../../shared/hooks/useBalanceAutoRefresh';
import { accountState, formatNumber } from '../../shared/lib/format';
import {
  amountByPlatform,
  creditShare,
  EXPIRY_WINDOWS,
  expiringAccounts,
  expiringTotals,
  usageByPlatform,
  type ExpiryWindow,
} from '../../shared/lib/overview-detail';
import { Button, Chip, EmptyState, ErrorState, LoadingBlock, Panel, Segmented } from '../../shared/ui';
import { PageShell, Stack } from '../../shared/ui/PageShell';
import { DetailState, MetricCard } from './MetricCard';
import { ShareBar } from './ShareBar';

export default function OverviewPage() {
  const { key } = useAuth();
  const navigate = useNavigate();
  const { data: summary, loading, error, reload } = useSummaryStore();

  const credits = useAsyncData(
    (signal) => getCreditHistory(1, key, signal),
    [key],
    { enabled: !!key },
  );

  /**
   * 到期明细所需的完整 packs：按账号懒加载。
   *
   * 只在用户展开「即将到期」时才开始拉（`expiryEnabled`），且只拉当前账号清单。
   * 详情端点单账号 4.7~10.3 KB（实测），23 个账号约 150 KB —— 一次性打开
   * 总览页不该付这个成本，所以必须按需。
   */
  const [expiryEnabled, setExpiryEnabled] = useState(false);
  const expiryDetails = useAsyncData(
    async (signal) => {
      const ids = (summary?.accounts ?? []).map((a) => a.id);
      const out: Account[] = [];
      // 并发上限 4：23 个账号一次全发会把浏览器连接池占满
      const queue = [...ids];
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
          const id = queue.shift();
          if (!id || signal.aborted) return;
          try {
            out.push(await getAccount(id, key, signal));
          } catch {
            /* 单账号失败不影响其余：该账号在明细里显示「读取失败」 */
          }
        }
      });
      await Promise.all(workers);
      return out;
    },
    [key, summary?.accounts],
    { enabled: !!key && expiryEnabled },
  );

  const [expiryWindow, setExpiryWindow] = useState<ExpiryWindow>(7);

  // 页面可见时每 60 秒触发一次真实余额查询，重新拉取后重读汇总与消耗统计。
  const { reload: reloadCredits } = credits;
  const refreshAll = useCallback(() => {
    reload();
    reloadCredits();
  }, [reload, reloadCredits]);
  useBalanceAutoRefresh(key, refreshAll);

  // 派生值不写入 state，随 summary 变化即时算出
  const accounts = useMemo<Account[]>(() => summary?.accounts ?? [], [summary]);

  /* ---------- ① 可用额度：按平台 ---------- */
  const amountRows = useMemo(() => amountByPlatform(accounts), [accounts]);
  /** 积分口径合计（唯一可相加的口径：Trae + WorkBuddy）。 */
  const creditTotal = useMemo(() => {
    let total = 0;
    for (const r of amountRows) {
      if (r.unit !== '积分') continue;
      // Raccoon 也是「积分」字样，但它是分池日清，单列一行、不并入
      if (r.platform === 'raccoon') continue;
      total += r.amount ?? 0;
    }
    return Math.round(total * 100) / 100;
  }, [amountRows]);
  /** 占比序列：卡面下方那条混合条的数据源，口径与 creditTotal 一致。 */
  const share = useMemo(() => creditShare(amountRows), [amountRows]);

  /* ---------- ② 今日消耗：按平台 → 按账号 ---------- */
  const usageRows = useMemo(
    () => usageByPlatform(accounts, credits.data?.data ?? []),
    [accounts, credits.data],
  );
  const usageTotal = useMemo(
    () => Math.round(usageRows.reduce((s, r) => s + r.amount, 0) * 100) / 100,
    [usageRows],
  );

  /* ---------- ③ 即将到期：按账号 ---------- */
  const expiryRows = useMemo(() => {
    const full = expiryDetails.data ?? [];
    // 详情没拉到之前，用列表里的 slim 数据也能算出「最紧迫的天数」，
    // 但金额需要完整 packs，所以只在拿到明细后计算金额
    return expiringAccounts(full, expiryWindow);
  }, [expiryDetails.data, expiryWindow]);
  const expiryTotalsByUnit = useMemo(() => expiringTotals(expiryRows), [expiryRows]);
  /**
   * 到期卡的卡面读数。
   *
   * 未展开时用 summary 的聚合值（后端按 3/7 日算好的积分额度），
   * 展开且已拉到明细后改用明细自己算的值——两者口径相同（都只算 remaining>0），
   * 但明细可以切 3/7/30 天，而 summary 只有 3 与 7。
   *
   * 注意 summary.expiring7d 只统计**积分**口径；切到 30 天窗口时它不适用，
   * 因此展开后的读数一律走明细。
   */
  const expiringHeadValue = useMemo(() => {
    if (expiryDetails.data) {
      const credit = expiryTotalsByUnit.find((x) => x.unit === '积分');
      return formatNumber(credit?.amount ?? 0);
    }
    return formatNumber(summary?.expiring7d ?? 0);
  }, [expiryDetails.data, expiryTotalsByUnit, summary?.expiring7d]);

  /** 卡面副文案：未展开时提示最近一项还有多久，避免「0」被误读成没有额度。 */
  const expiringHint = useMemo(() => {
    if (expiryDetails.data) {
      if (!expiryRows.length) {
        return `当前 ${expiryWindow} 天窗口内没有到期的额度`;
      }
      const soonest = expiryRows[0];
      return `最近一项：${soonest.label} 还有 ${soonest.days} 天（${formatNumber(soonest.amount)} ${soonest.unit}）`;
    }
    return '点开可按 3 / 7 / 30 天查看具体账号';
  }, [expiryDetails.data, expiryRows, expiryWindow]);

  /**
   * 需处理的异常：需重新登录、冷却中、已停用。
   *
   * 「需重新登录」与凭据池同一判据：refreshToken 已过期（账号无法自愈）。
   * 这里直接读 `refreshExpiredAt` 而不是 `keepaliveOf().tone === 'danger'`，
   * 因为后者还要走一遍 pack 解析，而本页对每个账号都要算，没必要。
   */
  const issues = useMemo(() => {
    const now = Date.now();
    let needLogin = 0;
    let cooling = 0;
    let disabled = 0;
    for (const a of accounts) {
      const st = accountState(a);
      if (st === 'cool') cooling += 1;
      else if (st === 'off') disabled += 1;
      if (a.refreshExpiredAt && new Date(a.refreshExpiredAt).getTime() <= now) needLogin += 1;
    }
    return { needLogin, cooling, disabled, total: needLogin + cooling + disabled };
  }, [accounts]);

  const refreshHint = (
    <Chip tone="brand" dot="dot-ok">
      每 60 秒自动刷新
    </Chip>
  );

  return (
    <PageShell
      title="总览"
      description="今天的额度、账号健康与待处理事项"
      actions={<Button onClick={refreshAll}>刷新</Button>}
    >
      <Stack>
        {error && <ErrorState message={error} onRetry={reload} />}

        {loading && !summary ? (
          <Panel>
            <LoadingBlock />
          </Panel>
        ) : (
          <div className="metric-cards">
            {/* ① 可用额度：点开 = 各平台各自的总额度 */}
            <MetricCard
              label="可用额度"
              value={formatNumber(creditTotal)}
              unit="积分"
              badge={refreshHint}
              hint={`仅 Trae 与 WorkBuddy 可相加；其余三类计量见展开项`}
              defaultOpen={false}
              detail={
                <DetailState
                  loading={false}
                  empty={amountRows.length === 0}
                  emptyHint="还没有接入账号"
                >
                  {/*
                    占比条放在明细最前：先给「谁占大头」，再给逐平台绝对值。
                    顺序反过来就成了「先读 5 行数字、自己心算比例」——那正是
                    用户说「缺乏直观参考性」的字面含义。
                  */}
                  <div className="mb-3">
                    <ShareBar
                      parts={share.parts}
                      total={share.total}
                      unknownPlatforms={share.unknownPlatforms}
                    />
                  </div>
                  <div className="metric-kv">
                    {amountRows.map((r) => {
                      const isCredit = r.unit === '积分' && r.platform !== 'raccoon';
                      return (
                        <div
                          key={r.platform}
                          className={`metric-kv-row${r.known === 0 ? ' is-muted' : ''}`}
                        >
                          <span className="k">
                            {r.label}
                            <span className="ml-1.5" style={{ color: 'var(--rg-text-tertiary)' }}>
                              {r.known}/{r.accounts} 个账号
                            </span>
                            {r.detail && (
                              <span className="ml-1.5" style={{ color: 'var(--rg-text-tertiary)' }}>
                                · {r.detail}
                              </span>
                            )}
                          </span>
                          <span className="v">
                            {r.amount == null ? '未查询' : formatNumber(r.amount)}{' '}
                            <span className="text-unit">{r.unit}</span>
                            {!isCredit && r.amount != null && (
                              <span className="ml-1 text-unit">不计入上方合计</span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                    <div className="metric-kv-row is-total">
                      <span className="k">积分口径合计（Trae + WorkBuddy）</span>
                      <span className="v">
                        {formatNumber(creditTotal)} <span className="text-unit">积分</span>
                      </span>
                    </div>
                  </div>
                  <p className="mt-2 text-aux leading-relaxed" style={{ color: 'var(--rg-text-tertiary)' }}>
                    Token、配额、分池积分是另外三种计量，不能与积分相加，因此分行展示。
                  </p>
                </DetailState>
              }
            />

            {/* ② 今日消耗：点开 = 各平台消耗，再点账号级明细在下一层 */}
            <MetricCard
              label="今日消耗"
              value={credits.loading && !credits.data ? '—' : formatNumber(usageTotal)}
              unit="积分"
              badge={refreshHint}
              hint="按各账号余额刷新时写入的快照差分（credit_history）"
              detail={
                <DetailState
                  loading={credits.loading && !credits.data}
                  error={credits.error}
                  empty={usageRows.length === 0}
                  emptyHint="还没有账号"
                >
                  <div className="metric-kv">
                    {usageRows.map((r) => (
                      <div key={r.platform} className="metric-kv-row">
                        <span className="k">
                          {r.label}
                          <span className="ml-1.5" style={{ color: 'var(--rg-text-tertiary)' }}>
                            {r.notTracked
                              ? '未纳入统计'
                              : `${r.covered}/${r.accounts} 个账号有快照`}
                          </span>
                        </span>
                        <span className="v">
                          {r.notTracked ? (
                            <span style={{ color: 'var(--rg-text-tertiary)' }}>—</span>
                          ) : (
                            <>
                              {formatNumber(r.amount)} <span className="text-unit">积分</span>
                            </>
                          )}
                        </span>
                      </div>
                    ))}
                    <div className="metric-kv-row is-total">
                      <span className="k">积分口径合计</span>
                      <span className="v">
                        {formatNumber(usageTotal)} <span className="text-unit">积分</span>
                      </span>
                    </div>
                  </div>

                  {usageRows.some((r) => r.members.length > 0) && (
                    <details className="mt-2">
                      <summary className="text-aux cursor-pointer" style={{ color: 'var(--rg-brand-600)' }}>
                        按账号查看
                      </summary>
                      <div className="mt-1.5 flex flex-col gap-2">
                        {usageRows
                          .filter((r) => r.members.length > 0)
                          .map((r) => (
                            <div key={r.platform}>
                              <div className="text-aux font-medium" style={{ color: 'var(--rg-text-secondary)' }}>
                                {r.label}
                              </div>
                              <div className="metric-kv">
                                {r.members.map((m) => (
                                  <div key={m.accountId} className="metric-kv-row">
                                    <span className="k" title={m.accountId}>
                                      {m.label}
                                      {!m.covered && (
                                        <span className="ml-1.5" style={{ color: 'var(--rg-text-tertiary)' }}>
                                          本轮无快照
                                        </span>
                                      )}
                                    </span>
                                    <span className="v">
                                      {formatNumber(m.amount)} <span className="text-unit">积分</span>
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                      </div>
                    </details>
                  )}

                  <p className="mt-2 text-aux leading-relaxed" style={{ color: 'var(--rg-text-tertiary)' }}>
                    ZCode 的 Token、Qoder 的配额、Raccoon 的分池积分不写入消耗表
                    （口径隔离），因此不在此统计，也不会被算成 0。
                  </p>
                </DetailState>
              }
            />

            {/* ③ 即将到期：点开 = 哪些账号、到期多少 */}
            <MetricCard
              label={`${expiryWindow} 日内到期`}
              value={expiringHeadValue}
              unit="积分"
              badge={refreshHint}
              hint={expiringHint}
              onExpand={() => setExpiryEnabled(true)}
              detail={
                <div>
                  <Segmented
                    ariaLabel="到期窗口"
                    value={String(expiryWindow) as '3' | '7' | '30'}
                    onChange={(v) => setExpiryWindow(Number(v) as ExpiryWindow)}
                    options={EXPIRY_WINDOWS.map((d) => ({ value: String(d) as '3' | '7' | '30', label: `${d} 天` }))}
                  />
                  <div className="mt-2">
                    <DetailState
                      loading={expiryDetails.loading && !expiryDetails.data}
                      error={expiryDetails.error}
                      empty={expiryRows.length === 0}
                      emptyHint={`${expiryWindow} 日内没有到期的额度`}
                    >
                      <div className="metric-kv">
                        {expiryRows.map((r) => (
                          <div key={r.accountId} className="metric-kv-row">
                            <span
                              className="k"
                              title={`${r.accountId}\n${r.items} 项到期，共 ${formatNumber(r.amount)} ${r.unit}\n${r.names.join('、')}${r.nameVariants > 1 ? ` 等 ${r.nameVariants} 种` : ''}`}
                            >
                              <span
                                style={{
                                  color:
                                    r.days <= 3
                                      ? 'var(--rg-state-error)'
                                      : r.days <= 7
                                        ? 'var(--rg-state-warning)'
                                        : 'var(--rg-text-secondary)',
                                }}
                              >
                                {r.days <= 0 ? '今天' : `${r.days} 天后`}
                              </span>
                              <span className="ml-1.5">{r.label}</span>
                              <span className="ml-1.5" style={{ color: 'var(--rg-text-tertiary)' }}>
                                {r.platformLabel} · {r.items} 项
                              </span>
                            </span>
                            <span className="v">
                              {formatNumber(r.amount)} <span className="text-unit">{r.unit}</span>
                            </span>
                          </div>
                        ))}
                        {expiryTotalsByUnit.map((t) => (
                          <div key={t.unit} className="metric-kv-row is-total">
                            <span className="k">合计（{t.unit}）</span>
                            <span className="v">
                              {formatNumber(t.amount)} <span className="text-unit">{t.unit}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                      <p className="mt-2 text-aux leading-relaxed" style={{ color: 'var(--rg-text-tertiary)' }}>
                        只统计仍未用尽的额度；已用尽的包到期不造成损失，不计入。
                        Raccoon 的每日积分次日清零，没有「N 天后到期」。
                      </p>
                    </DetailState>
                  </div>
                </div>
              }
            />
          </div>
        )}

        {accounts.length === 0 ? (
          <Panel title="待处理">
            <EmptyState
              label="还没有接入任何账号"
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
                label={`全部 ${accounts.length} 个账号都在正常调度`}
                hint="账号掉线或额度临期时会在这里出现提示。"
              />
            ) : (
              <div className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
                「需重新登录」的账号无法自动恢复，需要重新导入凭据或重新登录；
                冷却中的账号会在冷却结束后自动回到调度池。
              </div>
            )}
          </Panel>
        )}

        <div className="flex items-center gap-2 text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
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
          <span>·</span>
          <button
            type="button"
            className="underline"
            style={{ color: 'var(--rg-brand-600)' }}
            onClick={() => navigate('/credentials')}
          >
            去凭据池看逐账号权益
          </button>
        </div>
      </Stack>
    </PageShell>
  );
}

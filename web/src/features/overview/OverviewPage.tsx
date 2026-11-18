/**
 * 总览页：今天的额度、账号健康与待处理事项。
 *
 * 约束：本页不复制凭据池的账号表格，也不复制运维页的运行状态——两者在各自页面
 * 都是完整版本，发现异常请链接过去处理。
 *
 * 三个额度指标都可展开看构成（2026-11-09 需求）：
 *   - 可用额度 → 按平台各自的总额度（四种口径分别展示，不相加）
 *   - 今日消耗 → 按平台 → 按账号
 *   - 即将到期 → 哪些账号、到期多少额度（可切 3 / 7 / 30 天窗口）
 *
 * 计量口径（2026-11-17 订正。此前本页与凭据池把 Qoder 标成「配额」、
 * Raccoon 标成「points」，而同一行的说明又写「赠送 2,587」「奖励积分 / 每日积分」
 * —— 一个数两个名字，读的人只能认为计量列在骗他）：
 *   - 除 ZCode 按 Token 计量外，Trae / WorkBuddy / Qoder / Raccoon 的上游单位
 *     **都是积分**，只是各平台积分价值不同、三类积分之间不可换算；
 *   - 因此计量列统一写「积分」（ZCode 写「Token」），差别写在口径说明里；
 *   - 所有过滤 / 分组 / 合计一律走内部口径键 `caliber`（credit / token / quota /
 *     points），**不走展示名字符串**：三个「积分」若按名字分组，合计会把
 *     不可相加的三类加成一个没有意义的数。
 *
 * 「今日消耗」只覆盖可累积积分（credit_history）。后端从 2026-10 起刻意不把
 * ZCode 的 token、Qoder 的两段积分、Raccoon 的日清积分写进这张表
 * （曾把今日消耗抬高 4 个数量级），所以这三类平台标「未纳入统计」，
 * 而不是编一个 0 出来。
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
import { accountState, formatFixed, formatNumber } from '../../shared/lib/format';
import { isCumulativeCredit } from '../../shared/lib/entitlement';
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
import { DetailState, MetricCard, MetricPanel } from './MetricCard';
import { ShareBar } from './ShareBar';

/** 手风琴的展开键。同时只开一个，null 表示全部收起。 */
type MetricKey = 'credit' | 'usage' | 'expiry';

export default function OverviewPage() {
  const { key } = useAuth();
  const navigate = useNavigate();
  const { data: summary, loading, error, reload } = useSummaryStore();
  /**
   * 单开手风琴。
   *
   * 为什么是手风琴而不是三张卡各自独立开合：三张卡的明细都是整行面板，
   * 允许同时展开会让页面变成三段互不相干的长内容，「当前在看哪一项」
   * 需要靠滚动位置猜。手风琴强制一次只回答一个问题。
   */
  const [openMetric, setOpenMetric] = useState<MetricKey | null>(null);
  const toggleMetric = useCallback(
    (k: MetricKey) => setOpenMetric((cur) => (cur === k ? null : k)),
    [],
  );

  const credits = useAsyncData(
    (signal) => getCreditHistory(1, key, signal),
    [key],
    { enabled: !!key },
  );

  /**
   * 到期明细所需的完整 packs：按账号懒加载。
   *
   * 只在用户展开「即将到期」时才开始拉（`expiryEnabled`），且只拉当前账号清单。
   * 详情端点单账号 4.7～10.3 KB（实测），23 个账号约 150 KB —— 一次性打开
   * 总览页不该付这个成本，所以必须按需。
   *
   * expiryEnabled 由 openMetric 派生（手风琴唯一事实源），
   * 不再另设一份独立的展开态。
   */
  const expiryEnabled = openMetric === 'expiry';
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
  /**
   * 可累积积分合计（唯一可相加的口径：Trae + WorkBuddy）。
   *
   * 判据走 `caliber`，不走 `unit`：Qoder 与 Raccoon 的展示名同样是「积分」，
   * 按名字筛会把它们加进来（2026-11-17 之前的写法是
   * `unit === '积分' && platform !== 'raccoon'`，靠平台名兜住 Raccoon，
   * 而 Qoder 一旦展示成「积分」就会被误并）。
   */
  const creditTotal = useMemo(() => {
    let total = 0;
    for (const r of amountRows) {
      if (!isCumulativeCredit(r.caliber)) continue;
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
  const expiryTotalsByCaliber = useMemo(() => expiringTotals(expiryRows), [expiryRows]);
  /**
   * 到期卡的卡面读数。
   *
   * 未展开时用 summary 的聚合值（后端按 3/7 日算好的可累积积分额度），
   * 展开且已拉到明细后改用明细自己算的值——两者口径相同（都只算 remaining>0），
   * 但明细可以切 3/7/30 天，而 summary 只有 3 与 7。
   *
   * 读数只取 `caliber === 'credit'` 那一组（与 summary.expiring7d 同口径），
   * 切到 30 天窗口时 summary 不适用，因此展开后的读数一律走明细。
   * 其余口径（Qoder 两段积分 / ZCode Token）不进这个数：它们与 Trae 积分
   * 不同值，加进卡面读数会让「到期」与「可用额度」两张卡的单位对不上。
   */
  const expiringHeadValue = useMemo(() => {
    if (expiryDetails.data) {
      const credit = expiryTotalsByCaliber.find((x) => x.caliber === 'credit');
      return formatNumber(credit?.amount ?? 0);
    }
    return formatNumber(summary?.expiring7d ?? 0);
  }, [expiryDetails.data, expiryTotalsByCaliber, summary?.expiring7d]);
  /**
   * 到期卡读数之外的口径。
   *
   * 卡面那个数只取 credit 一组（与 summary.expiring7d 同口径）。若明细里还
   * 出现了别的口径在到期，必须在副文案说出来 —— 否则「7 日内到期 X 积分」
   * 会被读成「总共就这些要到期」，而下面表格里另有 Qoder 的两段积分在到期。
   */
  const expiringOtherCalibers = useMemo(
    () => expiryTotalsByCaliber.filter((x) => x.caliber !== 'credit'),
    [expiryTotalsByCaliber],
  );

  /** 卡面副文案：未展开时提示最近一项还有多久，避免「0」被误读成没有额度。 */
  const expiringHint = useMemo(() => {
    if (expiryDetails.data) {
      if (!expiryRows.length) {
        return `当前 ${expiryWindow} 天窗口内没有到期的额度`;
      }
      const soonest = expiryRows[0];
      const others = expiringOtherCalibers.length
        ? `；另有 ${expiringOtherCalibers
            .map((x) => `${x.unit} ${formatNumber(x.amount)}`)
            .join(' / ')} 到期，单列不并入`
        : '';
      return `最近一项：${soonest.label} 还有 ${soonest.days} 天（${formatNumber(soonest.amount)} ${soonest.unit}）${others}`;
    }
    return '点开可按 3 / 7 / 30 天查看具体账号';
  }, [expiryDetails.data, expiryRows, expiryWindow, expiringOtherCalibers]);

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
          <>
            {/*
              三张卡固定等高，只做触发器；明细在下方以整行面板呈现（单开）。
              gap-4 由外部 Stack 提供，这里只负责卡与面板之间的 12px 间隔。
            */}
            <div className="flex flex-col gap-3">
              <div className="metric-cards">
                {/* ① 可用额度 */}
                <MetricCard
                  label="可用额度"
                  value={formatFixed(creditTotal, 2)}
                  unit="积分"
                  hint="只含 Trae + WorkBuddy 的可累积积分；Qoder / Raccoon 的积分不同值，ZCode 是 Token，均单列不相加"
                  panelId="overview-panel-credit"
                  open={openMetric === 'credit'}
                  onToggle={() => toggleMetric('credit')}
                />

                {/* ② 今日消耗 */}
                <MetricCard
                  label="今日消耗"
                  value={credits.loading && !credits.data ? '—' : formatFixed(usageTotal, 2)}
                  unit="积分"
                  hint="只含可累积积分（credit_history 差分）"
                  panelId="overview-panel-usage"
                  open={openMetric === 'usage'}
                  onToggle={() => toggleMetric('usage')}
                />

                {/* ③ 即将到期 */}
                <MetricCard
                  label={`${expiryWindow} 日内到期`}
                  value={expiringHeadValue}
                  unit="积分"
                  hint={expiringHint}
                  panelId="overview-panel-expiry"
                  open={openMetric === 'expiry'}
                  onToggle={() => toggleMetric('expiry')}
                />
              </div>

              {/* ① 可用额度明细 */}
              {openMetric === 'credit' && (
                <MetricPanel
                  id="overview-panel-credit"
                  title="可用额度 · 构成明细"
                  sub="四种计量不可相加，按计量分组"
                  onClose={() => setOpenMetric(null)}
                >
                  <DetailState empty={amountRows.length === 0} emptyHint="还没有接入账号">
                    {/*
                      占比条在最前：先回答「谁占大头」，再给逐平台绝对值。
                      顺序反过来就变成「先读 5 行数字、自己心算比例」。
                    */}
                    <div className="mb-4">
                      <ShareBar
                        parts={share.parts}
                        total={share.total}
                        unknownPlatforms={share.unknownPlatforms}
                        showTotal={false}
                      />
                    </div>
                    <CreditTable rows={amountRows} creditTotal={creditTotal} />
                  </DetailState>
                </MetricPanel>
              )}

              {/* ② 今日消耗明细 */}
              {openMetric === 'usage' && (
                <MetricPanel
                  id="overview-panel-usage"
                  title="今日消耗 · 构成明细"
                  sub="只覆盖可累积积分（credit_history 只写 Trae / WorkBuddy）"
                  onClose={() => setOpenMetric(null)}
                >
                  <DetailState
                    loading={credits.loading && !credits.data}
                    error={credits.error}
                    empty={usageRows.length === 0}
                    emptyHint="还没有账号"
                  >
                    <UsageTable rows={usageRows} total={usageTotal} />
                    {usageRows.some((r) => r.members.length > 0) && (
                      <details className="mt-4">
                        <summary
                          className="text-aux cursor-pointer"
                          style={{ color: 'var(--rg-brand-600)' }}
                        >
                          按账号查看
                        </summary>
                        <div className="mt-2 flex flex-col gap-3">
                          {usageRows
                            .filter((r) => r.members.length > 0)
                            .map((r) => (
                              <div key={r.platform}>
                                <div
                                  className="text-aux font-medium mb-1"
                                  style={{ color: 'var(--rg-text-secondary)' }}
                                >
                                  {r.label}
                                </div>
                                <table className="detail-table">
                                  <tbody>
                                    {r.members.map((m) => (
                                      <tr key={m.accountId}>
                                        <td className="col-name" title={m.accountId}>
                                          {m.label}
                                        </td>
                                        <td className="col-unit">{r.unit}</td>
                                        <td className="col-num">{formatFixed(m.amount, 2)}</td>
                                        <td className="col-note">
                                          {!m.covered && '本轮无快照'}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            ))}
                        </div>
                      </details>
                    )}
                  </DetailState>
                </MetricPanel>
              )}

              {/* ③ 即将到期明细 */}
              {openMetric === 'expiry' && (
                <MetricPanel
                  id="overview-panel-expiry"
                  title="即将到期 · 按账号"
                  onClose={() => setOpenMetric(null)}
                >
                  <div className="mb-3">
                    <Segmented
                      ariaLabel="到期窗口"
                      value={String(expiryWindow) as '3' | '7' | '30'}
                      onChange={(v) => setExpiryWindow(Number(v) as ExpiryWindow)}
                      options={EXPIRY_WINDOWS.map((d) => ({
                        value: String(d) as '3' | '7' | '30',
                        label: `${d} 天`,
                      }))}
                    />
                  </div>
                  <DetailState
                    loading={expiryDetails.loading && !expiryDetails.data}
                    error={expiryDetails.error}
                    empty={expiryRows.length === 0}
                    emptyHint={`${expiryWindow} 日内没有到期的额度`}
                  >
                    <ExpiryTable rows={expiryRows} totals={expiryTotalsByCaliber} />
                  </DetailState>
                </MetricPanel>
              )}
            </div>
          </>
        )}

        {accounts.length === 0 ? (
          <Panel title="待处理">
            <EmptyState
              label="还没有接入任何账号"
              hint="接入上游账号后，这里显示待处理事项。"
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

/* ---------------------------------------------------------------------------
 * 明细表
 * ---------------------------------------------------------------------------
 *
 * 三张展开区共用同一套骨架：名称 / 计量 / 数值 / 说明。
 * 之所以抽成表格而不是继续用原来的两栏 flex：
 *   1. 数值列定宽右对齐 + tabular-nums，五行数字才能纵向比较；
 *   2. 计量单独成列，单位不再混在数值列里；
 *   3. 分组表头只写一次「不并入合计」的理由，替代原来每行重复的「不计入合计」。
 *
 * 计量列的取值规则（2026-11-17 订正）：除 ZCode 是 Token，四个平台上游都按
 * 积分计量，因此这一列就写「积分」。**分组与合计不读这一列**，读 `caliber`
 * 内部键 —— 「都是积分」不等于「可以相加」，各平台积分价值不同。
 */

/** ① 可用额度：可相加的可累积积分在上，其余口径归入分组表头之下。 */
function CreditTable({
  rows,
  creditTotal,
}: {
  rows: ReturnType<typeof amountByPlatform>;
  creditTotal: number;
}) {
  // 与 creditTotal 同源：判据是 caliber，不是展示名
  const isCredit = (r: (typeof rows)[number]) => isCumulativeCredit(r.caliber);
  const creditRows = rows.filter(isCredit);
  const otherRows = rows.filter((r) => !isCredit(r));

  return (
    <table className="detail-table">
      <thead>
        <tr>
          <th scope="col" className="col-name">
            平台
          </th>
          <th scope="col" className="col-unit">
            计量
          </th>
          <th scope="col" className="col-num">
            数值
          </th>
          <th scope="col" className="col-note">
            说明
          </th>
        </tr>
      </thead>
      <tbody>
        {creditRows.map((r) => (
          <tr key={r.platform} className={r.known === 0 ? 'is-muted' : undefined}>
            <td className="col-name">{r.label}</td>
            <td className="col-unit" title={r.caliberNote}>
              {r.unit}
            </td>
            <td className="col-num">{r.amount == null ? '未查询' : formatFixed(r.amount, 2)}</td>
            <td className="col-note">
              {r.known}/{r.accounts} 个账号{r.detail ? ` · ${r.detail}` : ''}
            </td>
          </tr>
        ))}
        <tr className="detail-total">
          <td className="col-name">合计</td>
          <td className="col-unit">积分</td>
          <td className="col-num">{formatFixed(creditTotal, 2)}</td>
          <td className="col-note">Trae + WorkBuddy 同一单位，可相加</td>
        </tr>

        {otherRows.length > 0 && (
          <tr className="detail-group">
            <th colSpan={4} scope="colgroup">
              以下口径不并入上方合计：同为积分但各平台价值不同，或与积分不同维
            </th>
          </tr>
        )}
        {otherRows.map((r) => (
          <tr key={r.platform} className={r.known === 0 ? 'is-muted' : undefined}>
            <td className="col-name">{r.label}</td>
            <td className="col-unit" title={r.caliberNote}>
              {r.unit}
            </td>
            <td className="col-num">{r.amount == null ? '未查询' : formatFixed(r.amount, 2)}</td>
            <td className="col-note">
              <span style={{ color: 'var(--rg-text-secondary)' }}>{r.caliberNote}</span>
              {` · ${r.known}/${r.accounts} 个账号`}
              {r.detail ? ` · ${r.detail}` : ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** ② 今日消耗：按平台，未纳入统计的平台显式标出而非补 0。 */
function UsageTable({
  rows,
  total,
}: {
  rows: ReturnType<typeof usageByPlatform>;
  total: number;
}) {
  return (
    <table className="detail-table">
      <thead>
        <tr>
          <th scope="col" className="col-name">
            平台
          </th>
          <th scope="col" className="col-unit">
            计量
          </th>
          <th scope="col" className="col-num">
            今日消耗
          </th>
          <th scope="col" className="col-note">
            说明
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.platform} className={r.notTracked ? 'is-muted' : undefined}>
            <td className="col-name">{r.label}</td>
            {/*
              计量列写该平台**自己的**单位，不再整列硬写「积分」：
              ZCode 是 Token，硬标「积分」等于给一个没被统计的数贴错单位。
              未纳入统计的行数值列本来就是「—」，单位标自己那个才自洽。
            */}
            <td className="col-unit" title={r.caliberNote}>
              {r.unit}
            </td>
            <td className="col-num">
              {r.notTracked ? '—' : formatFixed(r.amount, 2)}
            </td>
            <td className="col-note">
              {r.notTracked
                ? '不写入消耗表，不按 0 计'
                : `${r.covered}/${r.accounts} 个账号有快照`}
            </td>
          </tr>
        ))}
        <tr className="detail-total">
          <td className="col-name">合计</td>
          <td className="col-unit">积分</td>
          <td className="col-num">{formatFixed(total, 2)}</td>
          <td className="col-note">只含已纳入统计的平台</td>
        </tr>
      </tbody>
    </table>
  );
}

/** ③ 即将到期：紧迫度用文字色表达，天数是排序键也是扫读键。 */
function ExpiryTable({
  rows,
  totals,
}: {
  rows: ReturnType<typeof expiringAccounts>;
  totals: ReturnType<typeof expiringTotals>;
}) {
  return (
    <table className="detail-table">
      <thead>
        <tr>
          <th scope="col" className="col-name">
            账号
          </th>
          <th scope="col" style={{ width: 96 }}>
            到期
          </th>
          <th scope="col" style={{ width: 120 }}>
            平台
          </th>
          <th scope="col" className="col-unit">
            计量
          </th>
          <th scope="col" className="col-num">
            金额
          </th>
          <th scope="col" className="col-note">
            说明
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.accountId}>
            <td className="col-name" title={r.accountId}>
              {r.label}
            </td>
            <td
              style={{
                color:
                  r.days <= 3
                    ? 'var(--rg-state-error)'
                    : r.days <= 7
                      ? 'var(--rg-state-warning)'
                      : 'var(--rg-text-secondary)',
                whiteSpace: 'nowrap',
              }}
            >
              {r.days <= 0 ? '今天' : `${r.days} 天后`}
            </td>
            <td className="col-note">{r.platformLabel}</td>
            <td className="col-unit" title={r.caliberNote}>
              {r.unit}
            </td>
            <td className="col-num">{formatFixed(r.amount, 2)}</td>
            <td
              className="col-note"
              title={`${r.items} 项到期，共 ${formatFixed(r.amount, 2)} ${r.unit}\n${r.names.join('、')}${
                r.nameVariants > 1 ? ` 等 ${r.nameVariants} 种` : ''
              }`}
            >
              {r.items} 项
              {r.nameVariants > 1 ? ` · ${r.nameVariants} 种` : ''}
            </td>
          </tr>
        ))}
        {/*
          合计按 caliber 分组，一行一组。key 也必须用 caliber：
          credit / quota 的展示名同为「积分」，用 t.unit 当 key 会撞出
          两个相同 key 的 <tr>（React 直接报 duplicate key，且渲染顺序不稳）。
        */}
        {totals.map((t) => (
          <tr key={t.caliber} className="detail-total">
            <td className="col-name">合计</td>
            <td colSpan={2} className="col-note">
              只计仍未用尽的额度
            </td>
            <td className="col-unit" title={t.caliberNote}>
              {t.unit}
            </td>
            <td className="col-num">{formatFixed(t.amount, 2)}</td>
            <td className="col-note">{t.caliberNote}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

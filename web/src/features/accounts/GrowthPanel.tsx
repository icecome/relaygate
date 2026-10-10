/**
 * WorkBuddy 成长中心面板（只读版）。
 *
 * 定位说明（为什么没有操作按钮）：
 * 后台定时任务（scheduler.js 的 growth poll，默认每 4h）已经自动执行
 * 旅行/领奖/兑换/抽奖，并通过通知渠道播报结果（如「旅行奖励已领取 +200」）。
 * 原面板暴露了一整套手动写操作（领奖/抽奖/兑换/一键执行），出现两个问题：
 *   1. 与定时任务是同一 job 的第二入口，且自带 4 state + 4 ref 的轮询状态机；
 *   2. 「网关」界面里出现「抽奖」「稀有度」「补登卡」会让任何技术用户
 *      对产品定位产生怀疑（Product Professor P2-001 / USER_COMPLAINTS 角色五）。
 *
 * 现在面板只做两件事：
 *   - 展示各账号的成长状态（连登、抽奖机会、旅行进度），让主人知道
 *     后台任务在干什么、干得怎么样；
 *   - 展示最近一次后台任务运行时间与结果摘要。
 * 需要手动干预的极少数场景走 CLI（node scripts/growth-*.js）或临时开
 * 后台任务的调试入口，不在常驻 UI 里。
 */
import { useAuth } from '../../shared/api/auth';
import { growthLastRun, growthOverview, growthStatusAll, type GrowthOverviewRow, type GrowthStatusRow } from '../../shared/api/growth';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { formatNumber, formatTime } from '../../shared/lib/format';
import { Button, Chip, EmptyState, ErrorState, LoadingBlock, Note, Panel } from '../../shared/ui';

export function GrowthPanel() {
  const { key } = useAuth();

  const statusAll = useAsyncData((signal) => growthStatusAll(key, signal), [key], { enabled: !!key });
  const overview = useAsyncData((signal) => growthOverview(key, signal), [key], { enabled: !!key });
  const lastRun = useAsyncData((signal) => growthLastRun(key, signal), [key], { enabled: !!key });

  const statusRows: GrowthStatusRow[] = statusAll.data?.data ?? [];
  const overviewRows: GrowthOverviewRow[] = overview.data?.data ?? [];

  /** 连登天数（各账号最大值）与抽奖机会（合计）——后台任务的两个关键健康指标。 */
  const maxStreak = Math.max(0, ...overviewRows.map((r) => r.streakDays ?? 0));
  const lotteryChances = overviewRows.reduce((s, r) => s + (r.lotteryChances ?? 0), 0);
  const traveling = statusRows.filter((r) => r.ok && r.state && r.state !== 'idle').length;

  return (
    <>
      <Panel
        title="成长任务运行"
        description="由后台定时任务自动执行（旅行 / 领奖 / 兑换 / 抽奖），结果经通知渠道播报"
        actions={
          <Button size="sm" onClick={() => { statusAll.reload(); overview.reload(); lastRun.reload(); }}>
            刷新
          </Button>
        }
        footer={
          lastRun.data?.ranAt
            ? `上次运行：${formatTime(lastRun.data.ranAt)}`
            : '后台任务尚未运行过（默认每 4 小时一轮，可在「运维 → 定时任务」调整）'
        }
      >
        <div className="flex flex-wrap gap-2">
          <Chip tone="brand" dot="dot-ok">
            可参与账号 {formatNumber(statusAll.data?.total ?? 0)}
          </Chip>
          {traveling > 0 && (
            <Chip tone="ok" dot="dot-ok">
              旅行中 {traveling}
            </Chip>
          )}
          <Chip tone="neutral" dot="dot-cool">
            最长连登 {formatNumber(maxStreak)} 天
          </Chip>
          <Chip tone="neutral" dot="dot-cool">
            抽奖机会 {formatNumber(lotteryChances)}
          </Chip>
        </div>
        {lastRun.data && (lastRun.data.okCount != null || lastRun.data.actions?.length) && (
          <div className="mt-3">
            <div className="text-aux mb-1">上次运行结果</div>
            <div className="text-[12px]" style={{ color: 'var(--rg-text-secondary)' }}>
              {formatNumber(lastRun.data.okCount ?? 0)} 个账号处理成功
              {lastRun.data.failCount ? `，${lastRun.data.failCount} 个失败` : ''}
            </div>
            {lastRun.data.actions && lastRun.data.actions.length > 0 && (
              <ul className="mt-1.5 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                {lastRun.data.actions.slice(0, 5).map((a, i) => (
                  <li key={i}>· {a}</li>
                ))}
                {lastRun.data.actions.length > 5 && (
                  <li>… 另有 {lastRun.data.actions.length - 5} 条</li>
                )}
              </ul>
            )}
          </div>
        )}
      </Panel>

      <Panel title="旅行状态" description="逐账号的当前行程与奖励" flush>
        {statusAll.error ? (
          <ErrorState message={statusAll.error} onRetry={statusAll.reload} />
        ) : statusAll.loading && !statusAll.data ? (
          <LoadingBlock />
        ) : statusRows.length === 0 ? (
          <EmptyState
            label="没有已启用的 WorkBuddy 账号。"
            hint="成长任务只对启用账号生效；接入账号后这里会显示旅行进度。"
          />
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="th">账号</th>
                <th className="th">状态</th>
                <th className="th">位置</th>
                <th className="th">出发</th>
                <th className="th">到达</th>
                <th className="th cell-num">奖励额度</th>
              </tr>
            </thead>
            <tbody>
              {statusRows.map((r) => (
                <tr key={r.accountId} className="row-hover">
                  <td className="td">{r.label}</td>
                  <td className="td">
                    {r.ok ? (
                      <Chip tone="brand">{r.state || '—'}</Chip>
                    ) : (
                      <Chip tone="danger" dot="dot-error">
                        {r.reason ? '查询失败' : '不可用'}
                      </Chip>
                    )}
                  </td>
                  <td className="td">{r.location?.name || '—'}</td>
                  <td className="td font-mono text-[12px]">{formatTime(r.departAt)}</td>
                  <td className="td font-mono text-[12px]">{formatTime(r.arriveAt)}</td>
                  <td className="td cell-num">{formatNumber(r.rewardCredit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="成长概览" description="连登天数与抽奖机会（只读）" flush>
        {overview.error ? (
          <ErrorState message={overview.error} onRetry={overview.reload} />
        ) : overview.loading && !overview.data ? (
          <LoadingBlock />
        ) : overviewRows.length === 0 ? (
          <EmptyState label="暂无成长数据。" hint="后台任务运行一轮后会出现。" />
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="th">账号</th>
                <th className="th cell-num">连登天数</th>
                <th className="th cell-num">抽奖机会</th>
              </tr>
            </thead>
            <tbody>
              {overviewRows.map((r) => (
                <tr key={r.accountId} className="row-hover">
                  <td className="td">{r.label}</td>
                  <td className="td cell-num">{formatNumber(r.streakDays)}</td>
                  <td className="td cell-num">{formatNumber(r.lotteryChances)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Note>
        成长任务由后台定时执行，无需也不提供手动操作入口；奖励到账会经通知渠道播报。
      </Note>
    </>
  );
}
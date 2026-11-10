/**
 * 成长中心（WorkBuddy 专属，只读为主）。
 *
 * 后台定时任务（jobs/growth-auto.js，默认每 4 小时一轮）已自动执行旅行、领奖、
 * 兑换与抽奖，并通过通知渠道播报结果。面板的职责是**看状态**，不是操作。
 *
 * 这次改造针对三个实测问题：
 *
 * 1. 「必须点底部展开」——原实现把 toggle 放在页面工具栏，内容却渲染在
 *    KeepaliveBoard **之后**（页面最底部）。点了以后屏幕一个像素都不动，
 *    用户必须手动滚到底。现在它是页面里的一块，自带收起/展开；
 *
 * 2. 「四张表列同一批账号四遍」——原实现有「成长任务运行」「成长每日汇总」
 *    「旅行状态」「成长概览」四张表，账号名列出现 4 次，连登在两处、旅行状态
 *    在两处。而 daily-progress 的返回体本来就同时含 growth/rewards/cat/
 *    checkin/active —— 四张表读的是同一份数据的四个切片。现在合成一张 8 列表，
 *    细节进行内展开；
 *
 * 3. 「一展开就是 104 次上游请求」——实测 8 个 WB 账号时 overview 40 次 +
 *    status 8 次 + daily 56 次。现在**收起态零上游请求**（只读 last-run 文件），
 *    展开才拉；且三个按钮按既定规范分级：
 *      刷新      = 重读本地（last-run）
 *      强制刷新  = daily-progress({force:true})，跳过 60s TTL 真打上游
 *      立即执行  = 真跑一轮自动化（会写上游）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';import { useAuth } from '../../shared/api/auth';
import { ApiError } from '../../shared/api/http';
import {
  growthAuto,
  growthDailyProgress,
  growthLastRun,
  growthOverview,
  growthProgress,
  growthStatusAll,
  type GrowthDailyRow,
  type GrowthOverviewRow,
  type GrowthStatusRow,
} from '../../shared/api/growth';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { formatNumber, formatTime, platformIdLabel } from '../../shared/lib/format';
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  LoadingBlock,
  Note,
  Panel,
  ProgressBar,
} from '../../shared/ui';
import { useToast } from '../../shared/ui/Toast';

/** 旅行状态的中文映射；未知值回退「未知状态」，不回显内部枚举。 */
const TRAVEL_STATE_LABEL: Record<string, string> = {
  traveling: '旅行中',
  arrived: '待领奖',
  idle: '空闲',
  locked: '未解锁',
  needs_selection: '需选择 Buddy',
};

export function GrowthPanel({ workbuddyCount }: { workbuddyCount: number }) {
  const { key } = useAuth();
  const toast = useToast();

  /** 展开态：默认收起。收起时不发任何上游请求。 */
  const [open, setOpen] = useState(false);

  /**
   * last-run 是纯文件读（cat-trip.js 的 readLastRun），零上游请求，
   * 所以收起态也安全地读它——这是筛选前的唯一数据源。
   */
  const lastRun = useAsyncData((signal) => growthLastRun(key, signal), [key], { enabled: !!key });

  /**
   * 三个展开态请求只在 open 时才启用。
   * `forceNonce` 用计数器而非布尔：布尔翻转会在第二次点击时退回读缓存，
   * 与按钮「每次都强制刷新」的语义不一致。
   */
  const [forceNonce, setForceNonce] = useState(0);
  const daily = useAsyncData(
    (signal) => growthDailyProgress(key, forceNonce > 0, signal),
    [key, forceNonce],
    { enabled: !!key && open },
  );
  const overview = useAsyncData((signal) => growthOverview(key, signal), [key], { enabled: !!key && open });
  const statusAll = useAsyncData((signal) => growthStatusAll(key, signal), [key], { enabled: !!key && open });

  /** 手动执行一轮（写上游）。已有任务在跑时后端回 409。 */
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoStage, setAutoStage] = useState('');
  const autoTaskRef = useRef<string | null>(null);
  const autoTimerRef = useRef<number | null>(null);

  const stopAutoPolling = useCallback(() => {
    if (autoTimerRef.current != null) {
      window.clearInterval(autoTimerRef.current);
      autoTimerRef.current = null;
    }
  }, []);

  useEffect(() => stopAutoPolling, [stopAutoPolling]);

  async function runAuto() {
    if (autoBusy) return;
    setAutoBusy(true);
    setAutoStage('启动中');
    try {
      const r = await growthAuto(key);
      autoTaskRef.current = r.taskId;
      setAutoStage('执行中');
      autoTimerRef.current = window.setInterval(() => {
        const id = autoTaskRef.current;
        if (!id) return;
        void (async () => {
          try {
            const p = await growthProgress(id, key);
            setAutoStage(`执行中 ${p.doneCount}/${p.total}`);
            if (!p.running) {
              stopAutoPolling();
              autoTaskRef.current = null;
              setAutoBusy(false);
              setAutoStage('');
              toast(
                `成长任务完成：${p.okCount} 成功${p.failCount ? ` · ${p.failCount} 失败` : ''}`,
                p.failCount ? 'warn' : 'ok',
              );
              lastRun.reload();
              statusAll.reload();
              overview.reload();
              setForceNonce((n) => n + 1);
            }
          } catch (e) {
            stopAutoPolling();
            autoTaskRef.current = null;
            setAutoBusy(false);
            setAutoStage('');
            toast(e instanceof ApiError ? e.message : '成长任务进度查询失败', 'err');
          }
        })();
      }, 2000);
    } catch (e) {
      setAutoBusy(false);
      setAutoStage('');
      // 409 = 已有任务在跑（调度器或另一窗口），不算系统错误
      const conflict = e instanceof ApiError && e.status === 409;
      toast(e instanceof ApiError ? e.message : '启动成长任务失败', conflict ? 'warn' : 'err');
    }
  }

  const statusRows: GrowthStatusRow[] = statusAll.data?.data ?? [];
  const overviewRows: GrowthOverviewRow[] = overview.data?.data ?? [];
  // useMemo 固定引用：下方 readyRows 以它为依赖，`?? []` 每次渲染都是新数组
  const dailyRows: GrowthDailyRow[] = useMemo(() => daily.data?.data ?? [], [daily.data]);

  /* 收起态摘要：全部来自零上游请求的两个来源 */
  const readyRows = useMemo(
    () => dailyRows.filter((r) => r.status === 'ready'),
    [dailyRows],
  );
  const activeKnown = readyRows.filter((r) => r.active?.todayActive != null);
  const activeToday = activeKnown.filter((r) => r.active?.todayActive === true).length;
  const maxStreak = Math.max(0, ...overviewRows.map((r) => r.streakDays ?? 0));

  const lastRunText = lastRun.data?.ranAt
    ? `上次运行 ${formatTime(lastRun.data.ranAt)}`
    : '尚未运行过';

  return (
    <Panel
      title="成长中心"
      description={`${platformIdLabel('workbuddy')} 专属：旅行 / 领奖 / 连登 / 抽奖由后台定时任务自动执行`}
      flush
    >
      {/* 摘要行：永远可见，高度固定 44px。收起时也不打上游。 */}
      <div className="growth-bar">
        <div className="growth-bar-main">
          <span>
            可参与 <strong>{formatNumber(workbuddyCount)}</strong> 个账号
          </span>
          {open && activeKnown.length > 0 && (
            <span>
              今日活跃{' '}
              <strong style={{ color: activeToday === activeKnown.length ? 'var(--rg-state-success)' : 'var(--rg-state-warning)' }}>
                {activeToday}/{activeKnown.length}
              </strong>
            </span>
          )}
          {open && overviewRows.length > 0 && (
            <span>
              最长连登 <strong>{formatNumber(maxStreak)}</strong> 天
            </span>
          )}
          <span style={{ color: 'var(--rg-text-tertiary)' }}>{lastRunText}</span>
          {lastRun.data?.failCount ? (
            <Chip tone="warn" dot="dot-cool">
              上轮 {lastRun.data.failCount} 个失败
            </Chip>
          ) : null}
        </div>
        <div className="growth-bar-acts">
          <Button size="sm" onClick={runAuto} disabled={autoBusy || workbuddyCount === 0}>
            {autoBusy && autoStage ? autoStage : '立即执行一轮'}
          </Button>
          {open && (
            <Button
              size="sm"
              onClick={() => {
                lastRun.reload();
                setForceNonce((n) => n + 1);
                overview.reload();
                statusAll.reload();
              }}
              disabled={daily.loading}
              title="跳过 60 秒缓存，重新查询上游（会产生真实请求）"
            >
              {daily.loading ? '查询中' : '强制刷新'}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? '收起' : '展开'}
          </Button>
        </div>
      </div>

      {open && (
        <div className="growth-body">
          {workbuddyCount === 0 ? (
            <EmptyState
              label="当前没有 WorkBuddy 账号"
              hint="成长任务（旅行 / 领奖 / 连登 / 抽奖）只有 WorkBuddy 提供，其余平台没有这项能力。"
            />
          ) : daily.error ? (
            <ErrorState message={daily.error} onRetry={daily.reload} />
          ) : daily.loading && !daily.data ? (
            <LoadingBlock label="读取成长明细" />
          ) : dailyRows.length === 0 ? (
            <EmptyState
              label="还没有成长数据"
              hint="点「立即执行一轮」让后台任务跑一次，或稍候等定时任务的结果。"
            />
          ) : (
            <GrowthTable
              dailyRows={dailyRows}
              statusByAccount={new Map(statusRows.map((r) => [r.accountId, r]))}
              overviewByAccount={new Map(overviewRows.map((r) => [r.accountId, r]))}
            />
          )}

          {lastRun.data && (lastRun.data.okCount != null || (lastRun.data.actions?.length ?? 0) > 0) && (
            <div className="mt-3">
              <div className="text-label mb-1">上一轮结果</div>
              <div className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
                {formatNumber(lastRun.data.okCount ?? 0)} 个账号处理成功
                {lastRun.data.failCount ? `，${lastRun.data.failCount} 个失败` : ''}
              </div>
              {(lastRun.data.actions?.length ?? 0) > 0 && (
                <ul className="mt-1.5 text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                  {lastRun.data.actions!.slice(0, 5).map((a, i) => (
                    <li key={i}>· {a}</li>
                  ))}
                  {lastRun.data.actions!.length > 5 && (
                    <li>另有 {lastRun.data.actions!.length - 5} 条未显示</li>
                  )}
                </ul>
              )}
            </div>
          )}

          <Note>
            成长任务默认由后台定时执行；「立即执行一轮」会真实请求上游（派猫 / 领奖 / 兑换 / 抽奖），
            「强制刷新」只重新查询上游状态、不改动任何东西。奖励到账会经通知渠道播报。
          </Note>
        </div>
      )}
    </Panel>
  );
}

/**
 * 单表：一行一个账号，8 列。
 *
 * 合并了原来的四张表。旅行状态与成长概览（Buddy / 能量 / 补登卡 / 抽奖机会）
 * 进行内展开——它们是同一账号的属性，不是需要横向比较的独立维度。
 */
function GrowthTable({
  dailyRows,
  statusByAccount,
  overviewByAccount,
}: {
  dailyRows: GrowthDailyRow[];
  statusByAccount: Map<string, GrowthStatusRow>;
  overviewByAccount: Map<string, GrowthOverviewRow>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th className="th">账号</th>
          <th className="th">成长任务</th>
          <th className="th cell-num">奖励</th>
          <th className="th">今日签到</th>
          <th className="th">今日活跃</th>
          <th className="th cell-num">连登</th>
          <th className="th">Buddy / 旅行</th>
          <th className="th cell-act">明细</th>
        </tr>
      </thead>
      <tbody>
        {dailyRows.map((r) => {
          const isOpen = expanded === r.accountId;
          if (r.status !== 'ready') {
            return (
              <tr key={r.accountId} className="row-hover">
                <td className="td">
                  <span className="truncate" title={r.label}>{r.label}</span>
                </td>
                <td className="td" colSpan={7}>
                  <Chip tone="danger" dot="dot-error">查询失败</Chip>
                  <span className="ml-2 text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                    {r.reason || '上游未返回原因'}
                  </span>
                </td>
              </tr>
            );
          }
          const g = r.growth;
          const rewards = r.rewards;
          const cat = r.cat;
          const ov = overviewByAccount.get(r.accountId);
          const st = statusByAccount.get(r.accountId);

          return (
            <FragmentRow
              key={r.accountId}
              row={r}
              g={g}
              rewards={rewards}
              cat={cat}
              ov={ov}
              st={st}
              open={isOpen}
              onToggle={() => setExpanded((cur) => (cur === r.accountId ? null : r.accountId))}
            />
          );
        })}
      </tbody>
    </table>
  );
}

/** 一行主数据 + 可选的展开行。 */
function FragmentRow({
  row,
  g,
  rewards,
  cat,
  ov,
  st,
  open,
  onToggle,
}: {
  row: GrowthDailyRow;
  g: GrowthDailyRow['growth'];
  rewards: GrowthDailyRow['rewards'];
  cat: GrowthDailyRow['cat'];
  ov?: GrowthOverviewRow;
  st?: GrowthStatusRow;
  open: boolean;
  onToggle: () => void;
}) {
  const taskTitle = g && g.tasks.length > 0
    ? g.tasks
      .map((t) => `${t.title}（${t.current}/${t.target}）${t.state === 'claimed' ? ' 已领取' : t.state === 'completed' ? ' 已完成' : ''}${t.automatable ? '' : ' · 需手动'}`)
      .join('\n')
    : undefined;

  return (
    <>
      <tr className="row-hover" data-open={open ? 'on' : 'off'}>
        <td className="td">
          <span className="truncate" title={row.accountId}>{row.label}</span>
        </td>
        <td className="td" title={taskTitle}>
          {g ? (
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex-1 min-w-[48px]">
                <ProgressBar ratio={g.ratio} tone={g.ratio >= 1 ? 'brand' : 'soft'} />
              </div>
              <span className="font-mono text-aux tabular-nums shrink-0">
                {g.completed}/{g.total}
              </span>
            </div>
          ) : (
            '—'
          )}
          {row.manualTasks && row.manualTasks.length > 0 && (
            <div className="text-aux mt-0.5" style={{ color: 'var(--rg-state-warning)' }} title={row.manualTasks.join('、')}>
              {row.manualTasks.length} 项需真实操作
            </div>
          )}
        </td>
        <td className="td cell-num">
          {rewards ? `${rewards.claimed}/${rewards.total}` : '—'}
          {rewards && rewards.pending > 0 && (
            <span className="ml-1 text-aux" style={{ color: 'var(--rg-state-warning)' }}>
              待领 {rewards.pending}
            </span>
          )}
        </td>
        <td className="td">
          {row.checkin?.source === 'upstream' ? (
            <Chip tone={row.checkin.checkedIn ? 'ok' : 'warn'} dot={row.checkin.checkedIn ? 'dot-ok' : 'dot-cool'}>
              {row.checkin.checkedIn ? '已签到' : '未签到'}
            </Chip>
          ) : (
            <span style={{ color: 'var(--rg-text-tertiary)' }}>未取到</span>
          )}
        </td>
        <td className="td">
          {row.active?.todayActive == null ? (
            <span style={{ color: 'var(--rg-text-tertiary)' }}>未取到</span>
          ) : (
            <Chip tone={row.active.todayActive ? 'ok' : 'warn'} dot={row.active.todayActive ? 'dot-ok' : 'dot-cool'}>
              {row.active.todayActive
                ? `活跃${row.active.todayScore ? ` ${row.active.todayScore} 分` : ''}`
                : '0 分'}
            </Chip>
          )}
        </td>
        <td className="td cell-num">
          {row.active?.streakDays == null ? '—' : formatNumber(row.active.streakDays)}
        </td>
        <td className="td">
          <TravelChip cat={cat} />
        </td>
        <td className="td cell-act">
          <div className="td-actions">
            <Button size="sm" variant="ghost" onClick={onToggle} aria-expanded={open}>
              {open ? '收起' : '明细'}
            </Button>
          </div>
        </td>
      </tr>

      {open && (
        <tr>
          <td className="td" colSpan={8} style={{ background: 'var(--rg-bg-secondary)' }}>
            <div className="flex flex-wrap gap-x-8 gap-y-2 text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
              <span>Buddy：{ov?.buddyName || '未解锁'}{ov?.rarity ? `（${ov.rarity}）` : ''}</span>
              <span>能量：{ov?.energy == null ? '—' : formatNumber(ov.energy)}{ov?.affordable ? ' · 可开箱' : ''}</span>
              <span>补登卡：{formatNumber(ov?.makeupCards)}</span>
              <span>抽奖机会：{formatNumber(ov?.lotteryChances)}</span>
              <span>
                旅行：{cat ? TRAVEL_STATE_LABEL[cat.state] ?? '未知状态' : '—'}
                {st?.location?.name ? ` · ${st.location.name}` : ''}
                {st?.arriveAt ? ` · 到达 ${formatTime(st.arriveAt)}` : ''}
                {st?.rewardCredit != null ? ` · 奖励 ${formatNumber(st.rewardCredit)}` : ''}
              </span>
              {ov?.todayScore != null && <span>今日得分：{ov.todayScore}</span>}
              {row.taskSource === 'v1' && (
                <span style={{ color: 'var(--rg-state-warning)' }}>
                  任务数据来自旧版接口（无进度明细：{row.taskV2Error || '未知原因'}）
                </span>
              )}
            </div>
            {g && g.tasks.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-aux" style={{ color: 'var(--rg-text-tertiary)' }}>
                {g.tasks.map((t) => (
                  <span key={t.taskCode} title={t.guide}>
                    {t.title} {t.current}/{t.target}
                    {t.state === 'claimed' ? ' 已领' : t.state === 'completed' ? ' 完成' : ''}
                    {t.automatable ? '' : '（需手动）'}
                  </span>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function TravelChip({ cat }: { cat: GrowthDailyRow['cat'] }) {
  if (!cat) return <span style={{ color: 'var(--rg-text-tertiary)' }}>—</span>;
  if (cat.state === 'locked') return <Chip tone="neutral">Buddy 未解锁</Chip>;
  if (cat.state === 'needs_selection') return <Chip tone="warn">需选择 Buddy</Chip>;
  return (
    <Chip tone={cat.state === 'traveling' ? 'brand' : cat.state === 'arrived' ? 'ok' : 'neutral'}>
      {cat.state === 'traveling'
        ? '旅行中'
        : cat.state === 'arrived'
          ? '待领奖'
          : cat.dailyLimitReached
            ? '今日额度已用完'
            : '空闲'}
    </Chip>
  );
}

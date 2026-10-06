/**
 * WorkBuddy 成长中心面板。
 *
 * 对应 /v1/workbuddy/growth/* 真实端点：
 *   - status-all / overview 汇总全部启用账号（只读）；
 *   - claim / draw / redeem-tier 为单账号写操作；
 *   - auto 为后台任务，立即返回 taskId，本面板轮询 progress 展示进度。
 *
 * 说明：这些操作直连上游真实接口，会实际消耗账号额度或触发上游限流，
 * 因此按钮均需二次确认，且失败时区分业务层原因与请求异常。
 */
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../shared/api/auth';
import {
  growthAuto,
  growthClaim,
  growthDraw,
  growthLastRun,
  growthOverview,
  growthProgress,
  growthRedeemTier,
  growthStatusAll,
  type GrowthOverviewRow,
  type GrowthStatusRow,
} from '../../shared/api/growth';
import { ApiError } from '../../shared/api/http';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { formatBoolean, formatNumber, formatTime, percent } from '../../shared/lib/format';
import { Button, Chip, ErrorState, LoadingBlock, MetricGrid, Note, Panel } from '../../shared/ui';
import { useToast } from '../../shared/ui/Toast';
import { usePrompt } from '../../shared/ui/Prompt';

interface TaskProgress {
  taskId: string;
  done: number;
  total: number;
  current: string;
  finished: boolean;
}

export function GrowthPanel() {
  const { key } = useAuth();
  const toast = useToast();
  const prompt = usePrompt();

  const [busyId, setBusyId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskProgress | null>(null);
  const [polling, setPolling] = useState(false);

  // 轮询用递归 setTimeout 而非 setInterval：
  // 请求耗时可能超过间隔，interval 会叠加并发请求
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);

  function stopTimer() {
    if (startRef.current != null) {
      window.clearTimeout(startRef.current);
      startRef.current = null;
    }
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  // 组件卸载时必须清理定时器，否则会在后台持续请求
  useEffect(() => stopTimer, []);

  const statusAll = useAsyncData((signal) => growthStatusAll(key, signal), [key], { enabled: !!key });
  const overview = useAsyncData((signal) => growthOverview(key, signal), [key], { enabled: !!key });
  const lastRun = useAsyncData((signal) => growthLastRun(key, signal), [key], { enabled: !!key });

  /** 统一包装写操作：业务层失败展示后端原因，不当作网络错误。 */
  async function run(id: string, label: string, fn: () => Promise<{ ok?: boolean; reason?: string }>, okMsg: string) {
    setBusyId(id);
    try {
      const r = await fn();
      if (r?.ok === false) {
        toast(`${label}未成功：${r.reason ?? '上游未给出原因'}`, 'err');
        return;
      }
      toast(okMsg, 'ok');
      statusAll.reload();
      overview.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : `${label}失败`, 'err');
    } finally {
      setBusyId(null);
    }
  }

  async function claim(accountId: string) {
    const ok = await prompt({
      title: '领取旅行奖励？',
      message: '将向该账号领取当前可领取的旅行奖励。',
      okText: '领取',
    });
    if (ok !== true) return;
    await run(accountId, '领取', () => growthClaim(accountId, key), '已领取');
  }

  async function draw(accountId: string) {
    const ok = await prompt({
      title: '抽奖？',
      message: '将消耗该账号的抽奖机会。',
      okText: '抽奖',
    });
    if (ok !== true) return;
    await run(accountId, '抽奖', () => growthDraw(accountId, key), '已抽奖');
  }

  async function redeem(accountId: string, tier: string) {
    const ok = await prompt({
      title: `使用连登兑换（${tier}）？`,
      message: '将消耗该账号的连登天数进行兑换。',
      okText: '兑换',
    });
    if (ok !== true) return;
    await run(accountId, '兑换', () => growthRedeemTier(accountId, tier, key), '已兑换');
  }

  /** 一键任务：启动后轮询进度，避免长请求阻塞界面。 */
  async function runAuto() {
    const ok = await prompt({
      title: '执行一键成长任务？',
      message: '将对全部启用的 WorkBuddy 账号依次执行旅行、任务、兑换与抽奖，会实际消耗各账号额度。',
      okText: '执行',
      danger: true,
    });
    if (ok !== true) return;

    setBusyId('__auto__');
    try {
      const r = await growthAuto({}, key);
      setTask({ taskId: r.taskId, done: 0, total: 0, current: '已启动', finished: false });
      setPolling(true);

      // 轮询句柄存ref，避免闭包读到过期的 task 状态
      stopTimer();
      const tick = async () => {
        try {
          const p = await growthProgress(r.taskId, key);
          const finished = p.status === 'done' || p.status === 'failed' || p.finishedAt != null;
          setTask({
            taskId: r.taskId,
            done: p.done ?? 0,
            total: p.total ?? 0,
            current: p.current ?? (finished ? '已结束' : '进行中'),
            finished,
          });
          if (finished) {
            stopTimer();
            setPolling(false);
            setBusyId(null);
            toast(
              p.status === 'failed'
                ? `任务失败：${p.errors?.join('；') ?? '未给出原因'}`
                : '一键任务已结束',
              p.status === 'failed' ? 'err' : 'ok',
            );
            lastRun.reload();
            statusAll.reload();
            overview.reload();
          }
        } catch (e) {
          stopTimer();
          setPolling(false);
          setBusyId(null);
          toast(e instanceof ApiError ? e.message : '进度查询失败', 'err');
        }
      };

      // 首次延迟 1.5s，给上游留出启动时间；最多轮询 5 分钟
      startRef.current = window.setTimeout(function loop() {
        void tick().then(() => {
          if (timerRef.current != null) timerRef.current = window.setTimeout(loop, 2000);
        });
      }, 1500);
    } catch (e) {
      stopTimer();
      setPolling(false);
      setBusyId(null);
      toast(e instanceof ApiError ? e.message : '启动一键任务失败', 'err');
    }
  }

  const statusRows: GrowthStatusRow[] = statusAll.data?.data ?? [];
  const overviewRows: GrowthOverviewRow[] = overview.data?.data ?? [];

  const metrics = [
    {
      key: '可参与账号',
      value: formatNumber(statusAll.data?.total ?? 0),
      delta: '仅统计已启用的 WorkBuddy 账号',
    },
    {
      key: '旅行中',
      value: formatNumber(statusRows.filter((r) => r.ok && r.state && r.state !== 'idle').length),
    },
    {
      key: '连登天数',
      value: formatNumber(Math.max(0, ...overviewRows.map((r) => r.streakDays ?? 0))),
      delta: '取账号最大值',
    },
    {
      key: '抽奖机会',
      value: formatNumber(overviewRows.reduce((s, r) => s + (r.lotteryChances ?? 0), 0)),
    },
  ];

  const taskRatio = task && task.total > 0 ? percent(task.done, task.total) / 100 : 0;

  return (
    <>
      <MetricGrid items={metrics} />

      {task && (
        <Panel
          title="一键成长任务"
          description={`任务 ${task.taskId}`}
          footer={
            lastRun.data?.ranAt
              ? `上次运行：${formatTime(lastRun.data.ranAt)}`
              : '暂无历史运行记录'
          }
        >
          <div className="flex items-center justify-between gap-3 mb-2">
            <span className="text-[13px]">{task.current}</span>
            <span className="font-mono text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
              {task.total > 0 ? `${task.done} / ${task.total}` : '—'}
            </span>
          </div>
          <div className="bar">
            <i style={{ width: `${Math.min(100, taskRatio * 100)}%` }} />
          </div>
          {task.finished && (
            <div className="mt-3">
              <Chip tone="ok" dot="dot-ok">
                已结束
              </Chip>
            </div>
          )}
        </Panel>
      )}

      <Panel
        title="成长概览"
        description="buddy、能量、连登与抽奖机会"
        actions={
          <>
            <Button size="sm" onClick={() => { statusAll.reload(); overview.reload(); }}>
              刷新
            </Button>
            <Button size="sm" variant="primary" onClick={runAuto} disabled={busyId === '__auto__' || polling}>
              {busyId === '__auto__' || polling ? '执行中…' : '一键执行'}
            </Button>
          </>
        }
        flush
      >
        {overview.error ? (
          <ErrorState message={overview.error} onRetry={overview.reload} />
        ) : overview.loading && !overview.data ? (
          <LoadingBlock />
        ) : overviewRows.length === 0 ? (
          <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
            暂无已启用的 WorkBuddy 账号。成长中心仅对启用账号生效。
          </div>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="th">账号</th>
                <th className="th">Buddy</th>
                <th className="th">稀有度</th>
                <th className="th cell-num">能量</th>
                <th className="th">可兑换</th>
                <th className="th cell-num">连登</th>
                <th className="th cell-num">补登卡</th>
                <th className="th cell-num">抽奖机会</th>
              </tr>
            </thead>
            <tbody>
              {overviewRows.map((r) => (
                <tr key={r.accountId} className="row-hover">
                  <td className="td">{r.label}</td>
                  <td className="td">{r.buddyName || '—'}</td>
                  <td className="td">{r.rarity || '—'}</td>
                  <td className="td cell-num">{formatNumber(r.energy)}</td>
                  <td className="td">{formatBoolean(r.affordable)}</td>
                  <td className="td cell-num">{formatNumber(r.streakDays)}</td>
                  <td className="td cell-num">{formatNumber(r.makeupCards)}</td>
                  <td className="td cell-num">{formatNumber(r.lotteryChances)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="旅行状态" description="逐账号的当前行程与奖励" flush>
        {statusAll.error ? (
          <ErrorState message={statusAll.error} onRetry={statusAll.reload} />
        ) : statusAll.loading && !statusAll.data ? (
          <LoadingBlock />
        ) : statusRows.length === 0 ? (
          <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
            暂无旅行状态
          </div>
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
                <th className="th cell-act">操作</th>
              </tr>
            </thead>
            <tbody>
              {statusRows.map((r) => {
                const busy = busyId === r.accountId;
                return (
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
                    <td className="td">{r.location || '—'}</td>
                    <td className="td font-mono text-[12px]">{formatTime(r.departAt)}</td>
                    <td className="td font-mono text-[12px]">{formatTime(r.arriveAt)}</td>
                    <td className="td cell-num">{formatNumber(r.rewardCredit)}</td>
                    <td className="td cell-act">
                      <div className="inline-flex items-center gap-1.5">
                        <Button size="sm" disabled={busy || !r.ok} onClick={() => claim(r.accountId)}>
                          领奖
                        </Button>
                        <Button size="sm" disabled={busy || !r.ok} onClick={() => draw(r.accountId)}>
                          抽奖
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy || !r.ok}
                          onClick={() => redeem(r.accountId, '1')}
                        >
                          兑换
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Note>
        成长中心操作直连上游真实接口，会实际消耗账号额度并可能触发上游限流，建议按需手动执行。
      </Note>
    </>
  );
}
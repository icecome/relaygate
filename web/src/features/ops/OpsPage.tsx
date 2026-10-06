/**
 * 运维中心：运行状态、定时任务、账号轮换、通知备份与网关配置。
 *
 * 运维类能力在侧栏收敛为一个入口，用页内分段切换，
 * 避免侧栏出现过多平级项导致导航过长。
 * 关键语义：账号轮换接口可能返回业务层失败（HTTP 200 但结果未成功），
 * 需与请求异常区分展示。
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../shared/api/auth';
import {
  clearTaskLog,
  getBalanceRefresh,
  getClientConfig,
  getRotateSettings,
  getRotateStatus,
  getRouteCheck,
  getRuntime,
  getRuntimeConfig,
  getSchedulerSettings,
  getSticky,
  getTaskLog,
  reloadConfig,
  runRotate,
  saveBalanceRefresh,
  saveRotateSettings,
  saveSchedulerSettings,
  seedRotate,
  switchRotate,
  type RotateHeatmapRow,
} from '../../shared/api/admin';
import { ApiError } from '../../shared/api/http';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import {
  formatBoolean,
  formatDuration,
  formatNumber,
  formatTime,
  formatUptime,
} from '../../shared/lib/format';
import {
  Button,
  Chip,
  ErrorState,
  FieldRow,
  KeyCardGroups,
  KeyCards,
  LoadingBlock,
  MetricGrid,
  Note,
  Panel,
  Segmented,
} from '../../shared/ui';
import { PageShell, Stack } from '../../shared/ui/PageShell';
import { useToast } from '../../shared/ui/Toast';
import { usePrompt } from '../../shared/ui/Prompt';
import { ClientAccessPanel } from './ClientAccessPanel';
import { NotifyBackupPanel } from './NotifyBackupPanel';

type Tab = 'runtime' | 'jobs' | 'rotate' | 'notify' | 'config';

/** 任务日志单页条数与向后端请求的上限（后端 clamp 到 500）。 */
const LOG_PAGE_SIZE = 20;
const LOG_LIMIT = 200;

const TABS: readonly { value: Tab; label: string; path: string }[] = [
  { value: 'runtime', label: '运行状态', path: '/ops' },
  { value: 'jobs', label: '定时任务', path: '/ops/jobs' },
  { value: 'rotate', label: '账号轮换', path: '/ops/rotate' },
  { value: 'notify', label: '通知与备份', path: '/ops/notify' },
  { value: 'config', label: '网关配置', path: '/ops/config' },
];

export default function OpsPage() {
  const { key } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const prompt = usePrompt();
  const [busy, setBusy] = useState<string | null>(null);
  /** 任务日志分页状态；后端一次性返回，故分页在前端切片 */
  const [logPage, setLogPage] = useState(0);
  const [logTask, setLogTask] = useState<string>('');
  /** 调度设置草稿：字段与后端 SPECS 一一对应，保存时只提交这一份 */
  const [schedulerDraft, setSchedulerDraft] = useState({
    checkinHour: 9,
    checkinMinute: 0,
    keepaliveHour: 22,
    keepaliveMinute: 0,
    tokenSweepMinutes: 15,
    modelProbeIntervalHours: 6,
    modelProbeMaxPerRun: 8,
    rotateHour: 0,
    rotateMinute: 10,
    growthPollEnabled: 1,
    growthPollIntervalHours: 4,
    checkinSpreadMinutes: 30,
    balanceSpreadMinutes: 15,
  });
  const [schedulerDirty, setSchedulerDirty] = useState(false);

  const active = TABS.find((t) => t.path === location.pathname)?.value ?? 'runtime';

  const runtime = useAsyncData((signal) => getRuntime(key, signal), [key], { enabled: !!key });
  const sticky = useAsyncData((signal) => getSticky(key, signal), [key], { enabled: !!key });
  const routeCheck = useAsyncData((signal) => getRouteCheck(key, signal), [key], { enabled: !!key });
  const clientConfig = useAsyncData((signal) => getClientConfig(key, signal), [key], {
    enabled: !!key,
  });
  // 粘性明细优先取 runtime 内嵌快照，回退到独立的 sticky 接口
  const stickyRows = useMemo(
    () => runtime.data?.sticky ?? sticky.data?.data ?? [],
    [runtime.data, sticky.data],
  );
  const scheduler = useAsyncData((signal) => getSchedulerSettings(key, signal), [key], { enabled: !!key });
  // 余额自动刷新是独立于签到链的定时器，开关此前无前端入口
  const balanceRefresh = useAsyncData((signal) => getBalanceRefresh(key, signal), [key], {
    enabled: !!key,
  });
  const [balanceDraft, setBalanceDraft] = useState({ enabled: false, intervalMinutes: 30 });
  const [balanceDirty, setBalanceDirty] = useState(false);

  useEffect(() => {
    if (!balanceRefresh.data || balanceDirty) return;
    setBalanceDraft({
      enabled: balanceRefresh.data.enabled === true,
      intervalMinutes: balanceRefresh.data.intervalMinutes ?? 30,
    });
  }, [balanceRefresh.data, balanceDirty]);

  async function saveBalanceCfg() {
    setBusy('balance-cfg');
    try {
      await saveBalanceRefresh(balanceDraft, key);
      setBalanceDirty(false);
      balanceRefresh.reload();
      toast('余额刷新设置已保存并已重排定时器', 'ok');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '保存余额刷新设置失败', 'err');
    } finally {
      setBusy(null);
    }
  }
  const taskLog = useAsyncData(
    (signal) => getTaskLog(LOG_LIMIT, key, logTask || undefined, signal),
    [key, logTask],
    { enabled: !!key },
  );
  const rotateStatus = useAsyncData((signal) => getRotateStatus(key, signal), [key], { enabled: !!key });
  const rotateSettings = useAsyncData((signal) => getRotateSettings(key, signal), [key], { enabled: !!key });
  const config = useAsyncData((signal) => getRuntimeConfig(key, signal), [key], { enabled: !!key });

  // 载入后同步草稿；用户编辑中不覆盖，避免输入被回填冲掉
  useEffect(() => {
    if (!scheduler.data || schedulerDirty) return;
    const d = scheduler.data;
    setSchedulerDraft({
      checkinHour: d.checkinHour ?? 9,
      checkinMinute: d.checkinMinute ?? 0,
      keepaliveHour: d.keepaliveHour ?? 22,
      keepaliveMinute: d.keepaliveMinute ?? 0,
      tokenSweepMinutes: d.tokenSweepMinutes ?? 15,
      modelProbeIntervalHours: d.modelProbeIntervalHours ?? 6,
      modelProbeMaxPerRun: d.modelProbeMaxPerRun ?? 8,
      rotateHour: d.rotateHour ?? 0,
      rotateMinute: d.rotateMinute ?? 10,
      growthPollEnabled: d.growthPollEnabled ?? 1,
      growthPollIntervalHours: d.growthPollIntervalHours ?? 4,
      checkinSpreadMinutes: d.checkinSpreadMinutes ?? 30,
      balanceSpreadMinutes: d.balanceSpreadMinutes ?? 15,
    });
  }, [scheduler.data, schedulerDirty]);

  /**
 * 账号列表：把「本机 auth 备份」与「成长活跃度」两个数据源按 uid 合并。
 * 后端 accounts[].uid 取自 auth 文件，heatmap[].uid 取自账号库 userId，同为上游 uid。
 * 只在 auth 目录里出现的账号也要展示，故以 accounts 为主表左连 heatmap。
 */
const rotateRows = useMemo(() => {
  const accounts = rotateStatus.data?.accounts ?? [];
  const heat = new Map<string, RotateHeatmapRow>();
  for (const h of rotateStatus.data?.heatmap ?? []) {
    if (h.uid) heat.set(String(h.uid), h);
  }
  if (accounts.length) {
    return accounts.map((a) => {
      const h = heat.get(String(a.uid));
      return {
        uid: a.uid,
        label: a.label ?? h?.label ?? '',
        backup: a.backup,
        score: h?.score,
        level: h?.level,
        statusText: h?.statusText,
        error: h?.error,
      };
    });
  }
  // auth 目录为空时退化为只看活跃度，避免整页空白
  return (rotateStatus.data?.heatmap ?? []).map((h) => ({
    uid: String(h.uid ?? h.accountId),
    label: h.label ?? '',
    backup: undefined,
    score: h.score,
    level: h.level,
    statusText: h.statusText,
    error: h.error,
  }));
}, [rotateStatus.data]);

  /**
   * 轮换配置草稿。自动轮换开关此前没有任何入口，
   * 这里把开关与停留时长、排除列表、切回设置收在一处。
   */
  const [rotateCfg, setRotateCfg] = useState({
    enabled: true,
    stayMs: 60000,
    excludeUids: '',
    switchBack: true,
  });
  const [rotateCfgDirty, setRotateCfgDirty] = useState(false);

  // 载入后同步草稿；用户编辑中不覆盖
  useEffect(() => {
    if (!rotateSettings.data || rotateCfgDirty) return;
    const s = rotateSettings.data;
    setRotateCfg({
      enabled: s.enabled !== false,
      stayMs: s.stayMs ?? 60000,
      excludeUids: s.excludeUids ?? '',
      switchBack: s.switchBack !== false,
    });
  }, [rotateSettings.data, rotateCfgDirty]);

  async function saveRotateCfg() {
    setBusy('rotate-cfg');
    try {
      await saveRotateSettings(
        {
          enabled: rotateCfg.enabled,
          stayMs: rotateCfg.stayMs,
          excludeUids: rotateCfg.excludeUids,
          switchBack: rotateCfg.switchBack,
        },
        key,
      );
      setRotateCfgDirty(false);
      rotateSettings.reload();
      rotateStatus.reload();
      toast('轮换设置已保存并已重启轮换定时器', 'ok');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '保存轮换设置失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function reloadAll() {
    runtime.reload();
    sticky.reload();
    routeCheck.reload();
    scheduler.reload();
    taskLog.reload();
    rotateStatus.reload();
    config.reload();
    clientConfig.reload();
  }

  async function doRotate() {
    const ok = await prompt({
      title: '执行账号轮换？',
      message: '将按当前策略重新分配账号，可能导致进行中的请求重试。',
      okText: '执行',
    });
    if (ok !== true) return;
    setBusy('rotate');
    try {
      const r = await runRotate(key);
      // 业务层失败：请求成功但轮换未全部成功
      if (r.failed > 0 || (r.skipped ?? 0) > 0 || r.reason) {
        toast(
          `轮换完成但有异常：成功 ${r.ok}，失败 ${r.failed}，跳过 ${r.skipped ?? 0}${r.reason ? `；${r.reason}` : ''}`,
          'warn',
        );
      } else {
        toast(`轮换成功：共 ${r.ok} 个账号`, 'ok');
      }
      rotateStatus.reload();
      taskLog.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '轮换请求失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function doSeed() {
    setBusy('seed');
    try {
      const r = await seedRotate(key);
      toast(`种子生成：成功 ${r.ok?.length ?? 0}，跳过 ${r.skipped?.length ?? 0}`, 'ok');
      rotateStatus.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '种子生成失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  /** 按 uid 切换（账号列表行内按钮）。 */
  async function doSwitchTo(uid: string, label: string) {
    setBusy(`switch-${uid}`);
    try {
      const r = await switchRotate(uid, key);
      if (!r.ok) toast(`切换未成功：${r.msg ?? '后端未给出原因'}`, 'err');
      else toast(`已切换到 ${label}`, 'ok');
      rotateStatus.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '切换失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  /** 手动输入 uid 切换（保留原有入口）。 */
  async function doSwitchPick() {
    const uid = await prompt({
      title: '切换到指定账号',
      message: '输入目标账号的 uid。',
      input: { label: 'uid' },
      okText: '切换',
    });
    if (typeof uid !== 'string' || !uid.trim()) return;
    await doSwitchTo(uid.trim(), uid.trim());
  }

  async function saveScheduler() {
    setBusy('scheduler');
    try {
      // 只提交 SPECS 中的可编辑字段：schedulerEnabled 来自环境变量，
      // 连同 object/scheduler 快照回传会被后端忽略，徒增歧义
      await saveSchedulerSettings(
        {
          checkinHour: schedulerDraft.checkinHour,
          checkinMinute: schedulerDraft.checkinMinute,
          keepaliveHour: schedulerDraft.keepaliveHour,
          keepaliveMinute: schedulerDraft.keepaliveMinute,
          tokenSweepMinutes: schedulerDraft.tokenSweepMinutes,
          modelProbeIntervalHours: schedulerDraft.modelProbeIntervalHours,
          modelProbeMaxPerRun: schedulerDraft.modelProbeMaxPerRun,
          rotateHour: schedulerDraft.rotateHour,
          rotateMinute: schedulerDraft.rotateMinute,
          growthPollEnabled: schedulerDraft.growthPollEnabled,
          growthPollIntervalHours: schedulerDraft.growthPollIntervalHours,
          checkinSpreadMinutes: schedulerDraft.checkinSpreadMinutes,
          balanceSpreadMinutes: schedulerDraft.balanceSpreadMinutes,
        },
        key,
      );
      toast('调度设置已保存并已重启调度器', 'ok');
      scheduler.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '保存失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function doReload() {
    const ok = await prompt({
      title: '重载网关配置？',
      message: '将按当前配置文件重建模型池与路由，期间请求可能短暂失败。',
      okText: '重载',
    });
    if (ok !== true) return;
    setBusy('reload');
    try {
      const r = await reloadConfig(key);
      toast(`已重载：模型数 ${r.before.modelCount} → ${r.after.modelCount}`, 'ok');
      config.reload();
      runtime.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '重载失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  // 任务日志分页：后端一次返回，故在此切片；任务名用于筛选下拉
  const taskRows = useMemo(() => taskLog.data?.data ?? [], [taskLog.data]);
  const taskNames = useMemo(() => {
    const set = new Set<string>();
    for (const t of taskRows) if (t.task) set.add(t.task);
    return Array.from(set).sort();
  }, [taskRows]);
  const taskPages = Math.max(1, Math.ceil(taskRows.length / LOG_PAGE_SIZE));
  const taskPageRows = useMemo(
    () => taskRows.slice(logPage * LOG_PAGE_SIZE, (logPage + 1) * LOG_PAGE_SIZE),
    [taskRows, logPage],
  );
  // 筛选后总页数可能变小，把页码夹回合法范围，避免出现空白页
  const safeLogPage = Math.min(logPage, taskPages - 1);

  const runtimeMetrics = [
    { key: '运行时长', value: formatUptime(runtime.data?.status?.uptimeSec) },
    {
      key: '调度器',
      value: runtime.data?.status?.scheduler?.enabled ? '开启' : '关闭',
      delta: formatTime(runtime.data?.status?.scheduler?.nextCheckinAt),
    },
    { key: '粘性条目', value: formatNumber(runtime.data?.status?.sticky?.entries ?? stickyRows.length) },
    {
      key: '账号',
      value: formatNumber(runtime.data?.status?.accounts?.total),
      delta: `冷却 ${runtime.data?.status?.accounts?.cooling ?? 0}`,
    },
  ];

  return (
    <PageShell
      title="运维中心"
      description="运行状态、定时任务、账号轮换、通知备份与网关配置"
      actions={<Button onClick={reloadAll}>刷新</Button>}
      toolbar={
        <Segmented
          ariaLabel="运维分区"
          value={active}
          onChange={(v) => {
            const t = TABS.find((x) => x.value === v);
            if (t) navigate(t.path);
          }}
          options={TABS.map((t) => ({ value: t.value, label: t.label }))}
        />
      }
    >
      <Stack>
        {active === 'runtime' && (
          <>
            {runtime.error && <ErrorState message={runtime.error} onRetry={runtime.reload} />}
            <MetricGrid items={runtimeMetrics} />

            <Panel title="服务与实例" description="节点、运行时长与依赖开关">
              {runtime.loading && !runtime.data ? (
                <LoadingBlock />
              ) : (
                <KeyCards
                  cols={3}
                  rows={[
                    { k: '节点', v: <span className="font-mono">{runtime.data?.status?.node || '—'}</span> },
                    {
                      k: '运行时长',
                      v: <span className="font-mono">{formatUptime(runtime.data?.status?.uptimeSec)}</span>,
                    },
                    {
                      k: '池化策略',
                      v: <span className="font-mono">{runtime.data?.pool?.strategy || runtime.data?.status?.pool?.strategy || '—'}</span>,
                    },
                    {
                      k: '单账号在途上限',
                      v: <span className="font-mono">{formatNumber(runtime.data?.pool?.maxInFlight)}</span>,
                    },
                    {
                      k: '等待队列',
                      v: <span className="font-mono">{formatNumber(runtime.data?.pool?.waiters?.count)}</span>,
                    },
                    {
                      k: '不可用模型',
                      v: <span className="font-mono">{formatNumber(runtime.data?.status?.models?.unavailable)}</span>,
                    },
                    {
                      k: '通知',
                      v: formatBoolean(runtime.data?.notify?.enabled),
                    },
                    {
                      k: '管理密钥分离',
                      v: formatBoolean(runtime.data?.keys?.adminSeparated),
                    },
                  ]}
                />
              )}
            </Panel>

            <Panel
              title="调度预演"
              description="不发真实请求，解释当前调度会选哪个账号"
              actions={
                <Button size="sm" onClick={routeCheck.reload} disabled={routeCheck.loading}>
                  {routeCheck.loading ? '计算中…' : '重新计算'}
                </Button>
              }
            >
              {routeCheck.error ? (
                <ErrorState message={routeCheck.error} onRetry={routeCheck.reload} />
              ) : !routeCheck.data ? (
                <LoadingBlock />
              ) : (
                <KeyCards
                  cols={3}
                  rows={[
                    { k: '当前策略', v: <span className="font-mono">{routeCheck.data.strategy || '—'}</span> },
                    {
                      k: '可用候选',
                      v: <span className="font-mono">{formatNumber(routeCheck.data.usableCount)}</span>,
                    },
                    {
                      k: '预计选中',
                      v: routeCheck.data.wouldPick ? (
                        <span className="font-mono">
                          {routeCheck.data.wouldPick.label || routeCheck.data.wouldPick.id}
                          {routeCheck.data.wouldPick.balance != null &&
                            ` · 余额 ${formatNumber(routeCheck.data.wouldPick.balance)}`}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--rg-state-error)' }}>无可用账号</span>
                      ),
                    },
                    {
                      k: '余额门槛',
                      v: <span className="font-mono">{formatNumber(routeCheck.data.minBalanceToUse)}</span>,
                    },
                    {
                      k: '计算时间',
                      v: <span className="font-mono">{formatTime(routeCheck.data.generatedAt)}</span>,
                    },
                  ]}
                />
              )}
            </Panel>

            <Panel
              title="账号池快照"
              description="含在途请求、模型级冷却与 FEFO 到期信号"
              flush
            >
              {(runtime.data?.pool?.accounts ?? []).length === 0 ? (
                <LoadingBlock />
              ) : (
                <div className="scroll-y" style={{ maxHeight: 420 }}>
                  <table className="w-full border-collapse text-[13px]">
                    <thead
                      className="sticky top-0 z-10"
                      style={{ background: 'var(--rg-bg-secondary)' }}
                    >
                      <tr>
                        <th className="th">账号</th>
                        <th className="th">可用</th>
                        <th className="th cell-num">在途</th>
                        <th className="th cell-num">余额</th>
                        <th className="th cell-num">优先级</th>
                        <th className="th">最近到期</th>
                        <th className="th cell-num">模型冷却</th>
                        <th className="th cell-num">错误数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(runtime.data?.pool?.accounts ?? []).map((a) => (
                        <tr key={a.id} className="row-hover">
                          <td className="td">
                            <div className="font-mono text-[12px]">{a.label || a.id}</div>
                            <div
                              className="font-mono text-[11px]"
                              style={{ color: 'var(--rg-text-tertiary)' }}
                            >
                              {a.id}
                            </div>
                          </td>
                          <td className="td">
                            {a.usable ? (
                              <Chip tone="ok" dot="dot-ok">
                                可用
                              </Chip>
                            ) : (
                              <Chip tone="neutral" dot="dot-off">
                                不可用
                              </Chip>
                            )}
                          </td>
                          <td className="td cell-num">{formatNumber(a.inFlight)}</td>
                          <td className="td cell-num">{formatNumber(a.balance)}</td>
                          <td className="td cell-num">{a.priority ?? 0}</td>
                          <td className="td font-mono text-[12px]">
                            {a.fefo?.never
                              ? '不过期'
                              : a.fefo?.hasExpiry && a.fefo.soonestDays != null
                                ? `${a.fefo.soonestDays} 天`
                                : '—'}
                          </td>
                          <td className="td cell-num">
                            {a.modelCooldowns
                              ? Object.keys(a.modelCooldowns).length
                              : 0}
                          </td>
                          <td className="td cell-num">{formatNumber(a.errorCount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <Panel
              title="粘性会话"
              description={`当前 ${stickyRows.length} 条会话绑定`}
              flush
            >
              {stickyRows.length === 0 ? (
                <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                  当前没有粘性会话
                </div>
              ) : (
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className="th">会话键</th>
                      <th className="th">绑定账号</th>
                      <th className="th">过期时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stickyRows.map((s, i) => (
                      <tr key={`${s?.key ?? i}`} className="row-hover">
                        <td className="td font-mono text-[11px] break-all">{s?.key || '—'}</td>
                        <td className="td font-mono text-[12px]">{s?.accountId || '—'}</td>
                        <td className="td font-mono text-[12px]">{formatTime(s?.expiresAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </>
        )}

        {active === 'jobs' && (
          <>
            <Panel
              title="调度设置"
              description="保存后会重启调度器使新配置立即生效"
              actions={
                <Button
                  size="sm"
                  variant="primary"
                  onClick={saveScheduler}
                  disabled={busy === 'scheduler' || !schedulerDirty}
                >
                  {busy === 'scheduler' ? '保存中…' : '保存'}
                </Button>
              }
            >
              {scheduler.loading && !scheduler.data ? (
                <LoadingBlock />
              ) : (
                <div className="flex flex-col gap-4">
                  {/* 总开关来自环境变量，配置文件改不了，如实展示来源而非做无效开关 */}
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
                      调度器总开关
                    </div>
                    {scheduler.data?.schedulerEnabled ? (
                      <Chip tone="ok" dot="dot-ok">
                        运行中 · 由 SCHEDULER_ENABLED 控制
                      </Chip>
                    ) : (
                      <Chip tone="neutral" dot="dot-off">
                        已停止 · 由 SCHEDULER_ENABLED 控制
                      </Chip>
                    )}
                  </div>

                  <div className="grid gap-4 grid-cols-2 items-start">
                    <div
                      className="rounded-lg border px-3.5 py-3 min-w-0"
                      style={{ borderColor: 'var(--rg-border)' }}
                    >
                      <div className="mb-2.5 flex items-center gap-2">
                        <span className="text-aux font-medium" style={{ color: 'var(--rg-text-secondary)' }}>
                          执行时刻
                        </span>
                        <span className="h-px flex-1" style={{ background: 'var(--rg-border)' }} />
                      </div>
                      <div className="flex flex-col gap-2.5">
                        <FieldRow label="每日签到">
                          <div className="flex items-center gap-2">
                            <input
                              className="field font-mono text-[12px]"
                              type="number"
                              min={0}
                              max={23}
                              value={String(schedulerDraft.checkinHour)}
                              onChange={(e) => {
                                setSchedulerDraft((d) => ({ ...d, checkinHour: Number(e.target.value) }));
                                setSchedulerDirty(true);
                              }}
                              aria-label="签到小时"
                            />
                            <span className="font-mono text-[12px]">:</span>
                            <input
                              className="field font-mono text-[12px]"
                              type="number"
                              min={0}
                              max={59}
                              value={String(schedulerDraft.checkinMinute)}
                              onChange={(e) => {
                                setSchedulerDraft((d) => ({ ...d, checkinMinute: Number(e.target.value) }));
                                setSchedulerDirty(true);
                              }}
                              aria-label="签到分钟"
                            />
                          </div>
                        </FieldRow>
                        <FieldRow label="每日保活">
                          <div className="flex items-center gap-2">
                            <input
                              className="field font-mono text-[12px]"
                              type="number"
                              min={0}
                              max={23}
                              value={String(schedulerDraft.keepaliveHour)}
                              onChange={(e) => {
                                setSchedulerDraft((d) => ({ ...d, keepaliveHour: Number(e.target.value) }));
                                setSchedulerDirty(true);
                              }}
                              aria-label="保活小时"
                            />
                            <span className="font-mono text-[12px]">:</span>
                            <input
                              className="field font-mono text-[12px]"
                              type="number"
                              min={0}
                              max={59}
                              value={String(schedulerDraft.keepaliveMinute)}
                              onChange={(e) => {
                                setSchedulerDraft((d) => ({ ...d, keepaliveMinute: Number(e.target.value) }));
                                setSchedulerDirty(true);
                              }}
                              aria-label="保活分钟"
                            />
                          </div>
                        </FieldRow>
                        <FieldRow label="账号轮换时刻">
                          <div className="flex items-center gap-2">
                            <input
                              className="field font-mono text-[12px]"
                              type="number"
                              min={0}
                              max={23}
                              value={String(schedulerDraft.rotateHour)}
                              onChange={(e) => {
                                setSchedulerDraft((d) => ({ ...d, rotateHour: Number(e.target.value) }));
                                setSchedulerDirty(true);
                              }}
                              aria-label="轮换小时"
                            />
                            <span className="font-mono text-[12px]">:</span>
                            <input
                              className="field font-mono text-[12px]"
                              type="number"
                              min={0}
                              max={59}
                              value={String(schedulerDraft.rotateMinute)}
                              onChange={(e) => {
                                setSchedulerDraft((d) => ({ ...d, rotateMinute: Number(e.target.value) }));
                                setSchedulerDirty(true);
                              }}
                              aria-label="轮换分钟"
                            />
                          </div>
                        </FieldRow>
                      </div>
                    </div>

                    <div
                      className="rounded-lg border px-3.5 py-3 min-w-0"
                      style={{ borderColor: 'var(--rg-border)' }}
                    >
                      <div className="mb-2.5 flex items-center gap-2">
                        <span className="text-aux font-medium" style={{ color: 'var(--rg-text-secondary)' }}>
                          间隔与错峰
                        </span>
                        <span className="h-px flex-1" style={{ background: 'var(--rg-border)' }} />
                      </div>
                      <div className="flex flex-col gap-2.5">
                        <FieldRow label="令牌扫描（分钟）">
                          <input
                            className="field font-mono text-[12px]"
                            type="number"
                            min={1}
                            max={1440}
                            value={String(schedulerDraft.tokenSweepMinutes)}
                            onChange={(e) => {
                              setSchedulerDraft((d) => ({ ...d, tokenSweepMinutes: Number(e.target.value) }));
                              setSchedulerDirty(true);
                            }}
                          />
                        </FieldRow>
                        <FieldRow label="模型探测间隔（小时）">
                          <input
                            className="field font-mono text-[12px]"
                            type="number"
                            min={0}
                            max={168}
                            value={String(schedulerDraft.modelProbeIntervalHours)}
                            onChange={(e) => {
                              setSchedulerDraft((d) => ({ ...d, modelProbeIntervalHours: Number(e.target.value) }));
                              setSchedulerDirty(true);
                            }}
                          />
                        </FieldRow>
                        <FieldRow label="每次探测模型数">
                          <input
                            className="field font-mono text-[12px]"
                            type="number"
                            min={0}
                            max={100}
                            value={String(schedulerDraft.modelProbeMaxPerRun)}
                            onChange={(e) => {
                              setSchedulerDraft((d) => ({ ...d, modelProbeMaxPerRun: Number(e.target.value) }));
                              setSchedulerDirty(true);
                            }}
                          />
                        </FieldRow>
                        <FieldRow label="签到错峰窗口（分钟）">
                          <input
                            className="field font-mono text-[12px]"
                            type="number"
                            min={0}
                            max={720}
                            value={String(schedulerDraft.checkinSpreadMinutes)}
                            onChange={(e) => {
                              setSchedulerDraft((d) => ({ ...d, checkinSpreadMinutes: Number(e.target.value) }));
                              setSchedulerDirty(true);
                            }}
                          />
                        </FieldRow>
                        <FieldRow label="余额错峰窗口（分钟）">
                          <input
                            className="field font-mono text-[12px]"
                            type="number"
                            min={0}
                            max={720}
                            value={String(schedulerDraft.balanceSpreadMinutes)}
                            onChange={(e) => {
                              setSchedulerDraft((d) => ({ ...d, balanceSpreadMinutes: Number(e.target.value) }));
                              setSchedulerDirty(true);
                            }}
                          />
                        </FieldRow>
                      </div>
                    </div>

                    <div
                      className="rounded-lg border px-3.5 py-3 min-w-0"
                      style={{ borderColor: 'var(--rg-border)' }}
                    >
                      <div className="mb-2.5 flex items-center gap-2">
                        <span className="text-aux font-medium" style={{ color: 'var(--rg-text-secondary)' }}>
                          成长中心轮询
                        </span>
                        <span className="h-px flex-1" style={{ background: 'var(--rg-border)' }} />
                      </div>
                      <div className="flex flex-col gap-2.5">
                        <label className="flex items-center justify-between gap-3">
                          <span className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
                            启用轮询
                          </span>
                          <input
                            type="checkbox"
                            checked={schedulerDraft.growthPollEnabled !== 0}
                            onChange={(e) => {
                              setSchedulerDraft((d) => ({
                                ...d,
                                growthPollEnabled: e.target.checked ? 1 : 0,
                              }));
                              setSchedulerDirty(true);
                            }}
                          />
                        </label>
                        <FieldRow label="轮询间隔（小时）">
                          <input
                            className="field font-mono text-[12px]"
                            type="number"
                            min={0}
                            max={168}
                            value={String(schedulerDraft.growthPollIntervalHours)}
                            onChange={(e) => {
                              setSchedulerDraft((d) => ({ ...d, growthPollIntervalHours: Number(e.target.value) }));
                              setSchedulerDirty(true);
                            }}
                          />
                        </FieldRow>
                      </div>
                    </div>

                    <div
                      className="rounded-lg border px-3.5 py-3 min-w-0"
                      style={{ borderColor: 'var(--rg-border)' }}
                    >
                      <div className="mb-2.5 flex items-center gap-2">
                        <span className="text-aux font-medium" style={{ color: 'var(--rg-text-secondary)' }}>
                          下次执行
                        </span>
                        <span className="h-px flex-1" style={{ background: 'var(--rg-border)' }} />
                      </div>
                      <dl className="flex flex-col text-[13px]">
                        {[
                          { k: '下次签到', v: runtime.data?.scheduler?.nextCheckinAt },
                          { k: '下次轮换', v: runtime.data?.scheduler?.nextRotateAutoAt },
                          { k: '上次签到', v: runtime.data?.scheduler?.lastCheckinAt },
                        ].map((row) => (
                          <div
                            key={row.k}
                            className="grid gap-2 py-[5px] items-baseline"
                            style={{ gridTemplateColumns: '64px minmax(0, 1fr)' }}
                          >
                            <dt className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                              {row.k}
                            </dt>
                            <dd className="m-0 font-mono text-[12px] break-all">
                              {row.v ? formatTime(row.v as string) : '—'}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  </div>

                  <Note>
                    错峰窗口按（日期, 账号）哈希把批量任务分散到窗口内，避免固定时刻集中打上游；填0 表示关闭错峰。
                  </Note>

                  {/* 余额自动刷新：独立于签到链的定时器，开关与间隔都在这里 */}
                  <div
                    className="rounded-lg border px-3.5 py-3 min-w-0"
                    style={{ borderColor: 'var(--rg-border)' }}
                  >
                    <div className="mb-2.5 flex items-center gap-2">
                      <span className="text-aux font-medium" style={{ color: 'var(--rg-text-secondary)' }}>
                        余额自动刷新
                      </span>
                      <span className="h-px flex-1" style={{ background: 'var(--rg-border)' }} />
                      {balanceRefresh.data?.enabled ? (
                        <Chip tone="ok" dot="dot-ok">
                          运行中
                        </Chip>
                      ) : (
                        <Chip tone="neutral" dot="dot-off">
                          已关闭
                        </Chip>
                      )}
                    </div>

                    <div className="flex flex-col gap-2.5">
                      <label className="flex items-center justify-between gap-3">
                        <span className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
                          启用定时刷新
                        </span>
                        <input
                          type="checkbox"
                          checked={balanceDraft.enabled}
                          onChange={(e) => {
                            setBalanceDraft((d) => ({ ...d, enabled: e.target.checked }));
                            setBalanceDirty(true);
                          }}
                          aria-label="启用余额定时刷新"
                        />
                      </label>

                      <FieldRow label="刷新间隔（分钟）">
                        <input
                          className="field font-mono text-[12px]"
                          type="number"
                          min={5}
                          max={1440}
                          value={String(balanceDraft.intervalMinutes)}
                          onChange={(e) => {
                            setBalanceDraft((d) => ({ ...d, intervalMinutes: Number(e.target.value) }));
                            setBalanceDirty(true);
                          }}
                        />
                      </FieldRow>

                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={saveBalanceCfg}
                          disabled={busy === 'balance-cfg' || !balanceDirty}
                        >
                          {busy === 'balance-cfg' ? '保存中…' : '保存刷新设置'}
                        </Button>
                        {balanceRefresh.data?.lastRunAt && (
                          <span className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                            上次 {formatTime(balanceRefresh.data.lastRunAt)}
                            {balanceRefresh.data.lastFailed
                              ? ` · 失败 ${balanceRefresh.data.lastFailed}`
                              : ''}
                          </span>
                        )}
                      </div>

                      <div className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                        {balanceRefresh.data?.timer?.nextRunAt
                          ? `下次运行：${balanceRefresh.data.timer.nextRunAt}`
                          : '定时器未启动；每日签到链结束后也会刷新一次余额'}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </Panel>

            <Panel
              title="任务日志"
              description={`按时间倒序，共 ${taskRows.length} 条`}
              actions={
                <>
                  <select
                    className="field w-auto"
                    value={logTask}
                    onChange={(e) => {
                      setLogTask(e.target.value);
                      setLogPage(0);
                    }}
                    aria-label="按任务筛选"
                  >
                    <option value="">全部任务</option>
                    {taskNames.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    onClick={async () => {
                      const ok = await prompt({
                        title: '清空任务日志？',
                        message: '将删除全部历史任务记录，不可恢复。',
                        okText: '清空',
                        danger: true,
                      });
                      if (ok !== true) return;
                      try {
                        await clearTaskLog(key);
                        toast('任务日志已清空', 'ok');
                        setLogPage(0);
                        taskLog.reload();
                      } catch (e) {
                        toast(e instanceof ApiError ? e.message : '清空失败', 'err');
                      }
                    }}
                  >
                    清空日志
                  </Button>
                </>
              }
              flush
            >
              {taskLog.loading && !taskLog.data ? (
                <LoadingBlock />
              ) : taskRows.length === 0 ? (
                <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                  暂无任务记录
                </div>
              ) : (
                <>
                  <div className="scroll-y" style={{ maxHeight: 420 }}>
                    <table className="w-full border-collapse text-[13px]">
                      {/* 表头吸顶：翻页时列名始终可见 */}
                      <thead
                        className="sticky top-0 z-10"
                        style={{ background: 'var(--rg-bg-base)' }}
                      >
                        <tr>
                          <th className="th">时间</th>
                          <th className="th">任务</th>
                          <th className="th">触发</th>
                          <th className="th cell-num">成功</th>
                          <th className="th cell-num">失败</th>
                          <th className="th">详情</th>
                        </tr>
                      </thead>
                      <tbody>
                        {taskPageRows.map((t, i) => {
                          // ok/failed 是计数而非布尔：按 failed 判定结果，
                          // 此前误按布尔比较导致失败任务也显示「成功」
                          const failed = t.failed ?? 0;
                          const okCount = t.ok ?? 0;
                          return (
                            <tr key={`${t.ts ?? i}`} className="row-hover">
                              <td className="td font-mono text-[12px]">{formatTime(t.ts)}</td>
                              <td className="td font-mono text-[12px]">{t.task || '—'}</td>
                              <td className="td font-mono text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                                {t.trigger || '—'}
                              </td>
                              <td className="td cell-num font-mono text-[12px]">{formatNumber(okCount)}</td>
                              <td className="td cell-num font-mono text-[12px]">
                                {failed > 0 ? (
                                  <span style={{ color: 'var(--rg-state-error)' }}>{failed}</span>
                                ) : (
                                  '0'
                                )}
                              </td>
                              <td className="td font-mono text-[11px] break-all">
                                {t.error ? (
                                  <span style={{ color: 'var(--rg-state-error)' }}>{t.error}</span>
                                ) : t.acted != null ? (
                                  `动作 ${t.acted}`
                                ) : t.total != null ? (
                                  `共 ${t.total}`
                                ) : (
                                  '—'
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div
                    className="flex items-center justify-between px-4 py-2.5"
                    style={{ borderTop: '1px solid var(--rg-border)' }}
                  >
                    <span className="text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                      第 {safeLogPage + 1} / {taskPages} 页 · 显示{' '}
                      {safeLogPage * LOG_PAGE_SIZE + 1}-
                      {Math.min((safeLogPage + 1) * LOG_PAGE_SIZE, taskRows.length)} 条
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        disabled={logPage === 0}
                        onClick={() => setLogPage((p) => Math.max(0, p - 1))}
                      >
                        上一页
                      </Button>
                      <Button
                        size="sm"
                        disabled={logPage >= taskPages - 1}
                        onClick={() => setLogPage((p) => Math.min(taskPages - 1, p + 1))}
                      >
                        下一页
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </Panel>
          </>
        )}

        {active === 'rotate' && (
          <>
            <Panel
              title="轮换状态"
              description={`本机 auth 目录：${rotateStatus.data?.authDir ?? '—'}`}
            >
              <KeyCardGroups
                groups={[
                  {
                    title: '当前账号',
                    rows: [
                      {
                        k: 'uid',
                        v: (
                          <span className="font-mono break-all">
                            {rotateStatus.data?.currentUid || '未设置'}
                          </span>
                        ),
                      },
                      {
                        k: '候选账号',
                        v: (
                          <span className="font-mono">
                            {formatNumber(rotateStatus.data?.accounts?.length ?? 0)} 个
                          </span>
                        ),
                      },
                      {
                        k: '上次轮换',
                        v: (
                          <span className="font-mono">
                            {formatTime(rotateStatus.data?.lastRotateAt)}
                          </span>
                        ),
                        wide: true,
                      },
                    ],
                  },
                  {
                    title: '轮换结果',
                    rows: [
                      {
                        k: '结果',
                        v:
                          rotateStatus.data?.lastRotateOk === true ? (
                            <Chip tone="ok" dot="dot-ok">
                              成功
                            </Chip>
                          ) : rotateStatus.data?.lastRotateOk === false ? (
                            <Chip tone="danger" dot="dot-error">
                              失败
                            </Chip>
                          ) : (
                            <Chip tone="neutral" dot="dot-off">
                              暂无记录
                            </Chip>
                          ),
                      },
                      {
                        k: '失败数',
                        v: (
                          <span className="font-mono">
                            {rotateStatus.data?.lastRotateFailed ?? '—'}
                          </span>
                        ),
                      },
                    ],
                  },
                ]}
              />
            </Panel>

            <Panel
              title="轮换设置"
              description="自动轮换的开关与参数都在这里；执行时刻在「定时任务 · 执行时刻」中设置"
              actions={
                <Button
                  size="sm"
                  variant="primary"
                  onClick={saveRotateCfg}
                  disabled={busy === 'rotate-cfg' || !rotateCfgDirty}
                >
                  {busy === 'rotate-cfg' ? '保存中…' : '保存'}
                </Button>
              }
            >
              {rotateSettings.loading && !rotateSettings.data ? (
                <LoadingBlock />
              ) : rotateSettings.error ? (
                <ErrorState message={rotateSettings.error} onRetry={rotateSettings.reload} />
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-aux font-medium" style={{ color: 'var(--rg-text-secondary)' }}>
                        自动轮换
                      </div>
                      <div className="text-[12px] mt-0.5" style={{ color: 'var(--rg-text-tertiary)' }}>
                        到达设定时刻后自动遍历候选账号，每个账号停留下方设定时长
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {rotateCfg.enabled ? (
                        <Chip tone="ok" dot="dot-ok">
                          已开启
                        </Chip>
                      ) : (
                        <Chip tone="neutral" dot="dot-off">
                          已关闭
                        </Chip>
                      )}
                      <input
                        type="checkbox"
                        checked={rotateCfg.enabled}
                        onChange={(e) => {
                          setRotateCfg((c) => ({ ...c, enabled: e.target.checked }));
                          setRotateCfgDirty(true);
                        }}
                        aria-label="启用自动轮换"
                      />
                    </div>
                  </div>

                  <div className="grid gap-4 grid-cols-2 items-start">
                    <div
                      className="rounded-lg border px-3.5 py-3 min-w-0"
                      style={{ borderColor: 'var(--rg-border)' }}
                    >
                      <div className="mb-2.5 flex items-center gap-2">
                        <span className="text-aux font-medium" style={{ color: 'var(--rg-text-secondary)' }}>
                          轮换行为
                        </span>
                        <span className="h-px flex-1" style={{ background: 'var(--rg-border)' }} />
                      </div>
                      <div className="flex flex-col gap-2.5">
                        <FieldRow label="每账号停留（秒）">
                          <input
                            className="field font-mono text-[12px]"
                            type="number"
                            min={10}
                            max={3600}
                            value={String(Math.round(rotateCfg.stayMs / 1000))}
                            onChange={(e) => {
                              const sec = Number(e.target.value);
                              setRotateCfg((c) => ({ ...c, stayMs: Number.isFinite(sec) ? sec * 1000 : c.stayMs }));
                              setRotateCfgDirty(true);
                            }}
                          />
                        </FieldRow>
                        <label className="flex items-center justify-between gap-3">
                          <span className="text-aux" style={{ color: 'var(--rg-text-secondary)' }}>
                            结束后切回起始账号
                          </span>
                          <input
                            type="checkbox"
                            checked={rotateCfg.switchBack}
                            onChange={(e) => {
                              setRotateCfg((c) => ({ ...c, switchBack: e.target.checked }));
                              setRotateCfgDirty(true);
                            }}
                          />
                        </label>
                      </div>
                    </div>

                    <div
                      className="rounded-lg border px-3.5 py-3 min-w-0"
                      style={{ borderColor: 'var(--rg-border)' }}
                    >
                      <div className="mb-2.5 flex items-center gap-2">
                        <span className="text-aux font-medium" style={{ color: 'var(--rg-text-secondary)' }}>
                          排除与目录
                        </span>
                        <span className="h-px flex-1" style={{ background: 'var(--rg-border)' }} />
                      </div>
                      <div className="flex flex-col gap-2.5">
                        <FieldRow label="排除的 uid（逗号分隔）">
                          <input
                            className="field font-mono text-[12px]"
                            value={rotateCfg.excludeUids}
                            placeholder="留空表示不排除"
                            onChange={(e) => {
                              setRotateCfg((c) => ({ ...c, excludeUids: e.target.value }));
                              setRotateCfgDirty(true);
                            }}
                          />
                        </FieldRow>
                        <div className="text-[12px] break-all" style={{ color: 'var(--rg-text-tertiary)' }}>
                          auth 目录：{rotateSettings.data?.authDir || rotateStatus.data?.authDir || '默认探测'}
                        </div>
                      </div>
                    </div>
                  </div>

                  <Note>
                    自动轮换按「定时任务」里的账号轮换时刻触发；关闭后仍可随时手动执行轮换。
                  </Note>
                </div>
              )}
            </Panel>

            <Panel
              title="账号列表"
              description={`共 ${rotateRows.length} 个账号 · 活跃度取自成长中心当日数据`}
              flush
            >
              {rotateStatus.loading && !rotateStatus.data ? (
                <LoadingBlock />
              ) : rotateStatus.error ? (
                <ErrorState message={rotateStatus.error} onRetry={rotateStatus.reload} />
              ) : rotateRows.length === 0 ? (
                <div className="p-4 text-[12px]" style={{ color: 'var(--rg-text-tertiary)' }}>
                  本机 auth 目录里没有可用账号备份，可先点「生成种子」写入。
                </div>
              ) : (
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className="th">账号</th>
                      <th className="th">uid</th>
                      <th className="th">状态</th>
                      <th className="th cell-num">当日活跃</th>
                      <th className="th">说明</th>
                      <th className="th cell-act">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rotateRows.map((r) => {
                      const isCurrent = r.uid && r.uid === rotateStatus.data?.currentUid;
                      const busyThis = busy === `switch-${r.uid}`;
                      return (
                        <tr key={r.uid} className="row-hover">
                          <td className="td font-mono text-[12px] break-all">{r.label || '—'}</td>
                          <td className="td font-mono text-[11px] break-all">{r.uid}</td>
                          <td className="td">
                            {isCurrent ? (
                              <Chip tone="brand" dot="dot-ok">
                                当前
                              </Chip>
                            ) : (
                              <Chip tone="neutral" dot="dot-off">
                                候选
                              </Chip>
                            )}
                          </td>
                          <td className="td cell-num font-mono text-[12px]">
                            {r.error ? (
                              <span style={{ color: 'var(--rg-text-tertiary)' }}>—</span>
                            ) : (
                              formatNumber(r.score ?? 0)
                            )}
                          </td>
                          <td className="td text-[12px] break-all">
                            {r.error ? (
                              <span style={{ color: 'var(--rg-state-error)' }}>{r.error}</span>
                            ) : (
                              <span style={{ color: 'var(--rg-text-secondary)' }}>
                                {[r.level, r.statusText].filter(Boolean).join(' · ') || '—'}
                              </span>
                            )}
                          </td>
                          <td className="td cell-act">
                            <Button
                              size="sm"
                              disabled={isCurrent || busyThis === true}
                              onClick={() => doSwitchTo(r.uid, r.label || r.uid)}
                            >
                              {busyThis ? '切换中…' : isCurrent ? '使用中' : '切到该账号'}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Panel>

            <Panel title="轮换操作" footer="轮换可能返回业务层失败（请求成功但结果未成功），此时会展示后端返回的原因。">
              <div className="flex items-center gap-2 flex-wrap">
                <Button variant="primary" onClick={doRotate} disabled={busy === 'rotate'}>
                  {busy === 'rotate' ? '执行中…' : '执行轮换'}
                </Button>
                <Button onClick={doSeed} disabled={busy === 'seed'}>
                  {busy === 'seed' ? '生成中…' : '生成种子'}
                </Button>
                <Button onClick={doSwitchPick} disabled={busy === 'switch'}>
                  切换账号
                </Button>
              </div>
            </Panel>
          </>
        )}

        {active === 'notify' && <NotifyBackupPanel apiKey={key} />}

        {active === 'config' && (
          <>
            <Panel
              title="网关配置"
              description="来自 /v1/admin/config 的当前生效值"
              actions={
                <Button size="sm" variant="primary" onClick={doReload} disabled={busy === 'reload'}>
                  {busy === 'reload' ? '重载中…' : '重载配置'}
                </Button>
              }
              footer="重载会按当前配置文件重建模型池与路由，并返回重载前后的对比。"
            >
              {config.loading && !config.data ? (
                <LoadingBlock />
              ) : config.error ? (
                <ErrorState message={config.error} onRetry={config.reload} />
              ) : (
                <KeyCardGroups
                  groups={[
                    {
                      title: '服务',
                      rows: [
                        {
                          k: '监听地址',
                          v: (
                            <span className="font-mono">
                              {config.data?.host}:{config.data?.port}
                            </span>
                          ),
                        },
                        { k: '池化策略', v: <span className="font-mono">{config.data?.poolStrategy}</span> },
                        { k: '公开状态页', v: formatBoolean(config.data?.statusPublic) },
                        { k: '管理密钥分离', v: formatBoolean(config.data?.adminSeparated) },
                      ],
                    },
                    {
                      title: '调度与限流',
                      rows: [
                        {
                          k: '在途上限',
                          v: <span className="font-mono">{formatNumber(config.data?.maxInFlightPerAccount)}</span>,
                        },
                        {
                          k: '最低余额',
                          v: <span className="font-mono">{formatNumber(config.data?.minBalanceToUse)}</span>,
                        },
                        {
                          k: '请求间隔',
                          v: <span className="font-mono">{formatNumber(config.data?.ratePaceMs)} ms</span>,
                        },
                        {
                          k: '限流窗口',
                          v: (
                            <span className="font-mono">
                              {formatNumber(config.data?.rateWindowMs)} ms /{' '}
                              {formatNumber(config.data?.rateWindowMax)} 次
                            </span>
                          ),
                        },
                        {
                          k: '冷却时长',
                          v: <span className="font-mono">{formatDuration(config.data?.rateCooldownMs)}</span>,
                        },
                      ],
                    },
                    {
                      title: '重试与超时',
                      rows: [
                        {
                          k: '请求超时',
                          v: <span className="font-mono">{formatDuration(config.data?.requestTimeoutMs)}</span>,
                        },
                        {
                          k: '最大重试',
                          v: <span className="font-mono">{formatNumber(config.data?.maxRetries)}</span>,
                        },
                        {
                          k: '重试基础延迟',
                          v: <span className="font-mono">{formatDuration(config.data?.retryBaseDelay)}</span>,
                        },
                      ],
                    },
                    {
                      title: '调度与上游',
                      rows: [
                        { k: '调度器', v: formatBoolean(config.data?.schedulerEnabled) },
                        {
                          k: '签到时间',
                          v: (
                            <span className="font-mono">
                              {String(config.data?.checkinHour ?? 0).padStart(2, '0')}:
                              {String(config.data?.checkinMinute ?? 0).padStart(2, '0')}
                            </span>
                          ),
                        },
                        {
                          k: '保活时间',
                          v: <span className="font-mono">{config.data?.keepaliveHour ?? '—'}</span>,
                        },
                        {
                          k: '令牌刷新',
                          v: (
                            <span className="font-mono">
                              {config.data?.tokenRefreshLeadHours ?? '—'} 小时提前
                            </span>
                          ),
                        },
                        {
                          k: '模型探测',
                          v: (
                            <span className="font-mono">
                              每 {config.data?.modelProbeIntervalHours ?? '—'} 小时
                            </span>
                          ),
                        },
                        {
                          k: '上游函数',
                          v: <span className="font-mono">{config.data?.upstreamFunction || '—'}</span>,
                        },
                        {
                          k: '上游路径',
                          v: (
                            <span className="font-mono text-[12px] break-all">
                              {config.data?.upstreamChatPath}
                            </span>
                          ),
                          wide: true,
                        },
                        { k: '工具协议', v: <span className="font-mono">{config.data?.toolProtocol}</span> },
                      ],
                    },
                  ]}
                />
              )}
            </Panel>

            <ClientAccessPanel
              config={clientConfig.data}
              loading={clientConfig.loading && !clientConfig.data}
              error={clientConfig.error}
              onRetry={clientConfig.reload}
            />
          </>
        )}

        <Note>
          运维操作直接影响网关可用性：轮换会重新分配账号，重载配置会重建模型池与路由。
        </Note>
      </Stack>
    </PageShell>
  );
}
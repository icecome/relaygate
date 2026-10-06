/**
 * 运维中心：运行状态、定时任务、账号轮换、通知备份与网关配置。
 *
 * 运维类能力在侧栏收敛为一个入口，用页内分段切换，
 * 避免侧栏出现过多平级项导致导航过长。
 * 关键语义：账号轮换接口可能返回业务层失败（HTTP 200 但结果未成功），
 * 需与请求异常区分展示。
 */
import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../shared/api/auth';
import {
  clearTaskLog,
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
  saveSchedulerSettings,
  seedRotate,
  switchRotate,
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
  KeyCardGroups,
  KeyCards,
  KeyValue,
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
  const taskLog = useAsyncData(
    (signal) => getTaskLog(LOG_LIMIT, key, logTask || undefined, signal),
    [key, logTask],
    { enabled: !!key },
  );
  const rotateStatus = useAsyncData((signal) => getRotateStatus(key, signal), [key], { enabled: !!key });
  const rotateSettings = useAsyncData((signal) => getRotateSettings(key, signal), [key], { enabled: !!key });
  const config = useAsyncData((signal) => getRuntimeConfig(key, signal), [key], { enabled: !!key });

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

  async function doSwitch() {
    const uid = await prompt({
      title: '切换到指定账号',
      message: '输入目标账号的 uid。',
      input: { label: 'uid' },
      okText: '切换',
    });
    if (typeof uid !== 'string' || !uid.trim()) return;
    setBusy('switch');
    try {
      const r = await switchRotate(uid.trim(), key);
      // 后端可能返回 ok:false，属业务层失败
      if (!r.ok) {
        toast(`切换未成功：${r.msg ?? '后端未给出原因'}`, 'err');
      } else {
        toast(`已切换到 ${r.label}`, 'ok');
      }
      rotateStatus.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '切换失败', 'err');
    } finally {
      setBusy(null);
    }
  }

  async function saveScheduler() {
    setBusy('scheduler');
    try {
      await saveSchedulerSettings(scheduler.data ?? {}, key);
      toast('调度设置已保存', 'ok');
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
              actions={
                <Button size="sm" variant="primary" onClick={saveScheduler} disabled={busy === 'scheduler'}>
                  {busy === 'scheduler' ? '保存中…' : '保存'}
                </Button>
              }
            >
              {scheduler.loading && !scheduler.data ? (
                <LoadingBlock />
              ) : (
                <KeyValue
                  rows={[
                    {
                      k: '调度器',
                      v: scheduler.data?.enabled ? (
                        <Chip tone="ok" dot="dot-ok">
                          开启
                        </Chip>
                      ) : (
                        <Chip tone="neutral" dot="dot-off">
                          关闭
                        </Chip>
                      ),
                    },
                    {
                      k: '签到时间',
                      v: (
                        <span className="font-mono">
                          {String(scheduler.data?.checkinHour ?? 0).padStart(2, '0')}:
                          {String(scheduler.data?.checkinMinute ?? 0).padStart(2, '0')}
                        </span>
                      ),
                    },
                    {
                      k: '保活时间',
                      v: <span className="font-mono">{scheduler.data?.keepaliveHour ?? '—'}</span>,
                    },
                    {
                      k: '令牌刷新提前量',
                      v: <span className="font-mono">{scheduler.data?.tokenRefreshLeadHours ?? '—'} 小时</span>,
                    },
                    {
                      k: '模型探测间隔',
                      v: <span className="font-mono">{scheduler.data?.modelProbeIntervalHours ?? '—'} 小时</span>,
                    },
                  ]}
                />
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
                        style={{ background: 'var(--rg-bg-secondary)' }}
                      >
                        <tr>
                          <th className="th">时间</th>
                          <th className="th">任务</th>
                          <th className="th">结果</th>
                          <th className="th cell-num">耗时</th>
                          <th className="th">信息</th>
                        </tr>
                      </thead>
                      <tbody>
                        {taskPageRows.map((t, i) => (
                          <tr key={`${t.ts ?? i}`} className="row-hover">
                            <td className="td font-mono text-[12px]">{formatTime(t.ts)}</td>
                            <td className="td font-mono text-[12px]">{t.task || '—'}</td>
                            <td className="td">
                              <Chip
                                tone={t.ok === false ? 'danger' : 'ok'}
                                dot={t.ok === false ? 'dot-error' : 'dot-ok'}
                              >
                                {t.ok === false ? '失败' : '成功'}
                              </Chip>
                            </td>
                            <td className="td cell-num">
                              {t.durationMs == null ? '—' : formatDuration(t.durationMs)}
                            </td>
                            <td className="td font-mono text-[11px] break-all">{t.message || '—'}</td>
                          </tr>
                        ))}
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
            <Panel title="轮换状态">
              <KeyValue
                rows={[
                  { k: '当前账号', v: <span className="font-mono">{rotateStatus.data?.label || '—'}</span> },
                  { k: 'uid', v: <span className="font-mono break-all">{rotateStatus.data?.uid || '—'}</span> },
                  { k: '候选账号', v: <span className="font-mono">{formatNumber(rotateStatus.data?.pool?.candidates)}</span> },
                  { k: '执行中', v: rotateStatus.data?.busy ? '是' : '否' },
                  { k: '更新时间', v: <span className="font-mono">{formatTime(rotateStatus.data?.updatedAt)}</span> },
                  {
                    k: '轮换策略',
                    v: (
                      <span className="font-mono">
                        {rotateSettings.data?.enabled ? '开启' : '关闭'} · 间隔{' '}
                        {rotateSettings.data?.intervalHours ?? '—'} 小时
                      </span>
                    ),
                  },
                ]}
              />
            </Panel>

            <Panel title="轮换操作" footer="轮换可能返回业务层失败（请求成功但结果未成功），此时会展示后端返回的原因。">
              <div className="flex items-center gap-2 flex-wrap">
                <Button variant="primary" onClick={doRotate} disabled={busy === 'rotate'}>
                  {busy === 'rotate' ? '执行中…' : '执行轮换'}
                </Button>
                <Button onClick={doSeed} disabled={busy === 'seed'}>
                  {busy === 'seed' ? '生成中…' : '生成种子'}
                </Button>
                <Button onClick={doSwitch} disabled={busy === 'switch'}>
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
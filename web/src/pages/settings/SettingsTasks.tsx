import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../stores/useAuth';
import { useToast } from '../../components/Toast';
import { usePrompt } from '../../components/Prompt';
import {
  getSchedulerSettings,
  saveSchedulerSettings,
  getBalanceRefresh,
  saveBalanceRefresh,
  runBalanceRefresh,
  getTaskLog,
  clearTaskLog,
  type SchedulerSettings,
  type BalanceRefreshSettings,
  type TaskLogRow,
} from '../../api/admin';
import { pad2, fmtBytes } from './shared';

type Status = { msg: string; kind: '' | 'ok' | 'err' };

function toTimeInput(h: number, m: number) {
  return `${pad2(h)}:${pad2(m)}`;
}

function fromTimeInput(v: string, fallbackH: number, fallbackM: number) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return { hour: fallbackH, minute: fallbackM };
  const hour = Math.min(Math.max(parseInt(m[1], 10) || 0, 0), 23);
  const minute = Math.min(Math.max(parseInt(m[2], 10) || 0, 0), 59);
  return { hour, minute };
}

/** 任务视图：定时任务时刻、余额自动刷新与任务执行日志。 */
export default function SettingsTasks() {
  const { key } = useAuth();
  const toast = useToast();
  const prompt = usePrompt();
  const [sched, setSched] = useState<SchedulerSettings | null>(null);
  const [checkinTime, setCheckinTime] = useState('09:00');
  const [keepaliveTime, setKeepaliveTime] = useState('22:00');
  const [tokenSweep, setTokenSweep] = useState('15');
  const [probeHours, setProbeHours] = useState('6');
  const [probeMax, setProbeMax] = useState('8');
  const [schedStatus, setSchedStatus] = useState<Status>({ msg: '', kind: '' });
  const [schedSaving, setSchedSaving] = useState(false);
  const [growthPollOn, setGrowthPollOn] = useState(true);
  const [growthPollHours, setGrowthPollHours] = useState('4');

  const [bal, setBal] = useState<BalanceRefreshSettings | null>(null);
  const [balOn, setBalOn] = useState(false);
  const [balMinutes, setBalMinutes] = useState('30');
  const [balStatus, setBalStatus] = useState<Status>({ msg: '', kind: '' });
  const [balBusy, setBalBusy] = useState(false);

  const [taskLog, setTaskLog] = useState<TaskLogRow[]>([]);
  const [taskFilter, setTaskFilter] = useState('');

  const applySched = (d: SchedulerSettings) => {
    setSched(d);
    setCheckinTime(toTimeInput(d.checkinHour, d.checkinMinute));
    setKeepaliveTime(toTimeInput(d.keepaliveHour, d.keepaliveMinute));
    setTokenSweep(String(d.tokenSweepMinutes));
    setProbeHours(String(d.modelProbeIntervalHours));
    setProbeMax(String(d.modelProbeMaxPerRun));
    setGrowthPollOn(d.growthPollEnabled !== 0);
    setGrowthPollHours(String(d.growthPollIntervalHours ?? 4));
  };

  const loadScheduler = useCallback(() => {
    if (!key) {
      setSched(null);
      return;
    }
    getSchedulerSettings(key)
      .then(applySched)
      .catch((e: Error) => setSchedStatus({ msg: `定时配置加载失败：${e.message}`, kind: 'err' }));
  }, [key]);

  const loadBalance = useCallback(() => {
    if (!key) {
      setBal(null);
      return;
    }
    getBalanceRefresh(key)
      .then((d) => {
        setBal(d);
        setBalOn(d.enabled);
        setBalMinutes(String(d.intervalMinutes));
      })
      .catch(() => setBal(null));
  }, [key]);

  const loadTaskLog = useCallback(() => {
    if (!key) return;
    getTaskLog(100, taskFilter || null, key)
      .then((r) => setTaskLog(r.data || []))
      .catch(() => {});
  }, [key, taskFilter]);

  useEffect(() => {
    loadScheduler();
    loadBalance();
  }, [loadScheduler, loadBalance]);

  useEffect(() => {
    loadTaskLog();
  }, [loadTaskLog]);

  async function saveScheduler() {
    if (!key) {
      setSchedStatus({ msg: '请先保存访问密钥', kind: 'err' });
      return;
    }
    const c = fromTimeInput(checkinTime, sched?.checkinHour ?? 9, sched?.checkinMinute ?? 0);
    const k = fromTimeInput(keepaliveTime, sched?.keepaliveHour ?? 22, sched?.keepaliveMinute ?? 0);
    setSchedSaving(true);
    try {
      const body = {
        checkinHour: c.hour,
        checkinMinute: c.minute,
        keepaliveHour: k.hour,
        keepaliveMinute: k.minute,
        tokenSweepMinutes: parseInt(tokenSweep, 10) || 15,
        modelProbeIntervalHours: parseInt(probeHours, 10) || 0,
        modelProbeMaxPerRun: parseInt(probeMax, 10) || 0,
        growthPollEnabled: growthPollOn ? 1 : 0,
        growthPollIntervalHours: parseInt(growthPollHours, 10) || 0,
      };
      applySched(await saveSchedulerSettings(body, key));
      setSchedStatus({ msg: '定时配置已保存，调度器已按新时刻重排', kind: 'ok' });
      toast('定时配置已保存', 'ok');
    } catch (e) {
      setSchedStatus({ msg: `保存失败：${(e as Error).message}`, kind: 'err' });
      toast('定时配置保存失败', 'err');
    } finally {
      setSchedSaving(false);
    }
  }

  async function saveBalance() {
    if (!key) {
      setBalStatus({ msg: '请先保存访问密钥', kind: 'err' });
      return;
    }
    try {
      const d = await saveBalanceRefresh(
        { enabled: balOn, intervalMinutes: parseInt(balMinutes, 10) || 30 },
        key,
      );
      setBal(d);
      setBalOn(d.enabled);
      setBalMinutes(String(d.intervalMinutes));
      setBalStatus({ msg: d.enabled ? `余额自动刷新已启用（每 ${d.intervalMinutes} 分钟）` : '余额自动刷新已关闭', kind: 'ok' });
      toast('余额自动刷新配置已保存', 'ok');
    } catch (e) {
      setBalStatus({ msg: `保存失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  async function runBalanceNow() {
    if (!key || balBusy) return;
    setBalBusy(true);
    try {
      const r = await runBalanceRefresh(key);
      setBalStatus({ msg: `刷新完成：成功 ${r.ok} · 失败 ${r.failed}`, kind: r.failed ? 'err' : 'ok' });
      toast(`余额刷新完成：成功 ${r.ok} · 失败 ${r.failed}`, r.failed ? 'warn' : 'ok');
      loadBalance();
    } catch (e) {
      setBalStatus({ msg: `刷新失败：${(e as Error).message}`, kind: 'err' });
    } finally {
      setBalBusy(false);
    }
  }

  async function clearTaskLogNow() {
    if (!key) return;
    const ok = await prompt({ title: '清空任务日志', message: '确定清空全部任务执行日志？该操作不可恢复。', danger: true, okText: '清空', cancelText: '取消' });
    if (!ok) return;
    try {
      await clearTaskLog(key);
      setTaskLog([]);
      toast('任务日志已清空', 'ok');
    } catch (e) {
      toast(`清空失败：${(e as Error).message}`, 'err');
    }
  }

  /** 任务日志行 → 人类可读摘要。 */
  function taskLogSummary(r: TaskLogRow): string {
    if (r.task === 'backup') {
      return r.ok ? `备份完成 ${r.file}（${fmtBytes(r.sizeBytes)}，校验 ${(r.checksum || '').slice(0, 8)}…）` : `备份失败：${r.error || ''}`;
    }
    if (r.task === 'balance-refresh') {
      return `成功 ${r.ok ?? 0} · 失败 ${r.failed ?? 0}${r.error ? `（${r.error}）` : ''}`;
    }
    if (r.task === 'growth-auto') {
      return `账号 ${r.total ?? 0} · 正常 ${r.ok ?? 0} · 失败 ${r.failed ?? 0}${r.acted ? ` · 动作 ${r.acted}` : ''}${r.error ? `（${r.error}）` : ''}`;
    }
    return `${r.ok ?? 0}/${r.failed ?? 0}${r.error ? `（${r.error}）` : ''}`;
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h2 className="text-sm font-semibold mb-1">定时任务</h2>
        <p className="text-xs text-ink-soft mb-4">
          签到 / 保活 / Token 扫描 / 模型探活时刻。保存后写入本机配置并立即重排调度（无需重启服务）。
          默认值来自 .env，此处保存会覆盖 env。
        </p>
        {!key ? (
          <div className="text-xs text-ink-soft">保存访问密钥后可调整定时任务</div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="s-checkin">每日签到时刻</label>
                <input
                  id="s-checkin"
                  type="time"
                  className="field w-full"
                  value={checkinTime}
                  onChange={(e) => setCheckinTime(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="s-keepalive">每日保活时刻</label>
                <input
                  id="s-keepalive"
                  type="time"
                  className="field w-full"
                  value={keepaliveTime}
                  onChange={(e) => setKeepaliveTime(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="s-sweep">Token 临期扫描间隔（分钟）</label>
                <input
                  id="s-sweep"
                  type="number"
                  min={1}
                  max={1440}
                  className="field w-full"
                  value={tokenSweep}
                  onChange={(e) => setTokenSweep(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="s-probe-h">模型探活间隔（小时，0=关闭）</label>
                <input
                  id="s-probe-h"
                  type="number"
                  min={0}
                  max={168}
                  className="field w-full"
                  value={probeHours}
                  onChange={(e) => setProbeHours(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="s-probe-max">模型探活每轮上限</label>
                <input
                  id="s-probe-max"
                  type="number"
                  min={0}
                  max={100}
                  className="field w-full"
                  value={probeMax}
                  onChange={(e) => setProbeMax(e.target.value)}
                />
              </div>
              <div>
                <label className="flex items-center gap-2 text-xs font-medium text-ink-soft mb-1.5" htmlFor="s-growth-on">
                  <input
                    id="s-growth-on"
                    type="checkbox"
                    className="w-4 h-4 accent-acc"
                    checked={growthPollOn}
                    onChange={(e) => setGrowthPollOn(e.target.checked)}
                  />
                  成长中心独立轮询（0=关闭）
                </label>
                <input
                  id="s-growth-h"
                  type="number"
                  min={0}
                  max={168}
                  className="field w-full"
                  value={growthPollHours}
                  onChange={(e) => setGrowthPollHours(e.target.value)}
                  disabled={!growthPollOn}
                />
              </div>
              <div className="flex items-end">
                <button type="button" className="btn btn-primary" onClick={saveScheduler} disabled={schedSaving}>
                  {schedSaving ? '保存中…' : '保存定时配置'}
                </button>
              </div>
            </div>
            <p className="text-xs text-ink-faint mt-2.5">
              成长中心轮询会按间隔自动执行「领奖 / 派猫 / 任务 / 补登 / 兑换 / 抽奖 / 盲盒」，与每日签到解耦，及时把礼物领回、避免当天名额浪费。
            </p>
          </>
        )}
        {schedStatus.msg && (
          <div role="status" className={`text-xs mt-2.5 ${schedStatus.kind === 'ok' ? 'text-acc-hover' : schedStatus.kind === 'err' ? 'text-danger' : 'text-ink-soft'}`}>
            {schedStatus.msg}
          </div>
        )}
      </div>

      <div className="card p-5">
        <h2 className="text-sm font-semibold mb-1">余额自动刷新</h2>
        <p className="text-xs text-ink-soft mb-4">
          按设定间隔自动查询全部启用账号余额并写入账号库；刷新过程不占用账号池租约、不影响转发请求。刷新后自动检测临期积分与低余额提醒。
        </p>
        {!key ? (
          <div className="text-xs text-ink-soft">保存访问密钥后可配置余额自动刷新</div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="flex items-center gap-2 text-xs font-medium text-ink-soft mb-1.5" htmlFor="b-on">
                  <input id="b-on" type="checkbox" className="w-4 h-4 accent-acc" checked={balOn} onChange={(e) => setBalOn(e.target.checked)} />
                  启用自动刷新
                </label>
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="b-min">刷新间隔（分钟，5–1440）</label>
                <input
                  id="b-min"
                  type="number"
                  min={5}
                  max={1440}
                  className="field w-full"
                  value={balMinutes}
                  onChange={(e) => setBalMinutes(e.target.value)}
                />
              </div>
              <div className="flex items-end gap-2">
                <button type="button" className="btn btn-primary" onClick={saveBalance}>
                  保存配置
                </button>
                <button type="button" className="btn btn-ghost" onClick={runBalanceNow} disabled={balBusy}>
                  {balBusy ? '刷新中…' : '立即刷新'}
                </button>
              </div>
            </div>
            {bal?.lastRunAt && (
              <div className="text-xs text-ink-faint mt-3 tabular-nums">
                上次刷新：{bal.lastRunAt.slice(0, 19).replace('T', ' ')} · 成功 {bal.lastOk ?? 0} / 失败 {bal.lastFailed ?? 0}
                {bal.running ? ' · 刷新中…' : ''}
              </div>
            )}
            {balStatus.msg && (
              <div role="status" className={`text-xs mt-2.5 ${balStatus.kind === 'ok' ? 'text-acc-hover' : balStatus.kind === 'err' ? 'text-danger' : ''}`}>
                {balStatus.msg}
              </div>
            )}
          </>
        )}
      </div>

      <div className="card p-5">
        <h2 className="text-sm font-semibold mb-1">任务执行日志</h2>
        <p className="text-xs text-ink-soft mb-4">定时任务与手动触发的执行记录（余额刷新 / 备份 / 成长中心轮询 / 签到等），新→旧展示，最多保留 500 条。</p>
        {!key ? (
          <div className="text-xs text-ink-soft">保存访问密钥后可查看任务日志</div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 items-center mb-3">
              <select className="field w-auto" value={taskFilter} onChange={(e) => setTaskFilter(e.target.value)} aria-label="按任务筛选">
                <option value="">全部任务</option>
                <option value="balance-refresh">余额刷新</option>
                <option value="backup">全量备份</option>
                <option value="growth-auto">成长中心</option>
              </select>
              <button type="button" className="btn btn-ghost btn-sm" onClick={loadTaskLog}>
                刷新
              </button>
              <button type="button" className="btn btn-ghost btn-sm ml-auto" onClick={clearTaskLogNow}>
                清空
              </button>
            </div>
            {taskLog.length ? (
              <div className="border border-line rounded-lg overflow-x-auto">
                <table className="w-full border-collapse text-[12px] min-w-[560px]">
                  <thead>
                    <tr>
                      <th className="th cell-num">时间</th>
                      <th className="th">任务</th>
                      <th className="th">触发</th>
                      <th className="th">结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {taskLog.map((r, i) => (
                      <tr key={i} className="row-hover [&>td]:px-4 [&>td]:py-2.5 align-middle">
                        <td className="cell-num text-ink-faint whitespace-nowrap">{String(r.ts || '').slice(0, 19).replace('T', ' ')}</td>
                        <td className="whitespace-nowrap">{r.task || '—'}</td>
                        <td className="text-ink-faint whitespace-nowrap">{r.trigger || '—'}</td>
                        <td className={r.failed ? 'text-warn' : 'text-acc-hover'}>{taskLogSummary(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-xs text-ink-faint">暂无任务执行记录。</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
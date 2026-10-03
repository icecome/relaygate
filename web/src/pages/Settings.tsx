import { useCallback, useEffect, useState } from 'react';
import { useAuth, setKey, clearKey } from '../stores/useAuth';
import { useToast } from '../components/Toast';
import { usePrompt } from '../components/Prompt';
import {
  getClientConfig,
  getNotifySettings,
  saveNotifySettings,
  testNotify,
  getRuntimeConfig,
  reloadConfig,
  getSchedulerSettings,
  saveSchedulerSettings,
  getBalanceRefresh,
  saveBalanceRefresh,
  runBalanceRefresh,
  getTaskLog,
  clearTaskLog,
  getBackup,
  saveBackup,
  runBackup,
  verifyBackup,
  addNotifyEvent,
  removeNotifyEvent,
  type ClientConfig,
  type NotifySettings,
  type RuntimeConfig,
  type SchedulerSettings,
  type NotifyEventPrefs,
  type BalanceRefreshSettings,
  type BackupSettings,
  type TaskLogRow,
} from '../api/admin';

type ChannelId = 'webhook' | 'serverchan' | 'pushplus' | 'telegram';
type EventId = keyof NotifyEventPrefs;

/**
 * 设置页按运维语义分四个视图：
 *   run    运行状态（只读快照，由 StatusPage 承担）
 *   tasks  定时任务与余额自动刷新
 *   notify 通知渠道、通知事件与全量备份
 *   config 登录密钥、客户端接入、服务信息与运行时配置
 * 状态与加载逻辑在各视图间共用，故以单组件 + view 切换承载，而非拆成四个独立页面。
 */
export type SettingsView = 'run' | 'tasks' | 'notify' | 'config';

const CHANNEL_META: { id: ChannelId; label: string; hint: string }[] = [
  { id: 'webhook', label: '自定义 Webhook', hint: 'URL / Method / Header / 字段名均可配置' },
  { id: 'serverchan', label: 'Server酱', hint: '填 SendKey，域名自动使用 sctapi.ftqq.com' },
  { id: 'pushplus', label: 'PushPlus', hint: '填 Token，域名自动使用 www.pushplus.plus' },
  { id: 'telegram', label: 'Telegram', hint: '填 Bot Token 与 Chat ID' },
];

/** 取字符串末 4 位作为可辨识片段；过短则整体用省略号替代 */
function tailOf(s: string): string {
  return s.length > 4 ? `…${s.slice(-4)}` : '…';
}

const EVENT_META: { id: EventId; label: string; hint: string }[] = [
  { id: 'checkin_ok', label: '签到成功', hint: '每日签到全部成功时推送汇总' },
  { id: 'checkin_fail', label: '签到失败', hint: '存在失败账号时推送' },
  { id: 'credits_expiring', label: '积分临期', hint: '余额刷新后检测 3/7 天内过期积分' },
  { id: 'balance_low', label: '余额过低', hint: '账号余额低于 MIN_BALANCE_TO_USE 时提醒' },
  { id: 'refresh_fail', label: 'Token 刷新失败', hint: '预刷新或保活失败' },
  { id: 'pool_empty', label: '账号池空', hint: '池内无可用账号' },
  { id: 'growth_claimed', label: '成长奖励到账', hint: '成长中心领取/兑换/抽奖成功时推送' },
  { id: 'growth_departed', label: '派猫出发', hint: '成长中心派猫出游时推送' },
  { id: 'backup_done', label: '备份完成', hint: '全量备份成功完成后推送' },
  { id: 'backup_failed', label: '备份失败', hint: '全量备份失败时推送' },
];

const DEFAULT_EVENTS: NotifyEventPrefs = {
  checkin_ok: true,
  checkin_fail: true,
  credits_expiring: true,
  balance_low: true,
  refresh_fail: true,
  pool_empty: true,
  growth_claimed: true,
  growth_departed: true,
  backup_done: true,
  backup_failed: true,
};

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

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

export default function Settings({ view = 'config' }: { view?: SettingsView }) {
  const { key } = useAuth();
  const toast = useToast();
  const prompt = usePrompt();
  const [inputKey, setInputKey] = useState(key);
  const [showKey, setShowKey] = useState(false);
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [notify, setNotify] = useState<NotifySettings>({});
  const [notifyStatus, setNotifyStatus] = useState<{ msg: string; kind: '' | 'ok' | 'err' }>({ msg: '', kind: '' });
  const [keyStatus, setKeyStatus] = useState<{ msg: string; kind: '' | 'ok' | 'err' }>({ msg: '', kind: '' });
  const [expandedChannel, setExpandedChannel] = useState<ChannelId | null>(null);
  const [rtConfig, setRtConfig] = useState<RuntimeConfig | null>(null);
  const [rtStatus, setRtStatus] = useState<{ msg: string; kind: '' | 'ok' | 'err' }>({ msg: '', kind: '' });
  const [rtReloading, setRtReloading] = useState(false);
  const [sched, setSched] = useState<SchedulerSettings | null>(null);
  const [checkinTime, setCheckinTime] = useState('09:00');
  const [keepaliveTime, setKeepaliveTime] = useState('22:00');
  const [tokenSweep, setTokenSweep] = useState('15');
  const [probeHours, setProbeHours] = useState('6');
  const [probeMax, setProbeMax] = useState('8');
  const [schedStatus, setSchedStatus] = useState<{ msg: string; kind: '' | 'ok' | 'err' }>({ msg: '', kind: '' });
  const [schedSaving, setSchedSaving] = useState(false);
  const [growthPollOn, setGrowthPollOn] = useState(true);
  const [growthPollHours, setGrowthPollHours] = useState('4');

  // 余额自动刷新
  const [bal, setBal] = useState<BalanceRefreshSettings | null>(null);
  const [balOn, setBalOn] = useState(false);
  const [balMinutes, setBalMinutes] = useState('30');
  const [balStatus, setBalStatus] = useState<{ msg: string; kind: '' | 'ok' | 'err' }>({ msg: '', kind: '' });
  const [balBusy, setBalBusy] = useState(false);

  // 任务执行日志
  const [taskLog, setTaskLog] = useState<TaskLogRow[]>([]);
  const [taskFilter, setTaskFilter] = useState('');

  // 全量备份
  const [backup, setBackup] = useState<BackupSettings | null>(null);
  const [bkOn, setBkOn] = useState(false);
  const [bkDir, setBkDir] = useState('');
  const [bkKeep, setBkKeep] = useState('5');
  const [bkHours, setBkHours] = useState('24');
  const [bkStatus, setBkStatus] = useState<{ msg: string; kind: '' | 'ok' | 'err' }>({ msg: '', kind: '' });
  const [bkBusy, setBkBusy] = useState(false);
  const [bkVerifyMsg, setBkVerifyMsg] = useState<{ msg: string; kind: '' | 'ok' | 'err' }>({ msg: '', kind: '' });

  // 通知事件自定义
  const [customEvent, setCustomEvent] = useState('');
  const [eventsStatus, setEventsStatus] = useState<{ msg: string; kind: '' | 'ok' | 'err' }>({ msg: '', kind: '' });

  const loadConfig = useCallback(() => {
    if (!key) {
      setConfig(null);
      return;
    }
    getClientConfig(key)
      .then(setConfig)
      .catch(() => setConfig(null));
  }, [key]);

  const loadNotify = useCallback(() => {
    if (!key) {
      setNotify({ events: { ...DEFAULT_EVENTS } });
      setNotifyStatus({ msg: '保存访问密钥后可配置通知渠道', kind: '' });
      return;
    }
    getNotifySettings(key)
      .then((d) => setNotify({ ...d, events: { ...DEFAULT_EVENTS, ...(d.events || {}) } }))
      .catch((e: Error) => setNotifyStatus({ msg: `通知配置加载失败：${e.message}`, kind: 'err' }));
  }, [key]);

  const loadScheduler = useCallback(() => {
    if (!key) {
      setSched(null);
      return;
    }
    getSchedulerSettings(key)
      .then((d) => {
        setSched(d);
        setCheckinTime(toTimeInput(d.checkinHour, d.checkinMinute));
        setKeepaliveTime(toTimeInput(d.keepaliveHour, d.keepaliveMinute));
        setTokenSweep(String(d.tokenSweepMinutes));
        setProbeHours(String(d.modelProbeIntervalHours));
        setProbeMax(String(d.modelProbeMaxPerRun));
        setGrowthPollOn(d.growthPollEnabled !== 0);
        setGrowthPollHours(String(d.growthPollIntervalHours ?? 4));
      })
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

  const loadBackup = useCallback(() => {
    if (!key) {
      setBackup(null);
      return;
    }
    getBackup(key)
      .then((d) => {
        setBackup(d);
        setBkOn(d.enabled);
        setBkDir(d.dir || '');
        setBkKeep(String(d.keep));
        setBkHours(String(d.intervalHours));
      })
      .catch(() => setBackup(null));
  }, [key]);

  const loadTaskLog = useCallback(() => {
    if (!key) return;
    getTaskLog(100, taskFilter || null, key)
      .then((r) => setTaskLog(r.data || []))
      .catch(() => {});
  }, [key, taskFilter]);

  const loadRtConfig = useCallback(() => {
    if (!key) {
      setRtConfig(null);
      setRtStatus({ msg: '', kind: '' });
      return;
    }
    setRtStatus({ msg: '', kind: '' });
    getRuntimeConfig(key)
      .then((d) => {
        setRtConfig(d);
        setRtStatus({ msg: '', kind: '' });
      })
      .catch((e: Error) => {
        // 与 loadNotify / loadScheduler 同口径：失败写状态，界面才能区分「加载中」与「加载失败」
        setRtConfig(null);
        setRtStatus({ msg: `运行时配置加载失败：${e.message}`, kind: 'err' });
      });
  }, [key]);

  useEffect(() => {
    setInputKey(key);
    loadConfig();
    loadNotify();
    loadScheduler();
    loadRtConfig();
    loadBalance();
    loadBackup();
    loadTaskLog();
  }, [key, loadConfig, loadNotify, loadScheduler, loadRtConfig, loadBalance, loadBackup, loadTaskLog]);

  function saveKey() {
    const v = inputKey.trim();
    setKey(v);
    setKeyStatus({ msg: '密钥已保存', kind: 'ok' });
    toast('密钥已保存并连接');
  }

  async function saveNotify() {
    try {
      await saveNotifySettings(notify, key);
      setNotifyStatus({ msg: '通知配置已保存，立即生效', kind: 'ok' });
      toast('通知配置已保存', 'ok');
    } catch (e) {
      setNotifyStatus({ msg: `保存失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  function setEventEnabled(id: EventId, on: boolean) {
    setNotify((prev) => ({
      ...prev,
      events: { ...(prev.events || DEFAULT_EVENTS), [id]: on },
    }));
  }

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
      const d = await saveSchedulerSettings(body, key);
      setSched(d);
      setCheckinTime(toTimeInput(d.checkinHour, d.checkinMinute));
      setKeepaliveTime(toTimeInput(d.keepaliveHour, d.keepaliveMinute));
      setTokenSweep(String(d.tokenSweepMinutes));
      setProbeHours(String(d.modelProbeIntervalHours));
      setProbeMax(String(d.modelProbeMaxPerRun));
      setGrowthPollOn(d.growthPollEnabled !== 0);
      setGrowthPollHours(String(d.growthPollIntervalHours ?? 4));
      setSchedStatus({ msg: '定时配置已保存，调度器已按新时刻重排', kind: 'ok' });
      toast('定时配置已保存', 'ok');
      loadRtConfig();
    } catch (e) {
      setSchedStatus({ msg: `保存失败：${(e as Error).message}`, kind: 'err' });
      toast('定时配置保存失败', 'err');
    } finally {
      setSchedSaving(false);
    }
  }

  async function doTestNotify() {
    if (!key) {
      setNotifyStatus({ msg: '请先保存访问密钥', kind: 'err' });
      return;
    }
    try {
      const r = await testNotify(key);
      if (r.ok) {
        setNotifyStatus({ msg: '测试通知已发送', kind: 'ok' });
        toast('测试通知已发送', 'ok');
      } else if (!r.enabled) {
        setNotifyStatus({ msg: '未配置通知渠道，请先填写并保存', kind: 'err' });
      } else {
        const parts = (r.results || []).map((c) =>
          c.ok ? `${c.channel} 已送达` : `${c.channel} 失败${c.message ? `（${c.message}）` : ''}`,
        );
        setNotifyStatus({ msg: `测试结果：${parts.join(' · ')}`, kind: 'err' });
        toast('测试通知未全部送达', 'err');
      }
    } catch (e) {
      setNotifyStatus({ msg: `测试失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  async function doReloadConfig() {
    if (!key) {
      setRtStatus({ msg: '请先保存访问密钥', kind: 'err' });
      return;
    }
    setRtReloading(true);
    try {
      const r = await reloadConfig(key);
      setRtStatus({ msg: `已重载：${r.after.modelCount} 个模型，池策略 ${r.after.poolStrategy}`, kind: 'ok' });
      toast('配置已重载', 'ok');
      loadRtConfig();
    } catch (e) {
      setRtStatus({ msg: `重载失败：${(e as Error).message}`, kind: 'err' });
      toast('配置重载失败', 'err');
    } finally {
      setRtReloading(false);
    }
  }

  // ===== 余额自动刷新 =====
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

  // ===== 任务执行日志 =====
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

  // ===== 全量备份 =====
  async function saveBackupCfg() {
    if (!key) {
      setBkStatus({ msg: '请先保存访问密钥', kind: 'err' });
      return;
    }
    try {
      const d = await saveBackup(
        { enabled: bkOn, dir: bkDir, keep: parseInt(bkKeep, 10) || 5, intervalHours: parseInt(bkHours, 10) || 24 },
        key,
      );
      setBackup(d);
      setBkOn(d.enabled);
      setBkDir(d.dir || '');
      setBkKeep(String(d.keep));
      setBkHours(String(d.intervalHours));
      setBkStatus({ msg: d.enabled ? `自动备份已启用（每 ${d.intervalHours} 小时 → ${d.dir}）` : '自动备份已关闭', kind: 'ok' });
      toast('备份配置已保存', 'ok');
    } catch (e) {
      setBkStatus({ msg: `保存失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  async function runBackupNow() {
    if (!key || bkBusy) return;
    setBkBusy(true);
    setBkStatus({ msg: '备份进行中…（收集 → 加密 → 落盘 → 清理旧档）', kind: '' });
    try {
      const r = await runBackup(key);
      if (r.ok && r.file) {
        setBkStatus({ msg: `备份完成：${r.file}（${fmtBytes(r.sizeBytes)}）`, kind: 'ok' });
        toast('全量备份完成', 'ok');
      } else {
        setBkStatus({ msg: `备份失败：${r.error || '未知原因'}`, kind: 'err' });
        toast(`备份失败：${r.error || '未知原因'}`, 'err');
      }
      loadBackup();
    } catch (e) {
      setBkStatus({ msg: `备份失败：${(e as Error).message}`, kind: 'err' });
    } finally {
      setBkBusy(false);
    }
  }

  async function verifyBackupNow(path: string) {
    if (!key) return;
    try {
      const r = await verifyBackup(path, key);
      setBkVerifyMsg({ msg: r.ok ? `校验通过（${r.reason || ''}）` : `校验失败：${r.reason || ''}`, kind: r.ok ? 'ok' : 'err' });
      toast(r.ok ? '备份校验通过' : `备份校验失败：${r.reason || ''}`, r.ok ? 'ok' : 'err');
    } catch (e) {
      setBkVerifyMsg({ msg: `校验失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  // ===== 通知事件自定义 =====
  const notifyEventsData = (notify.events || {}) as Record<string, boolean>;
  const customEventIds = Object.keys(notifyEventsData).filter((id) => !EVENT_META.some((m) => m.id === id));

  async function addCustomEvent() {
    const id = customEvent.trim();
    if (!id) {
      setEventsStatus({ msg: '请输入事件名', kind: 'err' });
      return;
    }
    try {
      const r = await addNotifyEvent(id, key);
      setEventsStatus({ msg: `事件「${r.event.id}」已添加`, kind: 'ok' });
      toast(`事件「${r.event.id}」已添加`, 'ok');
      setCustomEvent('');
      loadNotify();
    } catch (e) {
      setEventsStatus({ msg: `添加失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  async function removeCustomEvent(id: string) {
    const ok = await prompt({ title: '删除自定义事件', message: `确定删除事件「${id}」？之后该事件将不再推送。`, danger: true, okText: '删除', cancelText: '取消' });
    if (!ok) return;
    try {
      await removeNotifyEvent(id, key);
      setEventsStatus({ msg: `事件「${id}」已删除`, kind: 'ok' });
      toast(`事件「${id}」已删除`, 'ok');
      loadNotify();
    } catch (e) {
      setEventsStatus({ msg: `删除失败：${(e as Error).message}`, kind: 'err' });
    }
  }

  const configRows = [
    ['站点 BASE URL', config?.baseUrl, true],
    ['OpenAI BASE URL', config?.openai?.OPENAI_BASE_URL, true],
    ['Anthropic BASE URL', config?.anthropic?.ANTHROPIC_BASE_URL, true],
    ['Codex（Responses）', config?.codex?.base_url, true],
  ] as const;

  /** 字节数人性化。 */
  function fmtBytes(n?: number): string {
    if (n == null || !Number.isFinite(n)) return '—';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
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

  const copyRow = async (v: string) => {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(v);
      else throw new Error();
      toast('已复制', 'ok');
    } catch {
      toast('复制失败', 'err');
    }
  };

  const isChannelConfigured = (id: ChannelId): boolean => {
    switch (id) {
      case 'webhook': return !!notify.webhookUrl?.trim();
      case 'serverchan': return !!notify.serverChanSendKey?.trim();
      case 'pushplus': return !!notify.pushPlusToken?.trim();
      case 'telegram': return !!notify.telegramBotToken?.trim() && !!notify.telegramChatId?.trim();
    }
  };

  const channelSummary = (id: ChannelId): string => {
    switch (id) {
      case 'webhook': {
        const url = notify.webhookUrl?.trim();
        if (!url) return '';
        // 数据源本身返回明文，摘要只露 host 与路径尾部，兼顾脱敏与可辨识
        try {
          const u = new URL(url);
          return `${u.host} ${tailOf(u.pathname)}`;
        } catch {
          return tailOf(url);
        }
      }
      case 'serverchan': return notify.serverChanSendKey?.trim() ? `SCT…${notify.serverChanSendKey!.slice(-4)}` : '';
      case 'pushplus': return notify.pushPlusToken?.trim() ? `Token…${notify.pushPlusToken!.slice(-4)}` : '';
      case 'telegram': return notify.telegramChatId?.trim() ? `…${notify.telegramChatId!.slice(-4)}` : '';
    }
  };

  const toggleChannel = (id: ChannelId) => {
    setExpandedChannel((cur) => (cur === id ? null : id));
  };

  return (
    <div className="space-y-4">

      {view === 'config' && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-1">登录密钥</h2>
          <p className="text-xs text-ink-soft mb-4">
            用于本管理面板登录（Authorization: Bearer）。与「访问密钥」分离：访问密钥在概览页管理，供 IDE 调用转发接口。密钥仅保存在本机浏览器。
          </p>
          <label className="block text-xs font-medium text-ink-soft mb-2" htmlFor="api-key">
            登录密钥
          </label>
          <div className="flex flex-wrap gap-2 items-center">
            <input
              id="api-key"
              className="field flex-1 min-w-[200px] h-10"
              type={showKey ? 'text' : 'password'}
              value={inputKey}
              onChange={(e) => setInputKey(e.target.value)}
              placeholder="粘贴登录密钥"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="button" className="btn btn-ghost btn-sm h-10" onClick={() => setShowKey((s) => !s)}>
              {showKey ? '隐藏' : '显示'}
            </button>
            <button type="button" className="btn btn-primary" onClick={saveKey}>
              保存并连接
            </button>
            <button type="button" className="btn btn-ghost" onClick={clearKey}>
              清除
            </button>
          </div>
          <p className="text-xs text-ink-faint mt-2.5">
            登录密钥丢失或需轮换：在服务器执行 <code className="font-mono">node scripts/login-key.js reset</code>，明文仅终端显示一次。
            IDE/客户端请使用概览页创建的「访问密钥」调用 /v1/chat*。
          </p>
          {keyStatus.msg && (
            <div role="status" className={`text-xs mt-2.5 ${keyStatus.kind === 'ok' ? 'text-acc-hover' : keyStatus.kind === 'err' ? 'text-danger' : ''}`}>
              {keyStatus.msg}
            </div>
          )}
        </div>
      )}

      {view === 'config' && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-1">客户端配置</h2>
          <p className="text-xs text-ink-soft mb-4">转发接口的接入地址与协议端点（只读）。转发面使用「访问密钥」，管理面板使用「登录密钥」。</p>
          {!key ? (
            <div className="text-xs text-ink-soft">保存登录密钥后展示接入信息</div>
          ) : (
            <div className="grid gap-2.5">
              {configRows.map(([k, v, copyable]) => (
                <div key={k} className="kv-row">
                  <span className="kv-k">{k}</span>
                  <span className="kv-v">
                    {v || '—'}
                    {copyable && v && (
                      <button type="button" className="btn-quiet ml-1" onClick={() => copyRow(v)}>
                        复制
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
          {config?.notes?.length ? <p className="text-xs text-ink-faint mt-3">说明：{config.notes.join('；')}</p> : null}
        </div>
      )}

      {view === 'notify' && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-1">通知渠道</h2>
          <p className="text-xs text-ink-soft mb-4">点击渠道展开配置，保存后立即生效；留空的渠道回退读取 .env 同名配置。下方可按事件类型开关推送。</p>

          <div className="border border-line rounded-lg divide-y divide-line overflow-hidden">
            {CHANNEL_META.map((ch) => {
              const configured = isChannelConfigured(ch.id);
              const expanded = expandedChannel === ch.id;
              return (
                <div key={ch.id}>
                  <button
                    type="button"
                    className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-surf-soft transition-colors"
                    onClick={() => toggleChannel(ch.id)}
                    aria-expanded={expanded}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`inline-block w-2 h-2 rounded-full shrink-0 ${configured ? 'bg-acc' : 'bg-line'}`}
                        aria-hidden
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-ink">{ch.label}</div>
                        <div className="text-xs text-ink-faint truncate">
                          {configured ? channelSummary(ch.id) : ch.hint}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-3">
                      <span className={`text-xs ${configured ? 'text-acc-hover' : 'text-ink-faint'}`}>
                        {configured ? '已配置' : '未配置'}
                      </span>
                      <span className={`text-ink-faint text-xs transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden>
                        ▼
                      </span>
                    </div>
                  </button>

                  {expanded && (
                    <div className="px-4 pb-4 pt-1 border-t border-line bg-surf-soft/40">
                      {ch.id === 'webhook' && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-3">
                          <div className="col-span-2">
                            <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-webhook">请求地址</label>
                            <input id="n-webhook" className="field w-full" value={notify.webhookUrl || ''} onChange={(e) => setNotify({ ...notify, webhookUrl: e.target.value })} placeholder="https://example.com/hook" />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-webhook-method">请求方法</label>
                            <select id="n-webhook-method" className="field w-full" value={notify.webhookMethod || 'POST'} onChange={(e) => setNotify({ ...notify, webhookMethod: e.target.value })}>
                              <option value="POST">POST</option>
                              <option value="PUT">PUT</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-webhook-title-key">标题字段名</label>
                            <input id="n-webhook-title-key" className="field w-full" value={notify.webhookTitleKey || ''} onChange={(e) => setNotify({ ...notify, webhookTitleKey: e.target.value })} placeholder="title（留空则发 event/ts/text/payload）" />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-webhook-content-key">内容字段名</label>
                            <input id="n-webhook-content-key" className="field w-full" value={notify.webhookContentKey || ''} onChange={(e) => setNotify({ ...notify, webhookContentKey: e.target.value })} placeholder="content（与标题字段名配合）" />
                          </div>
                          <div className="col-span-2">
                            <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-webhook-headers">自定义 Header（JSON）</label>
                            <input id="n-webhook-headers" className="field w-full font-mono text-xs" value={notify.webhookHeaders || ''} onChange={(e) => setNotify({ ...notify, webhookHeaders: e.target.value })} placeholder='{"Authorization":"Bearer xxx"}' />
                            <p className="text-xs text-ink-faint mt-1">留空则仅发 Content-Type: application/json。填 JSON 可加 Authorization 等自定义头。</p>
                          </div>
                        </div>
                      )}
                      {ch.id === 'serverchan' && (
                        <div className="pt-3">
                          <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-serverchan">SendKey</label>
                          <input id="n-serverchan" className="field w-full" value={notify.serverChanSendKey || ''} onChange={(e) => setNotify({ ...notify, serverChanSendKey: e.target.value })} placeholder="SCT…（sct.ftqq.com）" />
                        </div>
                      )}
                      {ch.id === 'pushplus' && (
                        <div className="pt-3">
                          <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-pushplus">Token</label>
                          <input id="n-pushplus" className="field w-full" value={notify.pushPlusToken || ''} onChange={(e) => setNotify({ ...notify, pushPlusToken: e.target.value })} placeholder="www.pushplus.plus" />
                        </div>
                      )}
                      {ch.id === 'telegram' && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-3">
                          <div>
                            <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-tg-token">Bot Token</label>
                            <input id="n-tg-token" className="field w-full" value={notify.telegramBotToken || ''} onChange={(e) => setNotify({ ...notify, telegramBotToken: e.target.value })} placeholder="123456:ABC…" />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="n-tg-chat">Chat ID</label>
                            <input id="n-tg-chat" className="field w-full" value={notify.telegramChatId || ''} onChange={(e) => setNotify({ ...notify, telegramChatId: e.target.value })} placeholder="chat_id" />
                          </div>
                        </div>
                      )}
                      <div className="flex gap-2 mt-3">
                        <button type="button" className="btn btn-primary btn-sm" onClick={saveNotify}>
                          保存通知配置
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={doTestNotify}>
                          测试通知
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-5">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-ink-soft">提醒事件</h3>
              <span className="text-[11px] text-ink-faint">关闭后该类事件不再推送（渠道需已配置）</span>
            </div>
            <div className="border border-line rounded-lg divide-y divide-line overflow-hidden">
              {EVENT_META.map((ev) => {
                const on = notify.events?.[ev.id] !== false;
                return (
                  <label
                    key={ev.id}
                    htmlFor={`ev-${ev.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 cursor-pointer hover:bg-surf-soft transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="text-sm text-ink">{ev.label}</div>
                      <div className="text-xs text-ink-faint truncate">{ev.hint}</div>
                    </div>
                    <input
                      id={`ev-${ev.id}`}
                      type="checkbox"
                      className="w-4 h-4 accent-acc shrink-0"
                      checked={on}
                      onChange={(e) => setEventEnabled(ev.id, e.target.checked)}
                    />
                  </label>
                );
              })}
            </div>
            <div className="flex gap-2 mt-3">
              <button type="button" className="btn btn-primary btn-sm" onClick={saveNotify}>
                保存通知配置
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={doTestNotify}>
                测试通知
              </button>
            </div>
          </div>

          {notifyStatus.msg && (
            <div role="status" className={`text-xs mt-2.5 ${notifyStatus.kind === 'ok' ? 'text-acc-hover' : notifyStatus.kind === 'err' ? 'text-danger' : 'text-ink-soft'}`}>
              {notifyStatus.msg}
            </div>
          )}
        </div>
      )}

      {/* 定时任务配置 */}
      {view === 'tasks' && (
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
      )}

      {view === 'tasks' && (
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
      )}

      {view === 'notify' && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-1">全量备份</h2>
          <p className="text-xs text-ink-soft mb-4">
            备份内容：账号凭据（AES 加密密文）、API 密钥、积分历史、调度/通知/模型配置。备份文件单文件 JSON（含校验和），
            绝不含明文凭据。密钥来自 TRAE_BACKUP_PASSPHRASE 或 .trae-api/backup.key（自动生成）。完成自动推送「系统备份完成」通知。
          </p>
          {!key ? (
            <div className="text-xs text-ink-soft">保存访问密钥后可配置备份</div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="flex items-center gap-2 text-xs font-medium text-ink-soft mb-1.5" htmlFor="bk-on">
                    <input id="bk-on" type="checkbox" className="w-4 h-4 accent-acc" checked={bkOn} onChange={(e) => setBkOn(e.target.checked)} />
                    启用自动备份
                  </label>
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="bk-dir">存储路径</label>
                  <input
                    id="bk-dir"
                    className="field w-full font-mono text-xs"
                    value={bkDir}
                    onChange={(e) => setBkDir(e.target.value)}
                    placeholder="backups（默认项目根目录 backups/）"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="bk-keep">保留份数（1–50）</label>
                  <input id="bk-keep" type="number" min={1} max={50} className="field w-full" value={bkKeep} onChange={(e) => setBkKeep(e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-soft mb-1.5" htmlFor="bk-hours">自动备份间隔（小时，1–168）</label>
                  <input id="bk-hours" type="number" min={1} max={168} className="field w-full" value={bkHours} onChange={(e) => setBkHours(e.target.value)} />
                </div>
                <div className="flex items-end gap-2">
                  <button type="button" className="btn btn-primary" onClick={saveBackupCfg}>
                    保存配置
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={runBackupNow} disabled={bkBusy}>
                    {bkBusy ? '备份中…' : '立即备份'}
                  </button>
                </div>
              </div>
              {backup?.list && backup.list.length > 0 && (
                <div className="mt-3 border border-line rounded-lg overflow-hidden">
                  <table className="w-full border-collapse text-[12px]">
                    <thead>
                      <tr className="text-left text-[11px] font-medium text-ink-soft [&>th]:px-3 [&>th]:py-2 [&>th]:border-b [&>th]:border-line">
                        <th className="th">备份文件</th>
                        <th className="th cell-num">大小</th>
                        <th className="th">校验和</th>
                        <th className="th cell-act">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {backup.list.map((b) => (
                        <tr key={b.file} className="row-hover [&>td]:px-4 [&>td]:py-2.5">
                          <td>
                            <div className="font-mono text-[11px]">{b.file}</div>
                            <div className="text-[10px] text-ink-faint">{b.path}</div>
                          </td>
                          <td className="cell-num">{fmtBytes(b.sizeBytes)}</td>
                          <td className="font-mono text-[10px] text-ink-faint">{b.checksum ? b.checksum.slice(0, 12) + '…' : '—'}</td>
                          <td className="cell-act">
                            <button type="button" className="btn-quiet" onClick={() => verifyBackupNow(b.path)}>
                              校验
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {bkVerifyMsg.msg && (
                <div role="status" className={`text-xs mt-2.5 ${bkVerifyMsg.kind === 'ok' ? 'text-acc-hover' : bkVerifyMsg.kind === 'err' ? 'text-danger' : ''}`}>
                  {bkVerifyMsg.msg}
                </div>
              )}
              {bkStatus.msg && (
                <div role="status" className={`text-xs mt-2.5 ${bkStatus.kind === 'ok' ? 'text-acc-hover' : bkStatus.kind === 'err' ? 'text-danger' : ''}`}>
                  {bkStatus.msg}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {view === 'tasks' && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-1">任务执行日志</h2>
          <p className="text-xs text-ink-soft mb-4">定时任务与手动触发的执行记录（余额刷新 / 备份 / 成长中心轮询 / 签到等），新→旧展示，最多保留 500 条。</p>
          {!key ? (
            <div className="text-xs text-ink-soft">保存访问密钥后可查看任务日志</div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 items-center mb-3">
                <select className="field w-auto" value={taskFilter} onChange={(e) => setTaskFilter(e.target.value)}>
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
      )}

      {view === 'notify' && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-1">通知事件（增 / 删）</h2>
          <p className="text-xs text-ink-soft mb-4">
            内置事件可在上方「提醒事件」开关；此处可新增自定义事件名（推送时按该事件名发送、可在此开关），或删除已添加的自定义事件。内置事件不可删除、只能关闭。
          </p>
          {!key ? (
            <div className="text-xs text-ink-soft">保存访问密钥后可管理通知事件</div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 items-center mb-3">
                <input
                  className="field flex-1 min-w-[220px] font-mono text-xs"
                  value={customEvent}
                  onChange={(e) => setCustomEvent(e.target.value)}
                  placeholder="事件名（小写字母/数字/下划线，如 quota_low）"
                />
                <button type="button" className="btn btn-primary" onClick={addCustomEvent}>
                  添加事件
                </button>
              </div>
              {customEventIds.length > 0 && (
                <div className="border border-line rounded-lg divide-y divide-line overflow-hidden mb-3">
                  {customEventIds.map((id) => (
                    <div key={id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="font-mono text-[12px] text-ink truncate">{id}</span>
                        <span className="text-[10px] text-ink-faint shrink-0">自定义</span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <label className="flex items-center gap-1.5 text-xs text-ink-soft">
                          <input
                            type="checkbox"
                            className="w-4 h-4 accent-acc"
                            checked={notifyEventsData[id] !== false}
                            onChange={(e) => setEventEnabled(id as EventId, e.target.checked)}
                          />
                          启用
                        </label>
                        <button type="button" className="btn-quiet text-danger" onClick={() => removeCustomEvent(id)}>
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {eventsStatus.msg && (
                <div role="status" className={`text-xs mt-2 ${eventsStatus.kind === 'ok' ? 'text-acc-hover' : eventsStatus.kind === 'err' ? 'text-danger' : ''}`}>
                  {eventsStatus.msg}
                </div>
              )}
              <div className="flex gap-2 mt-2">
                <button type="button" className="btn btn-primary btn-sm" onClick={saveNotify}>
                  保存事件开关
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {view === 'config' && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-1">服务信息</h2>
          <p className="text-xs text-ink-soft mb-4">当前页面可推断的连接信息（只读）。</p>
          <div className="grid gap-2.5">
            <div className="kv-row"><span className="kv-k">站点</span><span className="kv-v">{typeof location !== 'undefined' ? location.origin : '—'}</span></div>
            <div className="kv-row"><span className="kv-k">摘要接口</span><span className="kv-v">/v1/credentials/summary</span></div>
            <div className="kv-row"><span className="kv-k">登录密钥存储</span><span className="kv-v">localStorage · trae_key</span></div>
            <div className="kv-row"><span className="kv-k">访问密钥</span><span className="kv-v">概览页管理 · 按平台绑定</span></div>
            <div className="kv-row"><span className="kv-k">通知</span><span className="kv-v">{key ? '已配置' : '—'}</span></div>
          </div>
        </div>
      )}

      {/* T4 运行时配置 */}
      {view === 'config' && (
        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-1">运行时配置</h2>
          <p className="text-xs text-ink-soft mb-4">当前生效的关键配置（只读）。「重新加载」会重读 model-config.json 与 .env 可热更项，无需重启服务。端口/密钥等监听级配置需重启生效。</p>
          {!key ? (
            <div className="text-xs text-ink-soft">保存访问密钥后展示运行时配置</div>
          ) : rtConfig ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 mb-3">
                <div className="kv-row"><span className="kv-k">池策略</span><span className="kv-v">{rtConfig.poolStrategy}</span></div>
                <div className="kv-row"><span className="kv-k">单账号在途</span><span className="kv-v">{rtConfig.maxInFlightPerAccount}</span></div>
                <div className="kv-row"><span className="kv-k">最低余额</span><span className="kv-v">{rtConfig.minBalanceToUse}</span></div>
                <div className="kv-row"><span className="kv-k">出站节流</span><span className="kv-v">{rtConfig.ratePaceMs}ms / 窗口 {rtConfig.rateWindowMax}次/{Math.round(rtConfig.rateWindowMs / 1000)}s</span></div>
                <div className="kv-row"><span className="kv-k">签到时刻</span><span className="kv-v">{rtConfig.checkinHour}:{pad2(rtConfig.checkinMinute ?? 0)}</span></div>
                <div className="kv-row"><span className="kv-k">保活时刻</span><span className="kv-v">{rtConfig.keepaliveHour}:00</span></div>
                <div className="kv-row"><span className="kv-k">上游函数</span><span className="kv-v">{rtConfig.upstreamFunction || '按模型映射'}</span></div>
                <div className="kv-row"><span className="kv-k">上游路径</span><span className="kv-v">{rtConfig.upstreamChatPath}</span></div>
                <div className="kv-row"><span className="kv-k">工具协议</span><span className="kv-v">{rtConfig.toolProtocol}</span></div>
                <div className="kv-row"><span className="kv-k">重试</span><span className="kv-v">{rtConfig.maxRetries} 次 / 基础 {rtConfig.retryBaseDelay}ms</span></div>
                <div className="kv-row"><span className="kv-k">请求超时</span><span className="kv-v">{Math.round(rtConfig.requestTimeoutMs / 1000)}s</span></div>
                <div className="kv-row"><span className="kv-k">定时任务</span><span className="kv-v">{rtConfig.schedulerEnabled ? '已启用' : '已关闭'}</span></div>
              </div>
              <div className="flex gap-2">
                <button type="button" className="btn btn-primary" onClick={doReloadConfig} disabled={rtReloading}>
                  {rtReloading ? '重载中…' : '重新加载配置'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={loadRtConfig}>刷新</button>
              </div>
              {rtStatus.msg && (
                <div role="status" className={`text-xs mt-2.5 ${rtStatus.kind === 'ok' ? 'text-acc-hover' : rtStatus.kind === 'err' ? 'text-danger' : ''}`}>
                  {rtStatus.msg}
                </div>
              )}
            </>
          ) : rtStatus.kind === 'err' ? (
            <>
              <div role="alert" className="text-xs text-danger mb-3">{rtStatus.msg}</div>
              <button type="button" className="btn btn-ghost" onClick={loadRtConfig}>重试</button>
            </>
          ) : (
            <div className="text-xs text-ink-soft">加载中…</div>
          )}
        </div>
      )}
    </div>
  );
}
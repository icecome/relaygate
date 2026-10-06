/** 格式化与纯函数工具。集中口径，避免各页面各写一套。 */

/** 账号三态：仅这三种，源于accountState() 的判定规则。 */
export type AccountState = 'off' | 'cool' | 'ok';

export function accountState(a: {
  enabled: boolean;
  coolUntil?: string | null;
}): AccountState {
  if (!a.enabled) return 'off';
  if (a.coolUntil && new Date(a.coolUntil).getTime() > Date.now()) return 'cool';
  return 'ok';
}

export const STATE_LABEL: Record<AccountState, string> = {
  ok: '可用',
  cool: '冷却中',
  off: '停用',
};

export const STATE_DOT_CLASS: Record<AccountState, string> = {
  ok: 'dot-ok',
  cool: 'dot-cool',
  off: 'dot-off',
};

export const STATE_PILL_CLASS: Record<AccountState, string> = {
  ok: 'pill-ok',
  cool: 'pill-warn',
  off: 'pill',
};

/**
 * 权益额度文案。
 * unlimited 表示不限量，必须显示为「不限量」，
 * 不能渲染成数字 0 —— 那会被误读为「没有额度」。
 */
export function formatQuota(unlimited: boolean | undefined, remaining?: number | null): string {
  if (unlimited) return '不限量';
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return '—';
  return String(remaining);
}

export function formatNumber(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN');
}

/** 成本保留4 位小数，避免把估算值显示得像精确账单。 */
export function formatCost(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (Math.abs(n) < 0.0001) return '<0.0001';
  return n.toFixed(4);
}

/** 毫秒 → 人类可读；用于接口耗时与调度间隔。 */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** 秒 → 「X 天 Y 小时」，用于运行时长这类粗粒度读数。 */
export function formatUptime(sec: number | null | undefined): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

export function formatTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatDate(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 冷却剩余；不在冷却中返回 null，调用方据此隐藏该列。 */
export function coolRemaining(coolUntil: string | null | undefined, now = Date.now()): string | null {
  if (!coolUntil) return null;
  const until = new Date(coolUntil).getTime();
  if (Number.isNaN(until) || until <= now) return null;
  return formatDuration(until - now);
}

export function formatBoolean(v: boolean | null | undefined): string {
  if (v === true) return '是';
  if (v === false) return '否';
  return '—';
}

/** 百分比；分母为 0 时返回 0 而不是 NaN。 */
export function percent(part: number, total: number): number {
  if (!total) return 0;
  return (part / total) * 100;
}
/** 格式化与纯函数工具。集中口径，避免各页面各写一套。 */

/**
 * 字节数转人话（1024 进制，1 位小数）。
 *
 * 口径注意：工具输出压缩（RTK）的节省量是 **UTF-8 字节**，不是字符数也不是
 * Token 数。中文下一个字符占 3 字节，用字符数报会小看三倍；而分词后字节与
 * Token 也不成比例，故界面上必须写明单位是字节。
 */
export function formatBytes(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  if (v < 1024) return `${v} B`;
  const kb = v / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** 账号三态：仅这三种，源于 accountState() 的判定规则。 */
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

/** 成本保留 4 位小数，避免把估算值显示得像精确账单。 */
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

/* 平台归类 */

/**
 * 账号所属平台：'trae' | 'workbuddy' | 'zcode'。
 *
 * 为什么不直接显示 `source`：source 记录的是「凭据怎么进来的」
 * （import / oauth / local / workbuddy），不是「账号属于哪个平台」。
 * Trae 账号无论粘贴导入还是 OAuth 登录，source 都是 import，
 * 直接展示会与「来源」这一列名的语义不符。
 *
 * 判定与后端 platform/variant.js 一致，且与筛选器同源：
 * edition 优先，WorkBuddy 的历史值含 'wb' 前缀变体，其余按 Trae 处理。
 */
export type Platform = 'trae' | 'workbuddy' | 'zcode' | 'qoder';

export function platformOf(a: {
  edition?: string | null;
  source?: string | null;
}): Platform {
  const edition = String(a.edition || '').toLowerCase();
  const source = String(a.source || '').toLowerCase();
  // edition 是平台的正源；source 仅在 edition 缺失时作为最后手段
  const raw = edition || source;
  if (raw === 'zcode') return 'zcode';
  if (raw === 'qoder') return 'qoder';
  if (raw === 'workbuddy' || raw.startsWith('wb')) return 'workbuddy';
  return 'trae';
}

const PLATFORM_LABEL: Record<Platform, string> = {
  trae: 'Trae',
  workbuddy: 'WorkBuddy',
  zcode: 'ZCode',
  qoder: 'Qoder',
};

/** 平台的展示名。 */
export function platformLabel(a: {
  edition?: string | null;
  source?: string | null;
}): string {
  return PLATFORM_LABEL[platformOf(a)];
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
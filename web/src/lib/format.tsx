import type { AccountState } from '../api/types';

export function statePill(s: AccountState) {
  if (s === 'ok') return <span className="pill-ok">启用</span>;
  if (s === 'cool') return <span className="pill-warn">冷却</span>;
  return <span className="pill-muted">禁用</span>;
}

export function sourceLabel(s?: string | null) {
  if (s === 'import') return '导入';
  if (s === 'oauth') return '授权登录';
  if (s === 'local') return '本机';
  return s || '—';
}

export function strategyLabel(s?: string | null) {
  if (s === 'least_balance') return '余额优先';
  if (s === 'round_robin') return '轮询';
  if (s === 'random') return '随机';
  return s || '—';
}

export function availabilityLabel(s?: string) {
  if (s === 'usable' || s === 'available') return '可用';
  if (s === 'unavailable') return '不可用';
  return '未知';
}

export function functionLabel(s?: string | null) {
  if (!s) return '使用模型配置';
  if (s === 'chat_v3') return 'chat_v3';
  if (s === 'inline_chat') return 'inline_chat';
  return s;
}

export function fmtRegion(v?: unknown): string {
  if (!v) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return String(o.region || o.aiRegion || o.country || '');
  }
  const s = String(v).trim();
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      return String(o.region || o.aiRegion || o.country || s);
    } catch {
      return s;
    }
  }
  return s;
}

export function relTime(ts?: string | null) {
  if (!ts) return '—';
  const t = new Date(ts).getTime();
  if (!t || Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtCool(v?: string | null) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  if (d.getTime() <= Date.now()) return '已到期';
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtBalance(v?: number | null | string): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  let rounded = Math.round(n * 100) / 100;
  if (Object.is(rounded, -0)) rounded = 0;
  let s = rounded.toFixed(2);
  if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  return s;
}

export function fmtTokens(n?: number): string {
  const v = Number(n) || 0;
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
  return String(v);
}

/** 千分位整数，用于请求量、条数等计数场景 */
export function fmtInt(n?: number): string {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US');
}

/** 距目标时刻的剩余时间。用于「下次执行：x 小时后」这类表述 */
export function untilTime(iso?: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.round((t - Date.now()) / 1000);
  if (s <= 0) return '即将执行';
  if (s < 3600) return `${Math.ceil(s / 60)} 分钟后`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} 小时后`;
  return `${Math.round(s / 86400)} 天后`;
}

export function fmtExpiry(sec?: number): string {
  if (!sec) return '长期';
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function humanError(msg?: string | null): string {
  const m = String(msg || '');
  if (/3004/.test(m) || /rate limit/i.test(m)) return '上游限流（3004），账号已自动冷却并切换';
  if (/401|SessionDead|unauthorized/i.test(m)) return '登录态失效（401）';
  if (/4001|model config/i.test(m)) return '模型配置不可用（4001）';
  if (/1005|plan limit/i.test(m)) return '套餐额度用尽（1005）';
  if (/timed out|ETIMEDOUT|ECONNRESET|ECONNABORTED/.test(m)) return '网络中断/超时';
  if (/5dd/.test(m)) return '上游服务异常';
  return m.length > 80 ? m.slice(0, 80) + '…' : m || '未知错误';
}
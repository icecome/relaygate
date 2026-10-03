/** 设置页各视图共用的格式化助手。 */

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 字节数人性化。 */
export function fmtBytes(n?: number): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}
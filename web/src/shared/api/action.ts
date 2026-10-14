/**
 * 写操作统一包装。
 *
 * 后端有一类接口是「HTTP 200 但业务未成功」（轮换、模型保存、签到、OAuth 等），
 * 必须与「请求异常」分开提示：前者展示后端给的原因，后者是网络或鉴权问题。
 *
 * 此前各页面各自手写这套判定（CredentialsPage、GrowthPanel 各一份，
 * OpsPage 直接写布尔），同一语义三种写法，改一处漏两处。
 * 这里收敛成唯一入口，页面只负责给文案与成功后的刷新动作。
 */
import { ApiError, businessFailureReason, isBusinessFailure } from './http';

export interface ActionSpec {
  /** 操作名，用于失败时的默认文案，如「签到」 */
  label: string;
  /** 实际请求 */
  fn: () => Promise<unknown>;
  /** 成功后的提示文案 */
  successMsg: string;
  /** 提示通道 */
  toast: (msg: string, tone?: 'ok' | 'warn' | 'err') => void;
  /** 成功后要做的事（刷新列表等），仅在成功时执行 */
  onDone?: () => void;
}

/**
 * 执行一次写操作。返回 true 表示业务成功。
 * 三类结果分别处理：业务失败（含原因）、传输/HTTP 异常、成功。
 */
export async function runAction({
  label,
  fn,
  successMsg,
  toast,
  onDone,
}: ActionSpec): Promise<boolean> {
  try {
    const result = await fn();
    if (isBusinessFailure(result)) {
      toast(`${label}未成功：${businessFailureReason(result, '网关未返回具体原因')}`, 'err');
      return false;
    }
    toast(successMsg, 'ok');
    onDone?.();
    return true;
  } catch (e) {
    toast(e instanceof ApiError ? e.message : `${label}请求失败`, 'err');
    return false;
  }
}

/**
 * 汇总型结果（批量操作返回 ok/failed 计数或数组）的统一播报。
 * 后端失败明细必须呈现到 UI：只报计数（如「失败 8」）而无原因，等同没有反馈。
 */
export function summarizeBatch(
  label: string,
  r: { ok?: unknown[] | number; failed?: unknown[] | number; skipped?: unknown[] | number },
  toast: (msg: string, tone?: 'ok' | 'warn' | 'err') => void,
): void {
  const count = (v: unknown[] | number | undefined) =>
    typeof v === 'number' ? v : Array.isArray(v) ? v.length : 0;
  const ok = count(r.ok);
  const failed = count(r.failed);
  const skipped = count(r.skipped);

  if (failed > 0) {
    const reasons = extractFailures(r.failed);
    toast(
      `${label}完成但有失败：成功 ${ok}，失败 ${failed}${skipped ? `，跳过 ${skipped}` : ''}${
        reasons ? `；${reasons}` : ''
      }`,
      'warn',
    );
    return;
  }
  toast(
    `${label}完成：成功 ${ok}${skipped ? `，跳过 ${skipped}` : ''}`,
    'ok',
  );
}

/** 从后端的失败数组里提取可读原因（最多 3 条，避免 toast 过长）。 */
export function extractFailures(failed: unknown[] | number | undefined): string {
  if (!Array.isArray(failed)) return '';
  return failed
    .slice(0, 3)
    .map((f) => {
      const o = f as { accountId?: string; label?: string; reason?: string; msg?: string };
      const who = o?.label || o?.accountId;
      const why = o?.reason || o?.msg;
      if (who && why) return `${who}：${why}`;
      return why || who || '';
    })
    .filter(Boolean)
    .join('；');
}
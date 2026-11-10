/**
 * WorkBuddy 账号接入接口（/v1/workbuddy/*）。
 *
 * 真实语义（对照 src/routes/workbuddy.js）：
 *   - 凭据只来自本机桌面客户端 auth 文件或粘贴的 .info 内容，
 *     后端不接受请求体传入的 token；
 *   - 导入的账号默认 enabled=false，避免混入 Trae 账号池调度；
 *   - 跨机粘贴导入不做在线验证，导入后需用 verify 补验。
 */
import { api } from './http';

/** 本机桌面客户端登录态（脱敏）。 */
export interface WbLocalInfo {
  found: boolean;
  /**
   * 未找到时的机读原因码（后端 workbuddy.js#local）：
   *   WB_TOKEN_ENCRYPTED = 客户端已登录但凭据已被客户端加密（去登录也没用）；
   *   WB_LOCAL_NOT_FOUND = 没有本机登录态。
   * 两种情形的恢复动作不同，前端据此分流（此前只读 hint 文本）。
   */
  code?: 'WB_TOKEN_ENCRYPTED' | 'WB_LOCAL_NOT_FOUND';
  /** 未找到时后端给出文件位置提示 */
  hint?: string;
  file?: string;
  uid?: string;
  nickname?: string;
  phoneNumber?: string;
  region?: string;
  expiresAt?: string | null;
  accessToken?: string;
  refreshToken?: string;
}

export interface WbVerifyResult {
  valid: boolean;
  reason?: string;
  balance?: number | null;
}

export interface WbImportResult {
  id?: string;
  label?: string;
  enabled?: boolean;
  verified?: boolean;
  verifiedBalance?: number | null;
  /** 后端标注本次是新建还是更新 */
  action?: 'created' | 'updated';
}

export interface WbCheckinOne {
  ok?: boolean;
  alreadyCheckedIn?: boolean;
  checkedIn?: boolean;
  result?: string;
  streakDays?: number;
  rewardCredit?: number;
  reason?: string;
}

export const wbLocal = (key: string, signal?: AbortSignal) =>
  api<WbLocalInfo>('/v1/workbuddy/local', { signal }, key);

/**
 * 导入登录态。
 * 传 infoJsonText 即为跨机粘贴导入；不传则抓取本机客户端登录态。
 */
export const wbImport = (
  body: { label?: string; infoJsonText?: string; force?: boolean },
  key: string,
) => api<WbImportResult>('/v1/workbuddy/import', { method: 'POST', body }, key);

/** 登录验证 + 余额查询。缺省 accountId 时验证本机登录态。 */
export const wbVerify = (body: { accountId?: string }, key: string) =>
  api<WbVerifyResult>('/v1/workbuddy/verify', { method: 'POST', body }, key);

export const wbCheckin = (body: { accountId?: string }, key: string) =>
  api<WbCheckinOne>('/v1/workbuddy/checkin', { method: 'POST', body }, key);

/**
 * 只读签到状态（不消耗签到次数）。缺省 accountId 时查本机登录态。
 * 字段对照 src/workbuddy/auth.js#checkinStatus。
 */
export interface WbCheckinStatus {
  ok: boolean;
  reason?: string;
  active?: boolean;
  checkedIn?: boolean;
  streakDays?: number | null;
  dailyCredit?: number | null;
  todayCredit?: number | null;
  totalCredits?: number | null;
}

export const wbCheckinStatus = (body: { accountId?: string }, key: string) =>
  api<WbCheckinStatus>('/v1/workbuddy/checkin-status', { method: 'POST', body }, key);

/**
 * 手动触发 token 刷新（用 refreshToken 换新）。
 * 后端返回脱敏后的 accessToken；失败（无 refreshToken / 上游拒绝）走错误分支。
 */
export const wbRefresh = (body: { accountId: string }, key: string) =>
  api<{ ok: boolean; expiredAt: string; accessToken: string }>(
    '/v1/workbuddy/refresh',
    { method: 'POST', body },
    key,
  );

/* 无感登录新账号（免退出 OAuth，对标 WorkDaddy） */

export interface WbOauthStartResult {
  object: string;
  loginId: string;
  /** 系统浏览器打开的授权页地址 */
  verificationUri: string;
  /** 会话超时秒数：前端据此显示倒计时（state 本身是服务端秘密，UI 不消费） */
  expiresIn: number;
}

export const wbOauthStart = (region: 'cn' | 'global', key: string) =>
  api<WbOauthStartResult>('/v1/workbuddy/oauth/start', { method: 'POST', body: { region } }, key);

export interface WbOauthPollResult {
  object: string;
  done: boolean;
  /** done 且成功时：入库结果。enabled 由后端回传（重授权保留、新建为 false） */
  result?: { id: string; uid: string; nickname: string; action: 'created' | 'updated'; enabled?: boolean } | null;
  error?: string | null;
  /** 网络抖动等瞬态失败：不算完成，继续轮询即可 */
  transient?: boolean;
  /** 仅在传 status=1 时出现：当前在途会话数（诊断用，UI 不消费） */
  pending?: number;
}

export const wbOauthPoll = (loginId: string, key: string, signal?: AbortSignal) =>
  api<WbOauthPollResult>(
    `/v1/workbuddy/oauth/poll?loginId=${encodeURIComponent(loginId)}`,
    { signal },
    key,
  );

export const wbOauthCancel = (loginId: string, key: string) =>
  api<{ ok: boolean }>('/v1/workbuddy/oauth/cancel', { method: 'POST', body: { loginId } }, key);
/**
 * WorkBuddy 账号接入接口（/v1/workbuddy/*）。
 *
 * 真实语义（对照 src/routes/workbuddy.js）：
 *   - 凭据只来自本机桌面客户端 auth 文件或粘贴的 .info 内容，
 *     后端不接受请求体传入的 token；
 *   - 导入的账号默认 enabled=false，避免污染 Trae 账号池调度；
 *   - 跨机粘贴导入不做在线验证，导入后需用 verify 补验。
 */
import { api } from './http';

/** 本机桌面客户端登录态（脱敏）。 */
export interface WbLocalInfo {
  found: boolean;
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

export interface WbCheckinBatch {
  ok?: number;
  failed?: number;
  total?: number;
  results?: { accountId?: string; ok?: boolean; msg?: string }[];
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

/** 手动触发 token 刷新。 */
export const wbRefresh = (accountId: string, key: string) =>
  api<{ ok: boolean; expiredAt?: string; accessToken?: string }>(
    '/v1/workbuddy/refresh',
    { method: 'POST', body: { accountId } },
    key,
  );

/** 签到状态查询（只读，不消耗）。 */
export const wbCheckinStatus = (body: { accountId?: string }, key: string) =>
  api<{ ok?: boolean; checkedIn?: boolean; streakDays?: number; rewardCredit?: number; reason?: string }>(
    '/v1/workbuddy/checkin-status',
    { method: 'POST', body },
    key,
  );

export const wbCheckin = (body: { accountId?: string }, key: string) =>
  api<WbCheckinOne>('/v1/workbuddy/checkin', { method: 'POST', body }, key);

export const wbCheckinAll = (key: string) =>
  api<WbCheckinBatch>('/v1/workbuddy/checkin-all', { method: 'POST' }, key);
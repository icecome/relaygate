/**
 * Raccoon（商汤小浣熊）运营面与对话面接口（`/v1/raccoon/*`）。
 *
 * 真实语义（对照 `src/routes/raccoon.js`）：
 *   - 本机没有官方桌面客户端可读凭据（与 WorkBuddy/ZCode/Qoder 不同），
 *     也**没有「粘贴凭据」这条路**：官方登录靠 `office-raccoon://` 自定义协议
 *     回调，服务端进程收不到。故登录只能由面板承载扫码；
 *   - 二维码由**后端**用零依赖编码器生成（`qr.path` 直接可渲染），
 *     内容是一次性登录票据 —— 绝不交给第三方二维码图片服务；
 *   - 每日 300 积分由服务端自动发放（**没有端点**），能领的只有一次性的
 *     「桌面端登录奖励」。
 */
import { api } from './http';

/**
 * 轮询与账号操作要打真实上游，默认 30 秒偏紧（登录轮询是 2 秒一次，本身很快；
 * 但余额/奖励要走活动平台）。统一放宽。
 */
const OPS_TIMEOUT_MS = 60_000;

/* ---------- 状态 ---------- */

export interface RaccoonStatus {
  platform: {
    id: string;
    label: string;
    capability: Record<string, boolean>;
  };
  accounts: { total: number; enabled: number };
  chat: { endpoint: string; inPool: boolean; modelsEndpoint: string };
  login: { mode: string; pollIntervalMs: number; timeoutMs: number; smsAvailable: boolean };
}

export const raccoonStatus = (key: string, signal?: AbortSignal) =>
  api<RaccoonStatus>('/v1/raccoon/status', { signal }, key);

/* ---------- 扫码登录 ---------- */

/** 二维码的**直接可渲染形态**：一个 SVG path 的 d 属性。 */
export interface RaccoonQr {
  size: number;
  dim: number;
  margin: number;
  path: string;
}

export interface RaccoonLoginSession {
  sessionId: string;
  /** 二维码承载的公开登录页 URL（「在浏览器里打开」的兜底入口） */
  qrUrl: string;
  qr: RaccoonQr;
  expiresAtMs: number;
  pollIntervalMs: number;
  hint: string;
}

/** 扫码状态：pending 是**兜底**（未知状态/异常都归到它），不要判成成功或取消。 */
export type RaccoonQrStatus = 'pending' | 'logging' | 'canceled' | 'success';

export interface RaccoonLoginPoll {
  status: RaccoonQrStatus | 'expired';
  account?: RaccoonAccount;
  expiredAt?: string;
  detail?: string;
}

export const raccoonStartLogin = (key: string) =>
  api<RaccoonLoginSession>('/v1/raccoon/login/session', { method: 'POST', body: {} }, key);

export const raccoonPollLogin = (sessionId: string, key: string) =>
  api<RaccoonLoginPoll>(
    `/v1/raccoon/login/session/${encodeURIComponent(sessionId)}`,
    { timeoutMs: 30_000 },
    key,
  );

export const raccoonCancelLogin = (sessionId: string, key: string) =>
  api<{ ok: boolean }>(
    `/v1/raccoon/login/session/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
    key,
  );

/* ---------- 账号 ---------- */

export interface RaccoonPoints {
  available: number | null;
  packages: { name: string; remaining: number }[];
  updatedAt: string | null;
}

export interface RaccoonAccount {
  id: string;
  label: string;
  userId?: string | null;
  enabled?: boolean;
  hasToken?: boolean;
  hasRefreshToken?: boolean;
  balance?: number | null;
  expiredAt?: string | null;
  /** 组织码（个人账号为 null） */
  raccoonOrg?: string | null;
  points?: RaccoonPoints;
  entitlementSnapshot?: Record<string, unknown> | null;
  error?: { message?: string };
}

export const raccoonAccounts = (key: string, signal?: AbortSignal) =>
  api<{ object: string; data: RaccoonAccount[] }>('/v1/raccoon/accounts', { signal }, key);

export const raccoonDeleteAccount = (accountId: string, key: string) =>
  api<{ ok: boolean }>(`/v1/raccoon/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' }, key);

/** 刷新积分余额（只读端点）。 */
export const raccoonRefreshPoints = (accountId: string, key: string) =>
  api<{ object: string; account: RaccoonAccount; points: RaccoonPoints }>(
    `/v1/raccoon/accounts/${encodeURIComponent(accountId)}/balance`,
    { method: 'POST', body: {}, timeoutMs: OPS_TIMEOUT_MS },
    key,
  );

/** 领取一次性「桌面端登录奖励」。结果 already 表示该号已领过（不是失败）。 */
export interface RaccoonRewardResult {
  object: string;
  accountId: string;
  result: 'claimed' | 'already' | 'failed';
  points?: number;
  message: string;
  code?: number | null;
}

export const raccoonClaimReward = (accountId: string, key: string) =>
  api<RaccoonRewardResult>(
    `/v1/raccoon/accounts/${encodeURIComponent(accountId)}/reward`,
    { method: 'POST', body: {}, timeoutMs: OPS_TIMEOUT_MS },
    key,
  );

/** 查询登录奖励是否已领（服务端没有状态端点，只能查账单明细）。 */
export const raccoonRewardStatus = (accountId: string, key: string, signal?: AbortSignal) =>
  api<{ object: string; accountId: string; claimed: boolean; points: number; detail: string }>(
    `/v1/raccoon/accounts/${encodeURIComponent(accountId)}/reward`,
    { signal, timeoutMs: OPS_TIMEOUT_MS },
    key,
  );

/** 强制续期（凭据过期或想立刻验证时用）。 */
export const raccoonRefreshToken = (accountId: string, key: string) =>
  api<{ object: string; account: RaccoonAccount }>(
    `/v1/raccoon/accounts/${encodeURIComponent(accountId)}/refresh`,
    { method: 'POST', body: {}, timeoutMs: OPS_TIMEOUT_MS },
    key,
  );

/* ---------- 模型目录 ---------- */

export interface RaccoonModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  supportsImage: boolean;
  status: 'normal' | 'discount' | 'limited_free';
  statusNote: string;
  /** 生效倍率原值；null 表示远端未给出（**不是** 0） */
  multiplier: number | null;
}

export const raccoonModels = (key: string, signal?: AbortSignal) =>
  api<{ object: string; source: 'remote' | 'fallback'; reason?: string; data: RaccoonModel[] }>(
    '/v1/raccoon/models',
    { signal, timeoutMs: OPS_TIMEOUT_MS },
    key,
  );

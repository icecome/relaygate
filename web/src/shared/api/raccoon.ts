/**
 * Raccoon（商汤小浣熊）运营面与对话面接口（`/v1/raccoon/*`）。
 *
 * 真实语义（对照 `src/routes/raccoon.js`）：
 *   - **两条登录入口**（2026-10-15 解包后新增第二条）：
 *     ① 面板承载扫码 —— 官方那条 `office-raccoon://` 自定义协议回调服务端进程
 *        收不到，故登录只能由面板承载；二维码由**后端**用零依赖编码器生成
 *        （`qr.path` 直接可渲染），内容是一次性登录票据，绝不交给第三方图片服务。
 *     ② 读取本机桌面端 —— 客户端把凭据**明文**写在
 *        `~/.box-agent/config/auth.json`，零解密成本（与 ZCode/Qoder 的加密存储不同）。
 *   - 每日 300 积分由服务端自动发放（**没有端点**），能领的只有一次性的
 *     「桌面端登录奖励」；但每日池**会过期**，故提供只读的 `/daily-usage` 看板。
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

/* ---------- 本机客户端导入 ---------- */

/** 本机桌面端预检：没装客户端时也返回 200（installed:false）。 */
export interface RaccoonLocalPreview {
  object: string;
  installed: boolean;
  path: string;
  credentialFile: string;
  error: string | null;
  account?: {
    userId: string | null;
    hasToken: boolean;
    hasRefreshToken: boolean;
    expiresAt: string | null;
    officeIdentity: string | null;
  };
}

export const raccoonLocalPreview = (key: string, signal?: AbortSignal) =>
  api<RaccoonLocalPreview>('/v1/raccoon/local/preview', { signal }, key);

/** 从本机客户端凭据导入（幂等：同 user_info.id 更新而非重复插入）。 */
export const raccoonLocalImport = (key: string) =>
  api<{ object: string; ok: boolean; account: RaccoonAccount } | { ok: false; error: { message: string; type: string } }>(
    '/v1/raccoon/local/import',
    { method: 'POST', body: {}, timeoutMs: OPS_TIMEOUT_MS },
    key,
  );

/* ---------- 每日积分看板（只读） ---------- */

/**
 * 每日积分运营视图。
 *
 * 每日 300 **不能领**（无端点），但会过期：本视图回答的是「还剩多少 /
 * 最早何时作废 / 历史作废了多少」，据此在过期前把额度用掉。
 */
export interface RaccoonDailyUsage {
  object: string;
  accountId: string;
  /** 恒 false：这个渠道没有可领取的每日端点 */
  claimable: false;
  grantPoints: number;
  /** 每日池当前余额（来自 balance.daily_points） */
  dailyRemaining: number | null;
  grantedBatches: number;
  nextExpiryAt: string | null;
  nextExpiryHoursLeft: number | null;
  /** 历史被清零的每日积分总量（daily_expire 绝对值之和） */
  expiredTotal: number;
  observedAt: string;
  /** 账单面是否取到数据（false 表示只是查不到，不是「没有发放」） */
  billsAvailable: boolean;
  balanceAvailable: boolean;
}

export const raccoonDailyUsage = (accountId: string, key: string, signal?: AbortSignal) =>
  api<RaccoonDailyUsage>(
    `/v1/raccoon/accounts/${encodeURIComponent(accountId)}/daily-usage`,
    { signal, timeoutMs: OPS_TIMEOUT_MS },
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

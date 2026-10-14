/**
 * Qoder 运营面与转发面接口（/v1/qoder/*）。
 *
 * 真实语义（对照 src/routes/qoder.js）：
 *   - 凭据只来自本机桌面客户端 auth.v1.dat（双区域），后端不接受请求体传入 token；
 *   - realm 由「扫到哪个客户端目录」确定并随账号持久化，UI 不传 realm 给后端推导；
 *   - 导入为幂等：同 realm+uid 已存在则更新而非重复插入。
 */
import { api } from './http';

/** 本机客户端探测结果（脱敏：只回显 uid/名称/有效期，不回显 token）。 */
export interface QoderLocalRealm {
  installed: boolean;
  appDir: string;
  clientVersion: string | null;
  loggedIn: boolean;
  userId?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  expiresAt?: string | null;
  error?: string | null;
}

export interface QoderLocalPreview {
  windows: boolean;
  realms: {
    cn: QoderLocalRealm;
    intl: QoderLocalRealm;
  };
}

export interface QoderImportResult {
  ok?: boolean;
  created?: { realm: string; id: string; label: string }[];
  updated?: { realm: string; id: string; label: string }[];
  skipped?: { realm: string; reason: string }[];
  message?: string;
  error?: { message?: string };
}

/** 预检本机客户端（双区域，不解密全文）。 */
export const qoderLocalPreview = (key: string, signal?: AbortSignal) =>
  api<QoderLocalPreview>('/v1/qoder/local/preview', { signal }, key);

/**
 * 导入本机已登录的全部区域账号。
 * 幂等：同 realm+uid 更新而非重复插入。
 */
export const qoderImportLocal = (key: string) =>
  api<QoderImportResult>('/v1/qoder/local/import', { method: 'POST' }, key);

/** 导入指定区域的账号。 */
export const qoderImportRealm = (realm: 'cn' | 'intl', key: string) =>
  api<{ ok?: boolean; account?: { id: string; label: string }; action?: string }>(
    `/v1/qoder/local/import/${realm}`,
    { method: 'POST' },
    key,
  );

/* ---------- 运营面：积分活动 / 额度 ---------- */

/**
 * 领取/探测类操作的超时（毫秒）。
 * 领取要走上游活动平台并可能重试，默认 30 秒会把正常请求误判成超时。
 */
const OPS_TIMEOUT_MS = 120_000;

/**
 * 活动条目（`parseCampaign` 归一化后的结构）。
 *
 * `claimStatus` 是判定能否领取的正源；`title/description` 已是中文文案
 * （后端从 placements 里挑 zh，取不到才回退英文）。
 */
export interface QoderCampaign {
  campaignId: string;
  campaignKey: string;
  actionType: string;
  claimStatus: string;
  kind: string;
  amount: number;
  /** RELATIVE_DAYS = 领取后 N 天有效；ABSOLUTE = 固定到期 */
  validityMode: string;
  validityDays: number;
  startAt: string | null;
  endAt: string | null;
  title: string;
  description: string;
  detailUrl: string | null;
}

export interface QoderCampaigns {
  object: string;
  accountId: string;
  realm: 'cn' | 'intl';
  showCampaign: boolean;
  claimable: boolean;
  campaigns: QoderCampaign[];
  /** 已按「积分类 + 可领取」过滤，即真正能领的那些 */
  claimableCampaigns: QoderCampaign[];
}

export interface QoderQuotaSide {
  remaining?: number;
  total?: number;
  [k: string]: unknown;
}

export interface QoderQuota {
  object: string;
  accountId: string;
  realm: 'cn' | 'intl';
  userType: string | null;
  usageType: string | null;
  base: QoderQuotaSide | null;
  addOn: QoderQuotaSide | null;
  /** 仅供展示：两段之和不写入任何积分口径 */
  totalRemaining: number;
  expiresAt: string | null;
  isQuotaExceeded: boolean;
}

/**
 * 领取结果语义。
 * `already_today` / `no_campaign` 是后端对 `skipped` 的细分——两者对用户的
 * 含义完全不同（「今日已领」vs「上游真没有」），UI 必须分开呈现。
 */
export type QoderClaimKind = 'claimed' | 'already' | 'skipped' | 'failed' | 'already_today' | 'no_campaign';

export interface QoderClaimResult {
  object: string;
  accountId: string;
  result: QoderClaimKind;
  campaignId: string;
  campaignKey: string;
  amount: number;
  grantId: string | null;
  expiresAt: string | null;
  replayed: boolean;
  message: string;
}

export const qoderCampaigns = (accountId: string, key: string, signal?: AbortSignal) =>
  api<QoderCampaigns>(
    `/v1/qoder/accounts/${encodeURIComponent(accountId)}/campaigns`,
    { signal, timeoutMs: OPS_TIMEOUT_MS },
    key,
  );

export const qoderQuota = (accountId: string, key: string, signal?: AbortSignal) =>
  api<QoderQuota>(
    `/v1/qoder/accounts/${encodeURIComponent(accountId)}/quota`,
    { signal, timeoutMs: OPS_TIMEOUT_MS },
    key,
  );

/** 领取积分活动；campaignId 缺省时后端自动挑第一个可领的。 */
export const qoderClaim = (accountId: string, key: string, campaignId?: string) =>
  api<QoderClaimResult>(
    `/v1/qoder/accounts/${encodeURIComponent(accountId)}/claim`,
    { method: 'POST', body: campaignId ? { campaignId } : {}, timeoutMs: OPS_TIMEOUT_MS },
    key,
  );

/**
 * 一轮批量任务的汇总。
 *
 * `emptyList` 必须单独呈现：上游在桌面端身份头缺失时**不报错但返回空活动列表**，
 * 这是最难排查的一类失败——把它混进「没有可领活动」会让用户以为今天真的没活动。
 */
export interface QoderRunSummary {
  total: number;
  probed: number;
  claimed: number;
  already: number;
  alreadyToday: number;
  failed: number;
  skipped: number;
  emptyList: number;
  claimedDetails?: { accountId: string; label: string; realm: string; campaignKey: string; amount: number; grantId: string | null; expiresAt: string | null }[];
  failedDetails?: { accountId: string; label: string; message: string }[];
  ranAt?: string;
  trigger?: string;
}

/**
 * 对全部启用账号跑一轮。claim 走 **query**（后端读 `req.query.claim`），
 * 不是请求体——写成 body 会被静默忽略并一律按「只探测不领取」执行。
 */
export const qoderRun = (key: string, claim = true) =>
  api<QoderRunSummary & { object?: string }>(
    `/v1/qoder/run?claim=${claim ? 'true' : 'false'}`,
    { method: 'POST', timeoutMs: OPS_TIMEOUT_MS },
    key,
  );

/* ---------- 账号（含奖励快照，供运营面表格） ---------- */

export interface QoderAccountRewards {
  lastProbeAt: string | null;
  lastClaimAt: string | null;
  lastClaimCampaign: string | null;
  lastClaimAmount: number | null;
  lastClaimExpiresAt: string | null;
  lastClaimGrantId: string | null;
  quota: QoderQuota | null;
  claimable: unknown[];
}

export interface QoderAccount {
  id: string;
  label: string;
  realm: 'cn' | 'intl';
  enabled?: boolean;
  userId?: string | null;
  hasToken?: boolean;
  hasRefreshToken?: boolean;
  rewards?: QoderAccountRewards;
}

export const qoderAccounts = (key: string, signal?: AbortSignal) =>
  api<{ object: string; data: QoderAccount[] }>('/v1/qoder/accounts', { signal }, key);

export interface QoderJobsSnapshot {
  enabled: boolean;
  hour: number;
  minute: number;
  spreadMinutes: number;
  autoClaim: boolean;
  lastRunAt: string | null;
  lastSummary: unknown;
  nextRunAt: string | null;
  lastError: string | null;
  accounts: number;
  localClient?: unknown;
}

export const qoderSettings = (key: string, signal?: AbortSignal) =>
  api<QoderJobsSnapshot>('/v1/qoder/settings', { signal }, key);

export const qoderSaveSettings = (patch: Partial<QoderJobsSnapshot>, key: string) =>
  api<QoderJobsSnapshot>('/v1/qoder/settings', { method: 'POST', body: patch }, key);


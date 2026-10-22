/**
 * ZCode 运营面接口（`/v1/zcode/*`）。
 *
 * 真实语义（对照 `src/routes/zcode.js` 与 `src/zcode/local.js`）：
 *   - 凭据只来自本机 ZCode 桌面客户端的 `~/.zcode/v2/credentials.json`
 *     （字段级 AES-256-GCM 密文，密钥由本机用户名/家目录派生）。
 *     **没有「粘贴凭据」这条路**：客户端 JWT 无 `exp`、也不返回 refresh_token，
 *     上游不发放可移植凭据，所以本模块也不提供粘贴入口；
 *   - 额度单位是 **token**（单包量级 1e8），与 RelayGate 的积分口径
 *     （单位 credit，量级 1e3）是两套计量，UI 必须单独标注单位、
 *     **不得并入积分汇总**（见 docs/02-technical/channels/zcode-integration.md 的「计量口径隔离」）；
 *   - `capability.chat=false`：ZCode 账号不参与对话转发，只做账号运营面。
 *
 * 超时口径：领取要现解阿里云无感验证码（单次 2–8 秒，内置重试），
 * 用默认 30 秒会把正常请求误判成超时，故运营面写操作统一放宽到 180 秒。
 */
import { api } from './http';

/** 领取/探测类操作的超时（毫秒）。验证码求解 + 上游往返远不止 30 秒。 */
const OPS_TIMEOUT_MS = 180_000;

/* ---------- 账号导入 ---------- */

export interface ZcodeLocalRealm {
  installed: boolean;
  /** 凭据文件路径（未安装时也回显，便于用户对照去装） */
  path: string;
  deviceMidReused?: boolean;
  account?: {
    label: string;
    userId: string | null;
    mode: string;
    hasToken: boolean;
  };
  error?: { message?: string };
}

export interface ZcodeImportResult {
  action?: 'created' | 'updated';
  account?: ZcodeAccount;
  error?: { message?: string };
}

/* ---------- 账号 ---------- */

export interface ZcodeRewardSnapshot {
  lastProbeAt: string | null;
  lastClaimAt: string | null;
  lastClaimPlan: { planId?: string; planName?: string; result?: string; message?: string } | null;
  plans: unknown[];
  balances: unknown[];
}

export interface ZcodeAccount {
  id: string;
  label: string;
  userId?: string | null;
  enabled?: boolean;
  hasToken?: boolean;
  tokenRemaining?: number;
  /** 后端按 order 写入的 token 桶（非积分） */
  tokenBuckets?: {
    name: string;
    bucketId: string | null;
    planId: string | null;
    meter: string;
    unit: string;
    limit: number;
    used: number;
    remaining: number;
    expireTime: number | null;
  }[];
  rewards?: ZcodeRewardSnapshot;
  lastCheckinResult?: string | null;
  error?: { message?: string };
}

/* ---------- 套餐探测与领取 ---------- */

export interface ZcodeGrant {
  name: string;
  units: number;
  period: string;
  capabilities: string[];
}

export interface ZcodePlan {
  planId: string;
  name: string;
  description: string;
  priority: number;
  grants: ZcodeGrant[];
}

export interface ZcodeProbeResult {
  accountId?: string;
  label?: string;
  plans: ZcodePlan[];
  /** 激活上报结果（资格信号）；null 表示本次未上报 */
  activation: { ok: string[]; failed: string[] } | null;
  /** 探测本身失败的原因（与「没有可领套餐」是两件事） */
  error: string | null;
}

/** 领取结果语义（对照 src/zcode/rewards.js 的 CLAIM_RESULT）。 */
export type ZcodeClaimResultKind = 'claimed' | 'already' | 'failed' | 'risk';

export interface ZcodeClaimResult {
  result: ZcodeClaimResultKind;
  planId: string;
  planName: string;
  grants: ZcodeGrant[];
  message: string;
  code: number | null;
}

export interface ZcodeBatchProbeResult {
  object: string;
  total: number;
  results: ZcodeProbeResult[];
}

export interface ZcodeBalanceResult {
  plans: unknown[];
  balances: {
    show_name?: string;
    entitlement_id?: string;
    bucket_id?: string;
    plan_id?: string;
    meter?: string;
    unit_type?: string;
    total_units?: number;
    used_units?: number;
    remaining_units?: number;
    expires_at?: number;
  }[];
  serverTime?: unknown;
}

/* ---------- 状态与设置 ---------- */

export interface ZcodeJobsSnapshot {
  enabled: boolean;
  hour1: number;
  minute1: number;
  hour2: number;
  minute2: number;
  spreadMinutes: number;
  autoClaim: boolean;
  lastRunAt: string | null;
  lastSummary: unknown;
  nextRunAt: string | null;
  lastError: string | null;
  solver: { available: boolean; dir: string };
  accounts: number;
}

/* ---------- 接口 ---------- */

export const zcodeStatus = (key: string, signal?: AbortSignal) =>
  api<{
    platform: { id: string; label: string; capability: Record<string, boolean> };
    jobs: ZcodeJobsSnapshot;
    solver: { available: boolean; dir: string };
    localClient: { installed: boolean; credentialsPath: string };
  }>('/v1/zcode/status', { signal }, key);

/** 预检本机客户端（不解密全文，只回答「文件在不在、里面有没有 JWT」）。 */
export const zcodeLocalPreview = (key: string, signal?: AbortSignal) =>
  api<ZcodeLocalRealm>('/v1/zcode/local/preview', { signal }, key);

/** 从本机客户端导入。幂等：同 userId 更新而非重复插入。 */
export const zcodeImportLocal = (key: string) =>
  api<ZcodeImportResult>('/v1/zcode/local/import', { method: 'POST' }, key);

export const zcodeAccounts = (key: string, signal?: AbortSignal) =>
  api<{ object: string; data: ZcodeAccount[] }>('/v1/zcode/accounts', { signal }, key);

/** 探测单账号可领套餐（不领取）。 */
export const zcodeProbe = (accountId: string, key: string) =>
  api<ZcodeProbeResult>(
    `/v1/zcode/accounts/${encodeURIComponent(accountId)}/rewards/probe`,
    { method: 'POST', body: {}, timeoutMs: OPS_TIMEOUT_MS },
    key,
  );

/** 领取套餐；planId 缺省时后端自动选优先级最高的一个。 */
export const zcodeClaim = (accountId: string, key: string, planId?: string) =>
  api<ZcodeClaimResult>(
    `/v1/zcode/accounts/${encodeURIComponent(accountId)}/rewards/claim`,
    { method: 'POST', body: planId ? { planId } : {}, timeoutMs: OPS_TIMEOUT_MS },
    key,
  );

/**
 * 一轮批量任务的汇总（`runRewards` 的返回）。
 * `risk > 0` 必须显著提示：命中风控的账号后端会立即中止本轮且不自动换指纹。
 */
export interface ZcodeRunSummary {
  total: number;
  probed: number;
  withPlans: number;
  claimed: number;
  already: number;
  failed: number;
  risk: number;
  skipped: number;
  claimedPlans?: { accountId: string; label: string; planId: string; planName: string; grants: string[] }[];
  failedDetails?: { accountId: string; label: string; message: string; risk?: boolean }[];
  activationFailures?: { accountId: string; label: string; detail: string }[];
  ranAt?: string;
  trigger?: string;
}

/** 对全部启用账号跑一轮「探测 + 领取」（等同定时任务手动触发）。 */
export const zcodeRunRewards = (key: string, claim = true) =>
  api<ZcodeRunSummary>('/v1/zcode/rewards/run', { method: 'POST', body: { claim }, timeoutMs: OPS_TIMEOUT_MS }, key);

/** 查询单账号额度（token 计量），并写入快照。 */
export const zcodeRefreshBalance = (accountId: string, key: string) =>
  api<ZcodeBalanceResult>(
    `/v1/zcode/accounts/${encodeURIComponent(accountId)}/balance`,
    { method: 'POST', body: {}, timeoutMs: OPS_TIMEOUT_MS },
    key,
  );

/**
 * 换发设备指纹（风控后「换设备」语义，device_mid 必变）。
 * 官方口径是人工决策：3012 真风控时定时任务**不会**自动换指纹重试。
 */
export const zcodeRotateFingerprint = (accountId: string, key: string) =>
  api<{ ok: boolean; fingerprint: unknown; account: ZcodeAccount }>(
    `/v1/zcode/accounts/${encodeURIComponent(accountId)}/fingerprint/rotate`,
    { method: 'POST', body: {} },
    key,
  );

export const zcodeSettings = (key: string, signal?: AbortSignal) =>
  api<ZcodeJobsSnapshot>('/v1/zcode/settings', { signal }, key);

export const zcodeSaveSettings = (patch: Partial<ZcodeJobsSnapshot>, key: string) =>
  api<ZcodeJobsSnapshot>('/v1/zcode/settings', { method: 'POST', body: patch }, key);

/** 验证码求解自检（真实求解一次，供排障）。 */
export const zcodeDiagnoseCaptcha = (key: string) =>
  api<{ ok: boolean; config?: unknown; paramLength?: number; region?: string; error?: { message?: string } }>(
    '/v1/zcode/diagnose/captcha',
    { method: 'POST', body: {}, timeoutMs: OPS_TIMEOUT_MS },
    key,
  );

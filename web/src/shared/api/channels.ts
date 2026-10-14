/**
 * 渠道接入清单（`GET /v1/admin/channels`）。
 *
 * 这是「后端有哪些渠道、每个渠道怎么接、本机客户端在不在」的唯一来源：
 * 能力位来自 `src/platform/variant.js`，账号计数来自 accounts 表。
 * 前端按它渲染渠道卡片，**不在前端写死平台名单**——
 * 那些写死的名单正是 ZCode 后端全就绪却没有入口的成因。
 */
import { api } from './http';

/** 渠道能力位，与 `src/platform/variant.js` 的 capability 一一对应。 */
export interface ChannelCapability {
  chat: boolean;
  checkin: boolean;
  balance: boolean;
  growth: boolean;
  billing: boolean;
  oauthLogin: boolean;
  deviceFingerprint: boolean;
  /** 运营面：限时套餐 / 积分活动探测与领取（ZCode、Qoder） */
  rewardClaim?: boolean;
  /** 运营面：本机客户端凭据导入 */
  localImport?: boolean;
}

export interface ChannelAccounts {
  /** 库中该渠道账号总数（含停用） */
  total: number;
  enabled: number;
  cooling: number;
}

/** 仅 Qoder：双区域各自的可导性。 */
export interface ChannelRealm {
  realm: 'cn' | 'intl';
  installed: boolean;
  loggedIn: boolean;
  available: boolean;
  detail: string;
}

export interface ChannelOnboarding {
  /** 后端声明的接入方式：'oauth' | 'paste' | 'local' */
  kind: string;
  label: string;
  available: boolean;
  /**
   * 可用时给位置或已登录账号提示；不可用时说明原因与需要装什么。
   * 一律是「可行动」的文案，不是空串或错误码。
   */
  detail: string;
  /** 仅 qoder：是否 Windows（非 Windows 无法解密客户端凭据） */
  windows?: boolean;
  realms?: ChannelRealm[];
}

/**
 * 平台运营面定时任务快照（仅 ZCode / Qoder 有；其余为 null）。
 * 注意后端已去掉 `localClient`——本机探测统一由 onboarding 给出，
 * 保留两份会在同一响应里出现两个可能不一致的结论。
 */
export interface ChannelJobs {
  enabled: boolean;
  spreadMinutes: number;
  autoClaim: boolean;
  lastRunAt: string | null;
  /** 上一轮的分平台汇总，结构随平台不同，仅用于展示 */
  lastSummary: unknown;
  nextRunAt: string | null;
  lastError: string | null;
  accounts: number;
  /** ZCode 两时段；Qoder 用单时段 hour/minute */
  hour?: number;
  minute?: number;
  hour1?: number;
  minute1?: number;
  hour2?: number;
  minute2?: number;
  /** 仅 ZCode：验证码求解器可用性 */
  solver?: { available: boolean; dir: string };
}

export interface Channel {
  id: string;
  label: string;
  note: string;
  capability: ChannelCapability;
  accounts: ChannelAccounts;
  onboarding: ChannelOnboarding[];
  jobs: ChannelJobs | null;
}

export interface ChannelsResponse {
  object: 'channels';
  data: Channel[];
  summary: {
    channels: number;
    /** 库里有该渠道账号的渠道数（口径是 total>0，不是 enabled>0） */
    connected: number;
    accounts: number;
    enabled: number;
  };
}

export const listChannels = (key: string, signal?: AbortSignal) =>
  api<ChannelsResponse>('/v1/admin/channels', { signal }, key);

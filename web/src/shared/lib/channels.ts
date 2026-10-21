/**
 * 渠道接入注册表（前端侧）。
 *
 * 渠道清单本身**不在**这里——它来自后端 `GET /v1/admin/channels`，能力位来自
 * `src/platform/variant.js`（单一事实源）。本文件只回答后端回答不了的那个问题：
 * **这个渠道点「接入」时该打开哪个向导。**
 *
 * 为什么需要这层：前端此前是「每加一个平台手写一个弹窗」，ZCode 的后端接口
 * （`/v1/zcode/local/preview` + `/local/import` + `/rewards/*`）全部就绪，
 * 前端却连一个按钮都没有，账号根本接不进来。现在向导按渠道 id 注册，于是：
 *   - 漏注册不再等于「静默消失」，而是卡片上明确显示「此渠道暂无接入向导」；
 *   - `src/test/channels.test.js` 双向比对后端渠道集合与本文件，漏注册即失败。
 *
 * 未注册的渠道 id 一律走 `channelEntry()` 返回 null 的降级分支，
 * 后端新增平台时前端不会白屏或崩在 undefined 上。
 */
import type { ChannelId } from './channelIds';

export type { ChannelId };

/** 接入向导种类。一个渠道可以有多条（Trae 同时有 OAuth 与粘贴两条路）。 */
export type WizardKind =
  | 'trae-oauth'
  | 'trae-paste'
  | 'wb-local'
  | 'zcode-local'
  | 'qoder-local'
  | 'qoder-manual'
  | 'raccoon-login';

export interface ChannelEntry {
  /**
   * 卡片色块颜色。刻意只用 global.css 里已定义的语义令牌，不写裸 hex——
   * 见 web/scripts/check-css-tokens.mjs 的校验口径。
   */
  accent: string;
  /**
   * 后端 `onboarding[].kind` → 向导实现。
   * 后端声明的每条接入方式都必须在这里有落点，否则卡片会显示「暂无向导」。
   * WorkBuddy 的 local 与 paste 共用同一个向导（该弹窗同时提供两种入口）。
   */
  wizards: Record<string, WizardKind>;
}

export const CHANNEL_ENTRY: Record<ChannelId, ChannelEntry> = {
  trae: {
    accent: 'var(--rg-brand-600)',
    wizards: { oauth: 'trae-oauth', paste: 'trae-paste' },
  },
  workbuddy: {
    accent: 'var(--rg-state-info)',
    wizards: { local: 'wb-local', paste: 'wb-local' },
  },
  zcode: {
    // ZCode 只有本机导入一条路：客户端 JWT 无 refresh_token、也不发放可移植凭据，
    // 「粘贴凭据」在它这里没有可粘贴的东西。
    accent: 'var(--rg-state-warning)',
    wizards: { local: 'zcode-local' },
  },
  qoder: {
    accent: 'var(--rg-state-success)',
    // Qoder 上游只认纯 Bearer 的 dt- token，凭据本身可移植，因此粘贴这条路
    // 是真的可用（与 ZCode 相反——它的 JWT 由家目录派生，无可粘贴之物）。
    // 本机导入要求服务端与客户端同机（DPAPI 密文换机解不开），手动粘贴覆盖
    // Linux 部署与跨机接入。两者共用同一个弹窗（内部切换方式）。
    wizards: { local: 'qoder-local', paste: 'qoder-manual' },
  },
  raccoon: {
    // Raccoon 本机没有官方客户端可读凭据（不像 WorkBuddy/ZCode/Qoder），
    // 官方那条自定义协议回调服务端也收不到 —— 只能由面板承载扫码登录。
    accent: 'var(--rg-state-error)',
    wizards: { login: 'raccoon-login' },
  },
};

/** 取渠道注册项；未注册（后端新增了平台而前端还没做向导）时返回 null。 */
export function channelEntry(id: string): ChannelEntry | null {
  return (CHANNEL_ENTRY as Record<string, ChannelEntry>)[id] ?? null;
}

/** 取出某渠道某条接入方式对应的向导；无落点返回 null。 */
export function wizardFor(id: string, kind: string): WizardKind | null {
  return channelEntry(id)?.wizards[kind] ?? null;
}

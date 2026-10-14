/**
 * 已实现接入向导的渠道 id 清单。
 *
 * 单独成文件，是为了让「前端向导注册表」与「后端渠道清单」的一致性可以被
 * `src/test/channels.test.js` 机械比对：测试直接提取本文件的字面量，
 * 不去解析 TS 类型（尝试用正则读类型定义既脆弱又读不到有用信息）。
 *
 * 顺序与 `src/platform/variant.js` 的 VARIANTS 定义顺序一致：
 * Trae / WorkBuddy / ZCode / Qoder / Raccoon。
 */
export const CHANNEL_IDS = ['trae', 'workbuddy', 'zcode', 'qoder', 'raccoon'] as const;

export type ChannelId = (typeof CHANNEL_IDS)[number];

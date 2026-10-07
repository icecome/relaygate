'use strict';
/**
 * platform/variant.js — 平台差异的单一事实源。
 *
 * 背景：Trae 与 WorkBuddy 的差异此前散落在至少 9 个文件里——域名在
 * lib/auth.js、credentials/oauth.js、upstream/checkin.js、upstream/balance.js、
 * workbuddy/auth.js、workbuddy/cat-trip.js 各自定义一份；能力有无靠调用方
 * 自行 `edition === 'workbuddy'` 判断（全库 40 余处）。后果：
 *   1. 新增平台要改多处，且容易漏改（漏一处就是运行时 4001/404）
 *   2. 同一事实出现多个副本后会分叉（例如 checkin.js 与 balance.js 各有一份
 *      DEFAULT_UG_HOST，改一处不改另一处即静默不一致）
 *
 * 本模块把「一个平台是什么」收敛为一张表：域名、数据根、凭据文件名、
 * 应用身份、能力声明、错误码语义。所有业务模块从这里取，不再自带副本。
 *
 * 边界（刻意不做的事）：不定义 chat/balance/checkin 的统一方法签名，
 * 也不把两个平台的实现搬进同一个目录。那是 Provider 接口的范畴，
 * 需要真正接入第三平台时再做——过早抽象会把当前两家的特例
 * （Trae 的设备指纹、WorkBuddy 的 region 映射）硬塞进一个假接口里。
 */
const path = require('path');
const os = require('os');

/** 账号表 edition 字段的取值（也是本模块的键）。 */
const TRAE = 'trae';
const WORKBUDDY = 'workbuddy';
const ZCODE = 'zcode';

/**
 * 平台定义表。
 *
 * 字段约定：
 * - id/label          标识与展示名
 * - edition           账号表 edition 字段的规范值（Trae 侧历史值含 cn/sg，见 normalizeEdition）
 * - capability        能力声明：调用方据此决定是否发起某类请求，不再猜 edition
 * - hosts             全部上游域名。region 相关项用 { cn, global } 形态
 * - identity          上游识别客户端所需的固定值
 * - errors            业务码语义（「已签到」「限流」这类跨模块共用的判定）
 */
const VARIANTS = {
  [TRAE]: {
    id: TRAE,
    label: 'Trae',
    edition: TRAE,
    capability: {
      chat: true,
      checkin: true,
      balance: true,
      growth: false,
      // 会话级用量明细（query_user_usage_group_by_session）。注意粒度：
      // 是「逐会话聚合」而非 WorkBuddy 那种逐请求，一行 = 一次完整会话
      // 的积分/token 汇总。2026-10 实测 CN 域可用（v1 路径）。
      billing: true,
      oauthLogin: true,
      deviceFingerprint: true,
    },
    hosts: {
      // agent 面（chat / 模型详情）：按 edition 或 userRegion 选
      agentCn: 'https://trae-api-cn.mchost.guru',
      agentSg: 'https://coresg-normal.trae.ai',
      agentUs: 'https://coreva-normal.trae.ai',
      // UG 面（签到 / 权益）：与 agent 域分离，日志实测为 api.trae.cn
      ug: 'https://api.trae.cn',
      // OAuth 授权与换票
      oauthAuth: 'https://www.trae.cn/authorization',
      // 授权页本身的来源（本地回调监听器的 ACAO 固定值）
      oauthAuthOrigin: 'https://www.trae.cn',
      oauthExchange: 'https://api.trae.cn',
      // 授权页回调来源白名单（OAuth 提交凭据时的 Origin 校验）
      callbackOriginPattern: '^https:\\/\\/([a-z0-9-]+\\.)*trae\\.(cn|com|ai|com\\.cn)$',
      // 换票 host 白名单（SSRF 防御：env 覆盖也不得指向白名单外）
      exchangeHostAllowlist: ['api.trae.com.cn', 'api.trae.cn', 'trae-api-cn.mchost.guru'],
    },
    identity: {
      appId: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
      packageType: 'stable_cn',
      oauthClientId: 'en1oxy7wnw8j9n',
      oauthClientSecret: '-',
    },
    // 上游端点路径
    paths: {
      chat: '/api/agent/v3/llm_utils_chat',
      modelDetail: '/api/ide/v1/get_detail_param',
      checkinStatus: '/trae/api/v2/ug/checkin_credits/status',
      checkinClaim: '/trae/api/v2/ug/checkin_credits/claim',
      entitlementUsage: '/trae/api/v2/pay/ide_user_ent_usage',
      // 会话级用量明细（v1，非 v2；v2 实测 404）。参数 usage_type:[7] 为
      // Cloud-IDE 会话积分口径，page_size 上限 20。
      sessionUsage: '/trae/api/v1/pay/query_user_usage_group_by_session',
    },
    errors: {
      alreadyCheckedIn: [9095],
      alreadyText: ['已经签到', '已签到', '明日再来'],
      busy: 9074,
      rateLimitCodes: [4011, 429, 3004],
      modelUnavailable: 4001,
      modelRateLimit: 6004,
      planLimit: 1005,
    },
  },

  [WORKBUDDY]: {
    id: WORKBUDDY,
    label: 'WorkBuddy',
    edition: WORKBUDDY,
    capability: {
      chat: true,
      checkin: true,
      balance: true,
      growth: true,
      billing: true,
      oauthLogin: false,
      deviceFingerprint: false,
    },
    hosts: {
      chat: { cn: 'https://copilot.tencent.com', global: 'https://www.workbuddy.ai' },
      billing: { cn: 'https://www.codebuddy.cn', global: 'https://www.workbuddy.ai' },
      // 成长中心固定走 workbuddy.cn（无 region 区分，实测确认）
      growth: 'https://www.workbuddy.cn',
      tokenRefresh: 'https://www.codebuddy.cn/v2/plugin/auth/token/refresh',
      // 域名字段（X-Domain / 账内 domain）与 base 不同：cn 用 copilot.tencent.com
      domain: { cn: 'copilot.tencent.com', global: 'www.workbuddy.ai' },
      regionPattern: 'workbuddy\\.ai',
    },
    identity: {
      userAgent: 'CLI/2.63.2 CodeBuddy/2.63.2',
      productCode: 'workbuddy',
      product: 'SaaS',
      clientPlatform: 'web',
    },
    paths: {
      chat: '/v2/chat/completions',
      checkinStatus: '/v2/billing/meter/checkin-activity-status',
      checkinClaim: '/v2/billing/meter/daily-checkin',
      resourceSummary: '/billing/meter/get-user-resource-summary',
      requestUsage: '/billing/meter/get-user-request-usage',
      growthBase: '/activity/growth',
    },
    errors: {
      alreadyCheckedIn: [10001],
      alreadyText: ['已签到'],
      rateLimitCodes: [6004],
      modelRateLimit: 6004,
    },
    // 桌面客户端凭据文件（导入 / 轮换用）
    clientAuth: {
      dirName: ['CodeBuddyExtension', 'Data', 'Public', 'auth'],
      fileName: 'workbuddy-desktop.info',
    },
  },

  // ZCode（智谱 / Z.ai 的官方桌面客户端）。当前只接入「账号运营面」：
  // 本机凭据导入、限时套餐领取、额度查询、激活上报。转发面（messages）
  // 刻意留空——上游按设备指纹+追踪头识别客户端，头形态写错会触发 3012
  // 「unusual activity」，不适合在未充分验证前并入转发池。
  [ZCODE]: {
    id: ZCODE,
    label: 'ZCode',
    edition: ZCODE,
    capability: {
      chat: false,
      checkin: false,
      balance: true,
      growth: false,
      billing: true,
      oauthLogin: false,
      deviceFingerprint: true,
      // 运营面能力位：限时套餐探测与领取（本平台独有）
      rewardClaim: true,
      // 本机客户端凭据导入（~/.zcode/v2/credentials.json）
      localImport: true,
    },
    hosts: {
      zcode: 'https://zcode.z.ai',
      zaiApi: 'https://api.z.ai',
      bigmodel: 'https://open.bigmodel.cn',
      chat: 'https://chat.z.ai',
      // 官方客户端 OAuth 授权页与换票端点
      oauthAuthorize: 'https://chat.z.ai/api/oauth/authorize',
      oauthToken: 'https://zcode.z.ai/api/v1/oauth/token',
      // 客户端 CDN 资源
      cdn: 'https://cdn-zcode.z.ai',
    },
    identity: {
      appId: 'client_P8X5CMWmlaRO9gyO-KSqtg',
      // X-Title = "Z Code@{sourceTitle}"，桌面端 sourceTitle=electron
      title: 'Z Code@electron',
      agent: 'glm',
      releaseChannel: 'stable',
      referer: 'https://zcode.z.ai/',
    },
    paths: {
      // 运营面
      billingPreview: '/api/v1/zcode-plan/billing/preview',
      billingClaim: '/api/v1/zcode-plan/billing/claim',
      billingBalance: '/api/v1/zcode-plan/billing/balance',
      clientConfigs: '/api/v1/client/configs',
      eventReport: '/api/v1/event/report',
      marketingTouch: '/api/v1/marketing/touch',
      incentiveBase: '/api/v1/incentive',
      oauthToken: '/api/v1/oauth/token',
      // 转发面（当前未启用；头形态见 zcode/identity.js 的风险说明）
      messages: '/api/v1/zcode-plan/anthropic/v1/messages',
      messagesFallback: '/api/anthropic/v1/messages',
    },
    errors: {
      // billing/claim 业务码（对齐 zcode2api claim.py 的实证映射）
      planNotFound: 1001,
      campaignEnded: 1002,
      alreadyClaimed: 1003,
      ineligible: 1004,
      quotaExhausted: 1005,
      paramError: 3001,
      // 验证码校验失败：换码重试一次
      captchaFailed: 3007,
      // 真风控：unusual activity，命中即应隔离账号保护资产
      riskControl: 3012,
      // 复用既有的通用分类器语义
      alreadyCheckedIn: [],
      alreadyText: ['已经领取', '已领取过'],
      rateLimitCodes: [429],
      // 额度类文案（classifyError 的 quota 分支按正则兜底）
      quotaText: ['名额已用完', '额度不足'],
    },
    // 每日限时套餐投放的时段（本地时区，运营面定时任务用）
    rewardClaimHours: [0, 21],
    rewardClaimMinute: 30,
    // 激活事件元素（preview 前的活跃上报，官方客户端首启/日活同源）
    activationElements: ['app_launch', 'app_daily_active'],
  },
};

/** Trae 侧的 edition 历史值（cn/sg/us/manual）归一到 trae。 */
function normalizeEdition(edition) {
  const e = String(edition || '').toLowerCase();
  if (e === WORKBUDDY) return WORKBUDDY;
  if (e === ZCODE) return ZCODE;
  return TRAE;
}

/**
 * 取平台定义；未知或缺失时按 Trae 处理（保持既有行为：Trae 是默认池）。
 * @param {string} id edition / platform / builtin 值
 * @returns {typeof VARIANTS[string]}
 */
function variantOf(id) {
  return VARIANTS[normalizeEdition(id)] || VARIANTS[TRAE];
}

/**
 * 账号 edition 的规范值（转发池分流用）。
 *
 * 与 variantOf 的区别：本函数不把未知值兜底成 trae，而是原样返回小写值，
 * 让调用方能区分「真的是 trae」与「不认识的值」。pool.pick 这类
 * 会实际发上游请求的地方必须用本函数，否则新增平台会被静默当成 Trae。
 */
function editionOf(id) {
  return String(id || '').toLowerCase();
}

/** 是否为可进转发池的平台（capability.chat）。 */
function canChat(platformId) {
  return variantOf(platformId).capability.chat === true;
}

/** Trae 侧的 edition 取值全集（含历史值）。 */
const TRAE_EDITIONS = new Set([TRAE, 'cn', 'sg', 'us', 'manual']);

/**
 * 是否为 Trae 系账号——显式白名单判定，不做未知值兜底。
 *
 * 与 variantOf 的区别：variantOf('__unknown__') 会兜底成 Trae（保持历史行为），
 * 但「按平台筛账号」的地方绝不能兜底，否则新增平台会被静默抓进 Trae 链路。
 * 需要按平台过滤账号时一律用本函数 / capability 位。
 */
function isTrae(edition) {
  return TRAE_EDITIONS.has(String(edition || '').toLowerCase());
}

/** 是否为指定平台的账号（显式比较，不兜底）。 */
function isEdition(edition, platformId) {
  const e = String(edition || '').toLowerCase();
  const want = String(platformId || '').toLowerCase();
  if (want === TRAE) return isTrae(e);
  return e === want;
}

/** 能力查询：调用方据此决定是否发起某类请求，替代散落的 edition 比较。 */
function can(platformId, capability) {
  return variantOf(platformId).capability[capability] === true;
}

/**
 * 按 region 取多区域域名的具体值。
 * @param {{cn:string, global:string}|string} hostSpec
 * @param {string} region 'cn' | 'global'
 */
function hostFor(hostSpec, region) {
  if (typeof hostSpec === 'string') return hostSpec;
  if (!hostSpec) return '';
  return region === 'global' ? hostSpec.global : hostSpec.cn;
}

/** 由域名/主机串推导 region（无法识别时归 cn）。 */
function regionOf(domainOrHost, platformId = WORKBUDDY) {
  const v = variantOf(platformId);
  const s = String(domainOrHost || '').toLowerCase();
  if (v.hosts.regionPattern && new RegExp(v.hosts.regionPattern).test(s)) return 'global';
  return 'cn';
}

/** 规范化 region 取值。 */
function validRegion(r) {
  return r === 'global' ? 'global' : 'cn';
}

/** 桌面客户端 auth 目录绝对路径（仅 WorkBuddy 有；无则返回 null）。 */
function clientAuthDir(platformId = WORKBUDDY) {
  const spec = variantOf(platformId).clientAuth;
  if (!spec) return null;
  return path.join(process.env.LOCALAPPDATA || os.homedir() || '', ...spec.dirName);
}

module.exports = {
  TRAE,
  WORKBUDDY,
  ZCODE,
  VARIANTS,
  TRAE_EDITIONS,
  variantOf,
  normalizeEdition,
  editionOf,
  can,
  canChat,
  isTrae,
  isEdition,
  hostFor,
  regionOf,
  validRegion,
  clientAuthDir,
};
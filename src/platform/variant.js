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
      billing: false,
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
};

/** Trae 侧的 edition 历史值（cn/sg/us/manual）归一到 trae。 */
function normalizeEdition(edition) {
  const e = String(edition || '').toLowerCase();
  if (e === WORKBUDDY) return WORKBUDDY;
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
  VARIANTS,
  variantOf,
  normalizeEdition,
  can,
  hostFor,
  regionOf,
  validRegion,
  clientAuthDir,
};
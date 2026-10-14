'use strict';
/**
 * platform/variant.js — 平台差异的单一事实源。
 *
 * 此前平台差异散落在至少 9 个文件（域名分别定义于 lib/auth.js、credentials/oauth.js、
 * upstream/checkin.js、upstream/balance.js、workbuddy/auth.js、workbuddy/cat-trip.js），
 * 能力有无靠调用方自行比较 `edition === 'workbuddy'`（全库 40 余处），后果是新增平台
 * 容易漏改（漏一处即运行时 4001 或 404），同一事实的多个副本会分叉（如 checkin.js 与
 * balance.js 各有一份 DEFAULT_UG_HOST，改一处不改另一处即静默不一致）。
 *
 * 本模块把「一个平台是什么」收敛为一张表：域名、数据根、凭据文件名、应用身份、
 * 能力声明、错误码语义。边界（刻意不做的事）：不定义 chat/balance/checkin 的统一方法签名，
 * 也不把两个平台的实现搬进同一目录——那是 Provider 接口的范畴，需要真正接入第三平台时再做，
 * 过早抽象会把当前两家的特例（Trae 的设备指纹、WorkBuddy 的 region 映射）硬塞进假接口。
 */
const path = require('path');
const os = require('os');

/** 账号表 edition 字段的取值（也是本模块的键）。 */
const TRAE = 'trae';
const WORKBUDDY = 'workbuddy';
const ZCODE = 'zcode';
const QODER = 'qoder';

/** Qoder 区域（realm）：国内版与国际版的账号体系、域名、协议三者都不同。 */
const QODER_REALM_CN = 'cn';
const QODER_REALM_INTL = 'intl';

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
    // 渠道展示元数据（面板「渠道接入」用）。刻意放在变体表内而不是前端常量：
    // 「新增平台」只需改这一处，前端不会漏掉入口——ZCode 曾在后端全部就绪
    // （/v1/zcode/local/preview + /local/import）的情况下前端一个按钮都没有。
    // 只写可核实的客户端来源，不写厂商归属（Qoder 的厂商在本仓库无任何证据）。
    note: 'Trae IDE 账号池；OAuth 登录换票或粘贴本机凭据 JSON',
    // 接入方式（静态声明）：oauth = 授权页换票；paste = 粘贴凭据 JSON；
    // local = 读本机桌面客户端登录态。运行时是否真可用由
    // /v1/admin/channels 逐项探测（文件在不在、登录没登录），前端按结果渲染。
    onboarding: ['oauth', 'paste'],
    capability: {
      chat: true,
      checkin: true,
      balance: true,
      growth: false,
      // 会话级用量明细（query_user_usage_group_by_session）。注意粒度：
      // 是「逐会话聚合」而非 WorkBuddy 那种逐请求，一行等于一次完整会话的
      // 积分与 token 汇总。2026-10 实测 CN 域可用（v1 路径）。
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
      // 会话级用量明细（v1，非 v2；v2 实测返回 404）。参数 usage_type:[7] 为
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
      // 上下文窗口超限（输入超模型真实上限）。Trae 实测无独立码，统一按
      // 网关本地拦截与文案正则兜底；WorkBuddy 显式为 11115（msg: prompt is too long）。
      contextTooLong: null,
    },
  },

  [WORKBUDDY]: {
    id: WORKBUDDY,
    label: 'WorkBuddy',
    edition: WORKBUDDY,
    note: 'CodeBuddy / WorkBuddy 桌面端登录态；含成长中心任务',
    onboarding: ['local', 'paste'],
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
      // 上下文窗口超限。WorkBuddy chat 上游在输入超模型上限时返回 HTTP 400，
      // body {"code":11115,"msg":"prompt is too long: N tokens > MAX maximum"}。
      contextTooLong: 11115,
    },
    // 桌面客户端凭据文件（导入 / 轮换用）
    clientAuth: {
      dirName: ['CodeBuddyExtension', 'Data', 'Public', 'auth'],
      fileName: 'workbuddy-desktop.info',
    },
  },

  // ZCode（智谱 / Z.ai 的官方桌面客户端）。当前只接入账号运营面：
  // 本机凭据导入、限时套餐领取、额度查询、激活上报。转发面（messages）
  // 刻意留空——上游按设备指纹与追踪头识别客户端，头形态写错会触发 3012
  // 「unusual activity」，未充分验证前不宜并入转发池。
  [ZCODE]: {
    id: ZCODE,
    label: 'ZCode',
    edition: ZCODE,
    note: 'ZCode 桌面端登录态；限时套餐自动探测与领取（不参与对话转发）',
    // ZCode 只有本机导入一条路：客户端 JWT 无 refresh_token、也不发放可移植凭据，
    // 「粘贴凭据」在它这里没有可粘贴的东西，不要为了界面整齐而假装支持。
    onboarding: ['local'],
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
      // billing/claim 业务码（与 zcode2api claim.py 的实证映射统一）
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

  // Qoder（字节/阿里系 Agent 工作台）。双区域（cn / intl）账号体系独立，
  // 凭据加密链路同构（Chromium os_crypt v10 + DPAPI）但域名与对话协议不同：
  //   - 国际版：新版 OpenAI 兼容面 api2-v2.qoder.sh/model/v1/chat/completions（纯 Bearer）
  //   - 国内版：统一走 gateway.qoder.com.cn，/model/v1/* 实测 503，
  //             对话只能走老版 COSY 签名协议 /algo/api/v2/...
  // 运营面（每日 100 积分 / 额度查询）双区域同构，仅域名不同。
  // 转发面（capability.chat）：**仅国际版**。api2-v2.qoder.sh/model/v1/*
  // 纯 Bearer、OpenAI 兼容 SSE，已实测打通（单账号）。
  // 国内版 /model/v1/* 实测 503 必须走 COSY 老协议（未实现）——
  // realm 维度的收口见 qoderChatRealms() 与 pool.js 的 editionOk，
  // 切勿据 capability.chat=true 就认为两个 realm 都能转发。
  [QODER]: {
    id: QODER,
    label: 'Qoder',
    edition: QODER,
    note: 'Qoder 桌面端登录态，双区域（国内版 / 国际版）；对话转发仅国际版',
    onboarding: ['local'],
    // 区域相关域名/路径的取值表。realm 由本机客户端目录推导，见 qoder/local.js。
    realms: {
      [QODER_REALM_CN]: {
        openapi: 'https://openapi.qoder.com.cn',
        gateway: 'https://gateway.qoder.com.cn',
        docsBase: 'https://docs.qoder.cn',
        // 桌面客户端目录（凭据扫描用）：%APPDATA%\<appDir> 与 ~/<homeDir>
        appDir: 'com.qodercn.app.stable',
        homeDir: '.qoder-cn',
        // 对话协议形态：intl=新版 OpenAI 兼容；cn=COSY 老版
        chatProtocol: 'cosy',
      },
      [QODER_REALM_INTL]: {
        openapi: 'https://openapi.qoder.sh',
        gateway: 'https://api2-v2.qoder.sh',
        docsBase: 'https://docs.qoder.com',
        appDir: 'com.qoder.app.stable',
        homeDir: '.qoder',
        chatProtocol: 'openai',
      },
    },
    capability: {
      // 转发面（仅国际版，见 qoderChatRealms 白名单；国内版 503 未开放）
      chat: true,
      // 运营面签到（每日 100 Credits 活动领取）由自有时段任务驱动，
      // 不并入 checkin-all 的批量签到（后者是「今日签到」语义，Qoder 是活动领取）。
      checkin: false,
      balance: true,
      growth: false,
      billing: false,
      oauthLogin: false,
      deviceFingerprint: true,
      // 运营面能力位
      rewardClaim: true,
      // 本机客户端凭据导入（auth.v1.dat，双区域）
      localImport: true,
    },
    // 默认（未知 realm 时按国际版）：运营面端点双区域同构，域名是唯一差异
    hosts: {
      openapi: 'https://openapi.qoder.sh',
      gateway: 'https://api2-v2.qoder.sh',
    },
    identity: {
      // 桌面端身份头（/sash 活动平台必需；缺失时服务端不报错但返回空活动列表）
      userAgent: 'Qoder',
      clientType: '10',      // CLI=5，QoderWork=6，桌面端=10
      clientVersion: '0.4.3',
      machineOs: 'x86_64_win32',
      machineHostname: 'DESKTOP-QODER',
      // COSY 协议版本（官方客户端内置常量，不是桌面版版本号）
      cosyVersion: '1.1.64',
      defaultUserType: 'personal_profession_trial',
    },
    paths: {
      // 运营面（挂 openapi 基址，纯 Bearer，无签名）
      userinfo: '/api/v1/userinfo',
      quota: '/api/v2/quota/usage',
      plan: '/api/v2/user/plan',
      devicePoll: '/api/v1/deviceToken/poll',
      deviceRefresh: '/api/v1/deviceToken/refresh',
      jobExchange: '/api/v1/jobToken/exchange',
      jobRefresh: '/api/v1/jobToken/refresh',
      // 活动平台（官方新活动平台，双区域通用）
      campaigns: '/sash/api/v1/me/campaigns',
      campaignReward: '/sash/api/v1/me/campaigns/%s/reward',
      campaignClaim: '/sash/api/v1/me/campaigns/%s/claim',
      // 旧签到接口（部分区域仍可用；实测国内版走 campaigns）
      checkinStatus: '/sash/api/v1/me/daily-check-in/status',
      checkinClaim: '/sash/api/v1/me/daily-check-in/claim',
      proEligibility: '/sash/api/v1/me/pro-upgrade/eligibility',
      proClaim: '/sash/api/v1/me/pro-upgrade/claim',
      // 对话面
      chat: '/model/v1/chat/completions',
      cosyChat: '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1',
      cosyModels: '/algo/api/v2/model/list?Encode=1',
    },
    errors: {
      // 活动平台业务码
      alreadyClaimed: 409,
      regionUnavailable: [404, 405, 410],
      rateLimitCodes: [429],
      // COSY 签名被拒（code 101）
      signatureInvalid: 101,
    },
    // 每日积分活动的投放时刻（UTC+8 10:00 刷新；服务端时段，本地任务在其后触发）
    rewardClaimHours: [10],
    rewardClaimMinute: 15,
    // 多账号确定性错峰窗口（分钟）；0=关闭
    spreadMinutes: 10,
    // 桌面端身份头必需的 cosy-machine* 六头：本服务部署在服务器、无原生桥，
    // 按 qoder2api-hub 实证必须整体省略（发派生假值会被服务端过滤掉活动）。
    // 国内版不发头是正确行为；国际版可能因此看不到活动，UI 需明示。
    omitMachineHeaders: true,
  },
};

/** Trae 侧的 edition 历史值（cn/sg/us/manual）归一到 trae。 */
function normalizeEdition(edition) {
  const e = String(edition || '').toLowerCase();
  if (e === WORKBUDDY) return WORKBUDDY;
  if (e === ZCODE) return ZCODE;
  if (e === QODER) return QODER;
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
 * 与 variantOf 的区别：本函数不把未知值回退成 trae，而是原样返回小写值，
 * 让调用方能区分「确实是 trae」与「不认识的值」。pool.pick 这类会实际发上游请求的
 * 地方必须用本函数，否则新增平台会被静默当成 Trae。
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
 * 是否为 Trae 系账号——显式白名单判定，不回退未知值。
 *
 * 与 variantOf 的区别：variantOf('__unknown__') 会回退成 Trae（保持历史行为），
 * 但「按平台筛账号」的地方绝不能回退，否则新增平台会被静默抓进 Trae 链路。
 * 需要按平台过滤账号时一律用本函数或 capability 位。
 */
function isTrae(edition) {
  return TRAE_EDITIONS.has(String(edition || '').toLowerCase());
}

/** 是否为指定平台的账号（显式比较，不回退）。 */
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

/** 由域名或主机串推导 region（无法识别时归 cn）。 */
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

/** 规范化 Qoder realm；无法识别时归 intl（运营面端点双区域同构，域名是唯一差异）。 */
function qoderRealm(realm) {
  const r = String(realm || '').toLowerCase();
  if (r === QODER_REALM_CN) return QODER_REALM_CN;
  return QODER_REALM_INTL;
}

/**
 * Qoder 某 realm 的域名/目录/协议定义。
 * @param {string} realm 'cn' | 'intl'
 */
function qoderRealmConfig(realm) {
  return variantOf(QODER).realms[qoderRealm(realm)];
}

/**
 * 由账号记录推导 Qoder realm。
 *
 * 刻意不用域名后缀判断：国际版客户端的 fastEndpoint 实测指向 api6.qoder.com.cn
 * （一个 .com.cn 域名），靠 host 猜 realm 会误判。realm 只在凭据导入时由
 * 「扫到哪个客户端目录」确定，之后随账号持久化（accounts.qoder_realm）。
 */
function qoderRealmOfAccount(acct) {
  if (!acct) return QODER_REALM_INTL;
  return qoderRealm(acct.qoderRealm || acct.qoder_realm);
}

/** Qoder 账号的 openapi 基址（运营面）。 */
function qoderOpenapiBase(realm) {
  return qoderRealmConfig(realm).openapi;
}

/** Qoder 账号的 gateway 基址（对话面 / COSY）。 */
function qoderGatewayBase(realm) {
  return qoderRealmConfig(realm).gateway;
}

/**
 * Qoder 支持对话转发的 realm 白名单。
 *
 * 国内版不在其中：/model/v1/* 实测 503，必须走 COSY 老协议（签名 + 自定义
 * Base64），实现成本高且未经多账号验证。国际版 api2-v2.qoder.sh 纯 Bearer、
 * OpenAI 兼容，已实测打通（单账号）。
 *
 * 用函数而非常量导出：测试需要能临时改写白名单以覆盖「国内版被显式请求」
 * 这条拒绝分支，写死的常量只能靠改模块源码。
 */
function qoderChatRealms() {
  const raw = String(process.env.QODER_CHAT_REALMS || '').trim();
  if (!raw) return [QODER_REALM_INTL];
  return raw.split(',').map((s) => qoderRealm(s)).filter((r, i, arr) => arr.indexOf(r) === i);
}

/**
 * Qoder 账号能否进入对话转发池。
 * 两个条件同时满足：realm 在白名单内 + 有 token。
 * 供 credentials/pool.js 的 editionOk 调用（那里负责 edition 维度的分池）。
 */
function qoderChatOk(acct) {
  if (!acct) return false;
  const realm = qoderRealmOfAccount(acct);
  if (!qoderChatRealms().includes(realm)) return false;
  return !!String(acct.token || '').trim();
}

/**
 * 全部渠道变体，按展示顺序返回。
 *
 * 顺序即 VARIANTS 的定义顺序（JS 对象字符串键保序）：Trae / WorkBuddy / ZCode / Qoder。
 * /v1/admin/channels 与面板「渠道接入」直接消费它——新增平台只需往 VARIANTS 里
 * 加一项，聚合端点与前端渠道卡片会自动出现，不必再改第二处（这正是 ZCode
 * 当初漏掉入口的根因：能力位在变体表里，前端却各写各的弹窗）。
 */
function allVariants() {
  return Object.values(VARIANTS);
}

module.exports = {
  TRAE,
  WORKBUDDY,
  ZCODE,
  QODER,
  QODER_REALM_CN,
  QODER_REALM_INTL,
  VARIANTS,
  allVariants,
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
  qoderRealm,
  qoderRealmConfig,
  qoderRealmOfAccount,
  qoderOpenapiBase,
  qoderGatewayBase,
  qoderChatRealms,
  qoderChatOk,
};
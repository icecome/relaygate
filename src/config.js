'use strict';
/**
 * config.js — 集中配置加载。
 * 所有 .env / model-config.json 的读取都在此完成，业务模块只引用这里导出的对象。
 * 敏感值（密钥/token）仅从环境变量或配置文件读取，禁止硬编码。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

/**
 * 进程启动时**真实存在**的环境变量名。
 *
 * 这是 .env 与进程环境之间的优先级依据，必须冻结在启动那一刻：
 * shell / 服务管理器 / 测试脚本显式给出的值优先级高于 .env 文件，
 * 只有进程环境里没有的键才允许由 .env 填充与刷新。
 *
 * 刻意挂在 globalThis 的 Symbol 上而不是用模块级常量：config.js 被
 * `delete require.cache[...]` 之后重新加载时（测试与若干脚本会这么做，见
 * test/unit.test.js 的 TRAE_UPSTREAM_FUNCTION 用例），模块级常量会重新快照
 * 一次——而那一刻 .env 注入的键早已在 process.env 里，会被误判成「进程环境
 * 显式给出」，此后 reload 再也刷不动它们（热重载静默失效）。
 * 以进程为单位只快照一次，才是这个集合应有的语义。
 */
const BOOT_ENV_SYMBOL = Symbol.for('relaygate.bootEnvKeys');
if (!globalThis[BOOT_ENV_SYMBOL]) {
  globalThis[BOOT_ENV_SYMBOL] = new Set(Object.keys(process.env));
}
const BOOT_ENV_KEYS = globalThis[BOOT_ENV_SYMBOL];

/**
 * 加载 / 重载 .env。
 *
 * 两处细节缺一个就会静默出错：
 *
 * 1. **显式给路径**：不给时 dotenv 按 process.cwd() 查找，从别的目录启动
 *    （起服务与跑脚本的 cwd 常常不同）就静默读不到任何配置。
 *
 * 2. **只刷新「进程环境没有的键」，而不是无脑 `override: true`**：
 *    早先 reload 里的 `require('dotenv').config()` 因为 dotenv 默认不覆盖
 *    已存在的 process.env 而完全是空操作——用户改了 .env 点「热重载」，
 *    日志打了 reloaded，实际一个值都没变。但反过来用 `override: true`
 *    同样错：那会让 .env 反过来压掉调用方显式设置的环境变量。
 *    本项目已有真实受害场景——`src/test/unit.test.js:12` 在 require 之前
 *    把 `WORKSPACE_DIR` 指向临时目录做隔离，而 `.env` 里也有 WORKSPACE_DIR；
 *    一旦 override，测试就会跑到真实的 output/ 状态目录上（凭据用另一把
 *    密钥加密，直接解密失败）。
 *
 *    故按「启动时的进程环境」逐个键判定：BOOT_ENV_KEYS 里的键永不覆盖，
 *    其余键每次加载都按文件当前内容刷新。
 */
function loadEnv() {
  let parsed;
  try {
    parsed = require('dotenv').parse(fs.readFileSync(ENV_FILE));
  } catch (e) {
    // 文件不存在是正常情况（纯环境变量部署），只在确实是解析/读取错误时提示
    if (e && e.code !== 'ENOENT') console.error(`[config] Failed to load ${ENV_FILE}: ${e.message}`);
    return;
  }
  for (const [k, v] of Object.entries(parsed || {})) {
    if (BOOT_ENV_KEYS.has(k)) continue;
    process.env[k] = v;
  }
}
loadEnv();

function readJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error(`[config] Failed to read ${p}: ${e.message}`);
    return fallback;
  }
}

const modelConfig = readJson(path.join(ROOT, 'model-config.json'), {
  models: {}, settings: {}
});

/**
 * 已移除：model-fallback.json 的读取。
 *
 * 该文件声明了 autoFallback / queueThreshold 与十余组模型降级映射，看起来
 * 像「配置降级策略」，但自 v3.0 全功能重构提交（5908f8f）加入后从未被任何
 * 业务代码消费——全库对 fallbackConfig 的读写只有 config.js 内部的
 * 读入/挂载/reload 三处，没有一处参与选型或降级决策。
 *
 * 也就是说：用户花时间配置的降级策略从未生效过，而且面板上也没有任何
 * 入口能看出它不生效，这比没有这个文件更糟。若将来要实现模型降级，
 * 应作为新功能从零设计（并接入面板），而不是复用一份从未被读过的配置。
 *
 * 遗留文件检查在 index.js 启动流程里做：文件仍存在就打印警告，
 * 让升级的用户立刻知道自己的配置没被用上。
 */

// 模型映射：key（对外模型名）-> { function, config_name, scene, reasoning }
function buildModelMap(modelConfig) {
  const map = {};
  for (const [key, val] of Object.entries((modelConfig && modelConfig.models) || {})) {
    map[key.toLowerCase()] = {
      function: val.function || 'chat_v3',
      config_name: val.config_name || key,
      scene: val.scene || null,
      reasoning: val.reasoning === true,
    };
  }
  map.auto = { function: 'inline_chat', config_name: null, scene: null, reasoning: false };
  return map;
}

/**
 * 构造模型名解析器。初始加载与热重载共用同一实现，避免两处返回形态分叉
 * （曾出现热重载后丢失 scene / reasoning 的问题）。
 */
function makeResolveModelOptions(map) {
  return function resolveModelOptions(modelName, configNameOverride) {
    const lower = (modelName || '').toLowerCase();
    if (lower === 'auto' || !lower) {
      return { function: 'inline_chat', config_name: null, scene: null, reasoning: false };
    }
    if (configNameOverride) {
      return { function: 'chat_v3', config_name: configNameOverride, scene: null, reasoning: false };
    }
    if (map[lower]) {
      return map[lower];
    }
    // 上游 config_name 精确匹配本地映射的 config_name（避免被短别名部分匹配吞掉）
    for (const val of Object.values(map)) {
      if (val.config_name && String(val.config_name).toLowerCase() === lower) {
        return { function: val.function || 'chat_v3', config_name: val.config_name, scene: val.scene || null, reasoning: val.reasoning === true };
      }
    }
    // 未登记的上游 ID：function=chat_v3，config_name 原样传给下游
    return { function: 'chat_v3', config_name: modelName, scene: null, reasoning: false };
  };
}

const MODEL_MAP = buildModelMap(modelConfig);
const resolveModelOptions = makeResolveModelOptions(MODEL_MAP);

/**
 * 密钥分域（K-1 权限分离）：
 *   - 管理域：ADMIN_KEY（env 过渡）/ DB 登录密钥 —— 仅管理面
 *   - 转发域：DB 访问密钥 —— 仅转发 API
 * API_KEY 不再参与运行期鉴权，仅为「库内尚无 access key」时的引导种子，
 * 且强制与管理密钥取不同值（同值视为配置事故，拒绝入库）。
 */
const apiKey = process.env.API_KEY || '';
const adminKey = process.env.ADMIN_KEY || '';
if (!adminKey) {
  console.warn('[config] ADMIN_KEY 未设置：首次引导只能经管理面板 setup 或 CLI 创建登录密钥');
}
if (apiKey && adminKey && apiKey === adminKey) {
  throw new Error('[config] API_KEY 与 ADMIN_KEY 同值：管理/转发密钥必须分离（K-1），请为二者配置不同值');
}

const config = {
  ROOT,
  port: parseInt(process.env.PORT || '19900', 10),
  // 个人本机默认只绑 loopback；跨机访问请显式设置 HOST=0.0.0.0 并自行配置防火墙
  host: process.env.HOST || '127.0.0.1',
  apiKey,
  adminKey,
  // /status 是否免鉴权（默认要求 Bearer；置 true 兼容旧探针）
  statusPublic: process.env.STATUS_PUBLIC === 'true',
  // 通知 Webhook（可选，通用 JSON POST；也可用 telegram 适配）
  notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL || '',
  notifyTelegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  notifyTelegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  notifyDedupeMs: parseInt(process.env.NOTIFY_DEDUPE_MS || String(60 * 60 * 1000), 10),
  // 通知合并窗口：同一事件在窗口内重复触发时，窗口结束补发一条合并摘要（毫秒）
  notifyMergeMs: parseInt(process.env.NOTIFY_MERGE_MS || String(10 * 60 * 1000), 10),
  // 状态根目录：一律解析为绝对路径。
  //
  // 必须 resolve，不能原样用 env 值：.env 里写的是相对路径 ./output，而
  // credentials/db.js、lib/paths.js、model-router/store.js 都直接拿它拼文件路径。
  // 留相对路径意味着「从哪个目录启动，就用哪个库」——换个 cwd 启动会静默打开
  // 另一个 trae-relay.db，用户看到的是「账号全丢了」。相对路径按项目根解析，
  // 与 .env 本身的解析基准（ENV_FILE 固定在 ROOT）一致。
  // 工具输出压缩（RTK）：请求发出前就地重写工具结果的文本，直接减少输入 token。
  // 默认开——输入 token 是本项目成本的绝对主体（实测输出仅占 0.3%），
  // 而 RTK 只压「工具输出」且小于 500 字节的块一律不动、错误轨迹一律跳过。
  // 置 RTK_ENABLED=false 可整体关闭（改动模型所见内容，留一个总闸）。
  rtkEnabled: process.env.RTK_ENABLED !== 'false',
  workspaceDir: path.resolve(ROOT, process.env.WORKSPACE_DIR || 'output'),
  logLevel: process.env.LOG_LEVEL || 'info',
  // 是否写旧格式逐请求 JSON 文件（默认关；默认写 traffic.jsonl + 控制台一行）
  legacyTrafficFiles: process.env.LEGACY_TRAFFIC_FILES === 'true',
  modelConfig,
  resolveModelOptions,

  // 重试/限流
  maxRetries: parseInt(process.env.TRAE_MAX_RETRIES || '3', 10),
  retryBaseDelay: parseInt(process.env.TRAE_RETRY_DELAY || '2000', 10),
  requestTimeoutMs: parseInt(process.env.TRAE_REQUEST_TIMEOUT_MS || '600000', 10),

  // 截断自动续写：上游因输出上限中断（finish_reason=length）时，网关把已产出内容
  // 拼回上下文继续请求，对客户端表现为一次完整回复。关闭则如实传给客户端截断信号。
  autoContinue: process.env.AUTO_CONTINUE === 'true',
  maxContinues: Math.max(0, parseInt(process.env.MAX_CONTINUES || '5', 10) || 0),
  // 残缺工具参数是否注入 __incomplete 诊断标记（默认关闭，避免严格 schema 客户端不认）
  markIncompleteToolArgs: process.env.MARK_INCOMPLETE_TOOL_ARGS === 'true',

  // 工具调用协议：'native'（默认）| 'text'
  // 注意：当前仅用于展示（/v1/admin/config 与运维面板的「工具协议」行），
  // 没有任何行为分支消费它。工具调用形态由上游返回决定（见 transform/sse.js 的
  // 三种形态归一化）。如需真正切换协议，必须先在 openai.js 的请求构造处接入。
  toolProtocol: process.env.TOOL_PROTOCOL || 'native',

  // 上游未回传 usage 时，是否用 tiktoken（cl100k_base）补算 token 写入日志。
  // 关闭则这些请求记为「未计量」，token 与费用均为 0（口径更保守）。
  // 注意：补算值与上游模型的分词器不完全一致，仅供趋势参考，非账单精确值。
  estimateMissingTokens: process.env.ESTIMATE_MISSING_TOKENS !== 'false',

  // 上游通道（多模式，与社区 trae 网关一致）
  // function 覆盖：chat_v3 | solo_work_lite | inline_chat | ……；留空则使用 model-config
  upstreamFunction: process.env.TRAE_UPSTREAM_FUNCTION || '',
  // chat 路径：默认 llm_utils_chat；raw 可用 /api/agent/v2/llm_raw_chat 等
  upstreamChatPath: process.env.TRAE_UPSTREAM_CHAT_PATH || '/api/agent/v3/llm_utils_chat',
  // TraeWork 产品身份（实验）：on 时请求体/请求头注入 Work 语义，用于验证服务端权益池路由
  traeWorkIdentity: process.env.TRAE_WORK_IDENTITY === 'on',

  // 账号池 / 并发
  poolStrategy: process.env.POOL_STRATEGY || 'least_balance', // least_balance | round_robin
  maxInFlightPerAccount: parseInt(process.env.MAX_IN_FLIGHT_PER_ACCOUNT || '2', 10),
  minBalanceToUse: Number(process.env.MIN_BALANCE_TO_USE || '0') || 0,

  /**
   * 跨平台账号级调度（POOL_ACCOUNT_PRIORITY，默认开）。
   *
   * 背景：账号池 FEFO（先到期先用）此前只在单个平台池内生效，模型层选候选时
   * 完全不感知账号权益——同一手机号在 trae 池和 workbuddy 池是两个独立账号、
   * 各自排序，跨池的流量分配只由「模型倍率 + 加权轮转」决定。结果是临期积分
   * 可能整池闲置，而余额低、到期远的池反而被优先消耗。
   *
   * 开启后模型层先比较「候选所属池的最佳账号权益」：
   *   1) 池内存在 ACCOUNT_PRIORITY_WINDOW_DAYS 内到期的未用尽权益包 → 该池抢占，
   *      按最早到期时刻升序（临期/到期优先，作废是硬损失）；
   *   2) 否则按池内最高可用余额降序（余额多的优先使用）；
   *   3) 以上同档再回落到原有成本序（倍率/窗口）。
   * 关闭（置 false）即恢复「纯成本序选候选」的旧行为。
   */
  poolAccountPriority: process.env.POOL_ACCOUNT_PRIORITY !== 'false',
  // 临期抢占窗口（天）：只有窗口内的到期包才触发跨池抢占，避免把
  // 「12 个月后到期」与「11 个月后到期」这类无意义差异当成优先级信号。
  poolAccountPriorityWindowDays: (() => {
    const n = parseInt(process.env.POOL_ACCOUNT_PRIORITY_WINDOW_DAYS || '7', 10);
    return Number.isFinite(n) && n > 0 && n <= 365 ? n : 7;
  })(),

  // 出站节流（用于 3004 上游限流：实测同账号 ~30 秒内第 3 个请求即 3004，冷却 ~20 秒）。
  // ratePaceMs：同账号两次请求开始的最小间隔（下限）。
  // rateWindowMs / rateWindowMax：同账号在滚动窗口内最多承载的请求数，超出则转其他号。
  // rateCooldownMs：rate_limit 后账号冷却时长，贴近上游恢复窗口。
  ratePaceMs: parseInt(process.env.RATE_PACE_MS || '5000', 10),
  rateWindowMs: parseInt(process.env.RATE_WINDOW_MS || '30000', 10),
  rateWindowMax: parseInt(process.env.RATE_WINDOW_MAX || '2', 10),
  rateCooldownMs: parseInt(process.env.RATE_COOLDOWN_MS || '20000', 10),
  // 连续 rate_limit 的指数退避上限（20s → 40s → …… → 此值）
  rateCooldownMaxMs: parseInt(process.env.RATE_COOLDOWN_MAX_MS || String(30 * 60 * 1000), 10),

  // 定时任务（进程内）
  schedulerEnabled: process.env.SCHEDULER_ENABLED !== 'false',
  checkinHour: parseInt(process.env.CHECKIN_HOUR || '9', 10),
  checkinMinute: parseInt(process.env.CHECKIN_MINUTE || '0', 10),
  keepaliveHour: parseInt(process.env.KEEPALIVE_HOUR || '22', 10),
  tokenRefreshLeadHours: parseInt(process.env.TOKEN_REFRESH_LEAD_HOURS || '24', 10),
  // 模型自动探活：间隔小时（0=关闭）；每轮最多探多少个未知模型
  modelProbeIntervalHours: parseInt(process.env.MODEL_PROBE_INTERVAL_HOURS || '6', 10),
  modelProbeMaxPerRun: parseInt(process.env.MODEL_PROBE_MAX_PER_RUN || '8', 10),
};

/**
 * 热重载 model-config.json 与 .env 可热更项（T4）。
 * 仅更新内存中的模型映射与可变运行参数；不重启进程。
 * 端口/host/密钥等监听或鉴权级配置不热更（需重启后生效）。
 */
config.reload = function reload() {
  // 重新读取 model-config.json
  const freshModelConfig = readJson(path.join(ROOT, 'model-config.json'), { models: {}, settings: {} });
  // 重新加载 .env：只刷新「进程环境未显式给出」的键，见 loadEnv 注释
  loadEnv();
  // 更新可热更的运行参数
  config.modelConfig = freshModelConfig;
  // 用同一构造函数重建解析器，保证与初始加载的返回形态一致
  config.resolveModelOptions = makeResolveModelOptions(buildModelMap(freshModelConfig));
  // 调度与节流参数
  config.poolStrategy = process.env.POOL_STRATEGY || 'least_balance';
  config.maxInFlightPerAccount = parseInt(process.env.MAX_IN_FLIGHT_PER_ACCOUNT || '2', 10);
  config.minBalanceToUse = Number(process.env.MIN_BALANCE_TO_USE || '0') || 0;
  config.poolAccountPriority = process.env.POOL_ACCOUNT_PRIORITY !== 'false';
  {
    const n = parseInt(process.env.POOL_ACCOUNT_PRIORITY_WINDOW_DAYS || '7', 10);
    config.poolAccountPriorityWindowDays = Number.isFinite(n) && n > 0 && n <= 365 ? n : 7;
  }
  config.ratePaceMs = parseInt(process.env.RATE_PACE_MS || '5000', 10);
  config.rateWindowMs = parseInt(process.env.RATE_WINDOW_MS || '30000', 10);
  config.rateWindowMax = parseInt(process.env.RATE_WINDOW_MAX || '2', 10);
  config.rateCooldownMs = parseInt(process.env.RATE_COOLDOWN_MS || '20000', 10);
  config.rateCooldownMaxMs = parseInt(process.env.RATE_COOLDOWN_MAX_MS || String(30 * 60 * 1000), 10);
  config.schedulerEnabled = process.env.SCHEDULER_ENABLED !== 'false';
  config.checkinHour = parseInt(process.env.CHECKIN_HOUR || '9', 10);
  config.checkinMinute = parseInt(process.env.CHECKIN_MINUTE || '0', 10);
  config.keepaliveHour = parseInt(process.env.KEEPALIVE_HOUR || '22', 10);
  config.tokenRefreshLeadHours = parseInt(process.env.TOKEN_REFRESH_LEAD_HOURS || '24', 10);
  config.modelProbeIntervalHours = parseInt(process.env.MODEL_PROBE_INTERVAL_HOURS || '6', 10);
  config.modelProbeMaxPerRun = parseInt(process.env.MODEL_PROBE_MAX_PER_RUN || '8', 10);
  config.upstreamFunction = process.env.TRAE_UPSTREAM_FUNCTION || '';
  config.upstreamChatPath = process.env.TRAE_UPSTREAM_CHAT_PATH || '/api/agent/v3/llm_utils_chat';
  config.traeWorkIdentity = process.env.TRAE_WORK_IDENTITY === 'on';
  config.toolProtocol = process.env.TOOL_PROTOCOL || 'native';
  config.estimateMissingTokens = process.env.ESTIMATE_MISSING_TOKENS !== 'false';
  config.maxRetries = parseInt(process.env.TRAE_MAX_RETRIES || '3', 10);
  config.retryBaseDelay = parseInt(process.env.TRAE_RETRY_DELAY || '2000', 10);
  config.requestTimeoutMs = parseInt(process.env.TRAE_REQUEST_TIMEOUT_MS || '600000', 10);
  config.autoContinue = process.env.AUTO_CONTINUE === 'true';
  config.maxContinues = Math.max(0, parseInt(process.env.MAX_CONTINUES || '5', 10) || 0);
  config.markIncompleteToolArgs = process.env.MARK_INCOMPLETE_TOOL_ARGS === 'true';
  config.statusPublic = process.env.STATUS_PUBLIC === 'true';
  console.log(`[config] reloaded: ${Object.keys(freshModelConfig.models || {}).length} models, pool=${config.poolStrategy}`);
};

module.exports = config;
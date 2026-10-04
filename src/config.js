'use strict';
/**
 * config.js — 集中配置加载。
 * 所有 .env / model-config.json 的读取都在此完成，业务模块只引用这里导出的对象。
 * 敏感值（密钥/token）仅从环境变量或配置文件读取，禁止硬编码。
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();

function readJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error(`[config] Failed to read ${p}: ${e.message}`);
    return fallback;
  }
}

const ROOT = path.resolve(__dirname, '..');

const modelConfig = readJson(path.join(ROOT, 'model-config.json'), {
  models: {}, settings: {}
});

const fallbackConfig = readJson(path.join(ROOT, 'model-fallback.json'), {});

// 模型映射：key(对外模型名) -> { function, config_name, scene, reasoning }
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
    // 未登记的上游 ID：function=chat_v3，config_name 原样透传
    return { function: 'chat_v3', config_name: modelName, scene: null, reasoning: false };
  };
}

const MODEL_MAP = buildModelMap(modelConfig);
const resolveModelOptions = makeResolveModelOptions(MODEL_MAP);

const apiKey = process.env.API_KEY;
if (!apiKey) {
  throw new Error('[config] API_KEY 未设置；请先在 .env 配置 API_KEY（禁止使用公开默认值）');
}
// 管理密钥与转发密钥分离；未配置 ADMIN_KEY 时回退 API_KEY，但需显式告警
const adminKey = process.env.ADMIN_KEY || apiKey;
if (!process.env.ADMIN_KEY) {
  console.warn('[config] ADMIN_KEY 未设置，管理面将回退使用 API_KEY；建议配置独立 ADMIN_KEY');
}

const config = {
  ROOT,
  port: parseInt(process.env.PORT || '19900', 10),
  // 个人本机默认只绑 loopback；跨机访问请显式设 HOST=0.0.0.0 并自配防火墙
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
  workspaceDir: process.env.WORKSPACE_DIR || path.join(ROOT, 'output'),
  logLevel: process.env.LOG_LEVEL || 'info',
  // 是否写旧格式逐请求 JSON 文件（默认关；默认写 traffic.jsonl + 控制台一行）
  legacyTrafficFiles: process.env.LEGACY_TRAFFIC_FILES === 'true',
  modelConfig,
  fallbackConfig,
  resolveModelOptions,

  // 重试/限流
  maxRetries: parseInt(process.env.TRAE_MAX_RETRIES || '3', 10),
  retryBaseDelay: parseInt(process.env.TRAE_RETRY_DELAY || '2000', 10),
  requestTimeoutMs: parseInt(process.env.TRAE_REQUEST_TIMEOUT_MS || '600000', 10),

  // 截断自动续写：上游因输出上限中断（finish_reason=length）时，网关把已产出内容
  // 拼回上下文继续请求，对客户端表现为一次完整回复。关闭则如实透传截断信号。
  autoContinue: process.env.AUTO_CONTINUE === 'true',
  maxContinues: Math.max(0, parseInt(process.env.MAX_CONTINUES || '5', 10) || 0),
  // 残缺工具参数是否注入 __incomplete 诊断标记（默认关闭，避免严格 schema 客户端不认）
  markIncompleteToolArgs: process.env.MARK_INCOMPLETE_TOOL_ARGS === 'true',

  // 工具调用协议：'native'(默认) / 'text'
  toolProtocol: process.env.TOOL_PROTOCOL || 'native',

  // 上游通道（多模式，对齐社区 trae 网关）
  // function 覆盖：chat_v3 | solo_work_lite | inline_chat | …；空=用 model-config
  upstreamFunction: process.env.TRAE_UPSTREAM_FUNCTION || '',
  // chat 路径：默认 llm_utils_chat；raw 可用 /api/agent/v2/llm_raw_chat 等
  upstreamChatPath: process.env.TRAE_UPSTREAM_CHAT_PATH || '/api/agent/v3/llm_utils_chat',
  // TraeWork 产品身份（实验）：on 时请求体/请求头注入 Work 语义，用于验证服务端权益池路由
  traeWorkIdentity: process.env.TRAE_WORK_IDENTITY === 'on',

  // 账号池 / 并发
  poolStrategy: process.env.POOL_STRATEGY || 'least_balance', // least_balance | round_robin
  maxInFlightPerAccount: parseInt(process.env.MAX_IN_FLIGHT_PER_ACCOUNT || '2', 10),
  minBalanceToUse: Number(process.env.MIN_BALANCE_TO_USE || '0') || 0,

  // 出站节流（用于 3004 上游限流：实测同账号 ~30s 内第3个请求即 3004，冷却 ~20s）。
  // ratePaceMs：同账号两次请求开始的最小间隔（下限）。
  // rateWindowMs / rateWindowMax：同账号在滚动窗口内最多承载的请求数，超出则转其他号。
  // rateCooldownMs：rate_limit 后账号冷却时长，贴近上游恢复窗口。
  ratePaceMs: parseInt(process.env.RATE_PACE_MS || '5000', 10),
  rateWindowMs: parseInt(process.env.RATE_WINDOW_MS || '30000', 10),
  rateWindowMax: parseInt(process.env.RATE_WINDOW_MAX || '2', 10),
  rateCooldownMs: parseInt(process.env.RATE_COOLDOWN_MS || '20000', 10),

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
 * 热重载 model-config.json / model-fallback.json 与 .env 可热更项（T4）。
 * 仅更新内存中的模型映射与可变运行参数；不重启进程。
 * 端口/host/密钥等监听或鉴权级配置不热更（需重启生效）。
 */
config.reload = function reload() {
  // 重新读取 model-config.json
  const freshModelConfig = readJson(path.join(ROOT, 'model-config.json'), { models: {}, settings: {} });
  const freshFallback = readJson(path.join(ROOT, 'model-fallback.json'), {});
  // 重新加载 .env（不覆盖已存在的环境变量，仅刷新可热更项）
  try { require('dotenv').config(); } catch { /* ignore */ }
  // 更新可热更的运行参数
  config.modelConfig = freshModelConfig;
  config.fallbackConfig = freshFallback;
  // 用同一构造函数重建解析器，保证与初始加载的返回形态一致
  config.resolveModelOptions = makeResolveModelOptions(buildModelMap(freshModelConfig));
  // 调度与节流参数
  config.poolStrategy = process.env.POOL_STRATEGY || 'least_balance';
  config.maxInFlightPerAccount = parseInt(process.env.MAX_IN_FLIGHT_PER_ACCOUNT || '2', 10);
  config.minBalanceToUse = Number(process.env.MIN_BALANCE_TO_USE || '0') || 0;
  config.ratePaceMs = parseInt(process.env.RATE_PACE_MS || '5000', 10);
  config.rateWindowMs = parseInt(process.env.RATE_WINDOW_MS || '30000', 10);
  config.rateWindowMax = parseInt(process.env.RATE_WINDOW_MAX || '2', 10);
  config.rateCooldownMs = parseInt(process.env.RATE_COOLDOWN_MS || '20000', 10);
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
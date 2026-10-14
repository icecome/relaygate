'use strict';
/**
 * relay-gate v3 入口 — 暴露端点转发 API。
 * 分层：routes（薄）→ transform（纯函数）→ upstream（唯一上游通道）→ auth（复用）。
 * 启动：node src/index.js
 */
// 先安装全局异常处理器，再加载业务模块：模块加载期的异常也能被记录，避免静默退出
require('./log/crash').install();

const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const openai = require('./routes/openai');
const anthropic = require('./routes/anthropic');
const models = require('./routes/models');
const credentials = require('./routes/credentials');
const adminOverview = require('./routes/admin-overview');
const adminTraffic = require('./routes/admin-traffic');
const adminJobs = require('./routes/admin-jobs');
const adminNotify = require('./routes/admin-notify');
const adminDebug = require('./routes/admin-debug');
const dashboard = require('./routes/dashboard');
const responses = require('./routes/responses');
const status = require('./routes/status');
const workbuddy = require('./routes/workbuddy');
const zcode = require('./routes/zcode'); // ZCode 运营面（凭据导入 / 套餐领取 / 额度）
const qoder = require('./routes/qoder'); // Qoder 运营面（双区域凭据导入 / 每日积分领取 / 额度 / 目录）
const catTrip = require('./routes/cat-trip'); // WorkBuddy 成长活动端点（/v1/workbuddy/growth）
const apiKeys = require('./routes/api-keys');
const modelRouterAdmin = require('./routes/model-router');
const adminSecurity = require('./routes/admin-security');
const { keyRateLimit } = require('./middleware/rate-limit');
const { authenticate, authenticateAny, requireKeyScope } = require('./middleware/auth');
const scheduler = require('./jobs/scheduler');
const apiKeyStore = require('./credentials/api-keys');

const app = express();
app.use(express.json({ limit: '10mb' }));

/**
 * 请求级上下文：为每次客户端请求生成一个**回合同** id，经 AsyncLocalStorage
 * 透传给该请求内所有 `logRequest` 调用。
 *
 * 为什么不逐个调用点显式传：一次客户端请求会产出多行 traffic（降级换候选时每个
 * 候选一行），这些行散落在 openai / anthropic / responses / model-router 的十余处
 * `logRequest` 里；逐个补字段既容易漏、也会被将来新增的调用点绕过。
 * 用 AsyncLocalStorage 让「同一请求」这件事由运行上下文承载，新调用点自动继承。
 * 详见 src/log/traffic.js#newTurnId 与 lib/stats 的 turnBuckets。
 */
const requestContext = require('./lib/request-context');
app.use((_req, _res, next) => requestContext.run({ turnId: requestContext.newTurnId() }, next));

// 管理面板的登录密钥存于 localStorage（web/src/stores/useAuth.ts），同源任意脚本可读，
// 故以 CSP 收紧脚本与连接来源，并禁止被嵌入、禁止类型嗅探。
// style 放开 'unsafe-inline' 是 Tailwind 构建产物含内联样式所需；script 不放开任何 unsafe-*。
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// 转发面与运维快照不是 HTML 文档，加 CSP 只会干扰客户端处理响应体
const isDocumentRoute = (p) => !p.startsWith('/v1/') && p !== '/status' && p !== '/health';

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (isDocumentRoute(req.path)) res.setHeader('Content-Security-Policy', CSP);
  next();
});

const startT = Date.now();

/**
 * 启动期健康快照。由 runStartupChecks() 在 listen 之前填充，
 * /health 读它返回真实状态，而不是硬编码 'ok'。
 * @type {{checks: object[], warnings: string[]}}
 */
let startupHealth = { checks: [], warnings: [] };

/**
 * /health：真实健康检查（此前 status 是硬编码 'ok' 字符串，
 * 只反映「进程还在」，DB 坏了也返回 ok，服务管理器无法据此重启）。
 *
 * 语义：
 *   200 + status:'ok'        —— 全部检查通过
 *   503 + status:'unhealthy' —— 有检查未通过（checks 里能看到是哪一项）
 * 免鉴权，因此 checks 只返回布尔与简短文案，不泄露路径或密钥材料。
 */
app.get('/health', (req, res) => {
  let s = null;
  try {
    s = status.buildStatus();
  } catch {
    s = null;
  }
  const failing = startupHealth.checks.filter((c) => !c.ok);
  const healthy = failing.length === 0 && s != null;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'unhealthy',
    checks: startupHealth.checks.map((c) => ({ name: c.name, ok: !!c.ok, detail: c.detail })),
    warnings: startupHealth.warnings,
    uptime: s ? s.uptimeSec : null,
    accounts: s ? s.accounts : null,
    scheduler: s ? s.scheduler.enabled : null,
    nextCheckinAt: s ? s.scheduler.nextCheckinAt : null,
    poolStrategy: s ? s.pool.strategy : null,
  });
});

app.use(status);
app.use(dashboard);
// React 管理面板（web/dist，vite build 产物）；SPA fallback 到 index.html
const webDist = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!v1\/|health$|dashboard$|status$).*/, (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(webDist, 'index.html'), (err) => {
      if (err) next();
    });
  });
}
// 管理面：按路径挂载，避免 router.use 拦截转发请求
app.use('/v1/credentials', credentials);
app.use('/v1/workbuddy', workbuddy);
app.use('/v1/workbuddy/growth', catTrip);
// ZCode 运营面：凭据导入 / 套餐探测领取 / 额度 / 定时任务设置（全部管理鉴权）
app.use('/v1/zcode', zcode);
// Qoder 运营面 + 国际版对话转发。
// 运营面端点自带 admin 鉴权；对话转发（/v1/qoder/chat/completions）在路由内
// 用 authenticate，并与转发面共用同一限流中间件实例（同 key 同一额度池）。
// 限流实例必须在此前创建——app.use 的顺序即中间件顺序。
const rateLimitMw = keyRateLimit();
app.use('/v1/qoder', qoder);
app.use('/v1/admin', adminOverview);
app.use('/v1/admin', adminTraffic);
app.use('/v1/admin', adminJobs);
app.use('/v1/admin', adminNotify);
app.use('/v1/admin', adminDebug);
app.use('/v1/admin/model-router', modelRouterAdmin);
app.use('/v1/admin', adminSecurity);
app.use('/v1/api-keys', apiKeys);
// 模型列表双面可用（转发客户端 + 面板）：与转发面共用同一限流中间件实例。
// K-2：访问密钥需 models:read scope；登录密钥/管理域直接放行（关卡内判定）。
app.use('/v1/models', authenticateAny, requireKeyScope('models:read'), rateLimitMw);
app.use(models);
app.use(authenticate);
app.use(rateLimitMw);
app.use(openai);
app.use(anthropic);
app.use(responses);
// 最后手段：未命中任何路由时返回 404
app.use((req, res) => {
  res.status(404).json({ error: { message: `Not found: ${req.method} ${req.path}`, type: 'invalid_request_error' } });
});

// 统一错误处理
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(500).json({ error: { message: err.message || 'internal error', type: 'internal_error' } });
});

function isPortBusy(err) {
  return err && (err.code === 'EADDRINUSE' || err.code === 'EACCES');
}

function listen(port, host, fallbacks = []) {
  const server = app.listen(port, host, () => {
    const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    console.log(`[relay-gate] 服务已启动: http://${shown}:${port} (bind=${host})`);
    console.log(`[relay-gate] 管理面板: http://${shown}:${port}/`);
    console.log(`[relay-gate] 接口地址: http://${shown}:${port}/v1/chat/completions`);
    if (host === '::') {
      console.warn('[relay-gate] 仅绑定 IPv6；请使用 localhost 或 [::1] 访问（127.0.0.1 可能被其他进程占用，如 VMware NAT）。');
    }

    // 优雅停机链（P0-002）
    // 顺序：停止接受新连接 → 停定时器 → flush 日志 → 关 DB → 退出。
    // 信号处理器（log/crash.js 的 onShutdown）按注册顺序执行这些钩子，
    // 任何钩子失败不阻断后续，5 秒后强制退出。
    const { onShutdown } = require('./log/crash');
    const dbModule = require('./credentials/db');
    onShutdown('http-server', () => {
      server.close();
    });
    onShutdown('scheduler', () => scheduler.stop());
    onShutdown('balance-refresh', () => require('./jobs/balance-refresh').stop());
    onShutdown('backup', () => require('./jobs/backup').stop());
    onShutdown('zcode-rewards', () => require('./jobs/zcode-rewards').stop());
    onShutdown('qoder-rewards', () => require('./jobs/qoder-rewards').stop());
    onShutdown('sqlite', () => dbModule.close());

    scheduler.start();
    // 凭据模块启动初始化（devices 回填；m-38：从 require 期副作用改为显式调用）
    require('./routes/credentials').initCredentials();
    // 余额自动刷新 / 全量备份 / ZCode 奖励定时（独立定时器，配置驱动）
    require('./jobs/balance-refresh').start();
    require('./jobs/backup').start();
    // ZCode 限时套餐探测与领取（默认关闭，需 ZCODE_REWARDS_ENABLED=true）
    require('./jobs/zcode-rewards').start();
    // Qoder 每日积分（100 Credits）领取（默认关闭，需 QODER_REWARDS_ENABLED=true；
    // 上游 UTC+8 10:00 刷新，默认本地 10:15 执行，时区不同时在 /v1/qoder/settings 调整）
    require('./jobs/qoder-rewards').start();
    // logs/ 日期目录保留策略（m-29：启动期清理过期日志，LOG_RETENTION_DAYS 可调）
    // 必须在调度器启动之前执行：先清出干净目录再排程，且它是同步阻塞的
    require('./log/retention').pruneAtStartup();
    console.log('[relay-gate] periodic jobs started (balance refresh + backup + zcode rewards + qoder rewards)');
  });
  server.on('error', (err) => {
    if (isPortBusy(err) && fallbacks.length) {
      const next = fallbacks[0];
      console.warn(`[relay-gate] ${host}:${port} busy (${err.code}), fallback bind ${next}`);
      listen(port, next, fallbacks.slice(1));
      return;
    }
    console.error(`[relay-gate] listen failed on ${host}:${port}: ${err.message}`);
    process.exit(1);
  });
}

// 优先 HOST；Windows 上 0.0.0.0 可能被 vmnat 等独占，回退 ::（IPv6）再 127.0.0.1
// 启动引导：库内无 Key 时用 API_KEY / WORKBUDDY_API_KEY 创建初始转发 Key（可选种子）
try {
  const bootstrapped = apiKeyStore.bootstrapFromEnv();
  if (bootstrapped.length) {
    for (const k of bootstrapped) {
      console.log(`[api-keys] bootstrap created platform=${k.platform} label=${k.label} id=${k.id}`);
    }
  }
  // K-3：存量访问密钥补齐 models:read（幂等），否则升级后模型列表 403
  const patched = apiKeyStore.ensureModelsReadScope();
  if (patched.length) {
    console.log(`[api-keys] scope migration: models:read added to ${patched.length} key(s): ${patched.join(', ')}`);
  }
} catch (e) {
  console.error('[api-keys] bootstrap failed:', e.message);
}

// 已废弃配置的启动期提醒：model-fallback.json 从未被任何业务代码消费
// （详见 config.js 的说明）。文件若还在，明确告知用户「你的配置没生效」，
// 否则他会一直以为系统有降级机制。
try {
  if (fs.existsSync(path.join(config.ROOT, 'model-fallback.json'))) {
    console.warn(
      '[relay-gate] 警告：检测到 model-fallback.json，但本版本不实现模型降级，' +
        '该文件不会被读取。其中的 autoFallback / mappings 不会生效，可安全删除。',
    );
  }
} catch {
  /* 检查失败不影响启动 */
}

// 启动期健康校验（把「静默降级」变成「明确失败」）
// 顺序要求：必须先打开 DB 拿到密文行信息，才能判断 encrypt.key 是否可用。
try {
  const startupChecks = require('./lib/startup-checks');
  const cryptoMod = require('./lib/crypto');
  const dbMod = require('./credentials/db');
  const result = startupChecks.runAll({
    config,
    cryptoMod,
    getDb: () => dbMod.db(),
    fsMod: fs,
    pathMod: path,
  });
  startupHealth = { checks: result.checks, warnings: result.warnings };
  if (result.fatal) {
    console.error(`[relay-gate] 启动检查未通过：${result.fatal.name} — ${result.fatal.detail}`);
    require('./log/crash').writeEvent({
      tag: 'lifecycle',
      event: 'startup_fatal',
      check: result.fatal.name,
      detail: result.fatal.detail,
    });
    process.exit(1);
  }
  for (const w of result.warnings) console.warn(`[relay-gate] 启动检查告警：${w}`);
} catch (e) {
  // 校验自身出错不应阻断启动，但要留痕且 /health 会体现为无检查项
  console.error(`[relay-gate] 启动检查执行失败：${e.message}`);
  startupHealth = { checks: [], warnings: [`启动检查本身失败：${e.message}`] };
}

listen(config.port, config.host, ['::', '127.0.0.1']);

module.exports = app;
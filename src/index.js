'use strict';
/**
 * relay-gate v3 入口 — 暴露端点转发 API。
 * 分层：routes(薄) → transform(纯函数) → upstream(唯一上游通道) → auth(复用)。
 * 启动：node src/index.js
 */
// 先装全局兜底，再加载业务模块：模块加载期的异常也能被记录，避免静默退出
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

// 转发面与运维快照不是 HTML 文档，带上 CSP 只会干扰客户端处理响应体
const isDocumentRoute = (p) => !p.startsWith('/v1/') && p !== '/status' && p !== '/health';

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (isDocumentRoute(req.path)) res.setHeader('Content-Security-Policy', CSP);
  next();
});

const startT = Date.now();

app.get('/health', (req, res) => {
  const s = status.buildStatus();
  res.json({
    status: 'ok',
    uptime: s.uptimeSec,
    accounts: s.accounts,
    scheduler: s.scheduler.enabled,
    nextCheckinAt: s.scheduler.nextCheckinAt,
    poolStrategy: s.pool.strategy,
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
const rateLimitMw = keyRateLimit();
app.use('/v1/models', authenticateAny, requireKeyScope('models:read'), rateLimitMw);
app.use(models);
app.use(authenticate);
app.use(rateLimitMw);
app.use(openai);
app.use(anthropic);
app.use(responses);

// 兜底 404
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
    scheduler.start();
    // 凭据模块启动初始化（devices 回填；m-38：从 require 期副作用改为显式调用）
    require('./routes/credentials').initCredentials();
    // 余额自动刷新 / 全量备份 / ZCode 奖励定时（独立定时器，配置驱动）
    require('./jobs/balance-refresh').start();
    require('./jobs/backup').start();
    // ZCode 限时套餐探测与领取（默认关闭，需 ZCODE_REWARDS_ENABLED=true）
    require('./jobs/zcode-rewards').start();
    // logs/ 日期目录保留策略（m-29：启动期清理过期日志，LOG_RETENTION_DAYS 可调）
    require('./log/retention').pruneAtStartup(config.ROOT);
    console.log('[relay-gate] periodic jobs started (balance refresh + backup + zcode rewards)');
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
// 启动引导：库内无 Key 时用 API_KEY / WORKBUDDY_API_KEY 建初始转发 Key（可选种子）
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
listen(config.port, config.host, ['::', '127.0.0.1']);

module.exports = app;
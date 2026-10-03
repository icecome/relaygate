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
const adminExtras = require('./routes/admin-extras');
const dashboard = require('./routes/dashboard');
const responses = require('./routes/responses');
const status = require('./routes/status');
const workbuddy = require('./routes/workbuddy');
const catTrip = require('./routes/cat-trip'); // WorkBuddy 成长活动端点（/v1/workbuddy/growth）
const apiKeys = require('./routes/api-keys');
const modelRouterAdmin = require('./routes/model-router');
const adminSecurity = require('./routes/admin-security');
const { keyRateLimit } = require('./middleware/rate-limit');
const { authenticate, authenticateAny } = require('./middleware/auth');
const scheduler = require('./jobs/scheduler');
const apiKeyStore = require('./credentials/api-keys');

const app = express();
app.use(express.json({ limit: '10mb' }));

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
app.use('/v1/admin', adminExtras);
app.use('/v1/admin/model-router', modelRouterAdmin);
app.use('/v1/admin', adminSecurity);
app.use('/v1/api-keys', apiKeys);
// 模型列表双面可用（转发客户端 + 面板）
app.use('/v1/models', authenticateAny);
app.use(models);
app.use(authenticate);
app.use(keyRateLimit());
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
    console.log(`[relay-gate] 管理面板: http://${shown}:${port}/dashboard`);
    console.log(`[relay-gate] 接口地址: http://${shown}:${port}/v1/chat/completions`);
    if (host === '::') {
      console.warn('[relay-gate] 仅绑定 IPv6；请使用 localhost 或 [::1] 访问（127.0.0.1 可能被其他进程占用，如 VMware NAT）。');
    }
    scheduler.start();
    // 余额自动刷新 / 全量备份（独立定时器，配置驱动）
    require('./jobs/balance-refresh').start();
    require('./jobs/backup').start();
    console.log('[relay-gate] periodic jobs started (balance refresh + backup)');
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
// 启动引导：库内无 Key 时用 API_KEY / WORKBUDDY_API_KEY 建初始转发 Key
try {
  const bootstrapped = apiKeyStore.bootstrapFromEnv();
  if (bootstrapped.length) {
    for (const k of bootstrapped) {
      console.log(`[api-keys] bootstrap created platform=${k.platform} label=${k.label} id=${k.id}`);
    }
  }
} catch (e) {
  console.error('[api-keys] bootstrap failed:', e.message);
}
listen(config.port, config.host, ['::', '127.0.0.1']);

module.exports = app;
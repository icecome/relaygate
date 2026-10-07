'use strict';
/**
 * routes/admin-debug.js — 调试与诊断端点：模型探活、一键测试、SSE 事件流、配置热更新。
 * 挂载前缀：/v1/admin（见 index.js）。
 */
const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const pool = require('../credentials/pool');
const { authenticateAdmin } = require('../middleware/auth');

const router = Router();
const admin = (req, res, next) => authenticateAdmin(req, res, next);

/**
 * 按模型 id 前缀选择平台并发起一次最小 chat 调用（probe / test-chat 共用）。
 *
 * wb/ 前缀 → WorkBuddy（wbChat 聚合，OpenAI 兼容 passthrough）；
 * 其余    → Trae（llmUtilsChat 转换层）。
 *
 * edition 必须显式传给 pool.run：其缺省语义是「只选非 workbuddy 账号」，
 * 漏传时 wb 模型会被发给 Trae 上游，上游回 PARAM_INVALID 并被误判成
 * 「模型不可用」写入 7 天状态表（2026-10-06 实际事故的根因）。
 * 返回 { result, accountId }；pool.run 的换号/冷却语义与转发面一致。
 */
async function chatViaPlatform(model, chatBody) {
  if (model.startsWith('wb/')) {
    const auth = require('../auth');
    const wbChat = require('../workbuddy/chat');
    return pool.run(async (id) => {
      const acct = await auth.ensureAuth(id);
      return wbChat.chatAggregate(acct, Object.assign(
        { stream: true },
        chatBody.opts || {},
        { model: model.replace(/^wb\//, ''), messages: chatBody.messages },
      ));
    }, { maxSwitches: 1, edition: 'workbuddy' });
  }
  const { llmUtilsChat } = require('../upstream/client');
  const { normalizeTraeMessages } = require('../transform/request');
  return pool.run((id2) =>
    llmUtilsChat(normalizeTraeMessages(chatBody.messages), model, false, Object.assign({}, chatBody.opts, { accountId: id2 })),
  { maxSwitches: 1, edition: 'trae' });
}

/**
 * 账号平台一致性校验：wb/ 模型必须由 workbuddy 账号服务。
 * 返回 true 表示确认发生了跨平台错路由（pool 选号语义变化 / 新调用点漏传
 * edition），此时上游报错只说明「请求发错了地方」，不是模型结论，禁止写状态表。
 * 非 wb/ 模型或账号不存在时返回 false（不阻断）。
 */
function platformMismatch(model, accountId) {
  if (!model.startsWith('wb/')) return false;
  const acctRec = accountId ? require('../credentials/store').get(accountId) : null;
  if (!acctRec) return false;
  const acctEdition = require('../platform/variant').normalizeEdition(acctRec.edition);
  return acctEdition !== 'workbuddy';
}

/**
 * 模型探活：最小请求打上游（真实调用）。
 *
 * 可用性只以「成功」写表：hasBody=false（HTTP 200 但无内容）不判不可用也不判可用，
 * 留待下次探测。上游异常一律抛错进入 catch 分支按错误类别处理，此处仅剩
 * 「上游行为不符合预期」一种中性情况。
 */
router.post('/models/probe', admin, async (req, res) => {
  const model = String((req.body && req.body.model) || req.query.model || '').trim();
  if (!model) {
    return res.status(400).json({ error: { message: 'model required', type: 'invalid_request_error' } });
  }
  const startedAt = Date.now();
  // accountId 声明在 try 之外：catch 分支要读它做平台一致性判断（块内 let 在 catch 中不可见）
  let accountId = null;

  try {
    let hasBody = false;

    const { result, accountId: pickedId } = await chatViaPlatform(model, {
      messages: [{ role: 'user', content: 'ping' }],
    });
    accountId = pickedId;
    hasBody = !!(result && (result.data || result.body || (Array.isArray(result.choices) && result.choices.length)));

    if (platformMismatch(model, accountId)) {
      return res.status(502).json({
        ok: false,
        model,
        message: `probe aborted: picked account ${accountId} does not serve ${model.startsWith('wb/') ? 'workbuddy' : 'trae'}`,
        durationMs: Date.now() - startedAt,
      });
    }

    // wb/auto 是上游真实模型（Auto 档），探测结论允许落盘；仅裸 'auto' 是网关
    // 本地语义（网关层自动路由），没有对应的上游调用实体，不写状态表。
    if (model !== 'auto') require('../models/availability').markUsable(model);
    res.json({
      ok: true,
      model,
      accountId,
      durationMs: Date.now() - startedAt,
      hasBody,
    });
  } catch (err) {
    if (model !== 'auto') {
      const { isModelConfigError, isPlanLimitError } = require('../upstream/errors');
      // 平台不匹配（跨平台错路由）时上游的报错只说明「请求发错了地方」，
      // 不是模型结论，绝不写入可用性状态表。
      if (!platformMismatch(model, accountId) && (isModelConfigError(err) || isPlanLimitError(err))) {
        require('../models/availability').markUnavailable(model, err.message);
      }
    }
    res.status(502).json({
      ok: false,
      model,
      message: err.message,
      durationMs: Date.now() - startedAt,
    });
  }
});

/** 自定义消息测试某模型（真实调用上游，返回完整响应）。 */
router.post('/test-chat', admin, async (req, res) => {
  const body = req.body || {};
  const model = String(body.model || 'auto').trim();
  const message = String(body.message || 'ping').trim();
  const stream = body.stream === true;
  const maxTokens = Number(body.max_tokens) || 128;

  if (!model || !message) {
    return res.status(400).json({ error: { message: 'model and message required', type: 'invalid_request_error' } });
  }
  const startedAt = Date.now();
  // 与 probe 相同：catch 分支需要 accountId 做平台一致性判断
  let accountId = null;
  try {
    const { result, accountId: pickedId } = await chatViaPlatform(model, {
      messages: [{ role: 'user', content: message }],
      opts: { max_tokens: maxTokens },
    });
    accountId = pickedId;
    if (platformMismatch(model, accountId)) {
      return res.status(502).json({
        ok: false,
        model,
        message: `test-chat aborted: picked account ${accountId} does not serve ${model.startsWith('wb/') ? 'workbuddy' : 'trae'}`,
        durationMs: Date.now() - startedAt,
      });
    }
    if (model !== 'auto') require('../models/availability').markUsable(model);
    // 从非流式聚合结果中提取文本
    const choice = result && result.choices && result.choices[0];
    const content = choice && choice.message ? (choice.message.content || '') : '';
    const usage = result && result.usage ? result.usage : null;
    res.json({
      ok: true,
      model,
      accountId,
      durationMs: Date.now() - startedAt,
      content,
      usage,
      finishReason: choice ? choice.finish_reason : null,
    });
  } catch (err) {
    if (model !== 'auto') {
      const { isModelConfigError, isPlanLimitError, isModelRateLimitError } = require('../upstream/errors');
      // 平台不匹配（跨平台错路由）时上游的报错不是模型结论，绝不写入状态表。
      // 模型级限流同理：6004 说明模型当前被打满而非不可用，标记 unavailable
      // 会在面板上把「稍后重试」误显示成「不可用」。
      if (!platformMismatch(model, accountId)
        && (isModelConfigError(err) || isPlanLimitError(err))) {
        require('../models/availability').markUnavailable(model, err.message);
      }
    }
    res.status(502).json({
      ok: false,
      model,
      message: err.message,
      durationMs: Date.now() - startedAt,
    });
  }
});

/** ===== SSE 调试模式 ===== */

const SSE_DEBUG_ENABLED = () => process.env.TRAE_DEBUG_SSE === 'true';
const SSE_DEBUG_DIR = () => path.join(config.ROOT, 'logs', new Date().toISOString().slice(0, 10));
const SSE_DEBUG_FILE = () => path.join(SSE_DEBUG_DIR(), 'sse-debug.jsonl');

/** SSE 调试状态。 */
router.get('/debug/sse/status', admin, (req, res) => {
  res.json({ object: 'sse_debug_status', enabled: SSE_DEBUG_ENABLED() });
});

/** 查询某请求/某天的 SSE 事件流。 */
router.get('/debug/sse', admin, (req, res) => {
  if (!SSE_DEBUG_ENABLED()) {
    return res.json({ object: 'list', enabled: false, data: [], hint: 'SSE 调试未开启，设置 TRAE_DEBUG_SSE=true 并重启后生效' });
  }
  const days = Math.min(Math.max(parseInt(req.query.days || '1', 10) || 1, 1), 7);
  const requestId = req.query.request_id ? String(req.query.request_id) : null;
  const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10) || 200, 1), 1000);

  const rows = [];
  const base = path.join(config.ROOT, 'logs');
  for (let d = 0; d < days; d++) {
    const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    const file = path.join(base, day, 'sse-debug.jsonl');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (requestId && r.requestId !== requestId) continue;
        rows.push(r);
      } catch { /* skip bad line */ }
    }
  }
  rows.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const total = rows.length;
  res.json({ object: 'list', enabled: true, total, data: rows.slice(0, limit) });
});

/** ===== 配置热更新 ===== */

/** 查看当前生效的关键配置。 */
router.get('/config', admin, (req, res) => {
  res.json({
    object: 'runtime_config',
    port: config.port,
    host: config.host,
    poolStrategy: config.poolStrategy,
    maxInFlightPerAccount: config.maxInFlightPerAccount,
    minBalanceToUse: config.minBalanceToUse,
    ratePaceMs: config.ratePaceMs,
    rateWindowMs: config.rateWindowMs,
    rateWindowMax: config.rateWindowMax,
    rateCooldownMs: config.rateCooldownMs,
    schedulerEnabled: config.schedulerEnabled,
    checkinHour: config.checkinHour,
    checkinMinute: config.checkinMinute,
    keepaliveHour: config.keepaliveHour,
    tokenRefreshLeadHours: config.tokenRefreshLeadHours,
    modelProbeIntervalHours: config.modelProbeIntervalHours,
    upstreamFunction: config.upstreamFunction || null,
    upstreamChatPath: config.upstreamChatPath,
    toolProtocol: config.toolProtocol,
    maxRetries: config.maxRetries,
    retryBaseDelay: config.retryBaseDelay,
    requestTimeoutMs: config.requestTimeoutMs,
    statusPublic: config.statusPublic,
    // K-1 后语义 = 「管理域已配置」（DB 登录密钥或 env ADMIN_KEY）
    adminSeparated: require('../credentials/api-keys').hasLoginKey() || !!config.adminKey,
  });
});

/** 重新加载 model-config.json / model-fallback.json / .env 关键项。 */
router.post('/config/reload', admin, (req, res) => {
  try {
    const before = {
      modelCount: Object.keys(config.modelConfig.models || {}).length,
      poolStrategy: config.poolStrategy,
    };
    config.reload();
    const after = {
      modelCount: Object.keys(config.modelConfig.models || {}).length,
      poolStrategy: config.poolStrategy,
    };
    res.json({ object: 'config_reload', ok: true, before, after, reloadedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

module.exports = router;

// 仅测试可见：helper 不进入 Express 路由表，测试通过桩 pool.run / store 验证
// 「平台声明与用号一致」这一根因约束（见 test/unit.test.js 回归用例）。
module.exports.__test = { chatViaPlatform, platformMismatch };
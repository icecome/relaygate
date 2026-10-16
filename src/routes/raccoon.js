'use strict';
/**
 * routes/raccoon.js —— Raccoon（商汤小浣熊）运营面 + 对话转发。
 * 挂载前缀：/v1/raccoon（见 index.js）。
 *
 * 两类端点，鉴权方式不同（与 routes/qoder.js 同构）：
 *   - 运营面（/status、/login/*、/accounts*、/models）：管理鉴权（authenticateAdmin）；
 *   - 对话转发（/chat/completions）：转发面鉴权（authenticate + keyRateLimit）。
 *     挂在 /v1/raccoon 下而不是并入 /v1/chat/completions，是为了让「Raccoon 是
 *     独立账号池、不进 Trae 转发池」这件事在路由层就成立，不必在分派里加判断。
 *
 * ## 对话面边界（2026-10 实测，见 docs/raccoon-integration.md）
 *
 *   - `POST /api/web/llm/v2/chat/completions` 是**标准 OpenAI 兼容 + 标准 SSE**
 *     （`chat.completion.chunk` + `data: [DONE]`），故这里**逐字透传**，
 *     不做任何协议改写（对比 ZCode 那条 Anthropic Messages 通道）。
 *   - `tools` 必须留在请求体顶层（参考项目里 Qoder 与 TRAE 都因漏发而让模型
 *     在正文里臆造 XML 工具调用）——这里不裁剪任何字段。
 *   - **不做图片缩放**：参考项目有一套按「请求体字节」目标的缩放链路
 *     （上游对请求体总量卡 10MB）。本实现原图直发，超限时上游回 413，
 *     错误如实透传；现状记入 docs/known-limitations.md。
 *   - 上游没有任何「身份块」准入要求（那是 ZCode 的 3012 判据），
 *     故这里不需要构造 system 身份块，也不改调用方的 system。
 */
const { Router } = require('express');
const store = require('../credentials/store');
const variant = require('../platform/variant');
const auth = require('../raccoon/auth');
const credits = require('../raccoon/credits');
const chat = require('../raccoon/chat');
const product = require('../raccoon/product');
const localClient = require('../raccoon/local');
const qr = require('../lib/qr');
const { authenticateAdmin, authenticate } = require('../middleware/auth');
const { keyRateLimit } = require('../middleware/rate-limit');
const { logRequest, usageToLogFields } = require('../log/traffic');
const { estimateCost } = require('../models/rates');
const { createLineFeeder } = require('../lib/sse-lines');
const { canUseModel, isRaccoonOnlyModel } = require('../middleware/model-access');

const router = Router();
const admin = (req, res, next) => authenticateAdmin(req, res, next);

const V = variant.variantOf(variant.RACCOON);

/** 账号出参脱敏（token/refreshToken 不出网）。 */
function redact(acct) {
  const { token, refreshToken, ...rest } = acct || {};
  return {
    ...rest,
    hasToken: !!token,
    hasRefreshToken: !!refreshToken,
  };
}

/** 积分快照摘要（供面板；**不是**积分口径本身，见 credits.js 的口径说明）。 */
function pointsSummary(acct) {
  const snap = acct.entitlementSnapshot || {};
  const p = snap.raccoonPoints || {};
  return {
    available: typeof p.available === 'number' ? p.available : null,
    packages: Array.isArray(p.packages) ? p.packages : [],
    updatedAt: p.updatedAt || null,
  };
}

/** 取 Raccoon 账号；非本平台账号返回 400。 */
function getRaccoonAccount(res, id, action = '操作') {
  const acct = store.get(id);
  if (!acct) {
    res.status(404).json({ error: { message: 'account not found', type: 'invalid_request_error' } });
    return null;
  }
  if (!variant.isEdition(acct.edition, variant.RACCOON)) {
    res.status(400).json({ error: { message: `not a raccoon account，已跳过${action}`, type: 'invalid_request_error' } });
    return null;
  }
  return acct;
}

// ---- 状态 ----

/**
 * 平台能力 + 账号统计 + 登录方式。
 *
 * ⚠️ 这里如实声明 `checkin: false`：Raccoon **没有签到端点**，每日 300 积分由
 * 服务端按日自动发放。若把它做成签到按钮，按钮必然失败（见 variant.js 的注释）。
 * 2026-10-15 对本机客户端 app.asar 的**全量端点穷举**（1597 处 URL 拼接）
 * 再次证实：`points/v1` 下只有 `balance` 与 `bills` 两个路径，全仓没有任何
 * daily / checkin / sign_in / claim / tasks 形态的发放端点。
 */
router.get('/status', admin, (_req, res) => {
  const list = store.list().filter((a) => variant.isEdition(a.edition, variant.RACCOON));
  res.json({
    platform: { id: V.id, label: V.label, capability: V.capability },
    accounts: {
      total: list.length,
      enabled: list.filter((a) => a.enabled).length,
    },
    chat: {
      endpoint: '/v1/raccoon/chat/completions',
      // 独立账号池：不进 Trae 转发池（pool.editionOk 的默认分支只取 Trae 系）
      inPool: false,
      modelsEndpoint: '/v1/raccoon/models',
    },
    login: {
      // 面板承载登录：不需要本机装客户端
      mode: 'qrcode',
      pollIntervalMs: product.QR_POLL_INTERVAL_MS,
      timeoutMs: product.LOGIN_TIMEOUT_MS,
      // 短信路径需要阿里云滑块，本实现**未提供**（见 docs 的边界说明）
      smsAvailable: false,
      // 第二条入口：本机桌面端凭据是**明文** auth.json，可直接导入
      localImport: true,
      localImportEndpoints: ['/v1/raccoon/local/preview', '/v1/raccoon/local/import'],
    },
    dailyPoints: {
      // 每日 300 由服务端自动发放，**没有可调用端点**，故面板不放签到按钮。
      // 但能观测：账单里 biz_type=daily_grant（+300）与 daily_expire（未用尽
      // 清零）两条记录，配合 balance 的 daily_points 池可算出「今天还剩多少、
      // 什么时候作废」—— 见 /daily-usage。
      claimable: false,
      grant: 'server-side',
      observedPoints: product.DAILY_GRANT_POINTS,
    },
  });
});

/**
 * 每日积分消耗看板（**只读**，把「自动发放」变成可运营的信息）。
 *
 * 为什么值得做：每日 300 不能领（无端点），但它**会过期**。实测账单里
 * `daily_grant` 带 `grant_at`/`expire_at`，未用尽的部分由 `daily_expire`
 * 清零 —— 即「每天 300，7 天内不烧完就作废」。用户真正想知道的是
 * 「今天还剩多少 / 什么时候作废」，而不是一个必然失败的签到按钮。
 *
 * 数据来源全部是已实证的只读端点：`points/v1/balance` 与
 * `points/v1/bills?type=income|expense`。不触碰任何写端点。
 */
router.get('/accounts/:id/daily-usage', admin, async (req, res) => {
  const acct = getRaccoonAccount(res, req.params.id, '查询每日积分');
  if (!acct) return;
  try {
    const usage = await credits.fetchDailyUsage(acct);
    res.json({ object: 'raccoon.dailyUsage', accountId: acct.id, ...usage });
  } catch (e) {
    res.status(502).json({ error: { message: e.message, type: 'raccoon_upstream_error' } });
  }
});

// ---- 扫码登录 ----

/**
 * 开启一次扫码登录会话。
 *
 * 返回的 `qr` 是**直接可渲染的 SVG path**（`{size, dim, margin, path}`），
 * 面板用 `<svg viewBox="0 0 dim dim"><path d={path}/></svg>` 画出来即可 ——
 * 不需要第三方二维码图片服务（那等于把一次性登录票据送给第三方），
 * 也不需要 `dangerouslySetInnerHTML`（只传一个属性字符串，无注入面）。
 */
router.post('/login/session', admin, (_req, res) => {
  try {
    const s = auth.startLoginSession();
    const shape = qr.renderQrPath(s.qrUrl);
    res.status(201).json({
      sessionId: s.sessionId,
      /** 二维码承载的公开登录页 URL（供「在浏览器里打开」的兜底入口） */
      qrUrl: s.qrUrl,
      qr: shape,
      expiresAtMs: s.expiresAtMs,
      pollIntervalMs: s.pollIntervalMs,
      hint: '用微信「扫一扫」扫描二维码，在微信内完成授权后本页会自动进入下一步',
    });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 轮询一次扫码状态。成功时账号已落库，返回 account。 */
router.get('/login/session/:id', admin, async (req, res) => {
  try {
    const r = await auth.pollLoginSession(req.params.id);
    if (r.status === 'expired') {
      return res.status(404).json({ error: { message: '登录会话不存在或已过期，请重新发起', type: 'not_found' } });
    }
    if (r.status === 'success' && r.account) {
      return res.json({ status: r.status, account: redact(r.account) });
    }
    return res.json({ status: r.status, ...(r.expiredAt ? { expiredAt: r.expiredAt } : {}) });
  } catch (e) {
    // 轮询失败不该让面板中断：返回 pending 让它继续轮询，原因写进 detail
    return res.json({ status: 'pending', detail: e.message });
  }
});

/** 取消登录会话（用户关闭弹窗）。 */
router.delete('/login/session/:id', admin, (req, res) => {
  res.json({ ok: auth.cancelLoginSession(req.params.id) });
});

// ---- 账号 ----

/** 列出 Raccoon 账号（含积分快照摘要）。 */
router.get('/accounts', admin, (_req, res) => {
  const data = store.list()
    .filter((a) => variant.isEdition(a.edition, variant.RACCOON))
    .map((a) => ({ ...redact(a), points: pointsSummary(a) }));
  res.json({ object: 'list', data });
});

/** 删除 Raccoon 账号。 */
router.delete('/accounts/:id', admin, (req, res) => {
  const acct = getRaccoonAccount(res, req.params.id, '删除');
  if (!acct) return;
  res.json({ ok: store.remove(acct.id) });
});

/** 刷新积分余额（只读端点，写回 balance 与隔离的 raccoonPoints 快照）。 */
router.post('/accounts/:id/balance', admin, async (req, res) => {
  const acct = getRaccoonAccount(res, req.params.id, '查询积分');
  if (!acct) return;
  try {
    const updated = await credits.refreshBalance(acct);
    res.json({ object: 'raccoon.balance', account: redact(updated), points: pointsSummary(updated) });
  } catch (e) {
    res.status(502).json({ error: { message: e.message, type: 'raccoon_upstream_error' } });
  }
});

/**
 * 领取「桌面端登录奖励」（一次性，幂等）。
 *
 * ⚠️ **不是签到**：该端点每号只能领一次，重复领取返回 already。
 * 每日 300 积分没有端点，不要在这里假装能领。
 */
router.post('/accounts/:id/reward', admin, async (req, res) => {
  const acct = getRaccoonAccount(res, req.params.id, '领取登录奖励');
  if (!acct) return;
  const r = await credits.claimLoginReward(acct);
  if (r.result === 'claimed') {
    try {
      const prev = acct.entitlementSnapshot && typeof acct.entitlementSnapshot === 'object' ? acct.entitlementSnapshot : {};
      store.update(acct.id, {
        lastCheckinAt: new Date().toISOString(),
        lastCheckinResult: 'reward_claimed',
        entitlementSnapshot: { ...prev, lastClaimAt: new Date().toISOString(), lastClaimAmount: r.points },
      });
    } catch { /* 快照失败不影响响应 */ }
  }
  res.json({ object: 'raccoon.reward', accountId: acct.id, ...r });
});

/** 查询登录奖励是否已领（读账单明细，服务端没有单独的状态端点）。 */
router.get('/accounts/:id/reward', admin, async (req, res) => {
  const acct = getRaccoonAccount(res, req.params.id, '查询登录奖励');
  if (!acct) return;
  const r = await credits.fetchOnboardingStatus(acct);
  res.json({ object: 'raccoon.reward.status', accountId: acct.id, ...r });
});

/** 强制续期（凭据过期、或刷新后想立刻验证时用）。 */
router.post('/accounts/:id/refresh', admin, async (req, res) => {
  const acct = getRaccoonAccount(res, req.params.id, '续期');
  if (!acct) return;
  try {
    const updated = await auth.refreshAccount(acct);
    res.json({ object: 'raccoon.refresh', account: redact(updated) });
  } catch (e) {
    const status = e.needsRelogin ? 401 : 502;
    res.status(status).json({ error: { message: e.message, type: e.needsRelogin ? 'needs_relogin' : 'raccoon_upstream_error' } });
  }
});

// ---- 本机客户端导入 ----

/**
 * 预检本机小浣熊桌面端的凭据（只读，不入库、不打上游写端点）。
 *
 * 与 routes/zcode.js 的 `/local/preview` 同构：**没装客户端时也返回 200**
 * （`installed:false`），让面板能正常渲染这张卡，而不是弹一个错误。
 */
router.get('/local/preview', admin, (_req, res) => {
  const p = localClient.preview();
  res.json({
    object: 'raccoon.local.preview',
    installed: p.installed,
    path: p.path,
    credentialFile: p.credentialFile,
    error: p.error,
    ...(p.installed ? {
      account: {
        userId: p.userId,
        hasToken: true,
        hasRefreshToken: p.hasRefreshToken,
        expiresAt: p.expiresAt,
        officeIdentity: p.officeIdentity,
      },
    } : {}),
  });
});

/**
 * 从本机客户端凭据导入（幂等：同 user_info.id 更新而非重复插入）。
 *
 * 复用 `auth.persistLogin` —— 导入与扫码两条入口必须产出同形状的账号记录，
 * 否则同一微信账号会在池里出现两次（label 与 userId 判据不一致所致）。
 */
router.post('/local/import', admin, async (_req, res) => {
  try {
    const saved = await localClient.importFromLocal();
    res.json({ object: 'raccoon.local.import', ok: true, account: redact(saved) });
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: { message: e.message, type: 'local_import_error' },
    });
  }
});

// ---- 模型目录 ----

/**
 * 模型目录。优先拉远端（含真实倍率与窗口），失败回退兜底表并在 `source` 里
 * 如实说明 —— 面板据此提示「倍率可能不是最新」，而不是假装拿到了。
 */
router.get('/models', admin, async (_req, res) => {
  const acct = pickAccount();
  if (!acct) {
    return res.json({
      object: 'list',
      source: 'fallback',
      reason: '没有已启用的 Raccoon 账号，远端目录需要登录态',
      data: product.fallbackCatalog(),
    });
  }
  const r = await auth.fetchModelCatalog(acct);
  res.json({ object: 'list', source: r.source, data: r.models });
});

// ---- 对话转发 ----

/** 转发面错误响应（与 routes/openai.js 的 error 信封一致）。 */
function chatError(res, status, message, code) {
  return res.status(status).json({
    error: { message, type: status === 429 ? 'rate_limit_error' : 'upstream_error', ...(code ? { code } : {}) },
  });
}

/**
 * 选一个可用的 Raccoon 账号。
 *
 * 本期单账号：取第一个 enabled 的账号（与 Qoder 同策略）。刻意不做轮询/择优——
 * 上游并发与限额阈值未验证，贸然轮询会把号打挂。
 *
 * 注意 store.list() 会剥离 token（safeTok），所以这里只能用 enabled 过滤，
 * 凭据的存在性由后续请求的报错兜底；最后必须 store.get() 取全量。
 */
function pickAccount() {
  const candidate = store.list()
    .filter((a) => a.enabled && variant.isEdition(a.edition, variant.RACCOON))
    .sort((x, y) => (x.lastPickedAt || 0) - (y.lastPickedAt || 0))[0];
  return candidate ? store.get(candidate.id) : null;
}

router.post('/chat/completions', authenticate, keyRateLimit(), async (req, res) => {
  const body = req.body || {};
  const { model = '', messages, stream = true } = body;
  const startedAt = Date.now();
  let requestError = null;
  let lastUsage = null;
  let usedAccountId = null;
  const reqTools = Array.isArray(body.tools) && body.tools.length ? body.tools : null;

  if (!Array.isArray(messages) || messages.length === 0) {
    return chatError(res, 400, 'messages is required', 'invalid_request_error');
  }

  // 端点只服务 Raccoon 模型（命名空间前缀 `sn-`，与 model-access 的平台收口同一判据）。
  //
  // 不加这道闸的话，把一个 Trae 模型发到这里会一路走到「没有可用的 Raccoon 账号」
  // 的 503 —— 那是误导：真正的问题是调错了端点，而不是缺账号。
  // 代价：若上游将来上架不在 `sn-` 命名空间里的模型，这里与 model-access 都要同步；
  // 但那种情况会得到一条明确的 400，而不是被静默路由到别家上游。
  if (!isRaccoonOnlyModel(model)) {
    logRequest({
      endpoint: '/v1/raccoon/chat/completions', method: 'POST', model,
      account: null, status: 400, toolCalls: 0, toolsIn: reqTools ? reqTools.length : 0,
      durationMs: Date.now() - startedAt, error: 'not a raccoon model', platform: 'raccoon',
    });
    return chatError(
      res, 400,
      `model "${model}" is not a Raccoon model. 本端点只服务 Raccoon 模型（id 以 sn- 开头）；其它模型请调用 /v1/chat/completions。`,
      'INVALID_MODEL',
    );
  }

  const access = canUseModel(req.platform, model, req.authKey || null);
  if (!access.ok) {
    logRequest({
      endpoint: '/v1/raccoon/chat/completions', method: 'POST', model,
      account: null, status: 403, toolCalls: 0, toolsIn: reqTools ? reqTools.length : 0,
      durationMs: 0, error: access.message, platform: 'raccoon',
    });
    return chatError(res, 403, access.message, 'MODEL_ACCESS_DENIED');
  }

  let acct = pickAccount();
  if (!acct) {
    logRequest({
      endpoint: '/v1/raccoon/chat/completions', method: 'POST', model,
      account: null, status: 503, toolCalls: 0, toolsIn: reqTools ? reqTools.length : 0,
      durationMs: Date.now() - startedAt, error: 'no enabled raccoon account', platform: 'raccoon',
    });
    return chatError(res, 503,
      '没有可用的 Raccoon 账号。请在「凭据池 → 渠道接入 → Raccoon」用微信扫码登录。',
      'NO_RACCOON_ACCOUNT');
  }

  // 凭据过期则先续期一次（不在上游请求里重试，避免重复计费）
  if (product.isExpired({
    access_token: acct.token, refresh_token: acct.refreshToken,
    expires_at: acct.expiredAt ? String(new Date(acct.expiredAt).getTime()) : undefined,
  })) {
    try {
      acct = await auth.refreshAccount(acct);
    } catch (e) {
      return chatError(res, 401, `Raccoon 凭据已过期且续期失败：${e.message}`, 'AUTH');
    }
  }

  usedAccountId = acct.id;
  store.update(acct.id, { lastPickedAt: Date.now() });

  // 逐字透传调用方字段（只补 extra_body.thinking），不做白名单裁剪 ——
  // 裁剪的代价是丢字段（tools 一旦丢了模型就会在正文里臆造工具调用）。
  const upBody = chat.buildUpstreamBody({ ...body, model, stream: stream !== false });

  try {
    if (stream !== false) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const up = await chat.chatStream(acct, upBody);
      const reader = up.body.getReader();
      const dec = new TextDecoder();
      // 旁路窥探 usage：不影响转发给客户端的字节（上游 usage 在 [DONE] 前一帧）
      const feeder = createLineFeeder((line) => {
        const t = line.trim();
        if (!t.startsWith('data:')) return;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        try {
          const ev = JSON.parse(payload);
          if (ev && ev.usage && (ev.usage.prompt_tokens || ev.usage.completion_tokens || ev.usage.total_tokens)) {
            lastUsage = ev.usage;
          }
        } catch { /* 非 JSON 帧忽略 */ }
      });
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true });
        feeder.feed(text);
        if (text && !res.writableEnded) res.write(text);
      }
      feeder.flush();
      if (!res.writableEnded) res.end();
    } else {
      const data = await chat.chatNonStream(acct, upBody);
      lastUsage = data && data.usage;
      return res.json(data);
    }
  } catch (err) {
    requestError = err.message;
    if (!res.writableEnded) {
      if (res.headersSent) {
        // SSE 头已下发：补错误帧后结束，避免 ERR_HTTP_HEADERS_SENT
        try {
          res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'upstream_error' } })}\n\n`);
          res.write('data: [DONE]\n\n');
        } catch { /* 客户端已断开 */ }
        res.end();
      } else {
        const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
        chatError(res, status, err.message, err.code || undefined);
      }
    }
  } finally {
    const usageFields = usageToLogFields(lastUsage);
    const cost = usageFields.totalTokens
      ? estimateCost(model, usageFields.promptTokens, usageFields.completionTokens, {
        cacheRead: Number(usageFields.cacheReadTokens) || 0,
        platform: 'raccoon',
      })
      : null;
    logRequest({
      endpoint: '/v1/raccoon/chat/completions', method: 'POST', model,
      account: usedAccountId,
      status: requestError ? 502 : 200,
      toolCalls: 0, toolsIn: reqTools ? reqTools.length : 0,
      durationMs: Date.now() - startedAt,
      error: requestError,
      platform: 'raccoon',
      pricedModel: model,
      routedTo: `raccoon/${model}`,
      ...usageFields,
      ...(cost != null ? { estimatedCost: cost } : {}),
    });
  }
});

module.exports = router;

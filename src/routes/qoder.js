'use strict';
/**
 * routes/qoder.js — Qoder 运营面端点 + 国际版对话转发。
 * 挂载前缀：/v1/qoder（见 index.js）。
 *
 * 两类端点，鉴权方式不同：
 *   - 运营面（/status、/accounts、/local/*、/campaigns、/quota、/claim、/run、
 *     /settings、/models）：管理鉴权（authenticateAdmin）。
 *   - 对话转发（/chat/completions）：转发面鉴权（authenticate + keyRateLimit），
 *     与 /v1/chat/completions 同构。它挂在 /v1/qoder 下是为了让「按模型名前缀
 *     分流到 Qoder」在 routes/openai.js 里只需一处判断，不必为它单独挂根路径。
 *
 * 对话转发边界（2026-10-13 实证）：
 *   - 仅国际版：api2-v2.qoder.sh/model/v1/chat/completions，纯 Bearer，OpenAI 兼容。
 *   - 国内版 /model/v1/* 实测 503，需 COSY 老协议（未实现），显式 400 拒绝。
 *   - 上游不返回结构化 tool_calls：传 tools 后模型把调用写成普通文本。
 *     本模块不做文本→tool_calls 启发式改写（那是猜测，误判会让 agent 执行
 *     一个并未发生的调用）。需要工具调用的客户端请用 Trae/WorkBuddy 池。
 *   - 模型可调用性以 src/qoder/chat.js 的 CALLABLE_INTL_MODELS 实测清单为准；
 *     is_free=true 不代表可调用（qfmodel 实测 invalid_model_error）。
 *
 * 账号选取：本期单账号——取第一个 enabled 的国际版账号。
 * 多账号负载均衡未做：上游并发与风控阈值未验证，贸然轮询会把号打挂。
 */
const { Router } = require('express');
const store = require('../credentials/store');
const variant = require('../platform/variant');
const rewards = require('../qoder/rewards');
const catalog = require('../qoder/catalog');
const chat = require('../qoder/chat');
const localClient = require('../qoder/local');
const qoderJobs = require('../jobs/qoder-rewards');
const { authenticateAdmin, authenticate } = require('../middleware/auth');
const { logRequest, usageToLogFields } = require('../log/traffic');
const { estimateCost } = require('../models/rates');
const { createLineFeeder } = require('../lib/sse-lines');
const { canUseModel } = require('../middleware/model-access');
const sticky = require('../session/sticky');

const router = Router();
const admin = (req, res, next) => authenticateAdmin(req, res, next);

const V = variant.variantOf(variant.QODER);

/** 账号出参脱敏（token/refreshToken 不出网）。 */
function redact(acct) {
  const { token, refreshToken, apiKey, ...rest } = acct || {};
  return {
    ...rest,
    realm: variant.qoderRealmOfAccount(acct),
    hasToken: !!token,
    hasRefreshToken: !!refreshToken,
  };
}

/** 取 Qoder 账号；非 Qoder 账号返回 400。 */
function getQoderAccount(res, id, action = '操作') {
  const acct = store.get(id);
  if (!acct) {
    res.status(404).json({ error: { message: 'account not found', type: 'invalid_request_error' } });
    return null;
  }
  if (!variant.isEdition(acct.edition, variant.QODER)) {
    res.status(400).json({ error: { message: `not a qoder account，已跳过${action}`, type: 'invalid_request_error' } });
    return null;
  }
  return acct;
}

// ---- 状态 ----

/** 平台能力 + 定时任务状态 + 本机客户端探测。 */
router.get('/status', admin, (req, res) => {
  res.json({
    platform: {
      id: V.id,
      label: V.label,
      capability: V.capability,
      realms: {
        cn: { openapi: variant.qoderOpenapiBase('cn'), chatProtocol: variant.qoderRealmConfig('cn').chatProtocol },
        intl: { openapi: variant.qoderOpenapiBase('intl'), chatProtocol: variant.qoderRealmConfig('intl').chatProtocol },
      },
      // 对话转发实况：capability.chat=true 只说明平台级能力已开，
      // 真正能否转发还要看 realm 白名单与是否有启用账号。
      chat: {
        realms: variant.qoderChatRealms(),
        endpoint: '/v1/qoder/chat/completions',
        models: chat.CALLABLE_INTL_MODELS,
        // list() 剥离 token，故只按 enabled + realm 白名单统计；
        // 单个账号是否真有可用 token 由转发时 blockReason 判定。
        accounts: store.list().filter((a) => a.enabled
          && variant.isEdition(a.edition, variant.QODER)
          && variant.qoderChatRealms().includes(variant.qoderRealmOfAccount(a)))
          .map((a) => ({ id: a.id, label: a.label, realm: variant.qoderRealmOfAccount(a) })),
        // 上游不支持结构化 tool_calls：传 tools 后模型把调用写成普通文本
        toolCalls: false,
      },
    },
    jobs: qoderJobs.snapshot(),
    localClient: qoderJobs.localClientStatus(),
  });
});

// ---- 账号 ----

/** 列出 Qoder 账号（含积分与奖励摘要）。 */
router.get('/accounts', admin, (req, res) => {
  const list = store.list()
    .filter((a) => variant.isEdition(a.edition, variant.QODER))
    .map((a) => ({ ...redact(a), rewards: rewardSummary(a) }));
  res.json({ object: 'list', data: list });
});

/** 删除 Qoder 账号。 */
router.delete('/accounts/:id', admin, (req, res) => {
  const acct = store.get(req.params.id);
  if (!acct) return res.status(404).json({ error: { message: 'account not found', type: 'invalid_request_error' } });
  if (!variant.isEdition(acct.edition, variant.QODER)) {
    return res.status(400).json({ error: { message: 'not a qoder account', type: 'invalid_request_error' } });
  }
  const ok = store.remove(req.params.id);
  res.json({ ok });
});

/** 账号摘要（积分快照 + 最近一次活动探测）。 */
function rewardSummary(acct) {
  const snap = acct.entitlementSnapshot || {};
  return {
    lastProbeAt: snap.lastProbeAt || null,
    lastClaimAt: snap.lastClaimAt || null,
    lastClaimCampaign: snap.lastClaimCampaign || null,
    lastClaimAmount: snap.lastClaimAmount != null ? snap.lastClaimAmount : null,
    lastClaimExpiresAt: snap.lastClaimExpiresAt || null,
    lastClaimGrantId: snap.lastClaimGrantId || null,
    quota: snap.quota || null,
    claimable: snap.claimable || [],
  };
}

// ---- 本机导入 ----

/** 预检本机客户端（双区域探测，不解密全文）。 */
router.get('/local/preview', admin, (req, res) => {
  const probe = localClient.probeAll();
  const out = { windows: probe.windows, realms: {} };
  for (const realm of ['cn', 'intl']) {
    const p = probe[realm];
    out.realms[realm] = {
      installed: p.installed,
      appDir: p.appDir,
      clientVersion: p.clientVersion,
      loggedIn: p.loggedIn,
      error: p.error || null,
      // 有凭据时才回显账号标识（uid + 名称），不回显 token
      userId: p.credentials ? p.credentials.userId : null,
      userName: p.credentials ? p.credentials.userName : null,
      userEmail: p.credentials ? p.credentials.userEmail : null,
      expiresAt: p.credentials ? p.credentials.expiresAt : null,
    };
  }
  res.json(out);
});

/** 导入本机已登录的全部区域账号（幂等：同 realm+uid 更新）。 */
router.post('/local/import', admin, (req, res) => {
  try {
    const out = localClient.importAllLocal();
    const total = out.created.length + out.updated.length;
    res.json({
      ok: true,
      created: out.created,
      updated: out.updated,
      skipped: out.skipped,
      message: total
        ? `导入完成：新增 ${out.created.length}，更新 ${out.updated.length}`
        : '未导入任何账号（请确认客户端已安装并登录）',
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: { message: e.message, type: 'local_import_error' } });
  }
});

/** 导入指定区域的账号。 */
router.post('/local/import/:realm', admin, (req, res) => {
  const realm = variant.qoderRealm(req.params.realm);
  try {
    const acct = localClient.buildAccountFromLocal(realm);
    const existing = store.list().find((a) => variant.isEdition(a.edition, variant.QODER)
      && variant.qoderRealmOfAccount(a) === realm
      && a.userId && acct.userId && String(a.userId) === String(acct.userId));
    const saved = existing
      ? store.update(existing.id, { ...acct, lastCheckinResult: 'local_import_updated' })
      : store.add(acct, 'local');
    res.json({ ok: true, account: redact(saved), action: existing ? 'updated' : 'created' });
  } catch (e) {
    res.status(502).json({ ok: false, error: { message: e.message, type: 'local_import_error' } });
  }
});

// ---- 积分活动 / 额度 ----

/** 查询账号的积分活动列表。 */
router.get('/accounts/:id/campaigns', admin, async (req, res) => {
  const acct = getQoderAccount(res, req.params.id, '查询活动');
  if (!acct) return;
  try {
    const c = await rewards.fetchCampaigns(acct);
    res.json({
      object: 'qoder.campaigns',
      accountId: acct.id,
      realm: variant.qoderRealmOfAccount(acct),
      showCampaign: c.showCampaign,
      claimable: c.claimable,
      campaigns: c.campaigns,
      claimableCampaigns: c.claimableCampaigns,
    });
  } catch (e) {
    res.status(502).json({ error: { message: e.message, type: 'qoder_upstream_error' } });
  }
});

/** 查询账号积分额度（两段隔离展示）。 */
router.get('/accounts/:id/quota', admin, async (req, res) => {
  const acct = getQoderAccount(res, req.params.id, '查询额度');
  if (!acct) return;
  try {
    const q = await rewards.fetchQuota(acct);
    res.json({ object: 'qoder.quota', accountId: acct.id, realm: variant.qoderRealmOfAccount(acct), ...q });
  } catch (e) {
    res.status(502).json({ error: { message: e.message, type: 'qoder_upstream_error' } });
  }
});

/**
 * 领取账号的积分活动。
 * body: { campaignId? } 缺省自动挑第一个可领的积分活动。
 *
 * 无 CLAIMABLE 项时区分两种情况（否则面板只会显示「没有可领活动」，
 * 而用户明明刚领过，无法判断是「今日已领」还是「真没有」）：
 *   - 当日积分活动已是 CLAIMED  → result='already_today'
 *   - 上游返回空活动列表       → result='no_campaign'
 */
router.post('/accounts/:id/claim', admin, async (req, res) => {
  const acct = getQoderAccount(res, req.params.id, '领取');
  if (!acct) return;
  try {
    const r = await rewards.claimCampaign(acct, req.body && req.body.campaignId);
    if (r.result === 'skipped') {
      // 说明「为什么跳过」：今日已领 vs 上游无活动
      const campaigns = await rewards.fetchCampaigns(acct);
      const claimedToday = campaigns.campaigns.filter(
        (c) => c.actionType === 'CLAIM_BENEFIT' && c.kind.toUpperCase() === 'CREDITS' && c.claimStatus === 'CLAIMED',
      );
      store.update(acct.id, {
        lastCheckinAt: new Date().toISOString(),
        lastCheckinResult: claimedToday.length ? 'already_today' : 'no_campaign',
      });
      return res.json({
        object: 'qoder.claim',
        accountId: acct.id,
        result: claimedToday.length ? 'already_today' : 'no_campaign',
        campaignId: '',
        campaignKey: claimedToday.length ? claimedToday[0].campaignKey : '',
        amount: claimedToday.length ? claimedToday[0].amount : 0,
        grantId: null,
        expiresAt: null,
        replayed: false,
        message: claimedToday.length
          ? `今日积分已领取（${claimedToday[0].campaignKey}，+${claimedToday[0].amount}），下次刷新为 UTC+8 明日 10:00`
          : '上游当前没有可领取的积分活动',
      });
    }
    if (r.result === 'claimed') {
      store.update(acct.id, {
        lastCheckinAt: new Date().toISOString(),
        lastCheckinResult: 'claimed',
        entitlementSnapshot: {
          lastProbeAt: new Date().toISOString(),
          lastClaimAt: new Date().toISOString(),
          lastClaimCampaign: r.campaignKey,
          lastClaimAmount: r.amount,
          lastClaimExpiresAt: r.expiresAt,
          lastClaimGrantId: r.grantId,
        },
      });
    } else if (r.result === 'already') {
      store.update(acct.id, {
        lastCheckinAt: new Date().toISOString(),
        lastCheckinResult: 'already',
      });
    }
    res.json({ object: 'qoder.claim', accountId: acct.id, ...r });
  } catch (e) {
    res.status(502).json({ error: { message: e.message, type: 'qoder_upstream_error' } });
  }
});

/** 对全部启用账号跑一轮（可选领取）。query: claim=true|false */
router.post('/run', admin, async (req, res) => {
  try {
    const claim = req.query.claim === 'true';
    const out = await qoderJobs.runRewards({ trigger: 'manual', claim });
    res.json({ object: 'qoder.rewards.run', ...out });
  } catch (e) {
    res.status(502).json({ error: { message: e.message, type: 'qoder_upstream_error' } });
  }
});

// ---- 模型目录 ----

/** 同步账号模型目录。query: prefer=cosy|cache|auto */
router.get('/accounts/:id/models', admin, async (req, res) => {
  const acct = getQoderAccount(res, req.params.id, '同步目录');
  if (!acct) return;
  try {
    const prefer = ['cosy', 'cache', 'auto'].includes(req.query.prefer) ? req.query.prefer : 'auto';
    const r = await catalog.syncCatalog(acct, { prefer });
    res.json({
      object: 'qoder.models',
      accountId: acct.id,
      realm: r.realm,
      source: r.source,
      count: r.models.length,
      freeModels: catalog.freeModels(r.models),
      models: r.models,
    });
  } catch (e) {
    res.status(502).json({ error: { message: e.message, type: 'qoder_upstream_error' } });
  }
});

// ---- 对话转发（国际版，单账号） ----

/**
 * 选一个可用的国际版账号。
 *
 * 本期单账号：取第一个 enabled 的国际版账号。刻意不做轮询/择优——
 * 上游并发与风控阈值未验证（见模块头）。sticky 会话优先复用同一账号，
 * 避免同一会话跨账号导致的上下文丢失。
 *
 * 注意 store.list() 会剥离 token（safeTok），所以平台过滤只能看
 * enabled + realm，token 的存在性由后续 chat.chatOnce 的 blockReason 兜底
 * ——在这里用含 token 的条件过滤会误杀所有账号（list() 返回的都没有 token）。
 */
function pickChatAccount(stickyKey) {
  const candidates = () => store.list().filter((a) => a.enabled
    && variant.isEdition(a.edition, variant.QODER)
    && variant.qoderChatRealms().includes(variant.qoderRealmOfAccount(a)));

  const bound = stickyKey ? sticky.lookup(stickyKey) : null;
  if (bound) {
    const a = store.get(bound);
    if (a && a.enabled && variant.isEdition(a.edition, variant.QODER)
      && variant.qoderChatOk(a)) {
      return a;
    }
  }
  const all = candidates();
  if (!all.length) return null;
  // 确定性选取：最近选用最早的先（与 pool 的 round_robin 末键同口径）
  all.sort((x, y) => (x.lastPickedAt || 0) - (y.lastPickedAt || 0));
  // 取完整记录（含明文 token）——list() 的副本没有 token
  return store.get(all[0].id);
}

/** 转发面错误响应（与 routes/openai.js 的 error 信封一致）。 */
function chatError(res, status, message, code) {
  return res.status(status).json({
    error: { message, type: status === 429 ? 'rate_limit_error' : 'upstream_error', ...(code ? { code } : {}) },
  });
}

/**
 * POST /v1/qoder/chat/completions — 国际版对话转发。
 *
 * 鉴权：转发面访问密钥（authenticate）。模型权限走 canUseModel：
 * 通用密钥（all）可调；trae/workbuddy 平台密钥一律拒绝——
 * Qoder 是独立平台，不让平台密钥越界调用。
 */
router.post('/chat/completions', authenticate, async (req, res) => {
  const body = req.body || {};
  const {
    model = 'auto',
    messages,
    stream = true,
    temperature,
    top_p,
    max_tokens,
    stop,
    tools,
    tool_choice,
  } = body;
  const startedAt = Date.now();
  let requestError = null;
  let lastUsage = null;
  let usedAccountId = null;
  const reqTools = Array.isArray(tools) && tools.length ? tools : null;

  if (!Array.isArray(messages) || messages.length === 0) {
    return chatError(res, 400, 'messages is required', 'invalid_request_error');
  }

  const access = canUseModel(req.platform, model, req.authKey || null);
  if (!access.ok) {
    logRequest({
      endpoint: '/v1/qoder/chat/completions', method: 'POST', model,
      account: null, status: 403, toolCalls: 0, toolsIn: reqTools ? reqTools.length : 0,
      durationMs: 0, error: access.message, platform: 'qoder',
    });
    return chatError(res, 403, access.message, 'MODEL_ACCESS_DENIED');
  }

  const acct = pickChatAccount(sticky.stickyKeyFromRequest(req));
  if (!acct) {
    logRequest({
      endpoint: '/v1/qoder/chat/completions', method: 'POST', model,
      account: null, status: 503, toolCalls: 0, toolsIn: reqTools ? reqTools.length : 0,
      durationMs: Date.now() - startedAt, error: 'no enabled qoder intl account', platform: 'qoder',
    });
    return chatError(res, 503,
      '没有可用的 Qoder 国际版账号。请在「凭据池 → 接入 Qoder」导入并启用国际版账号。',
      'NO_QODER_ACCOUNT');
  }
  usedAccountId = acct.id;
  if (sticky.stickyKeyFromRequest(req)) sticky.bind(sticky.stickyKeyFromRequest(req), acct.id);
  store.update(acct.id, { lastPickedAt: new Date().toISOString() });

  const upBody = {
    model,
    messages,
    stream: stream !== false,
    temperature, top_p, max_tokens, stop,
    tools: reqTools || undefined,
    tool_choice,
  };

  try {
    if (stream !== false) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const up = await chat.chatStream(acct, upBody);
      if (up.status !== 200 || !up.body) {
        throw new chat.QoderChatError(`Qoder 对话上游 HTTP ${up.status}`, { status: up.status, model });
      }
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
        } catch { /* ignore */ }
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
        platform: 'qoder',
      })
      : null;
    logRequest({
      endpoint: '/v1/qoder/chat/completions', method: 'POST', model,
      account: usedAccountId,
      status: requestError ? 502 : 200,
      toolCalls: 0, toolsIn: reqTools ? reqTools.length : 0,
      durationMs: Date.now() - startedAt,
      error: requestError,
      platform: 'qoder',
      pricedModel: model,
      routedTo: `qoder/${model}`,
      ...usageFields,
      ...(cost != null ? { estimatedCost: cost } : {}),
    });
  }
});

// ---- 设置 ----

router.get('/settings', admin, (req, res) => {
  res.json(qoderJobs.snapshot());
});

router.post('/settings', admin, (req, res) => {
  try {
    res.json(qoderJobs.save(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: { message: e.message, type: 'invalid_request_error' } });
  }
});

module.exports = router;

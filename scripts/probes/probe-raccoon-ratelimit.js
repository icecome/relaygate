'use strict';
/**
 * scripts/probes/probe-raccoon-ratelimit.js —— 实测 Raccoon 对话面的**频率限流边界**。
 *
 * ## 为什么需要这个脚本
 *
 * 「raccoon: 您的模型请求频率超限，请稍后重试」这句文案是**上游**给的，不是本仓库
 * 或参考插件的自造文案（参考实现只是把上游 message 原样拼进 `raccoon: <message>`）。
 * 但它到底挂在
 *
 *   - HTTP 429 还是 200+业务码？
 *   - 报文里有没有 `code`？
 *   - 有没有 `Retry-After` / `reset` 时刻？
 *   - 是「账号级」还是「模型级」？
 *   - 阈值大概是每分钟几次？
 *
 * 这四件事决定限流器怎么设计：能不能精确冷却、冷却多久、要不要按模型分桶。
 * 猜错任何一个，代价都是「冷却过长 → 用户干等」或「冷却过短 → 反复撞墙」。
 *
 * ## 用法
 *
 * ```bash
 * # 只读探测：一次请求，看状态码与报文形状（不烧额度，max_tokens=1）
 * node scripts/probes/probe-raccoon-ratelimit.js
 *
 * # 阈值探测：连续 N 次直到撞墙，报告第几次开始限流（**会消耗额度**，需显式确认）
 * node scripts/probes/probe-raccoon-ratelimit.js --burst=12 --yes
 *
 * # 指定账号与模型
 * node scripts/probes/probe-raccoon-ratelimit.js --account=acct_xxx --model=sn-glm-5-3-flash
 * ```
 *
 * ## 安全边界
 *
 * - 只读：只打 `chat/completions`（`max_tokens=1`）与 `model_catalog`，不碰任何写端点；
 * - 不打印凭据：token 只用于 Authorization 头，任何输出都不含它（打印前统一脱敏）；
 * - burst 模式**必须**显式 `--yes`：它会故意把账号打到限流，恢复窗口内该账号不可用。
 *
 * @module scripts/probes/probe-raccoon-ratelimit
 */
const os = require('node:os');
const path = require('node:path');

// 必须在 require 业务模块前把状态目录指向临时目录：
// 本脚本只读账号库，但 store/db 会在加载期建表，指到真实目录会写用户库。
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || path.join(os.tmpdir(), `raccoon-rl-${process.pid}`);
process.env.TRAE_API_ENCRYPT_KEY = process.env.TRAE_API_ENCRYPT_KEY || 'e'.repeat(64);

const variant = require('../../src/platform/variant');
const raccoonClient = require('../../src/raccoon/client');
const product = require('../../src/raccoon/product');

const V = variant.variantOf(variant.RACCOON);

function argOf(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

/** 从 JWT 的 exp 算剩余寿命（天），只用来看凭据是否还活着。 */
function tokenDaysLeft(token) {
  const ms = product.decodeJwtExpMs(token);
  if (ms === undefined) return null;
  return Math.round((ms - Date.now()) / 86400000 * 10) / 10;
}

/** 本地桌面端凭据（明文 auth.json）。探测用它的原因：不需要先扫码。 */
function localCredential() {
  const dir = process.env.BOX_AGENT_CONFIG_DIR
    || path.join(os.homedir(), '.box-agent', 'config');
  const file = path.join(dir, 'auth.json');
  // eslint-disable-next-line global-require
  const fs = require('node:fs');
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw.access_token !== 'string' || raw.access_token.length === 0) return null;
    return {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token,
      office_identity: raw.office_identity,
    };
  } catch {
    return null;
  }
}

/** 对话面请求头 —— 与 src/raccoon/chat.js 的 chatHeaders 逐字一致（比对的基准）。 */
function chatHeaders(credential) {
  return {
    ...product.headers(credential, { platform: V.identity.clientPlatform }),
    Accept: 'text/event-stream',
  };
}

/**
 * 一次最小对话请求，返回 {status, headers, body, ms}。
 *
 * ⚠️ `max_tokens` **不能给 1**（2026-11-09 实测）：`max_tokens:1` 会被内部 MaaS
 * 组件判成非法请求，回
 * `HTTP 400 invalid_request_error — the request was rejected by an internal MaaS
 *  component`。那是**请求体校验**的 400，与限流无关，会污染探测结论。
 * 16 是实测可用的最小值（思考关掉后正文为空但请求合法）。
 */
async function oneChat(credential, model, timeoutMs = 60_000) {
  const url = raccoonClient.urlFor('chat');
  const t0 = Date.now();
  const init = raccoonClient.withDispatcher({
    method: 'POST',
    headers: chatHeaders(credential),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      max_tokens: 16,
      // 关思考：思考开着的模型会把整段思考算进 max_tokens，16 个 token 只够思考
      // 一个开头，正文恒空 —— 但这不影响限流报文，且能把单次额度消耗压到最低。
      extra_body: { thinking: { type: 'disabled' } },
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  let resp;
  try {
    resp = await fetch(url.toString(), init);
  } catch (e) {
    return { status: 0, headers: {}, body: `<transport: ${e.message}>`, ms: Date.now() - t0 };
  }
  const text = await resp.text();
  const headers = {};
  // 只挑与限流相关的头，别把整包响应头打进日志
  for (const k of ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'content-type']) {
    const v = resp.headers.get(k);
    if (v != null) headers[k] = v;
  }
  return { status: resp.status, headers, body: text.slice(0, 800), ms: Date.now() - t0 };
}

/** 判定一次响应是不是「频率限流」（上游文案 + 状态码 + 业务码三路）。 */
function classifyThrottle(r) {
  if (r.status === 429) return 'http429';
  const b = r.body || '';
  if (/频率|限流|rate.?limit|too many requests|frequency/i.test(b)) return 'body-text';
  try {
    const j = JSON.parse(b);
    if (j && typeof j.code === 'number' && j.code !== 0) return `code:${j.code}`;
  } catch { /* 非 JSON */ }
  return '';
}

async function main() {
  const burst = Number(argOf('burst', '0')) || 0;
  const gapMs = Number(argOf('gap', '0')) || 0;
  const model = argOf('model', 'sn-glm-5-3-flash');
  const yes = hasFlag('yes');

  const credential = localCredential();
  if (!credential) {
    console.error(`未找到本机桌面端凭据（${path.join(os.homedir(), '.box-agent', 'config', 'auth.json')}）。`);
    console.error('先装并登录小浣熊桌面客户端，或在网关里扫码登录后从账号库取 token。');
    process.exit(2);
  }

  console.log('=== Raccoon 对话面限流探测 ===');
  console.log(`host      : ${V.hosts.openapi}`);
  console.log(`model     : ${model}`);
  console.log(`platform  : ${V.identity.clientPlatform}   (chat 面**不发** X-Client-Version)`);
  console.log(`org-code  : ${JSON.stringify(product.orgCodeOf(credential))}   (personal 必须归一成空串)`);
  console.log(`token 寿命: ${tokenDaysLeft(credential.access_token)} 天`);
  console.log('');

  // ---- 1. 单次基线 ----
  const first = await oneChat(credential, model);
  console.log(`[1/2] 基线单次：HTTP ${first.status}  ${first.ms}ms`);
  if (Object.keys(first.headers).length) console.log(`      headers: ${JSON.stringify(first.headers)}`);
  console.log(`      body   : ${first.body.replace(/\s+/g, ' ').slice(0, 400)}`);
  const throttle0 = classifyThrottle(first);
  console.log(`      判定   : ${throttle0 || '正常（未限流）'}`);
  console.log('');

  if (!burst) {
    console.log('[2/2] 阈值探测跳过（加 --burst=N --yes 才会执行；它会故意把账号打到限流）');
    return;
  }
  if (!yes) {
    console.error('[2/2] 已请求 --burst 但缺少 --yes：该模式会让账号进入限流恢复窗口，必须显式确认。');
    process.exit(2);
  }

  // ---- 2. 连续打，找阈值 ----
  console.log(`[2/2] 阈值探测：最多 ${burst} 次${gapMs ? `，间隔 ${gapMs}ms` : '，**无间隔**'}`);
  let throttledAt = 0;
  const t0 = Date.now();
  for (let i = 1; i <= burst; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await oneChat(credential, model);
    const t = classifyThrottle(r);
    const at = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  #${String(i).padStart(2)} t+${at}s HTTP ${r.status} ${r.ms}ms  ${t ? `限流(${t})` : 'ok'}`);
    if (t) {
      throttledAt = i;
      console.log(`      报文: ${r.body.replace(/\s+/g, ' ').slice(0, 400)}`);
      if (Object.keys(r.headers).length) console.log(`      头  : ${JSON.stringify(r.headers)}`);
      break;
    }
    if (gapMs > 0) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res) => setTimeout(res, gapMs));
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('');
  if (throttledAt) {
    console.log(`结论：第 ${throttledAt} 次开始限流（${elapsed}s 内 ${throttledAt} 次请求）。`);
    console.log('      把该数值当作**观察下界**——真实阈值可能更低（别的会话也在共用一个账号的额度）。');
  } else {
    console.log(`结论：${burst} 次全部通过（${elapsed}s）。阈值高于该值；加大 --burst 继续逼近。`);
  }
}

main().catch((e) => {
  console.error('探测失败:', e && e.message ? e.message : e);
  process.exit(1);
});

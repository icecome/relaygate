'use strict';
/**
 * 端到端验证：用**网关自己的 raccoon 模块**（product/credits/auth/chat）配合
 * 本机客户端凭据打真实上游，证明修复前后的行为差异。
 *
 *   node scripts/verify-raccoon-live.js            # 只读项（余额/目录/账单/用户）
 *   node scripts/verify-raccoon-live.js --chat     # 额外验证对话面（会消耗少量积分）
 *
 * 凭据来源：本机小浣熊客户端 ~/.box-agent/config/auth.json（只读，不写回）。
 * ⚠️ 不调用 login/points/grant 之外的任何写端点；grant 是一次性幂等，默认也不打。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const product = require('../src/raccoon/product');
const client = require('../src/raccoon/client');
const credits = require('../src/raccoon/credits');
const auth = require('../src/raccoon/auth');

function readClientCredential() {
  const dir = process.env.BOX_AGENT_CONFIG_DIR
    || path.join(os.homedir(), '.box-agent', 'config');
  const p = path.join(dir, 'auth.json');
  if (!fs.existsSync(p)) {
    throw new Error(`未找到客户端凭据：${p}（需要先登录小浣熊桌面端）`);
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    // 刻意照抄客户端的坑值：桌面端把 office_identity 写成 "personal"
    office_identity: raw.office_identity,
  };
}

/** 手工构造「修复前」的头，用来对照复现 400。 */
function legacyHeaders(credential, opts = {}) {
  const h = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential.access_token}`,
    'X-Org-Code': credential.office_identity || '',
    'X-Raccoon-Language': 'zh',
  };
  if (opts.platform) h['X-Client-Platform'] = opts.platform;
  if (opts.version) h['X-Client-Version'] = opts.version;
  return h;
}

async function show(label, fn) {
  try {
    const r = await fn();
    console.log(`  PASS  ${label}  ${r}`);
    return { ok: true, value: r };
  } catch (e) {
    console.log(`  FAIL  ${label}  ${e.message}`);
    return { ok: false, error: e.message };
  }
}

(async () => {
  const credential = readClientCredential();
  console.log(`凭据：office_identity=${JSON.stringify(credential.office_identity)} `
    + `exp-epoch=${product.decodeJwtExpMs(credential.access_token)}`);
  console.log(`X-Org-Code 取值：修复前=${JSON.stringify(credential.office_identity || '')} `
    + `修复后=${JSON.stringify(product.orgCodeOf(credential))}`);

  // 1) 复现修复前的失败（证明这个 bug 真实存在且我们理解正确）
  console.log('\n[1] 修复前的头（X-Org-Code: "personal"）打模型目录 —— 期望 400');
  await show('legacy catalog', async () => {
    const r = await client.request({
      method: 'GET', path: 'modelCatalog',
      headers: { ...legacyHeaders(credential), Accept: 'application/json' },
      timeoutMs: 20_000,
    });
    return `HTTP ${r.status} code=${r.envelope.code} ${r.envelope.message}`;
  });

  // 2) 修复后的网关路径（credits/auth 用的是 product.headers / catalogHeaders）
  console.log('\n[2] 修复后走网关自己的模块 —— 期望全部成功');
  const bal = await show('credits.fetchBalance', async () => {
    const b = await credits.fetchBalance({
      id: 'verify', token: credential.access_token,
      refreshToken: credential.refresh_token, raccoonOrg: credential.office_identity,
    });
    if (!b) throw new Error('返回 null（形状不符）');
    return `available=${b.available} pools=${b.packages.map((p) => `${p.name}:${p.remaining}`).join(' ')}`;
  });

  const cat = await show('auth.fetchModelCatalog', async () => {
    const c = await auth.fetchModelCatalog({
      id: 'verify', token: credential.access_token,
      refreshToken: credential.refresh_token, raccoonOrg: credential.office_identity,
    });
    if (c.source !== 'remote') throw new Error(`回退到兜底表（source=${c.source}），说明远端请求失败`);
    return `source=${c.source} models=${c.models.length} [${c.models.map((m) => m.id).join(', ')}]`;
  });

  const bills = await show('credits.fetchOnboardingStatus', async () => {
    const s = await credits.fetchOnboardingStatus({
      id: 'verify', token: credential.access_token,
      refreshToken: credential.refresh_token, raccoonOrg: credential.office_identity,
    });
    return `claimed=${s.claimed} points=${s.points} detail=${s.detail}`;
  });

  const info = await show('auth.fetchUserInfo', async () => {
    const u = await auth.fetchUserInfo(credential);
    return `userId=${u.userId} name=${u.nickname} office_identity=${JSON.stringify(u.officeIdentity)}`;
  });

  // 3) 对话面（可选，消耗积分）
  if (process.argv.includes('--chat')) {
    console.log('\n[3] 对话面（会消耗少量积分）');
    const chat = require('../src/raccoon/chat');
    await show('chat.chatNonStream', async () => {
      const acct = {
        id: 'verify', token: credential.access_token,
        refreshToken: credential.refresh_token, raccoonOrg: credential.office_identity,
      };
      const data = await chat.chatNonStream(acct, {
        model: 'sn-sensenova-6-8-flash-lite',
        messages: [{ role: 'user', content: '只回复两个字：收到' }],
        stream: false,
        max_tokens: 16,
      });
      const txt = data?.choices?.[0]?.message?.content || '';
      return `model=${data.model} usage=${JSON.stringify(data.usage)} content=${JSON.stringify(txt.slice(0, 24))}`;
    });
  } else {
    console.log('\n[3] 跳过对话面（加 --chat 才跑，会消耗积分）');
  }

  const results = { bal, cat, bills, info };
  const failed = Object.entries(results).filter(([, v]) => !v.ok).map(([k]) => k);
  console.log(`\n汇总：${Object.keys(results).length - failed.length}/${Object.keys(results).length} 通过`
    + (failed.length ? `；失败：${failed.join(', ')}` : ''));
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => {
  console.error('脚本异常：', e.message);
  process.exitCode = 2;
});

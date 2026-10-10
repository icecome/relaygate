'use strict';
/**
 * test/oauth-listener.test.js — OAuth 本地回调监听器的凭据注入面（P1-004）。
 *
 * 背景：监听器 127.0.0.1:<port>/authorize 的 GET 分支既无 Origin 校验、
 * 也无 state 强制（state 不匹配只打 console 告警），因此任何本地进程或
 * 恶意网页（no-cors 导航）都能 GET 注入任意 refreshToken/accessToken，
 * 而 store.add 默认 enabled=true —— 注入账号立刻可参与调度。
 *
 * 修复策略（行为保持）：不能做强 state 匹配 —— Trae 授权页会重新生成 state
 * （代码注释与实测均证实此点），强匹配会打断真实登录。改用更弱但足够的不变量：
 * **没有待完成的登录会话时，一律拒绝回调**。真实登录流程必然经历过
 * GET /oauth/url（由管理面鉴权保护），因此一定有 pending 会话。
 *
 * 运行：node src/test/oauth-listener.test.js
 */
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.TRAE_OAUTH_REDIRECT_PORT || 17701);
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `trae-oauth-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'c'.repeat(64);
process.env.TRAE_OAUTH_REDIRECT_PORT = String(PORT);

const assert = require('assert');
const oauth = require('../credentials/oauth');
const store = require('../credentials/store');

let pass = 0;
let fail = 0;
const queue = [];
function t(name, fn) {
  queue.push({ name, fn });
}

/** 发一个 GET 到监听器，返回 { status, body }。 */
function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(4000, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------ 攻击面

console.log('credentials/oauth — 本地回调闸门');

t('没有待完成登录会话时，GET 回调必须被拒绝（监听器在听但无会话）', async () => {
  // 先发起一次登录让监听器真正 listen 上，再只作废会话 ——
  // 这样「连接被拒」与「被闸门拒绝」两种保护都能在测试里区分开：
  // 我们要断言的是后者（403），而不是前者（ECONNREFUSED）。
  const issued = oauth.getLoginUrl();
  await sleep(250);
  assert.strictEqual(oauth.hasPendingLogin(), true, '前置条件：监听器应已启动');

  // 用一次性消费语义作废会话（与 /oauth/complete 使用的同一闸门）：
  // 消费后 pending.state 清空 → hasPendingLogin 变 false，但端口仍在监听
  assert.strictEqual(oauth.verifyAndConsumeState(issued.state), true, '一次性 state 应可消费');
  assert.strictEqual(oauth.hasPendingLogin(), false, '会话被消费后不应再有 pending');

  // 尝试注入（这正是审计里描述的攻击请求）—— 监听器仍在，应返回 403
  const r = await get('/authorize?refreshToken=EVIL&accessToken=EVIL&userId=attacker');
  assert.strictEqual(r.status, 403, `无会话时注入必须 403，实际 ${r.status}`);

  const accounts = store.list();
  assert.ok(!accounts.some((a) => String(a.userId) === 'attacker'), '注入的账号绝不能落库');
});

t('路径畸形形态（/authorize&refreshToken=…）同样被拒', async () => {
  // 保持监听器在听、无会话状态
  const r = await get('/authorize&refreshToken=EVIL2&userId=attacker2');
  assert.strictEqual(r.status, 403, `畸形路径注入也必须 403，实际 ${r.status}`);
  assert.ok(!store.list().some((a) => String(a.userId) === 'attacker2'));
});

t('非 /authorize 路径不落到回调处理', async () => {
  const before = store.list().length;
  await get('/other?refreshToken=EVIL3').catch(() => null);
  assert.strictEqual(store.list().length, before, '非回调路径不得改动账号表');
});

// ------------------------------------------------------------ 正常流程

console.log('credentials/oauth — 真实流程不被破坏');

t('发起登录后有 pending 会话（真实回调才能通过闸门）', async () => {
  const r = oauth.getLoginUrl();
  assert.ok(r && r.url && r.state, 'getLoginUrl 应返回授权 URL 与 state');
  assert.strictEqual(oauth.hasPendingLogin(), true, '发起登录后应有 pending 会话');
  await sleep(250);
  // 有会话时闸门放行（凭据本身的有效性由 completeLogin 校验）
  const res = await get('/authorize?state=' + encodeURIComponent(r.state) + '&userId=nobody');
  assert.strictEqual(res.status, 200, `有 pending 会话时不应被闸门拦截，实际 ${res.status}`);
  oauth.stopListener('test-teardown');
});

t('timeout/stopListener 之后 pending 会话被清空，闸门重新收紧', async () => {
  oauth.getLoginUrl();
  assert.strictEqual(oauth.hasPendingLogin(), true);
  oauth.stopListener('manual');
  await sleep(150);
  assert.strictEqual(oauth.hasPendingLogin(), false, 'stopListener 后不应再有 pending 会话');
  const r = await get('/authorize?refreshToken=EVIL4');
  // 监听器已停 → 连接被拒；无论哪种，都不能成功注入
  assert.ok(!store.list().some((a) => String(a.userId) === 'EVIL4'));
});

// ---------------------------------------------------------------- 汇总

async function main() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      pass++;
      console.log(`  ok  ${name}`);
    } catch (e) {
      fail++;
      console.error(`FAIL  ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  oauth.stopListener('cleanup');
  console.log(`\n${pass} passed, ${fail} failed`);
  if (process.exitCode) process.exit(process.exitCode);
}

main();
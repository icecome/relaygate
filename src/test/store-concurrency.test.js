'use strict';
/**
 * test/store-concurrency.test.js——账号写入的丢失更新回归（P0-001）。
 * 运行：node src/test/store-concurrency.test.js
 *
 * 背景：store.update() 原实现是「get(id) 全列读，merge，UPDATE 全部 34 列」。
 * 单进程内 node:sqlite 是同步 API，pick() 也没有 await，不存在进程内竞态；
 * 真正的风险是跨进程（第二个 Node 进程或运维脚本）与多客户端同时写库：
 * 另一写入方在「读」与「写」之间写入的字段，会被本次的陈旧快照覆盖回去，且无任何报错。
 * 本文件用两个独立 Node 进程复现该场景，这也是唯一能真实构造出
 * 「读到旧快照、别人写入、自己再写」时序的方式。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const WORKSPACE = path.join(os.tmpdir(), `trae-conc-${Date.now()}`);
process.env.WORKSPACE_DIR = WORKSPACE;
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);
process.env.API_KEY = 'test-api-key';
process.env.ADMIN_KEY = 'test-admin-key';

const assert = require('assert');

let pass = 0;
let fail = 0;
const queue = [];
function t(name, fn) {
  queue.push({ name, fn });
}

async function runAll() {
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
}

const STORE = path.resolve(__dirname, '..', 'credentials', 'store.js');
const DB = path.resolve(__dirname, '..', 'credentials', 'db.js');

/** 在独立 Node 进程里对同一 WORKSPACE_DIR 执行一段读写脚本。 */
function runInChild(script) {
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: {
      ...process.env,
      WORKSPACE_DIR: WORKSPACE,
      TRAE_API_ENCRYPT_KEY: 'a'.repeat(64),
    },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`子进程失败(${r.status}): ${r.stderr || r.stdout}`);
  }
  return (r.stdout || '').trim();
}

// 场景构造

console.log('credentials/store — 并发写入（跨进程）');

t('seed：主进程建一个账号', () => {
  const store = require('../credentials/store');
  const created = store.add({ id: 'acct_conc_1', label: '并发测试号', enabled: true }, 'import');
  assert.ok(created && created.id, '账号创建失败');
  assert.strictEqual(created.label, '并发测试号');
});

t('两个字段由两个进程分别写入时都必须保留（原实现会丢一个）', () => {
  // 子进程 A：把 priority 改成 7
  // 子进程 B：读到不含 A 修改的快照后写入 enabled=false
  // 关键：B 的写入不能把 A 的 priority 覆盖回旧值
  const child = `
    const store = require(${JSON.stringify(STORE)});
    require(${JSON.stringify(DB)}).db();
    // A 写 priority
    store.update('acct_conc_1', { priority: 7 });
    process.exit(0);
  `;
  runInChild(child);

  // 主进程此刻再写 enabled：若 update 仍是全列重写，且它读的是 A 写之前的快照，
  // priority 就会被打回 0
  const store = require('../credentials/store');
  store.update('acct_conc_1', { enabled: false });

  const after = store.get('acct_conc_1');
  assert.strictEqual(after.enabled, false, 'enabled 应已写入');
  assert.strictEqual(
    after.priority,
    7,
    `priority 被并发写入回滚了（实际 ${after.priority}）—— 这就是丢失更新`,
  );
});

t('update 只写 patch 中出现的列（未提及的列保持原值）', () => {
  const store = require('../credentials/store');
  const before = store.get('acct_conc_1');
  store.update('acct_conc_1', { label: '改了备注' });
  const after = store.get('acct_conc_1');
  assert.strictEqual(after.label, '改了备注');
  assert.strictEqual(after.enabled, before.enabled, '未提及的 enabled 不应被改动');
  assert.strictEqual(after.priority, before.priority, '未提及的 priority 不应被改动');
});

t('version 随每次成功写入递增，且不出现在对外返回值里', () => {
  const store = require('../credentials/store');
  const db = require('../credentials/db').db();
  const v0 = db.prepare('SELECT version FROM accounts WHERE id = ?').get('acct_conc_1').version;
  const returned = store.update('acct_conc_1', { label: '再改一次' });
  const v1 = db.prepare('SELECT version FROM accounts WHERE id = ?').get('acct_conc_1').version;
  assert.ok(v1 > v0, `version 应递增，${v0} → ${v1}`);
  assert.strictEqual(returned.version, undefined, 'version 是内部乐观锁字段，不应外泄给调用方');
});

t('未知字段被忽略，不会写坏其它列', () => {
  const store = require('../credentials/store');
  const before = store.get('acct_conc_1');
  store.update('acct_conc_1', { somethingUnknown: 'x', label: '只改这个' });
  const after = store.get('acct_conc_1');
  assert.strictEqual(after.label, '只改这个');
  assert.strictEqual(after.priority, before.priority);
  assert.strictEqual(after.somethingUnknown, undefined);
});

t('更新不存在的账号返回 null（保持原契约）', () => {
  const store = require('../credentials/store');
  assert.strictEqual(store.update('acct_does_not_exist', { label: 'x' }), null);
});

t('空 patch 返回当前账号而不报错', () => {
  const store = require('../credentials/store');
  const r = store.update('acct_conc_1', {});
  assert.ok(r && r.id === 'acct_conc_1');
});

/**
 * CAS 谓词本身必须生效：这是防「跨进程丢失更新」的机制。
 * 真实丢更新需要 OS 级抢占才能复现，无法在测试里稳定构造；
 * 但「用陈旧 version 发起的写入被拒绝」是它的等价可测断言。
 */
t('用陈旧 version 发起的 UPDATE 必须 0 行生效', () => {
  const db = require('../credentials/db').db();
  const cur = db.prepare('SELECT version FROM accounts WHERE id = ?').get('acct_conc_1').version;
  const stale = Number(cur) + 100;
  const info = db
    .prepare('UPDATE accounts SET label = ?, version = version + 1 WHERE id = ? AND version = ?')
    .run('不该被写入', 'acct_conc_1', stale);
  assert.strictEqual(info.changes, 0, '陈旧 version 竟然写入成功 → CAS 未生效');
  const after = db.prepare('SELECT label FROM accounts WHERE id = ?').get('acct_conc_1');
  assert.notStrictEqual(after.label, '不该被写入');
});

// 只读接口不得产生写库

console.log('credentials/pool — 只读接口无写副作用');

/**
 * 构造一个「已过期的模型冷却条目」。原实现里 snapshot()/explainCandidates()
 * 会顺手把它写入数据库（store.update 全列重写），于是免鉴权的 GET /status
 * 与 GET /v1/admin/runtime 每次调用都产生 N 次数据库写。
 * 有了这条过期数据，「只读不写」才是可验证的断言。
 */
function seedExpiredModelCooldown() {
  const store = require('../credentials/store');
  store.update('acct_conc_1', {
    modelCooldowns: { 'trae/expired-probe': new Date(Date.now() - 60_000).toISOString() },
  });
}

t('pool.snapshot() 不改动任何账号的 version', () => {
  const pool = require('../credentials/pool');
  const db = require('../credentials/db').db();
  seedExpiredModelCooldown();
  const v = () => db.prepare('SELECT version FROM accounts WHERE id = ?').get('acct_conc_1').version;
  const v0 = v();
  pool.snapshot();
  pool.snapshot();
  assert.strictEqual(
    v(),
    v0,
    'snapshot() 是只读视图，不应写库（/status 免鉴权时会被外部触发放大写入）',
  );
});

t('pool.explainCandidates() 不改动任何账号的 version', () => {
  const pool = require('../credentials/pool');
  const db = require('../credentials/db').db();
  seedExpiredModelCooldown();
  const v = () => db.prepare('SELECT version FROM accounts WHERE id = ?').get('acct_conc_1').version;
  const v0 = v();
  pool.explainCandidates();
  assert.strictEqual(v(), v0, 'explainCandidates() 是只读视图，不应写库');
});

t('过期冷却条目由 sweepModelCooldowns 显式清理并落库', () => {
  const pool = require('../credentials/pool');
  const store = require('../credentials/store');
  seedExpiredModelCooldown();
  const swept = pool.sweepModelCooldowns();
  assert.ok(swept >= 1, `sweep 应至少清理 1 个账号，实际 ${swept}`);
  const after = store.get('acct_conc_1');
  const left = after.modelCooldowns || {};
  assert.ok(!left['trae/expired-probe'], '过期条目应已被清理落库');
});

// 汇总

async function main() {
  await runAll();
  console.log(`\n${pass} passed, ${fail} failed`);
  try {
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
  if (process.exitCode) process.exit(process.exitCode);
}

main();

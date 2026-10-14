'use strict';
/**
 * test/startup-checks.test.js——启动期健康校验（P3-001）。
 * 运行：node src/test/startup-checks.test.js
 *
 * 覆盖三类此前「静默降级」的场景：
 *   1. DB 打不开：此前进程照常启动、每请求 500；现在必须 fatal 拒绝启动；
 *   2. encrypt.key 丢失且库里有密文：此前静默生成新 key，凭据永久不可解，
 *      现在必须 fatal（唯一的不可逆数据丢失入口）；
 *   3. model-config / model-router 损坏：此前静默降级为空对象，面板仍显示正常，
 *      现在必须让 /health 报 unhealthy。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const WORKSPACE = path.join(os.tmpdir(), `trae-startup-${Date.now()}`);
fs.mkdirSync(WORKSPACE, { recursive: true });
process.env.WORKSPACE_DIR = WORKSPACE;
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);

const assert = require('assert');
const checks = require('../lib/startup-checks');

let pass = 0;
let fail = 0;
const queue = [];
function t(name, fn) {
  queue.push({ name, fn });
}

/** 构造一个临时 ROOT 目录，供模型配置文件检查使用。 */
function withRoot(files, fn) {
  const root = path.join(WORKSPACE, `root-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content, 'utf8');
  }
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const pathMod = require('path');
const fsMod = require('fs');

// 加密密钥

console.log('startup-checks — 加密密钥不可逆丢失防护');

t('key 来自配置/文件（非新生成）且库中有密文 → 通过', () => {
  const cryptoMod = {
    getEncryptionKey: () => Buffer.alloc(32),
    wasKeyGenerated: () => false,
    KEY_ENV_VAR: 'TRAE_API_ENCRYPT_KEY',
  };
  const db = { prepare: () => ({ get: () => ({ n: 5 }) }) };
  const r = checks.checkEncryptionKey(cryptoMod, () => db);
  assert.strictEqual(r.ok, true, `应通过，实际：${r.detail}`);
});

t('key 新生成且库中有密文 → 必须 fatal（凭据将永久不可解）', () => {
  const cryptoMod = {
    getEncryptionKey: () => Buffer.alloc(32),
    wasKeyGenerated: () => true,
    KEY_ENV_VAR: 'TRAE_API_ENCRYPT_KEY',
  };
  const db = { prepare: () => ({ get: () => ({ n: 3 }) }) };
  const r = checks.checkEncryptionKey(cryptoMod, () => db);
  assert.strictEqual(r.ok, false, '必须判为不健康');
  assert.strictEqual(r.fatal, true, '必须 fatal —— 这是唯一的不可逆数据丢失入口');
  assert.match(r.detail, /encrypt\.key|恢复/, '错误文案必须告诉用户怎么恢复');
});

t('key 新生成但库中无密文（首次安装）→ 通过', () => {
  const cryptoMod = {
    getEncryptionKey: () => Buffer.alloc(32),
    wasKeyGenerated: () => true,
    KEY_ENV_VAR: 'TRAE_API_ENCRYPT_KEY',
  };
  const db = { prepare: () => ({ get: () => ({ n: 0 }) }) };
  const r = checks.checkEncryptionKey(cryptoMod, () => db);
  assert.strictEqual(r.ok, true, `首次安装应通过，实际：${r.detail}`);
});

t('密钥不可持久化 → fatal 并给出明确原因', () => {
  const cryptoMod = {
    getEncryptionKey: () => {
      throw new Error('encryption key cannot be persisted (EACCES)');
    },
    wasKeyGenerated: () => false,
    KEY_ENV_VAR: 'TRAE_API_ENCRYPT_KEY',
  };
  const r = checks.checkEncryptionKey(cryptoMod, () => null);
  assert.strictEqual(r.fatal, true);
  assert.match(r.detail, /EACCES/);
});

// 数据库

console.log('startup-checks — 数据库不可用必须 fatal');

t('db() 抛错 → fatal', () => {
  const r = checks.checkDatabase(() => {
    throw new Error('SQLITE_CANTOPEN: unable to open database file');
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fatal, true, 'DB 不可用必须拒绝启动，而不是让每个请求 500');
});

t('db() 返回 null → fatal', () => {
  const r = checks.checkDatabase(() => null);
  assert.strictEqual(r.fatal, true);
});

t('db 正常 → 通过', () => {
  const r = checks.checkDatabase(() => ({ prepare: () => ({ get: () => ({ 1: 1 }) }) }));
  assert.strictEqual(r.ok, true);
});

// 模型配置

console.log('startup-checks — 配置文件损坏不再静默兜底');

t('model-config.json 存在且有模型 → 通过', () => {
  withRoot({ 'model-config.json': JSON.stringify({ models: { 'trae/glm-5': {} }, settings: {} }) }, (root) => {
    const r = checks.checkModelConfig({ ROOT: root }, fsMod, pathMod);
    assert.strictEqual(r.ok, true, `应通过，实际：${r.detail}`);
    assert.match(r.detail, /1 个模型/);
  });
});

t('model-config.json 非法 JSON → 不健康（此前静默变成空模型表）', () => {
  withRoot({ 'model-config.json': '{ this is not json' }, (root) => {
    const r = checks.checkModelConfig({ modelConfig: { models: {} }, ROOT: root }, fsMod, pathMod);
    assert.strictEqual(r.ok, false, '解析失败必须被看见');
    assert.strictEqual(r.fatal, undefined, '配置损坏不应阻止启动（可以兜底运行），但必须在 /health 可见');
  });
});

t('model-config.json 缺失 → 不健康并说明后果', () => {
  withRoot({}, (root) => {
    const r = checks.checkModelConfig({ modelConfig: { models: {} }, ROOT: root }, fsMod, pathMod);
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /兜底|不存在/);
  });
});

t('model-router.json 非法 JSON → 不健康（vm/* 会被当物理模型必然 400）', () => {
  withRoot({ 'model-router.json': '{{{ broken' }, (root) => {
    const r = checks.checkModelRouter({ ROOT: root }, fsMod, pathMod);
    assert.strictEqual(r.ok, false);
    assert.match(r.detail, /vm\/|物理模型/);
  });
});

t('model-router.json 不存在 → 可选配置，通过', () => {
  withRoot({}, (root) => {
    const r = checks.checkModelRouter({ ROOT: root }, fsMod, pathMod);
    assert.strictEqual(r.ok, true, '虚拟模型是可选的，缺失不算问题');
  });
});

// 汇总

console.log('startup-checks — 汇总语义');

t('runAll 把 fatal 与 warning 分开', () => {
  const result = checks.runAll({
    config: { ROOT: WORKSPACE, modelConfig: { models: {} } },
    cryptoMod: { getEncryptionKey: () => Buffer.alloc(32), wasKeyGenerated: () => false, KEY_ENV_VAR: 'X' },
    getDb: () => ({ prepare: () => ({ get: () => ({ n: 0 }) }) }),
    fsMod,
    pathMod,
  });
  assert.ok(Array.isArray(result.checks), '应返回 checks 数组');
  assert.strictEqual(result.fatal, null, `全部正常时不应有 fatal，实际 ${JSON.stringify(result.fatal)}`);
  assert.ok(Array.isArray(result.warnings));
});

t('DB 失败时 runAll 报出 fatal（供 index.js 拒绝启动）', () => {
  const result = checks.runAll({
    config: { ROOT: WORKSPACE, modelConfig: { models: {} } },
    cryptoMod: { getEncryptionKey: () => Buffer.alloc(32), wasKeyGenerated: () => false, KEY_ENV_VAR: 'X' },
    getDb: () => {
      throw new Error('cannot open');
    },
    fsMod,
    pathMod,
  });
  assert.ok(result.fatal, 'DB 失败必须被 runAll 判为 fatal');
  assert.strictEqual(result.fatal.name, 'db');
});

// 汇总

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
  console.log(`\n${pass} passed, ${fail} failed`);
  try {
    fs.rmSync(WORKSPACE, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (process.exitCode) process.exit(process.exitCode);
}

main();

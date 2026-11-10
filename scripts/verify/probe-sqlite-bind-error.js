'use strict';
/**
 * scripts/verify/probe-sqlite-bind-error.js — 定位
 * 「Provided value cannot be bound to SQLite parameter N」到底是哪条语句、哪个参数。
 *
 * 只做两件事：
 *  1) 用内存库确认 node:sqlite 的参数编号是 0-based 还是 1-based；
 *  2) 用真实库复现 store.get(undefined) 与 pool.unfreezeIfHealthy(undefined)
 *     ——后者是 balance-refresh 链路里唯一在 try 顶层、且入参可能为 undefined 的调用。
 * 全程只读，不写业务数据。
 */
process.env.LOGS_DIR = require('path').join(__dirname, '..', '..', 'logs');
const { DatabaseSync } = require('node:sqlite');

const ROOT = require('path').join(__dirname, '..', '..');
const store = require(ROOT + '/src/credentials/store');
const pool = require(ROOT + '/src/credentials/pool');

function probe(label, fn) {
  try {
    const r = fn();
    console.log(`${label} -> OK ${JSON.stringify(r)}`);
  } catch (e) {
    console.log(`${label} -> THROWN ${e.message}`);
  }
}

// 1) 参数编号基准
const mem = new DatabaseSync(':memory:');
mem.exec('CREATE TABLE t (a TEXT, b TEXT)');
probe('mem bind(undefined at pos0)', () => mem.prepare('INSERT INTO t (a,b) VALUES (?,?)').run(undefined, 'x'));
probe('mem bind(undefined at pos1)', () => mem.prepare('INSERT INTO t (a,b) VALUES (?,?)').run('x', undefined));
mem.close();

// 2) 真实链路
probe('store.get(undefined)', () => store.get(undefined) === null ? 'null' : 'row');
probe('pool.unfreezeIfHealthy(undefined)', () => pool.unfreezeIfHealthy(undefined));

// 3) raccoon 的 refreshBalance 返回值形状：有没有 accountId 字段
const rc = store.list().find((a) => a.edition === 'raccoon');
console.log('raccoon sample:', rc ? rc.id : 'none');
if (rc) {
  probe('store.update(raccoon).accountId', () => ({
    hasAccountIdField: store.update(rc.id, {}).accountId === undefined ? 'ABSENT' : 'present',
    id: store.update(rc.id, {}).id,
  }));
}

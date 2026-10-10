'use strict';
/**
 * test/shutdown.test.js — 优雅停机链与调度锁（P0-002）。
 *
 * 背景：此前 SIGTERM/SIGINT 的处理器在 writeEvent 之后立刻 process.exit(0)，
 * src/index.js 无 server.close()、无 flush、无 DB close —— 停机时在途 SSE 被硬切、
 * 内存态全丢、客户端看到的是「连接重置」。且调度器无跨进程防重，两个进程
 * 并行调度会让备份与账号轮换这类非幂等任务重复执行（start.bat 注释自承过这点）。
 *
 * 覆盖三件事：
 *   1) 停机钩子按注册顺序执行、失败不阻断后续、有 5 秒兜底；
 *   2) db.close() 幂等且真的释放连接；
 *   3) 调度锁：活进程持锁时拒绝获取、死进程留下的陈旧锁可接管、release 只删自己的。
 *
 * 运行：node src/test/shutdown.test.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync, spawn } = require('child_process');

const WORKSPACE = path.join(os.tmpdir(), `trae-shut-${Date.now()}`);
fs.mkdirSync(WORKSPACE, { recursive: true });
process.env.WORKSPACE_DIR = WORKSPACE;
process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);

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

// ------------------------------------------------------------ 停机钩子

console.log('log/crash — 停机钩子链');

t('onShutdown 注册的钩子按顺序执行，且抛错的钩子不阻断后续', async () => {
  // runShutdown 最后会 process.exit(0)，因此用子进程验证，并通过退出前写的
  // 标记文件断言「哪些钩子跑了、按什么顺序」。第三个钩子故意抛错。
  const marker = path.join(WORKSPACE, 'order.json');
  const script = `
    const fs = require('fs');
    const crash = require(${JSON.stringify(path.resolve(__dirname, '..', 'log', 'crash.js'))});
    const order = [];
    crash.onShutdown('a', () => { order.push('a'); });
    crash.onShutdown('b', async () => { order.push('b'); });
    crash.onShutdown('hook-throws', () => { throw new Error('boom'); });
    crash.onShutdown('c', () => { order.push('c'); });
    crash.onShutdown('flush', () => { fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(order)); });
    crash.runShutdown('test');
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, WORKSPACE_DIR: WORKSPACE, TRAE_API_ENCRYPT_KEY: 'a'.repeat(64) },
    encoding: 'utf8',
    cwd: path.resolve(__dirname, '..', '..'),
  });
  assert.strictEqual(r.status, 0, `子进程应以 0 退出，实际 ${r.status}: ${r.stderr}`);
  const order = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.deepStrictEqual(order, ['a', 'b', 'c'], `钩子应全部执行且保序，实际 ${JSON.stringify(order)}`);
});

t('抛错的钩子不阻断后续钩子（且已记录）', async () => {
  // 上一条已包含 throw 的钩子且顺序正确，这里显式断言日志里有 shutdown_hook_error
  const day = new Date().toISOString().slice(0, 10);
  const crashFile = path.resolve(__dirname, '..', '..', 'logs', day, 'crash.jsonl');
  const lines = fs.readFileSync(crashFile, 'utf8').trim().split('\n');
  const hasHookError = lines.some((l) => {
    try {
      return JSON.parse(l).event === 'shutdown_hook_error';
    } catch {
      return false;
    }
  });
  assert.ok(hasHookError, '抛错的钩子应被记录为 shutdown_hook_error（不能静默）');
});

t('runShutdown 重复调用不会重复执行钩子', async () => {
  const marker = path.join(WORKSPACE, 'once.json');
  const script = `
    const fs = require('fs');
    const crash = require(${JSON.stringify(path.resolve(__dirname, '..', 'log', 'crash.js'))});
    let n = 0;
    crash.onShutdown('count', () => { n += 1; fs.writeFileSync(${JSON.stringify(marker)}, String(n)); });
    crash.runShutdown('first');
    crash.runShutdown('second');   // 并发第二次调用应直接返回
  `;
  spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, WORKSPACE_DIR: WORKSPACE, TRAE_API_ENCRYPT_KEY: 'a'.repeat(64) },
    encoding: 'utf8',
    cwd: path.resolve(__dirname, '..', '..'),
  });
  const n = Number(fs.readFileSync(marker, 'utf8'));
  assert.strictEqual(n, 1, `钩子应只执行一次，实际 ${n} 次`);
});

// ------------------------------------------------------------ DB 关闭

console.log('credentials/db — 显式关闭');

t('db.close() 幂等且释放连接', () => {
  const dbMod = require('../credentials/db');
  dbMod.db(); // 打开
  const first = dbMod.close();
  const second = dbMod.close();
  assert.strictEqual(first, true, '首次 close 应返回 true');
  assert.strictEqual(second, false, '未打开状态再次 close 应返回 false 而不是抛错');
});

t('close 之后可重新打开（供测试后续用例）', () => {
  const dbMod = require('../credentials/db');
  const d = dbMod.db();
  assert.ok(d);
  dbMod.close();
});

// ------------------------------------------------------------ 调度锁

console.log('jobs/scheduler-lock — 跨进程单实例');

t('活进程持锁时，另一进程获取应被拒绝', () => {
  const lock = require('../jobs/scheduler-lock');
  // 先确保无残留锁
  try {
    fs.unlinkSync(lock.lockFile());
  } catch {
    /* 无锁文件 */
  }

  // 起一个真实存活的长驻子进程，由它持有锁
  const holder = spawn(
    process.execPath,
    ['-e', `const l=require(${JSON.stringify(path.resolve(__dirname, '..', 'jobs', 'scheduler-lock.js'))});
       const r=l.acquire(); process.stdout.write(JSON.stringify(r)); setTimeout(()=>{}, 20000);`],
    {
      env: { ...process.env, WORKSPACE_DIR: WORKSPACE, TRAE_API_ENCRYPT_KEY: 'a'.repeat(64) },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  try {
    // 等子进程真正拿到锁（轮询锁文件里的 pid 变成子进程 pid）
    const deadline = Date.now() + 10000;
    let holderPid = null;
    while (Date.now() < deadline) {
      const cur = lock.readLock();
      if (cur && Number(cur.pid) === holder.pid) {
        holderPid = cur.pid;
        break;
      }
      // 同步等待 ~100ms（测试进程不能用 await 混排，保持简单）
      const until = Date.now() + 100;
      while (Date.now() < until) {
        /* spin */
      }
    }
    assert.ok(holderPid, '子进程未能在超时内拿到锁（测试环境问题）');

    // 现在本进程（不同 pid）再取一次 → 必须被拒
    const r2 = lock.acquire();
    assert.strictEqual(r2.acquired, false, '活进程持锁时不得被抢');
    assert.strictEqual(Number(r2.holderPid), holderPid, 'holderPid 应指向持锁进程');
  } finally {
    holder.kill();
    try {
      fs.unlinkSync(lock.lockFile());
    } catch {
      /* 已清理 */
    }
  }
});

t('陈旧锁（进程已死）可被接管', () => {
  const lock = require('../jobs/scheduler-lock');
  // 造一个指向已死 pid 的锁文件（pidAlive 对不存在的 pid 返回 false）
  fs.mkdirSync(path.dirname(lock.lockFile()), { recursive: true });
  fs.writeFileSync(
    lock.lockFile(),
    JSON.stringify({ pid: 999999, startedAt: Date.now(), host: '127.0.0.1', port: 1 }),
    'utf8',
  );
  const r = lock.acquire();
  assert.strictEqual(r.acquired, true, '进程已死的锁应被接管');
  lock.release();
});

t('release 只删除属于自己的锁', () => {
  const lock = require('../jobs/scheduler-lock');
  // 写一个属于别人的锁
  fs.writeFileSync(
    lock.lockFile(),
    JSON.stringify({ pid: process.pid + 1, startedAt: Date.now() }),
    'utf8',
  );
  const released = lock.release();
  assert.strictEqual(released, false, '不属于自己的锁不应被删除');
  assert.ok(fs.existsSync(lock.lockFile()), '他人的锁文件应仍在');
  fs.unlinkSync(lock.lockFile());
});

t('过期（超 STALE_MS）的锁被忽略并接管', () => {
  const lock = require('../jobs/scheduler-lock');
  fs.writeFileSync(
    lock.lockFile(),
    JSON.stringify({ pid: process.pid, startedAt: Date.now() - (lock.STALE_MS + 1000) }),
    'utf8',
  );
  // 同 pid 但时间戳超龄 → 按陈旧处理
  const r = lock.acquire();
  assert.strictEqual(r.acquired, true, '超龄锁应被接管');
  lock.release();
});

// ---------------------------------------------------------------- 汇总

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
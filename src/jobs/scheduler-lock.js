'use strict';
/**
 * jobs/scheduler-lock.js — 调度器的跨进程单实例锁。
 *
 * 为什么需要：进程在 CHECKIN_HOUR 前后重启，或用户手动 `node src/index.js`
 * 与 start.bat 同时跑，会出现两个调度器并行 —— start.bat 自己的注释承认过
 * 这种情况。签到是幂等的，但**备份与账号轮换不是**：重复执行有真实副作用。
 * scheduler.js 的 scheduleEpoch 只能解决进程内重排，跨进程要靠文件锁。
 *
 * 锁文件写 pid + 启动时刻。获取时若已有锁，用 process.kill(pid, 0) 探活：
 *   - 进程存活 → 拒绝获取（返回 { acquired:false, holderPid }）
 *   - 进程已死 → 视为陈旧锁，接管
 * 探活本身有误判空间（pid 复用），因此同时校验进程启动时间不可行（无跨平台
 * 稳定 API），采用「pid 存活 + 锁文件 mtime 新鲜度」双条件降低误判。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

/** 锁文件路径（与其它运行态文件同目录，便于整体备份/清理）。 */
function lockFile() {
  return path.join(config.workspaceDir, '.trae-api', 'scheduler.lock');
}

/** 锁被视为陈旧的最长时间：超过则不再信任其中记录的 pid。 */
const STALE_MS = 12 * 60 * 60 * 1000; // 12h

function readLock() {
  try {
    const raw = fs.readFileSync(lockFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** pid 是否存活（不发送真实信号，仅做存在性探测）。 */
function pidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    // EPERM 表示进程存在但无权限发信号（Windows 上常见）→ 视为存活
    return e && e.code === 'EPERM';
  }
}

/**
 * 尝试获取锁。
 * @returns {{acquired:boolean, holderPid?:number, reason?:string}}
 */
function acquire() {
  const existing = readLock();
  if (existing && Number(existing.pid) !== process.pid) {
    const fresh = Date.now() - (Number(existing.startedAt) || 0) < STALE_MS;
    if (fresh && pidAlive(existing.pid)) {
      return { acquired: false, holderPid: Number(existing.pid), reason: 'held' };
    }
    // 陈旧锁（进程已死或太久没更新）→ 接管
    try {
      fs.unlinkSync(lockFile());
    } catch {
      /* 已被别的进程清掉也无妨 */
    }
  }
  try {
    fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
    fs.writeFileSync(
      lockFile(),
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), host: config.host, port: config.port }),
      'utf8',
    );
    return { acquired: true };
  } catch (e) {
    return { acquired: false, reason: `write_failed:${e.message}` };
  }
}

/** 释放锁（仅当锁属于本进程时删除，避免误删他人刚拿到的锁）。 */
function release() {
  const existing = readLock();
  if (existing && Number(existing.pid) !== process.pid) return false;
  try {
    fs.unlinkSync(lockFile());
    return true;
  } catch {
    return false;
  }
}

module.exports = { acquire, release, lockFile, readLock, pidAlive, STALE_MS };
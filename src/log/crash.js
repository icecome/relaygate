'use strict';
/**
 * log/crash.js — 进程级异常记录。
 * 进程无任何全局处理时，未捕获异常会静默退出（无堆栈、无 WER），导致「服务无声
 * 消失」难以定位。本模块把异常与退出事件写入 logs/YYYY-MM-DD/crash.jsonl，
 * 并提供进程生命周期（exit/signal）留痕。
 */
const fs = require('fs');
const path = require('path');
const { localDateKey } = require('../lib/util');
const { logsDir } = require('../lib/paths');

function todayDir() {
  // 本地日期、且跟随 logsDir()：与 traffic/audit 共用同一个 logs/<date>/ 目录，
  // 日期键与根目录都不能各写一套。
  return path.join(logsDir(), localDateKey());
}

function serializeError(err) {
  if (!err) return { message: String(err) };
  if (typeof err !== 'object') return { message: String(err) };
  return {
    name: err.name,
    message: err.message,
    code: err.code,
    stack: err.stack,
  };
}

/** 追加一条事件到 crash.jsonl（best-effort，绝不能因写日志而抛错）。 */
function writeEvent(entry) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ...entry,
    });
    console.error(line);
    const dir = todayDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'crash.jsonl'), line + '\n', 'utf-8');
  } catch {
    /* 记录失败不影响主流程 */
  }
}

let installed = false;
/**
 * 优雅停机钩子，由 index.js 在启动时注册（registerShutdown）。
 * 信号处理先执行这些钩子，再由 force-exit 最后手段计时器接管。
 * @type {{label:string, fn:()=>void|Promise<void>}[]}
 */
const shutdownHooks = [];
let shuttingDown = false;

/**
 * 注册一个停机钩子。按注册顺序执行；任何一个钩子抛错都不阻断后续钩子。
 * @param {string} label 便于排查卡在哪个钩子的名字
 * @param {()=>void|Promise<void>} fn
 */
function onShutdown(label, fn) {
  shutdownHooks.push({ label, fn });
}

/**
 * 执行停机链并退出。
 * @param {string} reason 触发原因（信号名或手动调用说明）
 */
async function runShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  writeEvent({ tag: 'lifecycle', event: 'shutdown_begin', reason });
  // 5 秒最后手段：钩子挂死也要退出，服务管理器需要进程真正退出
  const force = setTimeout(() => {
    writeEvent({ tag: 'lifecycle', event: 'shutdown_timeout' });
    process.exit(1);
  }, 5000);
  try {
    for (const { label, fn } of shutdownHooks) {
      try {
        await fn();
      } catch (e) {
        writeEvent({ tag: 'lifecycle', event: 'shutdown_hook_error', hook: label, error: serializeError(e) });
      }
    }
    writeEvent({ tag: 'lifecycle', event: 'shutdown_done', reason });
  } finally {
    clearTimeout(force);
    process.exit(0);
  }
}

/**
 * 注册全局异常处理。应在任何业务模块 require 之前调用，以便捕获加载期异常。
 * @param {{onFatal?: (event: object) => void}} [opts]
 */
function install(opts = {}) {
  if (installed) return;
  installed = true;

  process.on('uncaughtException', (err) => {
    writeEvent({ tag: 'crash', event: 'uncaughtException', error: serializeError(err) });
    try {
      if (typeof opts.onFatal === 'function') opts.onFatal({ event: 'uncaughtException', error: err });
    } catch {
      /* 最后手段回调失败不阻断退出 */
    }
    // 未捕获异常后进程状态不可信，记录后退出，交由服务管理器拉起
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : { message: String(reason) };
    writeEvent({ tag: 'crash', event: 'unhandledRejection', error: serializeError(error) });
  });

  process.on('warning', (w) => {
    if (w && (w.name === 'MaxListenersExceededWarning' || w.name === 'DeprecationWarning')) {
      writeEvent({ tag: 'crash', event: 'warning', error: serializeError(w) });
    }
  });

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      writeEvent({ tag: 'lifecycle', event: 'signal', signal: sig });
      void runShutdown(sig);
    });
  }

  process.on('exit', (code) => {
    writeEvent({ tag: 'lifecycle', event: 'exit', code });
  });
}

module.exports = { install, writeEvent, serializeError, onShutdown, runShutdown };

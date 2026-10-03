'use strict';
/**
 * log/crash.js — 进程级异常落盘。
 *
 * 背景：进程无任何全局兜底时，未捕获异常会静默退出（无堆栈、无 WER），
 * 导致「服务无声消失」难以定位。此模块把异常与退出事件写入
 * logs/YYYY-MM-DD/crash.jsonl，并提供进程生命周期（exit/signal）留痕。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function todayDir() {
  return path.join(ROOT, 'logs', new Date().toISOString().slice(0, 10));
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
 * 注册全局兜底。应在任何业务模块 require 之前调用，以便捕获加载期异常。
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
      /* 兜底回调失败不阻断退出 */
    }
    // 未捕获异常后进程状态不可信，记录后退出交由服务管理器拉起
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
      process.exit(0);
    });
  }

  process.on('exit', (code) => {
    writeEvent({ tag: 'lifecycle', event: 'exit', code });
  });
}

module.exports = { install, writeEvent, serializeError };

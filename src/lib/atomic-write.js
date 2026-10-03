'use strict';
/**
 * lib/atomic-write.js — 配置文件原子落盘。
 *
 * 背景：全库 JSON 配置（scheduler-settings、rotate-settings、notify-settings、
 * model-status、model-router 等）此前一律 fs.writeFileSync 直接覆写。覆写过程
 * 不是原子的——进程在 truncate 之后、write 完成之前被杀死（或磁盘写满），
 * 文件会停留在半截 JSON，下次启动解析失败即静默回退默认值，用户配置丢失。
 *
 * 做法：写同目录临时文件 → fsync → rename 覆盖。同目录保证 rename 不跨设备
 * （跨设备 rename 会退化为 copy+unlink，失去原子性）；rename 在同一文件系统内
 * 是原子替换，读者要么看到旧内容要么看到新内容。
 *
 * 与「写前备份」的区别：本模块只保证单次写入不产生半截文件，不做版本留存。
 * 需要回滚历史版本的场景请用 jobs/backup.js。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 原子写入文本文件。父目录不存在时自动创建。
 *
 * @param {string} filePath 目标路径
 * @param {string} content  完整内容
 * @param {{encoding?:BufferEncoding, mode?:number}} [opts]
 * @returns {boolean} 是否成功（失败已记录日志，不抛出）
 */
function writeFileAtomic(filePath, content, opts = {}) {
  const encoding = opts.encoding || 'utf-8';
  const dir = path.dirname(filePath);
  // 同目录 + 随机后缀：并发写同一路径时互不覆盖临时文件
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(tmp, 'w', opts.mode);
    fs.writeFileSync(fd, content, encoding);
    // fsync 后再 rename：否则断电时可能留下「文件已改名但内容未落盘」的空壳
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, filePath);
    return true;
  } catch (e) {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    console.error(`[atomic-write] ${filePath} failed: ${e.message}`);
    return false;
  }
}

/**
 * 原子写入 JSON（自动缩进与末尾换行）。
 *
 * @param {string} filePath
 * @param {unknown} data
 * @param {{indent?:number, newline?:boolean}} [opts]
 * @returns {boolean} 是否成功
 */
function writeJsonAtomic(filePath, data, opts = {}) {
  const indent = opts.indent == null ? 2 : opts.indent;
  const newline = opts.newline !== false ? '\n' : '';
  return writeFileAtomic(filePath, JSON.stringify(data, null, indent) + newline);
}

module.exports = { writeFileAtomic, writeJsonAtomic };

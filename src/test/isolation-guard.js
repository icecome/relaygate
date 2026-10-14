'use strict';
/**
 * src/test/isolation-guard.js —— 测试隔离硬护栏。
 *
 * 为什么需要它：每个测试文件都靠「在 require 任何项目模块之前设置
 * WORKSPACE_DIR / TRAE_API_ENCRYPT_KEY」把状态目录与加密密钥指到临时位置。
 * 这只是「打算隔离」——一旦 config 加载 .env 时反向覆盖了它们，隔离就静默失效，
 * 测试的 store / import / backup / restore 用例会全部作用在**真实** output/
 * 状态目录上，用测试假密钥写真实账号库。
 *
 * 本项目已实际发生过一次：config 的 .env 加载曾改成 dotenv override:true，
 * 于是 .env 里的 WORKSPACE_DIR=./output 压掉了测试的临时目录，10 个测试文件里有
 * 若干把 73 行测试账号写进了真实凭据库（靠「用真实密钥解不开」才识别出来）。
 *
 * 因此不依赖断言阶段的自觉：require 本模块即当场判定，不通过直接退出，
 * 绝不进入测试体。
 *
 * 用法（必须在任何 `require('../...')` 之前）：
 *   process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `trae-test-${Date.now()}`);
 *   process.env.TRAE_API_ENCRYPT_KEY = 'a'.repeat(64);
 *   require('./isolation-guard')('unit');
 */
const os = require('node:os');
const path = require('node:path');

module.exports = function assertIsolated(testName) {
  const label = testName || 'test';
  const tmpRoot = path.resolve(os.tmpdir());
  const ws = process.env.WORKSPACE_DIR;

  // 日志目录一并隔离，且不必由各测试文件自己写：日志是运行期状态，
  // log/traffic.js、log/crash.js、log/audit.js 默认写 <ROOT>/logs，
  // 而 /v1/admin/stats/* 读的正是它——不隔离就会把测试流量写进真实统计口径
  // （实测 model=test、vm/sec-guard 之类的行会出现在统计面板与热力图里）。
  if (!process.env.LOGS_DIR && ws) {
    process.env.LOGS_DIR = path.join(String(ws), 'logs');
  }

  const problems = [];

  if (!ws) {
    problems.push('WORKSPACE_DIR 未设置：状态文件会落到默认的 <ROOT>/output');
  } else if (!path.resolve(String(ws)).startsWith(tmpRoot)) {
    problems.push(`WORKSPACE_DIR=${ws} 不在临时目录 ${tmpRoot} 内`);
  }

  if (!process.env.TRAE_API_ENCRYPT_KEY) {
    problems.push('TRAE_API_ENCRYPT_KEY 未设置：会读取真实的 encrypt.key，可能写入真实凭据');
  }

  const logs = process.env.LOGS_DIR;
  if (!logs) {
    problems.push('LOGS_DIR 未设置：日志会落到 <ROOT>/logs，测试流量会进统计面板');
  } else if (!path.resolve(String(logs)).startsWith(tmpRoot)) {
    problems.push(`LOGS_DIR=${logs} 不在临时目录 ${tmpRoot} 内`);
  }

  // 再问一次各模块自己的解析结果：env 设对了但被 .env 覆盖时，
  // 只有这一步能看出来。
  let cfg;
  try {
    cfg = require('../config');
  } catch (e) {
    problems.push(`require('../config') 失败：${e.message}`);
  }
  if (cfg && !path.resolve(String(cfg.workspaceDir)).startsWith(tmpRoot)) {
    problems.push(
      `config.workspaceDir=${cfg.workspaceDir} 不在临时目录内（.env 覆盖了进程环境变量？）`,
    );
  }
  try {
    const { logsDir } = require('../lib/paths');
    const resolved = logsDir();
    if (!path.resolve(String(resolved)).startsWith(tmpRoot)) {
      problems.push(`lib/paths.logsDir()=${resolved} 不在临时目录内`);
    }
  } catch (e) {
    problems.push(`require('../lib/paths') 失败：${e.message}`);
  }

  if (problems.length) {
    console.error(`\n[FATAL] ${label} 测试未处于隔离环境，拒绝运行：`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\n  这些用例会写入真实状态库与真实日志目录（账号 / 密钥 / 备份 / 统计口径），\n' +
      '  不是「测试失败」而是数据事故。\n' +
      '  请检查 src/config.js 的 .env 加载是否覆盖了进程环境变量。\n',
    );
    process.exit(1);
  }
};

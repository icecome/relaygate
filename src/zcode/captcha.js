'use strict';
/**
 * zcode/captcha.js — 阿里云无感验证码参数求解（免浏览器）。
 *
 * 背景：billing/claim 强制校验 X-Aliyun-Captcha-Verify-Param，服务端会回调
 * 阿里云验证接口核验；不带或伪造一律 code 3007「captcha verify failed」。
 * 官方客户端在浏览器里跑 AliyunCaptcha.js 的无感模式（startTracelessVerification）
 * 取一枚参数；本模块复用 zcode2api 的 Node 求解器（happy-dom 模拟浏览器），
 * 以子进程方式调用，避免依赖真实浏览器。
 *
 * 求解器约定（captcha_node/solver.js 头部注释）：
 *   用法   node solver.js <scene> <region> <prefix>
 *   成功   stdout 打印 VERIFY_PARAM=<param>，退出码 0
 *   失败   退出码 2 超时 / 3 初始化失败 / 4 fail / 5 onError / 6 参数无效
 *
 * 参数是一次性的（certifyId 不可复用，官方客户端日志有 F008 重复提交检测），
 * 且 TTL 约 2 分钟，故此处按「用时现解 + FIFO 淘汰」而非长驻池：
 * 定时任务一天两轮、单次领取数量有限，同步求解的等待（数秒）远小于业务代价。
 *
 * 零依赖降级：求解器不可用时抛 CaptchaUnavailableError，上层据此只探测不领取。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const variant = require('../platform/variant');
const identity = require('./identity');

const V = variant.variantOf(variant.ZCODE);

/** client/configs 返回空时的兜底配置（2026-10 实测值）。 */
const CAPTCHA_DEFAULTS = Object.freeze({
  enabled: true,
  prefix: 'no8xfe',
  region: 'cn',
  sceneId: '11xygtvd',
});

/** 求解器目录（内含 solver.js 与 node_modules/happy-dom）。 */
function solverDir() {
  const p = String(process.env.ZCODE_CAPTCHA_SOLVER_DIR || '').trim();
  if (p) return p;
  return path.join('C:', 'opt', 'workstations', 'project', 'zcode2api', 'captcha_node');
}
function solverJs() {
  return path.join(solverDir(), 'solver.js');
}
function nodeBin() {
  return String(process.env.ZCODE_NODE_PATH || process.env.ZCODE2API_NODE_PATH || 'node').trim() || 'node';
}

const SOLVE_TIMEOUT_MS = Number(process.env.ZCODE_CAPTCHA_TIMEOUT_MS || 45000);
const SOLVE_RETRIES = Math.max(1, Number(process.env.ZCODE_CAPTCHA_RETRIES || 3));

/** 验证码配置不可用（无 sceneId / 服务端 enabled=false 时视为免验证）。 */
class CaptchaUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'CaptchaUnavailableError'; }
}

/** 求解失败（已重试耗尽）。 */
class CaptchaSolveError extends Error {
  constructor(message, lastErr) { super(message); this.name = 'CaptchaSolveError'; this.lastErr = lastErr; }
}

/**
 * 拉取验证码配置（client/configs）。
 * 注意：该端点**禁止**带 platform 参数（实测带则 400 code 3001），
 * 也不需要 Authorization；故单独走最小头集，不复用 billing 身份头。
 */
async function fetchConfig() {
  const { request } = require('./client');
  try {
    const envelope = await request({
      method: 'GET',
      path: V.paths.clientConfigs,
      headers: {
        Accept: 'application/json',
        'User-Agent': `ZCode/${identity.appVersion()}`,
        'HTTP-Referer': V.identity.referer,
        'X-Title': identity.TITLE,
        'X-ZCode-App-Version': identity.appVersion(),
      },
      query: { app_version: identity.appVersion() },
      timeoutMs: 15000,
    });
    const cfg = envelope && envelope.code === 0
      ? (((envelope.data || {}).configs || {}).captcha)
      : null;
    return cfg && cfg.sceneId ? cfg : { ...CAPTCHA_DEFAULTS };
  } catch (e) {
    console.warn(`[zcode-captcha] client/configs 失败，使用默认配置: ${e.message}`);
    return { ...CAPTCHA_DEFAULTS };
  }
}

/** 求解器是否可用（文件 + Node 存在）。 */
function solverAvailable() {
  try {
    return fs.existsSync(solverJs()) && !!nodeBin();
  } catch {
    return false;
  }
}

/** 跑一次求解器，返回参数或 null。 */
function runSolver(scene, region, prefix) {
  return new Promise((resolve) => {
    const proc = spawn(nodeBin(), [solverJs(), scene, region, prefix], {
      cwd: solverDir(),
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* 已退出 */ }
      console.warn(`[zcode-captcha] 求解超时 ${SOLVE_TIMEOUT_MS}ms`);
      finish(null);
    }, SOLVE_TIMEOUT_MS);

    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.on('error', (err) => {
      console.error(`[zcode-captcha] 无法启动求解器: ${err.message}`);
      finish(null);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        console.warn(`[zcode-captcha] 求解器退出码 ${code}（${SOLVE_RETRIES} 次重试内）`);
        return finish(null);
      }
      for (const line of out.split(/\r?\n/)) {
        if (line.startsWith('VERIFY_PARAM=')) {
          const param = line.slice('VERIFY_PARAM='.length).trim();
          return finish(param || null);
        }
      }
      console.warn('[zcode-captcha] 求解器未输出 VERIFY_PARAM');
      return finish(null);
    });
  });
}

/**
 * 取一枚可用的验证码参数（重试若干次）。
 * @returns {Promise<{param:string, region:string}>}
 */
async function getVerifyParam() {
  if (!solverAvailable()) {
    throw new CaptchaUnavailableError(
      `未找到验证码求解器 ${solverJs()}；请在 ${solverDir()} 执行 npm install，或设 ZCODE_CAPTCHA_SOLVER_DIR 指向正确目录`
    );
  }
  const cfg = await fetchConfig();
  if (cfg.enabled === false) {
    throw new CaptchaUnavailableError('服务端 captcha.enabled=false，无需验证码');
  }
  const scene = cfg.sceneId || CAPTCHA_DEFAULTS.sceneId;
  const region = cfg.region || CAPTCHA_DEFAULTS.region;
  const prefix = cfg.prefix || CAPTCHA_DEFAULTS.prefix;
  let lastErr = null;
  for (let i = 1; i <= SOLVE_RETRIES; i++) {
    // eslint-disable-next-line no-await-in-loop
    const param = await runSolver(scene, region, prefix);
    if (param) {
      if (i > 1) console.log(`[zcode-captcha] 第 ${i} 次求解成功`);
      return { param, region };
    }
    lastErr = `第 ${i}/${SOLVE_RETRIES} 次求解无结果`;
  }
  throw new CaptchaSolveError(`验证码求解失败: ${lastErr}`);
}

/** claim 请求头：叠加验证码参数（参数 + region 必须同时带，缺 region 亦 3007）。 */
function claimHeaders(verifyParam, region) {
  return {
    'X-Aliyun-Captcha-Verify-Param': verifyParam,
    'X-Aliyun-Captcha-Verify-Region': String(region || CAPTCHA_DEFAULTS.region).trim(),
  };
}

module.exports = {
  CAPTCHA_DEFAULTS,
  CaptchaUnavailableError,
  CaptchaSolveError,
  fetchConfig,
  solverAvailable,
  solverDir,
  solverJs,
  getVerifyParam,
  claimHeaders,
};
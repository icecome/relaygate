'use strict';
/**
 * zcode/fingerprint.js — 每账号客户端设备档案（一号一台）。
 *
 * 背景：ZCode 上游按「设备指纹」识别客户端。官方客户端是 Electron 桌面端
 * （darwin-arm64 / win32-x64 为主），若把部署机形态直接发给上游，会聚成
 * 「一台机房机器开了 N 个 ZCode」。本模块为每个账号分配一套**成套**桌面
 * SKU：platform × arch × os_version × screen 必须互相自洽（禁止笛卡尔积，
 * 例如 darwin-arm64 不可能配 1366x768），并配一个独立的 device_mid。
 *
 * 档案一经分配即稳定（存 accounts.fingerprint），除非显式 rotate。
 * 字段集与取值范围对齐 zcode2api/app/fingerprint.py（同一上游契约）。
 */
const crypto = require('crypto');

/**
 * 成套桌面 SKU：(weight, platform, arch, osVersion, screen)
 * 分辨率与平台绑定（Mac 逻辑分辨率不配 Windows），权重贴近真实分布。
 */
const SKUS = [
  // Apple silicon MacBook Air/Pro 13–14"（darwin 24 = Sequoia，25 = Tahoe）
  [10, 'darwin', 'arm64', '24.5.0', '1512x982'],
  [10, 'darwin', 'arm64', '24.6.0', '1512x982'],
  [8, 'darwin', 'arm64', '24.5.0', '1728x1117'],
  [8, 'darwin', 'arm64', '24.6.0', '1728x1117'],
  [8, 'darwin', 'arm64', '25.5.0', '1512x982'],
  [6, 'darwin', 'arm64', '25.5.0', '1728x1117'],
  [5, 'darwin', 'arm64', '23.6.0', '1512x982'],
  [4, 'darwin', 'arm64', '23.6.0', '1728x1117'],
  [4, 'darwin', 'arm64', '24.5.0', '2560x1440'],
  [3, 'darwin', 'arm64', '24.6.0', '2560x1600'],
  [2, 'darwin', 'arm64', '25.5.0', '2560x1440'],
  [2, 'darwin', 'arm64', '24.5.0', '3840x2160'],
  // Intel Mac 存量（Ventura/Sonoma；darwin 24+ 不再配 x64）
  [2, 'darwin', 'x64', '23.6.0', '1920x1080'],
  [2, 'darwin', 'x64', '22.6.0', '1440x900'],
  [1, 'darwin', 'x64', '23.6.0', '2560x1440'],
  // Windows 11 主流 + 少量 Win10
  [8, 'win32', 'x64', '10.0.22631', '1920x1080'],
  [7, 'win32', 'x64', '10.0.26100', '1920x1080'],
  [5, 'win32', 'x64', '10.0.22631', '2560x1440'],
  [4, 'win32', 'x64', '10.0.26200', '1920x1080'],
  [3, 'win32', 'x64', '10.0.26100', '2560x1440'],
  [3, 'win32', 'x64', '10.0.22621', '1920x1080'],
  [2, 'win32', 'x64', '10.0.22631', '3840x2160'],
  [2, 'win32', 'x64', '10.0.19045', '1920x1080'],
  [1, 'win32', 'x64', '10.0.19045', '1366x768'],
  [1, 'win32', 'x64', '10.0.26100', '2560x1600'],
  [1, 'win32', 'x64', '10.0.22000', '1920x1080'],
];

/** 按权重展开的抽样池。 */
const SKU_POOL = SKUS.flatMap(([w, ...rest]) => Array.from({ length: w }, () => rest));

/** 允许的 (platform, arch, osVersion, screen) 组合集合。 */
const SKU_COMBOS = new Set(SKU_POOL.map(([p, a, v, s]) => `${p}|${a}|${v}|${s}`));

/** 语言-时区真实地区组合（X-Client-Language ↔ X-Client-Timezone 必须成对）。 */
const LOCALES = [
  ['zh-CN', 'Asia/Shanghai'],
  ['en-US', 'America/New_York'],
  ['en-US', 'America/Los_Angeles'],
  ['en-GB', 'Europe/London'],
  ['de-DE', 'Europe/Berlin'],
  ['ja-JP', 'Asia/Tokyo'],
  ['ko-KR', 'Asia/Seoul'],
  ['en-SG', 'Asia/Singapore'],
];

const SCREEN_RE = /^\d{3,4}x\d{3,4}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid4() {
  return crypto.randomUUID();
}

function pick(list) {
  return list[crypto.randomInt(list.length)];
}

/** 档案是否内部自洽（成套 SKU / 真实地区对 / 分辨率形态 / 合法 UUID）。 */
function validate(fp) {
  if (!fp || typeof fp !== 'object') return '空档案';
  const { platform, arch, osVersion, screen, language, timezone, deviceMid } = fp;
  if (!platform || !arch || !osVersion || !screen) return '缺少平台/架构/系统/分辨率';
  if (!SKU_COMBOS.has(`${platform}|${arch}|${osVersion}|${screen}`)) {
    return `非成套桌面 SKU: ${platform}-${arch}/${osVersion}/${screen}`;
  }
  if (!LOCALES.some(([l, t]) => l === language && t === timezone)) {
    return `语言/时区组合不真实: ${language}/${timezone}`;
  }
  if (!SCREEN_RE.test(String(screen))) return `分辨率形态非法: ${screen}`;
  if (!UUID_RE.test(String(deviceMid || ''))) return `device_mid 非 UUID: ${deviceMid}`;
  return null;
}

/** 生成一套全新档案（字段自洽）。 */
function generate() {
  const [platform, arch, osVersion, screen] = pick(SKU_POOL);
  const [language, timezone] = pick(LOCALES);
  const fp = { platform, arch, osVersion, language, timezone, screen, deviceMid: uuid4() };
  const err = validate(fp);
  if (err) throw new Error(`生成指纹失败: ${err}`);
  return fp;
}

/** 档案是否为生成 SKU（旧版宿主机克隆为 false）。 */
function isGenerated(fp) {
  return !!fp && SKU_COMBOS.has(`${fp.platform}|${fp.arch}|${fp.osVersion}|${fp.screen}`);
}

/**
 * 取账号档案：无则生成并回调持久化。
 * @param {object} acct accounts 行（含 fingerprint 字段）
 * @param {() => void} [persist] 档案变更时的持久化回调（由调用方接 store.update）
 */
function profileFor(acct, persist) {
  const raw = acct && acct.fingerprint;
  if (raw && !validate(raw)) return raw;
  const fp = generate();
  if (persist && acct && acct.id) {
    try { persist(fp); } catch { /* 落库失败不阻断本次请求 */ }
  }
  return fp;
}

/**
 * 为本机构造档案（本机客户端凭据导入用）。
 *
 * 与随机 SKU 的区别：本机导入的账号就是这台机器上的真实客户端账号，
 * 沿用它的真实 device_mid 与宿主平台形态，比「假装是伦敦的 Mac」更少
 * 设备维度风控信号（客户端自己上报的日活/激活事件用的就是这个 device_mid）。
 *
 * 仍走成套 SKU 约束：平台/架构必须匹配宿主，os_version 与 screen 从对应
 * 平台的合法组合里取，语言-时区按宿主 locale 就近选真实地区对。
 *
 * @param {string|null} [deviceMid] 客户端 telemetry-state.json 的 deviceMid
 */
function forHost(deviceMid) {
  const os = require('os');
  const plat = os.platform(); // win32 / darwin / linux
  // 官方桌面端不含 linux 形态；宿主为 linux 时退回随机 SKU
  const arch = os.arch() === 'x64' ? 'x64' : (os.arch() === 'arm64' ? 'arm64' : 'x64');
  const combos = SKU_POOL.filter(([p, a]) => p === plat && a === arch);
  if (!combos.length) return generate();

  const [p, a, osVersion, screen] = pick(combos);
  const locale = String(Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase();
  const tz = String(process.env.TZ || os.timezone?.() || '');
  let [language, timezone] = pick(LOCALES);
  if (locale.startsWith('zh')) {
    const zh = LOCALES.find(([l, t]) => l === 'zh-CN' && (t === tz || tz.includes('Shanghai')));
    if (zh) [language, timezone] = zh;
    else [language, timezone] = ['zh-CN', 'Asia/Shanghai'];
  } else if (tz) {
    const same = LOCALES.find(([, t]) => t === tz);
    if (same) [language, timezone] = same;
  }

  const fp = {
    platform: p, arch: a, osVersion, language, timezone, screen,
    deviceMid: isValidUuid(deviceMid) ? String(deviceMid).toLowerCase() : uuid4(),
  };
  const err = validate(fp);
  if (err) {
    // 宿主形态与 SKU 表冲突（如 linux）时兜底随机档案，保证可用性
    const alt = generate();
    if (isValidUuid(deviceMid)) alt.deviceMid = String(deviceMid).toLowerCase();
    return alt;
  }
  return fp;
}

const UUID_RE2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(v) {
  return typeof v === 'string' && UUID_RE2.test(v.trim());
}

/** 换发全新档案（风控后换设备语义；device_mid 必变）。 */
function rotate() {
  return generate();
}

// ── 派生取值（映射到上游头字段） ────────────────────────────────────────────

/** X-Platform 的 messages 形态：<platform>-<arch>（实测 billing 面要求同形态）。 */
function platformFull(fp) {
  return `${fp.platform}-${fp.arch}`;
}

/** X-Os-Category：darwin→macos / win32→windows / 其余→linux。 */
function osCategory(fp) {
  if (fp.platform === 'darwin' || fp.platform === 'macos') return 'macos';
  if (fp.platform === 'win32' || fp.platform === 'windows') return 'windows';
  return 'linux';
}

module.exports = {
  SKUS,
  LOCALES,
  validate,
  generate,
  forHost,
  isGenerated,
  profileFor,
  rotate,
  platformFull,
  osCategory,
  uuid4,
};
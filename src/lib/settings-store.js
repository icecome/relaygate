'use strict';
/**
 * lib/settings-store.js — 本机 JSON 设置文件的统一读写。
 *
 * 五处设置模块（jobs/scheduler-settings、jobs/rotate-settings、notify/settings、
 * jobs/balance-refresh、jobs/backup）此前各自实现同一套骨架：
 * readStored（读 JSON，失败回 {}）→ getEffective（文件 > env > 默认，逐字段夹紧）
 * → save（白名单取值 + 夹紧 + writeJsonAtomic）。差异只在字段表，故收敛到此处。
 *
 * 字段描述符：
 *   type      'int' | 'bool' | 'string'；缺省时按是否给出 min/max 推断为 int
 *   env       对应的环境变量名；缺省表示该字段没有 env 兜底
 *   default   默认值，可以是值或返回值的函数
 *   min/max   int 字段的夹紧区间
 *   keepEmpty string 字段：文件里的空串视为有效值（不再回落到 env）
 *   saveEmpty string 字段：save 是否接受空串（false 表示空串不覆盖既有值）
 *   invalidToDefault  int 字段：save 遇到非法值时写入默认值而非跳过
 *                     （rotate-settings 的历史行为，收敛时保持等价）
 *   transform string 字段读取后的加工（如 path.resolve），仅作用于读取
 */
const fs = require('fs');
const { writeJsonAtomic } = require('./atomic-write');
const { stateFile, resolveStateFileForRead } = require('./paths');

/** 整数取值：空值与非有限值一律视为无效（Number('') === 0 需显式排除）。 */
function clampInt(v, min, max) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(Math.round(n), min), max);
}

/** 布尔取值：文件值按 truthy；env 额外把 'false' / '0' / 'off' 视为假。 */
function coerceBool(v, fromEnv) {
  if (!fromEnv) return !!v;
  return !['false', '0', 'off'].includes(String(v));
}

function typeOf(spec) {
  return spec.type || (spec.min != null || spec.max != null ? 'int' : 'string');
}

/**
 * 单字段取值。
 * @param {object} spec
 * @param {*} v 原始值
 * @param {boolean} fromEnv 是否来自环境变量
 * @param {boolean} forSave 是否用于写入（写入不做 transform，保持落盘值为用户输入）
 * @returns {*} 无效时返回 null，由调用方决定回落
 */
function coerce(spec, v, fromEnv, forSave) {
  if (v == null) return null;
  const type = typeOf(spec);
  if (type === 'bool') return coerceBool(v, fromEnv);
  if (type === 'string') {
    const s = String(v).trim();
    if (!s && !spec.keepEmpty) return null;
    return !forSave && spec.transform ? spec.transform(s) : s;
  }
  return clampInt(v, spec.min, spec.max);
}

/** 写入专用：布尔只接受真布尔值，避免字符串 'yes' 被当成 true 落盘。 */
function coerceForSave(spec, v) {
  if (typeOf(spec) === 'bool') return typeof v === 'boolean' ? v : null;
  if (typeOf(spec) === 'string' && spec.saveEmpty === false) {
    if (v == null || String(v).trim() === '') return null;
  }
  return coerce(spec, v, false, true);
}

/**
 * @param {object} opts
 * @param {string} opts.name .trae-api 下的文件名（读写路径的默认来源）
 * @param {Record<string, object>} opts.specs 字段描述符表
 * @param {() => string} [opts.fileOf] 写入路径，缺省 stateFile(name)
 * @param {() => string} [opts.readFileOf] 读取路径，缺省按存在性回退旧位置
 */
function createSettingsStore({ name, specs, fileOf, readFileOf }) {
  const FILE = fileOf || (() => stateFile(name));
  const readFile = readFileOf || (() => resolveStateFileForRead(name, fs.existsSync));
  const keys = Object.keys(specs);

  function readStored() {
    try {
      const raw = JSON.parse(fs.readFileSync(readFile(), 'utf-8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  function writeStored(stored) {
    writeJsonAtomic(FILE(), stored);
    return stored;
  }

  function resolveField(spec, stored) {
    const fromFile = coerce(spec, stored[spec.key], false, false);
    if (fromFile != null) return fromFile;
    const envRaw = spec.env ? process.env[spec.env] : null;
    if (envRaw != null && envRaw !== '') {
      const fromEnv = coerce(spec, envRaw, true, false);
      if (fromEnv != null) return fromEnv;
    }
    return typeof spec.default === 'function' ? spec.default() : spec.default;
  }

  /** 合并后的生效配置（文件 > env > 默认）。 */
  function getEffective() {
    const stored = readStored();
    const out = {};
    for (const key of keys) out[key] = resolveField({ ...specs[key], key }, stored);
    return out;
  }

  /** 保存传入字段（白名单 + 夹紧），返回生效配置。 */
  function save(partial) {
    const stored = readStored();
    for (const key of keys) {
      const spec = specs[key];
      let v = coerceForSave(spec, partial[key]);
      // 非法值按字段声明处理：默认跳过（不覆盖既有值），声明了 invalidToDefault 时写入默认值
      if (v == null && spec.invalidToDefault && typeOf(spec) === 'int' && partial[key] != null) {
        v = typeof spec.default === 'function' ? spec.default() : spec.default;
      }
      if (v != null) stored[key] = v;
    }
    writeStored(stored);
    return getEffective();
  }

  return { FILE, readFile, readStored, writeStored, getEffective, save };
}

module.exports = { createSettingsStore, clampInt };
'use strict';
/**
 * lib/client-meta.js — Trae 真实客户端安装元数据扫描（m-35 拆分自 lib/auth.js）。
 *
 * 职责单一：从本机安装目录的 manifest.json / product.json 读取 appVersion /
 * buildVersion，带 TTL 缓存（含 null 结果）。headersFor 每请求会调 5 次版本函数，
 * 而候选目录常不存在（每次 5 轮 existsSync），高并发下同步 IO 会阻塞事件循环。
 *
 * 依赖方向：本模块为叶子，不 require 任何业务模块（auth.js → client-meta 单向）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** TTL 缓存窗口：客户端升级后最多延迟一个 TTL 生效。 */
const CLIENT_META_TTL_MS = (() => {
  const n = Number(process.env.TRAE_CLIENT_META_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 5 * 60 * 1000;
})();
let _clientMetaCache = null;
let _clientMetaAt = 0;
const CLIENT_META_UNSET = 0; // _clientMetaAt 初始值：0 表示尚未扫描过

function readRealClientMeta() {
  const now = Date.now();
  if (_clientMetaAt !== CLIENT_META_UNSET && now - _clientMetaAt < CLIENT_META_TTL_MS) {
    return _clientMetaCache;
  }
  _clientMetaCache = scanRealClientMeta();
  _clientMetaAt = now;
  return _clientMetaCache;
}

function scanRealClientMeta() {
  // 客户端安装目录候选：TRAE_CLIENT_DIR 优先（非标准安装位置时用），
  // 其余为 Windows 常见安装路径。
  const candidates = [
    process.env.TRAE_CLIENT_DIR,
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Trae SOLO CN'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Trae SOLO'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Trae-CN'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Trae'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      const manifestPath = path.join(dir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const productPath = path.join(dir, 'resources', 'app', 'product.json');
      let buildVersion = '';
      try {
        if (fs.existsSync(productPath)) {
          buildVersion = JSON.parse(fs.readFileSync(productPath, 'utf-8')).buildVersion || '';
        }
      } catch (e) { /* ignore */ }
      return {
        dir,
        appVersion: manifest.appVersion || '',
        buildVersion: buildVersion || manifest.buildVersion || '',
      };
    } catch (e) {
      continue;
    }
  }
  return null;
}

/** 清空客户端元数据缓存（测试或客户端升级后手动刷新用）。 */
function resetClientMetaCache() {
  _clientMetaCache = null;
  _clientMetaAt = 0;
}

module.exports = { readRealClientMeta, resetClientMetaCache };

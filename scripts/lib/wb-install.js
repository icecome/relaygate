'use strict';
/**
 * scripts/lib/wb-install.js — 定位 WorkBuddy 桌面客户端安装（app.asar）。
 *
 * 供 check-wb-fingerprint.js 与 probes/wb-asar.js 共用。探测顺序
 * （最可靠 → 最通用）：
 *   1. WB_ASAR 环境变量（显式覆盖；指向不存在的文件时告警并继续兜底）；
 *   2. 注册表卸载条目（HKLM/HKCU，含 WOW6432Node）的 DisplayIcon /
 *      UninstallString —— NSIS 条目普遍不写 InstallLocation（实测
 *      WorkBuddy 5.8.3 条目就没有），但 DisplayIcon 恒为
 *      「安装目录\WorkBuddy.exe,0」，自定义安装位置也能定位；
 *   3. 常见安装路径候选（NSIS 默认值：per-user %LOCALAPPDATA%\Programs、
 *      per-machine %ProgramFiles%，含 Tencent 子目录与裸目录两种布局）；
 *   4. 本项目开发机的非标准安装位置（C:\opt\software\...，保留兜底）。
 */
const fs = require('fs');
const path = require('path');

/** 常见安装目录布局（相对各根目录）。 */
const CANDIDATE_SUBDIRS = [
  ['Programs', 'WorkBuddy'],
  ['Programs', 'Tencent', 'WorkBuddy'],
  ['Tencent', 'WorkBuddy'],
  ['WorkBuddy'],
];

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function asarUnder(installDir) {
  if (!installDir) return null;
  const p = path.join(installDir, 'resources', 'app.asar');
  return isFile(p) ? p : null;
}

/** 从注册表值（DisplayIcon / UninstallString）里抠出 exe 路径。
 *  reg query 输出形如 `    DisplayIcon    REG_SZ    C:\x\WorkBuddy.exe,0` 或
 *  `    UninstallString    REG_SZ    "C:\x\Uninstall WorkBuddy.exe" /allusers`：
 *  优先取引号包裹的 exe，否则取 REG_SZ 行里首个绝对盘符路径。 */
function exeFromRegistryValue(v) {
  const s = String(v || '');
  const quoted = s.match(/"([^"]+\.exe)"/i);
  if (quoted) return quoted[1];
  const line = s.split(/\r?\n/).find((l) => /REG_(?:EXPAND_)?SZ/.test(l)) || '';
  const bare = line.match(/([A-Za-z]:[^\s"]*\.exe)/i);
  return bare ? bare[1] : null;
}

function queryReg(args) {
  try {
    const { execFileSync } = require('child_process');
    return execFileSync('reg', args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; }
}

/** 注册表探测：从卸载条目反推安装目录。 */
function fromRegistry() {
  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    const out = queryReg(['query', root, '/s', '/f', 'WorkBuddy', '/d']);
    const keyLines = out.split(/\r?\n/).filter((l) => l.includes('HKEY_'));
    for (const k of keyLines) {
      // DisplayIcon 优先（直指主程序）；UninstallString 的 exe 与主程序同目录，等价兜底
      for (const valueName of ['DisplayIcon', 'UninstallString']) {
        const v = queryReg(['query', k, '/v', valueName]);
        const asar = asarUnder(path.dirname(exeFromRegistryValue(v) || ''));
        if (asar) return { asar, source: `registry:${valueName}` };
      }
    }
  }
  return null;
}

/** 常见路径候选探测。 */
function fromCandidates() {
  const bases = [];
  if (process.env.LOCALAPPDATA) {
    bases.push(path.join(process.env.LOCALAPPDATA, 'Programs'));
    bases.push(process.env.LOCALAPPDATA);
  }
  if (process.env.ProgramFiles) bases.push(process.env.ProgramFiles);
  if (process.env['ProgramFiles(x86)']) bases.push(process.env['ProgramFiles(x86)']);
  for (const base of bases) {
    for (const sub of CANDIDATE_SUBDIRS) {
      const asar = asarUnder(path.join(base, ...sub));
      if (asar) return { asar, source: 'path-candidate' };
    }
  }
  return null;
}

/** 本项目开发环境的非标准安装位置（最后兜底）。 */
function fromLegacyDevPath() {
  const asar = 'C:\\opt\\software\\Tencent\\WorkBuddy\\resources\\app.asar';
  return isFile(asar) ? { asar, source: 'legacy-dev-path' } : null;
}

/**
 * 定位 app.asar。返回 {asar, source}；全部落空返回 null
 * （调用方自行决定报错还是跳过检查）。
 *
 * @param {{env?:object, exists?:(p:string)=>boolean, registry?:Function,
 *          candidates?:Function, legacy?:Function}} [opts] 测试用依赖注入
 */
function discoverAsar(opts = {}) {
  const env = opts.env || process.env;
  const exists = opts.exists || isFile;
  if (env.WB_ASAR) {
    if (exists(env.WB_ASAR)) return { asar: env.WB_ASAR, source: 'env:WB_ASAR' };
    console.warn(`[wb-install] WB_ASAR 指向的文件不存在，忽略并继续探测: ${env.WB_ASAR}`);
  }
  return (opts.registry || fromRegistry)()
    || (opts.candidates || fromCandidates)()
    || (opts.legacy || fromLegacyDevPath)();
}

module.exports = { discoverAsar };

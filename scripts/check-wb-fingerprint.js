'use strict';
/**
 * scripts/check-wb-fingerprint.js — WorkBuddy 客户端指纹漂移检查。
 *
 * 背景：渠道校验（11128）按「请求形状像不像官方客户端」判定，而我们模拟的
 * UA/版本号是静态声明（platform/variant.js#identity）。官方客户端每次升级，
 * 静态声明就开始衰减——社区已有 WorkBuddy/5.5.2 旧版本号被风控怀疑的先例。
 *
 * 用法：
 *   node scripts/check-wb-fingerprint.js            # 检查并打印对比表
 *   node scripts/check-wb-fingerprint.js --update   # 检测到漂移时自动改 variant.js
 * 退出码：0 = 指纹一致或已自动更新；1 = 检测到漂移且未更新（供 cron/CI 报警）。
 *
 * 数据源优先级：本机安装的真实 app.asar（最权威）> 注册表卸载信息。
 * 只读，不写客户端目录。
 */
const fs = require('fs');
const path = require('path');

const ASAR = process.env.WB_ASAR || 'C:\\opt\\software\\Tencent\\WorkBuddy\\resources\\app.asar';
const VARIANT = path.join(__dirname, '..', 'src', 'platform', 'variant.js');

/** 从 asar/unpacked 读版本。app 版本在根 package.json；CLI 版本官方取值链是
 *  cli/package.json 的 publishConfig.customPackage.version（fallback 顶层 version），
 *  见 app.asar.unpacked/cli/bin/codebuddy 的 CLIENT_INFO_PRODUCT_VERSION 兜底逻辑。 */
function asarVersion() {
  if (!fs.existsSync(ASAR)) return null;
  const app = readAsarJson('package.json');
  const cli = readAsarJson('cli/package.json');
  const appVersion = app && app.version ? String(app.version) : null;
  const cliVersion = cli && cli.publishConfig && cli.publishConfig.customPackage && cli.publishConfig.customPackage.version
    ? String(cli.publishConfig.customPackage.version)
    : (cli && cli.version && cli.version !== '0.0.0' ? String(cli.version) : null);
  if (!appVersion && !cliVersion) return null;
  return { appVersion, cliVersion, source: ASAR };
}

/** 读 asar 内 JSON（自动跟随 unpacked 标记）；失败返回 null。 */
function readAsarJson(rel) {
  try {
    if (!fs.existsSync(ASAR)) return null;
    const buf = fs.readFileSync(ASAR);
    // asar（Chrome pickle）布局：u32@0=4，u32@4=header pickle 总长，
    // 数据区基点 = 8 + u32@4（4 字节对齐）。header JSON 本体在 16..16+jsonLen，
    // 但文件偏移的参照系是**对齐后的基点**——直接用 16+jsonLen 会差出
    // 1~3 字节填充（实测本机 pkg 前垫了 3 个 \0，JSON.parse 直接炸）。
    const jsonLen = buf.readUInt32LE(12);
    const hdr = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'));
    let node = hdr;
    for (const s of rel.split('/')) {
      node = node && node.files ? node.files[s] : undefined;
      if (!node) return null;
    }
    if (node.files) return null;
    if (node.unpacked) {
      const p = path.join(ASAR + '.unpacked', rel);
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    const DATA = 8 + buf.readUInt32LE(4);
    const off = Number(node.offset);
    const size = Number(node.size);
    return JSON.parse(Buffer.from(buf.slice(DATA + off, DATA + off + size)).toString('utf8'));
  } catch { return null; }
}

/** 从 Windows 注册表卸载信息读显示版本（asar 不可用时的降级路径）。
 *  返回 {appVersion}——注册表只有应用版本，没有内嵌 CLI 版本。 */
function registryVersion() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'WorkBuddy', '/d'], { encoding: 'utf8', timeout: 10000 });
    const m = out.match(/DisplayVersion\s+REG_SZ\s+([\d.]+)/);
    return m ? { appVersion: m[1], cliVersion: null, source: 'registry Uninstall' } : null;
  } catch { return null; }
}

/** 从 variant.js 源码里抠当前声明的版本（不 require，避免 .env 侧效应）。 */
function declaredVersions() {
  const src = fs.readFileSync(VARIANT, 'utf8');
  const m = src.match(/appVersion:\s*'([^']+)'/);
  const c = src.match(/cliVersion:\s*'([^']+)'/);
  const u = src.match(/userAgent:\s*'([^']+)'/);
  return { app: m ? m[1] : null, cli: c ? c[1] : null, ua: u ? u[1] : null };
}

function main() {
  const wantUpdate = process.argv.includes('--update');
  const real = asarVersion() || registryVersion();
  const decl = declaredVersions();
  if (!real) {
    console.log('[wb-fingerprint] 本机未找到 WorkBuddy 安装（asar 与注册表都不可用），跳过检查');
    console.log(`  声明指纹保持：app=${decl.app} cli=${decl.cli}`);
    return 0;
  }
  // CLI 版本拿不到时（客户端结构变化）不误报：只比对新到的字段
  const rows = [
    ['appVersion', decl.app, real.appVersion, real.appVersion != null],
    ['cliVersion', decl.cli, real.cliVersion, real.cliVersion != null],
  ].filter(([, , , have]) => have);
  console.log('[wb-fingerprint] 客户端指纹对比（声明 vs 本机真实安装）：');
  let drift = false;
  for (const [k, declared, actual] of rows) {
    const ok = declared === actual;
    if (!ok) drift = true;
    console.log(`  ${ok ? '✓' : '✗'} ${k.padEnd(10)} 声明=${declared}  真实=${actual}`);
  }
  if (!drift) {
    console.log('[wb-fingerprint] 指纹一致');
    return 0;
  }
  if (!wantUpdate) {
    console.log('[wb-fingerprint] 检测到漂移。官方客户端已升级，静态指纹开始衰减。');
    console.log('  处置：升级客户端后执行 node scripts/check-wb-fingerprint.js --update');
    return 1;
  }
  // --update：把 variant.js 里 WORKBUDDY 段的 appVersion/cliVersion 改成本机真实版本。
  // 只动 WORKBUDDY 块（用键名锚点定位），不碰其他平台的同名键。
  const src = fs.readFileSync(VARIANT, 'utf8');
  const anchor = src.indexOf('[WORKBUDDY]');
  if (anchor < 0) {
    console.error('[wb-fingerprint] variant.js 中找不到 [WORKBUDDY] 锚点，拒绝盲改');
    return 1;
  }
  // 块边界 = 下一个**平台级键**（行首两空格缩进的 [XXX]:），不是下一个 '['——
  // 块内到处是数组字面量（rateLimitCodes: [6004] 等），拿 '[' 当边界会把块切短。
  const rest = src.slice(anchor + 1);
  const nextKey = rest.match(/\n  \[[A-Z_]+\]:/);
  const end = nextKey ? anchor + 1 + nextKey.index + 1 : src.length;
  const block = src.slice(anchor, end);
  let updated = block;
  if (real.appVersion != null) updated = updated.replace(/appVersion:\s*'[^']*'/, `appVersion: '${real.appVersion}'`);
  if (real.cliVersion != null) updated = updated.replace(/cliVersion:\s*'[^']*'/, `cliVersion: '${real.cliVersion}'`);
  if (updated === block) {
    console.error('[wb-fingerprint] 未找到可替换的 appVersion/cliVersion 声明');
    return 1;
  }
  fs.writeFileSync(VARIANT, src.slice(0, anchor) + updated + src.slice(end));
  console.log(`[wb-fingerprint] variant.js 已更新：app=${real.appVersion} cli=${real.cliVersion}（来源 ${real.source}）`);
  console.log('  提醒：重启服务生效；UA 模板（identity.userAgent）里内嵌的版本号也要同步核对，');
  console.log('  或临时用 WB_UA 环境变量覆盖。');
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { asarVersion, registryVersion, declaredVersions };

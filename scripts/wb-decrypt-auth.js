'use strict';
/**
 * scripts/wb-decrypt-auth.js — 解开 WorkBuddy 客户端 at-rest 加密的凭据备份。
 *
 * 背景：新版客户端把 token/nickname/phoneNumber 等字段加密为
 * {$wbEncrypted:1, envelope:"<base64>"}，信封为 AES-256-GCM：
 *   - 密钥 = 32 字节 at-rest 保护密钥（keyId = sha256(key).slice(0,16)）
 *   - 信封明文为 JSON {suite,keyId,nonce,authTag,ciphertext}
 *   - AAD = 'WB-AAD\0' | 0x01 | u32be(len)+framingTag | u32be(len)+scheme |
 *           u32be(suite) | u32be(len)+keyId | framingId | 0x00 | 0x00
 *     其中 framing='field' → tag 'WBEV1'，framingId=2，scheme='sym-v1'
 *     （与客户端 app.asar 中 buildAuthenticatedContextAad 逐字节一致）
 *
 * 密钥来源（二选一，本机取证）：
 *   - 环境变量 WB_ATREST_KEY：base64 的 32 字节保护密钥（推荐）
 *   - 或由 scripts/wb-mem-keys.js 的扫描结果提供
 * 密钥校验：sha256(key) 的前 16 位十六进制必须等于信封里的 keyId。
 *
 * 用法：
 *   set WB_ATREST_KEY=x0qv...QFU=
 *   node scripts/wb-decrypt-auth.js                 # 解全部，输出到 logs/_wb-plain
 *   node scripts/wb-decrypt-auth.js --out <目录>
 * 输出为明文 .info 文件，可直接喂给 scripts/import-wb-auth.js（WB_AUTH_DIR 指向输出目录）。
 * 明文含真实 token，输出目录已在 .gitignore（logs/）内，勿提交。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUTH_DIR = process.env.WB_AUTH_DIR || path.join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
const OUT_DIR = (() => {
  const i = process.argv.indexOf('--out');
  return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(__dirname, '..', 'logs', '_wb-plain');
})();

const KEY_B64 = String(process.env.WB_ATREST_KEY || '').trim();
if (!KEY_B64) {
  console.error('缺少 WB_ATREST_KEY（32 字节 at-rest 保护密钥的 base64）');
  process.exit(2);
}
const KEY = Buffer.from(KEY_B64, 'base64');
if (KEY.length !== 32) {
  console.error(`WB_ATREST_KEY 解码后应为 32 字节，实际 ${KEY.length}`);
  process.exit(2);
}

const GE = { file: 'WBEF1', field: 'WBEV1', record: 'WBER1', stream: 'WBES1' };
const FRAMING_ID = { file: 1, field: 2, record: 3, stream: 4 };

function u32(n) { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(n); return b; }
function lp(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]); }
function aad(framing, suite, keyId) {
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lp(GE[framing]),
    lp('sym-v1'),
    u32(suite),
    lp(keyId),
    Buffer.from([FRAMING_ID[framing]]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/** 解开单个 {$wbEncrypted, envelope} 字段；失败返回 null。 */
function decryptField(envWrapper) {
  if (!envWrapper || typeof envWrapper !== 'object' || envWrapper.$wbEncrypted == null) return null;
  const env = JSON.parse(Buffer.from(envWrapper.envelope, 'base64').toString('utf8'));
  if (env.keyId !== crypto.createHash('sha256').update(KEY).digest('hex').slice(0, 16)) {
    throw new Error(`密钥与信封 keyId 不匹配（信封 ${env.keyId}）`);
  }
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 });
  d.setAAD(aad('field', env.suite, env.keyId));
  d.setAuthTag(Buffer.from(env.authTag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()]).toString('utf8');
}

function decryptDeep(value) {
  if (value && typeof value === 'object' && value.$wbEncrypted != null) return decryptField(value);
  if (Array.isArray(value)) return value.map(decryptDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decryptDeep(v);
    return out;
  }
  return value;
}

function main() {
  const files = fs.readdirSync(AUTH_DIR)
    .filter((f) => f.startsWith('workbuddy-desktop.info'))
    // 新文件优先：同一账号会有多份备份（换号登录产生），必须取最新登录的 token，
    // 否则会把已失效的旧 token 当成本次结果（实测踩过：旧的 401、新的可用）。
    .map((f) => ({ f, mtime: fs.statSync(path.join(AUTH_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.f);
  if (!files.length) { console.error('auth 目录下没有 workbuddy-desktop.info* 文件'); process.exit(1); }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let ok = 0;
  let fail = 0;
  const seen = new Set();
  for (const f of files) {
    const src = path.join(AUTH_DIR, f);
    if (f.endsWith('.json')) continue;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(src, 'utf8')); } catch (e) { console.log(`✗ ${f} 解析失败: ${e.message}`); fail += 1; continue; }
    let plain;
    try { plain = decryptDeep(parsed); } catch (e) { console.log(`✗ ${f} 解密失败: ${e.message}`); fail += 1; continue; }
    const uid = plain.account && (plain.account.uid || plain.account.uin);
    const token = plain.auth && (plain.auth.accessToken || plain.auth.access_token);
    if (!token) { console.log(`✗ ${f} 无 token`); fail += 1; continue; }
    // 同名去重（同一 uid 只保留最新文件）
    const dedupeKey = uid || token.slice(0, 16);
    if (seen.has(dedupeKey)) { console.log(`· ${f} 跳过（同账号已解出）`); continue; }
    seen.add(dedupeKey);
    const out = path.join(OUT_DIR, `workbuddy-desktop.info.${uid || 'unknown'}`);
    fs.writeFileSync(out, JSON.stringify(plain, null, 2), 'utf8');
    ok += 1;
    console.log(`✓ ${f}  uid=${String(uid || '?').slice(0, 8)}…  token=${token.length}B  → ${path.basename(out)}`);
  }
  console.log(`\n解出 ${ok} 个账号，失败 ${fail} 个；输出目录 ${OUT_DIR}`);
  if (ok) console.log('下一步：set WB_AUTH_DIR=' + OUT_DIR + ' 后运行 node scripts/import-wb-auth.js');
}

main();

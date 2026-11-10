'use strict';
/**
 * repro-key-scope.js — 复现「聚合虚拟模型可用、后端单个模型提示密钥失效」。
 *
 * 只读诊断：从库里取每把访问密钥的 scopes/resources，按转发面的真实判定链
 * （middleware/model-access.js#canUseModel → auth/scope.js#canInvokeModel）
 * 分别对「虚拟模型」和「单个物理模型」求值，把两条路径的结论并排打出来。
 *
 * 2026-11-07 事故形态（修复前）：
 *   平台密钥 scopes 只剩 ["models:read"] ⇒ trae/wb 单模型全部
 *   `DENY access denied: scope_missing:models:invoke`，虚拟模型 ALLOW；
 *   Trae 密钥调 glm-5.3 被 `platform_mismatch` 拒（静态 WB 名单误判）。
 * 修复后（ensureModelsReadScope 物化 + ensureInvokeScope 修复坏行 +
 * platform-ownership 归属表）：平台密钥对本平台单模型 ALLOW，
 * 跨平台与真 WB 独有模型仍 DENY。
 *
 * 用法：node scripts/repro-key-scope.js
 */
process.env.LOGS_DIR = process.env.LOGS_DIR || require('path').join(require('os').tmpdir(), 'rg-repro-logs');

const apiKeys = require('../src/credentials/api-keys');
const { canUseModel } = require('../src/middleware/model-access');

const rows = apiKeys.listKeys({ kind: 'access' });
console.log(`访问密钥 ${rows.length} 把\n`);

const SAMPLES = {
  virtual: 'vm/long-context',
  traeSingle: 'glm-5.3',
  wbSingle: 'wb/glm-5.3',
};

for (const r of rows) {
  const rec = apiKeys.verifyAccessKey(apiKeys.revealKeyPlain(r.id) || '');
  console.log(`— ${r.id}  label=${r.label}  platform=${r.platform}  keyType=${r.keyType}  enabled=${r.enabled}`);
  console.log(`  DB scopes   = ${JSON.stringify(r.scopes)}`);
  console.log(`  DB resources= ${JSON.stringify(r.resources)}`);
  if (!rec) {
    console.log('  (无法按明文重建密钥记录：无密文备份或已撤销/过期)\n');
    continue;
  }
  console.log(`  verify 后生效 resources = ${JSON.stringify(rec.resources)}`);
  for (const [tag, model] of Object.entries(SAMPLES)) {
    const out = canUseModel(rec.platform, model, rec);
    console.log(`    ${tag.padEnd(10)} ${model.padEnd(18)} → ${out.ok ? 'ALLOW' : 'DENY  ' + out.message}`);
  }
  console.log('');
}

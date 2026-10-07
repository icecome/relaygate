'use strict';
/* 导入本机 ZCode 凭据到 RelayGate store（等价于 POST /v1/zcode/local/import）。
 * 使用项目正常配置解析（.env 的 WORKSPACE_DIR），写入真实账号库。 */
const store = require('../src/credentials/store');
const local = require('../src/zcode/local');
const fingerprint = require('../src/zcode/fingerprint');
const variant = require('../src/platform/variant');

(async () => {
  const acct = local.buildAccountFromLocal();
  const existing = store.list().find((a) => variant.isEdition(a.edition, 'zcode') && a.userId === acct.userId);
  if (existing) {
    const prev = store.get(existing.id);
    // 同设备沿用原档案（一经分配即稳定，避免每次导入换设备身份）
    const fp = fingerprint.validate(prev.fingerprint) ? prev.fingerprint : acct.fingerprint;
    store.update(existing.id, { ...acct, fingerprint: fp });
    console.log('updated account', existing.id);
  } else {
    const created = store.add(acct, 'local');
    console.log('created account', created.id);
  }
  const all = store.list().filter((a) => variant.isEdition(a.edition, 'zcode'));
  for (const a of all) {
    const full = store.get(a.id);
    console.log(`- ${a.id} | ${a.label} | mode=${full.mode} | hasToken=${!!full.token} | fp=${JSON.stringify(full.fingerprint)}`);
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
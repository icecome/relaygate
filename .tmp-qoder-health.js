'use strict';
/**
 * 一次性只读健康探针：对库里每个 Qoder 账号打 GET /api/v1/userinfo，
 * 判断 token 是否仍然有效（不刷新、不轮换、不写库）。
 * 用法：node .tmp-qoder-health.js
 */
const store = require('./src/credentials/store');
const variant = require('./src/platform/variant');
const client = require('./src/qoder/client');

(async () => {
  const rows = store.list().filter((a) => variant.isEdition(a.edition, variant.QODER));
  for (const a of rows) {
    const full = store.get(a.id);
    const realm = variant.qoderRealmOfAccount(full);
    const now = Date.now();
    const exp = full.expiredAt ? new Date(full.expiredAt).getTime() : null;
    const rtExp = full.refreshExpiredAt ? new Date(full.refreshExpiredAt).getTime() : null;
    const line = {
      id: full.id,
      label: full.label,
      realm,
      source: full.source,
      userId: full.userId,
      expiredAt: full.expiredAt,
      expiredBy: exp == null ? 'n/a' : (exp <= now ? `已过期 ${Math.round((now - exp) / 3600000)}h` : `剩 ${Math.round((exp - now) / 3600000)}h`),
      refreshExpiredAt: full.refreshExpiredAt,
      refreshBy: rtExp == null ? 'n/a' : (rtExp <= now ? '已过期' : '有效'),
      hasRefreshToken: !!full.refreshToken,
      tokenTail: String(full.token || '').slice(-6),
    };
    try {
      const j = await client.request({ method: 'GET', path: 'userinfo', token: full.token, realm });
      line.userinfo = { ok: true, name: j && j.name, email: j && j.email };
    } catch (e) {
      line.userinfo = { ok: false, status: e.status, name: e.name, message: String(e.message).slice(0, 200) };
    }
    console.log(JSON.stringify(line));
  }
})();

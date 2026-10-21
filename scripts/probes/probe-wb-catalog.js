'use strict';
/** scripts/probes/probe-wb-catalog.js —— 目录端点在新旧头集下是否可用。 */
const store = require('../../src/credentials/store');
const wbAuth = require('../../src/workbuddy/auth');

(async () => {
  const acct = store.list().find((a) => a.enabled && a.edition === 'workbuddy');
  const full = store.get(acct.id);
  const info = { accessToken: full.token, uid: full.userId, region: 'cn' };
  const url = 'https://copilot.tencent.com/console/enterprises/personal/models';
  const legacy = wbAuth.authHeaders(info);
  const modern = {
    Accept: 'application/json',
    Authorization: 'Bearer ' + full.token,
    'User-Agent': 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.63.2',
    'X-User-Id': full.userId,
    'X-Domain': 'copilot.tencent.com',
    'X-Product': 'SaaS',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': '5.8.3',
    'x-codebuddy-request': '1',
  };
  for (const [name, h] of [['legacy', legacy], ['modern', modern]]) {
    try {
      const r = await fetch(url, { headers: h });
      const t = await r.text();
      let n = null;
      try { const j = JSON.parse(t); const d = j.data || j; const arr = Array.isArray(d) ? d : (d.models || d.list || []); n = arr.length; } catch { /* noop */ }
      console.log(name, 'http=' + r.status, 'models=' + n, t.slice(0, 120).replace(/\s+/g, ' '));
    } catch (e) {
      console.log(name, 'ERR', e.message);
    }
  }
})();

'use strict';
/**
 * 一次性协议探针（只读/无副作用）：确认 Qoder 设备码登录与续期端点的真实响应形态。
 *   1. poll 端点用假 nonce → 期望 404「无待授权会话」（证明端点存在且豁免认证）
 *   2. refresh 端点用假 refresh_token → 观测信封与 machine_id 是否被前置校验
 *   3. 授权页可达性
 * 不发送任何真实 refresh_token，因此不会轮换任何凭据。
 */
const variant = require('./src/platform/variant');

async function probe(label, url, init) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    console.log(`[${label}] ${r.status} ${r.headers.get('content-type') || ''} :: ${text.slice(0, 300).replace(/\s+/g, ' ')}`);
    return { status: r.status, text };
  } catch (e) {
    console.log(`[${label}] NETWORK ERROR :: ${e.message}`);
    return { status: 0, text: '' };
  }
}

(async () => {
  for (const realm of ['intl', 'cn']) {
    const openapi = variant.qoderOpenapiBase(realm);
    const cfg = variant.qoderRealmConfig(realm);
    const paths = variant.variantOf(variant.QODER).paths;
    console.log(`\n===== realm=${realm} openapi=${openapi} =====`);

    await probe(`${realm} poll(假 nonce)`,
      `${openapi}${paths.devicePoll}?nonce=00000000-0000-4000-8000-000000000000&verifier=${'a'.repeat(43)}&challenge_method=S256`,
      { method: 'GET', headers: { Accept: 'application/json' } });

    await probe(`${realm} refresh(假 refresh_token)`,
      `${openapi}${paths.deviceRefresh}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'qoder/1.0.0' },
        body: JSON.stringify({ refresh_token: 'drt-this-is-not-a-real-token', machine_id: '00000000-0000-4000-8000-000000000000' }),
      });

    await probe(`${realm} refresh(空体)`,
      `${openapi}${paths.deviceRefresh}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}' });

    const authBase = cfg.docsBase.replace('docs.', '');
    console.log(`[${realm}] 推断 authBase=${authBase}（docsBase=${cfg.docsBase}）`);
    await probe(`${realm} 授权页 HEAD 探测`,
      `${realm === 'cn' ? 'https://qoder.cn' : 'https://qoder.com'}/device/selectAccounts?challenge=${'b'.repeat(43)}&challenge_method=S256&nonce=00000000-0000-4000-8000-000000000000&machine_id=00000000-0000-4000-8000-000000000000&client_id=00000000-0000-4000-8000-000000000000`,
      { method: 'GET', headers: { Accept: 'text/html' } });
  }
})();
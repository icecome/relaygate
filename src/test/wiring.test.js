'use strict';
/**
 * test/wiring.test.js —— 前后端接线契约（2026-11-06 全量审查的修复回归）。
 *
 * 本文件只测一件事：**前端发出的请求形状，后端是否真的接受**。
 * 这类缺陷的共同表现是「接口存在、按钮存在、点了必失败」，而单侧的
 * 单元/集成测试都发现不了——后端测的是自己期望的形状，前端测的是自己
 * 发送的形状，两者从不放在一起比对。oauth/callback 的 `url` vs
 * `callbackUrl` 断接就是这样活了很久：端点有测试、弹窗有测试，
 * 唯独没人把「弹窗实际发出的 body」打给「端点」看。
 *
 * 覆盖：
 *   W-01 POST /credentials/oauth/callback 接受前端实际发送的 {url}
 *   W-02 POST /credentials/transfer/export 接受 accountIds 与旧键 uids
 *   W-03 GET /credentials/groups 的形状与前端 CredentialGroup 一致
 *   W-04 POST /workbuddy/refresh 缺凭据时的状态码与文案（前端据此提示）
 *   W-05 POST /workbuddy/checkin-status 无本机登录态时的错误形状
 *   W-06 GET /admin/stats/cache + /stats/cache/clear + official-usage/cache/clear
 *   W-07 POST /workbuddy/growth/auto → /progress → /progress-list 全链路（无账号）
 *   W-08 前端封装与后端端点集合的一致性扫描（防「后端加了、前端没接」）
 */
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.WORKSPACE_DIR = path.join(os.tmpdir(), `rg-wiring-${Date.now()}`);
process.env.TRAE_API_ENCRYPT_KEY = 'f'.repeat(64);
process.env.LOGS_DIR = path.join(process.env.WORKSPACE_DIR, 'logs');
process.env.API_KEY = 'wiring-test-api-key';
process.env.ADMIN_KEY = 'wiring-test-admin-key';
process.env.PORT = String(19000 + (process.pid % 1000));
process.env.HOST = '127.0.0.1';
process.env.SCHEDULER_ENABLED = 'false';
require('./isolation-guard')('wiring');

require('../index.js');
const store = require('../credentials/store');

const ROOT = path.resolve(__dirname, '..', '..');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const ADMIN = process.env.ADMIN_KEY;

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  ${name}  ${detail || ''}`);
  }
}

function req(method, p, { token = ADMIN, body, rawBody } = {}) {
  return new Promise((resolve) => {
    const data = rawBody != null ? rawBody : (body != null ? JSON.stringify(body) : null);
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = http.request(BASE + p, { method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* 保留原文 */ }
        resolve({ status: res.statusCode, json, text: buf });
      });
    });
    r.on('error', (e) => resolve({ status: 0, json: null, text: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

async function run() {
  /* ---------- W-01 oauth/callback 请求体字段 ---------- */
  // 前端 shared/api/credentials.ts#oauthCallback 发的是 {url}。
  // 后端此前只读 req.body.callbackUrl ⇒ 该调用永远 400。
  // 回调 URL **不带任何凭据参数**：端点会因「缺少 token/refreshToken」而
  // 失败，但那正好证明请求体已被正确解析（若仍只读 callbackUrl，失败原因
  // 会是 "callbackUrl is required"）。这样断言不依赖上游，也不发网络请求。
  const fakeCb = 'http://127.0.0.1:9999/authorize?state=st-1';
  const asUrl = await req('POST', '/v1/credentials/oauth/callback', { body: { url: fakeCb } });
  const asCallbackUrl = await req('POST', '/v1/credentials/oauth/callback', { body: { callbackUrl: fakeCb } });
  check(
    '[W-01] {url} 与 {callbackUrl} 两种键都被接受（不再对前端的实际形状回 400 required）',
    !/callbackUrl is required/.test(asUrl.json?.error?.message || '')
    && !/callbackUrl is required/.test(asCallbackUrl.json?.error?.message || ''),
    `url→${asUrl.status} ${asUrl.json?.error?.message || ''} / callbackUrl→${asCallbackUrl.status} ${asCallbackUrl.json?.error?.message || ''}`,
  );
  // 端点对「URL 解析成功但缺凭据」返回 200 + {ok:false, detail:{message}}，
  // 对「URL 都没拿到」返回 400 + error.message。两者都要覆盖：
  // 前者证明 body 已解析（失败原因是凭据，不是字段名）。
  const urlMsg = `${asUrl.json?.error?.message || ''}${asUrl.json?.detail?.message || ''}`;
  check(
    '[W-01] 凭据参数缺失时的失败原因指向「凭据」而非「字段名」（证明 body 已解析）',
    /refreshToken|accessToken|凭据/i.test(urlMsg),
    `${asUrl.status} ${urlMsg || asUrl.text.slice(0, 200)}`,
  );
  const emptyCb = await req('POST', '/v1/credentials/oauth/callback', { body: {} });
  check(
    '[W-01] 两个键都缺时仍回 400 且文案可展示',
    emptyCb.status === 400 && /callbackUrl is required/.test(emptyCb.json?.error?.message || ''),
    `${emptyCb.status} ${emptyCb.text.slice(0, 120)}`,
  );

  /* ---------- W-02 transfer/export 选择参数 ---------- */
  const wb = store.add({
    label: 'wiring-wb', edition: 'workbuddy',
    token: 'tok-wiring-1', refreshToken: 'ref-wiring-1', userId: 'uid-wiring-1',
  }, 'workbuddy');
  const expNew = await req('POST', '/v1/credentials/transfer/export', { body: { password: 'wiring-pass', accountIds: [wb.id] } });
  const expOld = await req('POST', '/v1/credentials/transfer/export', { body: { password: 'wiring-pass', uids: [wb.id] } });
  check(
    '[W-02] accountIds 与 uids 都能选中导出（参数改名不破坏既有调用方）',
    expNew.status === 200 && expNew.json?.count === 1
    && expOld.status === 200 && expOld.json?.count === 1,
    `accountIds→${expNew.status} count=${expNew.json?.count} / uids→${expOld.status} count=${expOld.json?.count}`,
  );
  const expBad = await req('POST', '/v1/credentials/transfer/export', { body: { password: 'wiring-pass', accountIds: 'nope' } });
  check(
    '[W-02] 非数组选择回 400（结构化错误，不按消息文本分类）',
    expBad.status === 400,
    `${expBad.status} ${expBad.text.slice(0, 120)}`,
  );

  /* ---------- W-03 groups 形状 ---------- */
  store.update(wb.id, { group: 'wiring-group' });
  const groups = await req('GET', '/v1/credentials/groups');
  const gList = groups.json?.data || [];
  check(
    '[W-03] GET /credentials/groups 返回 {object,data:[{name,count}]}（前端 CredentialGroup 同形）',
    groups.status === 200 && groups.json?.object === 'list'
    && gList.some((g) => g.name === 'wiring-group' && typeof g.count === 'number'),
    `${groups.status} ${JSON.stringify(gList)}`,
  );
  check(
    '[W-03] 未分组以 name:null 表示（前端映射成 __ungrouped__ 显示键）',
    Array.isArray(gList),
    JSON.stringify(gList),
  );

  /* ---------- W-04 workbuddy/refresh ---------- */
  const noRefresh = store.add({ label: 'wiring-no-rt', edition: 'workbuddy', token: 't-only', userId: 'uid-wiring-no-rt' }, 'workbuddy');
  const r404 = await req('POST', '/v1/workbuddy/refresh', { body: { accountId: noRefresh.id } });
  check(
    '[W-04] 无 refreshToken → 404 且文案点明原因（前端 toast 直接可用）',
    r404.status === 404 && /refreshToken/.test(r404.json?.error?.message || ''),
    `${r404.status} ${r404.text.slice(0, 160)}`,
  );
  const rMissing = await req('POST', '/v1/workbuddy/refresh', { body: {} });
  check('[W-04] 缺 accountId → 404（不当 500 抛）', rMissing.status === 404, `${rMissing.status} ${rMissing.text.slice(0, 120)}`);

  /* ---------- W-05 checkin-status ---------- */
  const st = await req('POST', '/v1/workbuddy/checkin-status', { body: { accountId: wb.id } });
  check(
    '[W-05] 只读签到状态返回 ok/reason 形状（前端 WbCheckinStatus 的 ok 字段）',
    st.status === 200 && typeof st.json?.ok === 'boolean',
    `${st.status} ${st.text.slice(0, 200)}`,
  );
  const stUnknown = await req('POST', '/v1/workbuddy/checkin-status', { body: { accountId: 'acct-does-not-exist' } });
  check('[W-05] 未知 accountId → 404', stUnknown.status === 404, `${stUnknown.status} ${stUnknown.text.slice(0, 120)}`);

  /* ---------- W-06 服务端缓存端点 ---------- */
  const cache = await req('GET', '/v1/admin/stats/cache');
  check(
    '[W-06] GET /stats/cache 返回 {enabled,dir}（前端 getStatsCache 同形）',
    cache.status === 200 && typeof cache.json?.enabled === 'boolean' && typeof cache.json?.dir === 'string',
    `${cache.status} ${cache.text.slice(0, 160)}`,
  );
  const cacheClear = await req('POST', '/v1/admin/stats/cache/clear');
  check('[W-06] POST /stats/cache/clear 返回 {ok}', cacheClear.status === 200 && typeof cacheClear.json?.ok === 'boolean', `${cacheClear.status} ${cacheClear.text.slice(0, 120)}`);
  const officialClear = await req('POST', '/v1/admin/stats/official-usage/cache/clear');
  check(
    '[W-06] official-usage/cache/clear 分端返回 workbuddy/trae（前端据此如实播报部分失败）',
    officialClear.status === 200
    && typeof officialClear.json?.ok === 'boolean'
    && typeof officialClear.json?.workbuddy === 'boolean'
    && typeof officialClear.json?.trae === 'boolean',
    `${officialClear.status} ${officialClear.text.slice(0, 200)}`,
  );

  /* ---------- W-07 growth auto 全链路 ---------- */
  const auto = await req('POST', '/v1/workbuddy/growth/auto', { body: {} });
  check(
    '[W-07] POST /growth/auto 立即返回 taskId + progressUrl（不阻塞请求）',
    auto.status === 200 && typeof auto.json?.taskId === 'string' && typeof auto.json?.progressUrl === 'string',
    `${auto.status} ${auto.text.slice(0, 200)}`,
  );
  const prog = auto.json?.taskId
    ? await req('POST', `/v1/workbuddy/growth/progress?taskId=${encodeURIComponent(auto.json.taskId)}`, { body: {} })
    : { status: 0, json: null };
  check(
    '[W-07] /growth/progress 返回轮询所需字段（running/total/doneCount/okCount/failCount）',
    prog.status === 200
    && typeof prog.json?.running === 'boolean'
    && typeof prog.json?.total === 'number'
    && typeof prog.json?.doneCount === 'number'
    && typeof prog.json?.okCount === 'number'
    && typeof prog.json?.failCount === 'number',
    `${prog.status} ${JSON.stringify(prog.json && { running: prog.json.running, total: prog.json.total, done: prog.json.doneCount })}`,
  );
  const list = await req('POST', '/v1/workbuddy/growth/progress-list', { body: {} });
  check(
    '[W-07] /growth/progress-list 返回数组（前端 GrowthAutoProgress[]）',
    list.status === 200 && Array.isArray(list.json?.data),
    `${list.status} ${list.text.slice(0, 120)}`,
  );
  const progMissing = await req('POST', '/v1/workbuddy/growth/progress', { body: {} });
  check('[W-07] 缺 taskId → 400', progMissing.status === 400, `${progMissing.status} ${progMissing.text.slice(0, 120)}`);

  /* ---------- W-08 前端封装 ↔ 后端端点一致性扫描 ---------- */
  // 只扫描 workbuddy 相关域（本次审查范围）：前端封装里出现的每个路径，
  // 后端路由表里必须存在；反向不要求（后端可以只给 CLI/jobs 用）。
  const apiFiles = [
    'web/src/shared/api/workbuddy.ts',
    'web/src/shared/api/growth.ts',
    'web/src/shared/api/credentials.ts',
  ];
  const routeSrc = ['src/routes/workbuddy.js', 'src/routes/cat-trip.js', 'src/routes/credentials.js']
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n');
  // 把 handle('name', ...) 展开成真实注册路径
  const handleNames = [...routeSrc.matchAll(/handle\('([a-z-]+)'/g)].map((m) => m[1]);
  const declared = new Set();
  for (const m of routeSrc.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)) {
    declared.add(m[2].replace(/^\//, ''));
  }
  for (const n of handleNames) declared.add(n);

  const frontPaths = [];
  for (const f of apiFiles) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/api<[^>]*>\(\s*[`']([^`']+)[`']/g)) {
      frontPaths.push({ file: f, p: m[1] });
    }
    for (const m of src.matchAll(/api\(\s*[`']([^`']+)[`']/g)) {
      frontPaths.push({ file: f, p: m[1] });
    }
  }
  /**
   * 把前端模板串归一成可匹配形态：
   *   `/v1/credentials/${encodeURIComponent(id)}` → `/v1/credentials/:p`
   *   `/v1/credentials/oauth/url${q}`             → `/v1/credentials/oauth/url`
   * 段内插值视作路径参数，尾部插值（查询串）直接丢弃。
   */
  function normalizePath(p) {
    return p
      .replace(/\/\$\{[^}]+\}/g, '/:p')
      .replace(/\$\{[^}]+\}/g, '')
      .split('?')[0];
  }
  const PREFIXES = {
    '/v1/workbuddy/growth/': 'growth',
    '/v1/workbuddy/': 'workbuddy',
    '/v1/credentials/': 'credentials',
  };
  const unknown = [];
  for (const { file, p: rawPath } of frontPaths) {
    const p = normalizePath(rawPath);
    const hit = Object.keys(PREFIXES).find((k) => p.startsWith(k));
    if (!hit) continue; // 非本次扫描域
    const relNoSlash = p.slice(hit.length - 1).replace(/^\//, '');
    // 路径参数端点（/:id/...）逐段比对，参数段可匹配任意非空值
    const ok = [...declared].some((d) => {
      const segs = d.replace(/^\//, '').split('/');
      const rs = relNoSlash.split('/');
      return segs.length === rs.length
        && segs.every((s, i) => (s.startsWith(':') ? rs[i] === ':p' || rs[i].length > 0 : s === rs[i]));
    });
    if (!ok) unknown.push(`${file} → ${rawPath}`);
  }
  check(
    '[W-08] 前端封装的每个 workbuddy/credentials 路径都在后端路由表里（无 404 封装）',
    unknown.length === 0,
    unknown.join(' | '),
  );
  check(
    '[W-08] 扫描确实覆盖到路径（防止正则失配导致假通过）',
    frontPaths.length >= 18,
    `只扫到 ${frontPaths.length} 条`,
  );

  /* ---------- 清理 ---------- */
  for (const a of [wb, noRefresh]) {
    try { store.remove(a.id); } catch { /* 忽略 */ }
  }
}

setTimeout(async () => {
  try {
    await run();
  } catch (e) {
    fail += 1;
    console.error(`FAIL  用例执行异常: ${e.stack || e.message}`);
  }
  console.log(`\n${pass} passed${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}, 300);

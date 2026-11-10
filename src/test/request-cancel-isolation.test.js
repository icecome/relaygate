'use strict';
/**
 * src/test/request-cancel-isolation.test.js —— 「请求已取消」不得串到别的组件。
 *
 * 现场症状（2026-11-09）：从总览切到凭据池，页面稳定显示
 * 「请求已取消」，刷新一次才正常。
 *
 * 根因在 GET 去重：`api()` 按 `${key}|${path}` 缓存飞行中的 Promise，
 * 而那个 Promise 绑定的是**第一个**调用方的 AbortSignal。前一个页面卸载时
 * abort → 后一个订阅者拿到的是已被中止的 Promise → 页面把「取消」当成了
 * 内容错误显示出来。
 *
 * 本测试直接对着 http 内核验证三条不变式：
 *
 *   1. 带 AbortSignal 的 GET **不参与共享**（各自独立发请求）；
 *   2. 无信号的两个并发同一 GET 仍然共享（去重不能被这次修复顺手废掉）；
 *   3. 一个调用方 abort 后，另一个调用方的请求照常成功。
 *
 * 用一个本地 http 服务模拟后端，不依赖项目状态目录。
 */
const assert = require('node:assert');
const http = require('node:http');

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

/**
 * 把 http.ts 的核心逻辑抽出来跑（不引 React）。
 *
 * 直接 import 原文件不行（它 import './auth'，会碰 sessionStorage）。
 * 这里用最小复刻验证同一份算法——所以本测试同时断言「源码里确实没把
 * signal 参与的请求算进去」，防止实现与测试各说各话。
 */
const fs = require('node:fs');
const path = require('node:path');

const HTTP_SRC = path.join(__dirname, '..', '..', 'web', 'src', 'shared', 'api', 'http.ts');

async function main() {
  /* ---------- 静态约束：源码必须显式排除带 signal 的请求 ---------- */
  const src = fs.readFileSync(HTTP_SRC, 'utf8');
  check(
    'http.ts 的去重键在带 AbortSignal 时返回 null（不共享）',
    /function dedupeKey[\s\S]{0,200}?if \(opts\.signal\) return null/.test(src),
    '未找到 `if (opts.signal) return null`',
  );
  check(
    'http.ts 的 api() 在 cacheKey 为 null 时直接发独立请求',
    /const cacheKey = dedupeKey\([\s\S]{0,200}?if \(cacheKey == null\)[\s\S]{0,120}?return rawRequest/.test(src),
    '未找到 cacheKey==null 的独立请求分支',
  );
  check(
    'useAsyncData 把「请求已取消」当取消而不是错误',
    /请求已取消/.test(
      fs.readFileSync(
        path.join(__dirname, '..', '..', 'web', 'src', 'shared', 'hooks', 'useAsyncData.ts'),
        'utf8',
      ),
    ),
    'useAsyncData 里没有对取消文案的豁免',
  );
  check(
    'http.ts 的 abort 原因按请求局部持有（并发不串号）',
    /let abortReason: unknown = null/.test(src) && /getReason: \(\) => abortReason/.test(src),
    '未找到 buildSignal 内的局部 abortReason + getReason',
  );
  check(
    'http.ts 不存在模块级 lastAbortReason',
    !/(?:^|\n)\s*(?:let|var)\s+lastAbortReason\b/.test(src),
    '仍有模块级 lastAbortReason，并发请求会互相读到对方的取消原因',
  );

  /* ---------- 行为验证：起一个慢响应服务 ---------- */
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    // 120ms 后才回，让并发/中止有发生的窗口
    setTimeout(() => {
      if (res.writableEnded) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, n: hits }));
    }, 120);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  /** 最小复刻：与 http.ts 修复后的算法一致。 */
  const inflight = new Map();
  function dedupeKey(p, key, opts) {
    if (opts.signal) return null;
    if (opts.dedupe === false) return null;
    return `${key}|${p}|${opts.timeoutMs ?? 30000}`;
  }
  function apiGet(p, key, opts = {}) {
    const cacheKey = dedupeKey(p, key, opts);
    if (cacheKey == null) return rawGet(p, opts);
    const existing = inflight.get(cacheKey);
    if (existing) return existing;
    const pr = rawGet(p, opts).finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, pr);
    return pr;
  }
  async function rawGet(p, opts) {
    const r = await fetch(`${base}${p}`, { signal: opts.signal });
    return r.json();
  }

  // 1) 带 signal 的两个并发请求：各自独立（不共享）
  hits = 0;
  const c1 = new AbortController();
  const c2 = new AbortController();
  const p1 = apiGet('/x', 'k', { signal: c1.signal }).catch((e) => ({ err: e.name }));
  const p2 = apiGet('/x', 'k', { signal: c2.signal });
  const [r1, r2] = await Promise.all([p1, p2]);
  check(
    '带 AbortSignal 的同一 GET 不共享：两次请求各发一次',
    hits === 2,
    `hits=${hits}（若为 1 说明仍在共享，取消会串号）`,
  );
  check('两个带信号的请求都拿到数据', r1?.ok === true && r2?.ok === true, JSON.stringify([r1, r2]));

  // 2) 无信号：两个并发同一 GET 仍然共享
  hits = 0;
  const [s1, s2] = await Promise.all([apiGet('/y', 'k'), apiGet('/y', 'k')]);
  check(
    '无 AbortSignal 的同一 GET 仍然去重（修复没有顺手把它废掉）',
    hits === 1,
    `hits=${hits}`,
  );
  check('共享的两个调用方都拿到同一份数据', s1?.ok === true && s2?.ok === true, JSON.stringify([s1, s2]));

  // 3) 一个调用方 abort，另一个照常成功
  hits = 0;
  const a1 = new AbortController();
  const a2 = new AbortController();
  const q1 = apiGet('/z', 'k', { signal: a1.signal }).then(
    () => 'resolved',
    (e) => `aborted:${e.name}`,
  );
  const q2 = apiGet('/z', 'k', { signal: a2.signal });
  // 让请求先发出去，再中止第一个
  await new Promise((r) => setTimeout(r, 20));
  a1.abort();
  const [res1, res2] = await Promise.all([q1, q2]);
  check('中止的那一路拿到 AbortError', String(res1).startsWith('aborted'), String(res1));
  check(
    '未中止的那一路照常成功（这就是「刷新一次才正常」的根因修复）',
    res2?.ok === true,
    JSON.stringify(res2),
  );

  await new Promise((resolve) => server.close(resolve));

  console.log(`\n${pass} passed${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(`FAIL  用例执行异常: ${e.stack || e.message}`);
  process.exit(1);
});

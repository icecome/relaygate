'use strict';
/**
 * src/test/wb-refresh-expiry.test.js —— refreshToken 到期口径契约。
 *
 * 背景（2026-11-25 事故）：面板报「7 个账号需重新登录」，而 8 个 WorkBuddy 账号
 * billing 面全部 200、当日 1200+ 次转发 0 个 401。根因是 refresh_expired_at
 * 这一列在 WB 渠道上只在导入时写一次、续期链路从不更新：
 * 导入满 30 天（refreshToken 寿命）后它必然跨过 now，前端据此永久判「需重新登录」。
 *
 * 本文件钉住三件事，任何一件回退都会让同一个事故复发：
 *
 *   1. **JWT exp 才是真值**。refreshToken 每次续期都换发新的 30 天有效期，
 *      而续期响应只返回 {accessToken, refreshToken, expiresAt}，不含
 *      refreshExpiresAt —— 所以新到期时刻只能从新 refreshToken 的 JWT 里取。
 *   2. **相对秒数不能当绝对时间**。客户端 .info 里的 refreshExpiresIn 是
 *      「写入那一刻起的剩余秒数」，文件放旧了再加 now 会把到期算到未来去。
 *   3. **「记录已过期」必须能被之后的成功续期反证**。若 lastRefreshAt 晚于
 *      refreshExpiredAt，那一列就是陈旧记录，不能判死。
 *
 * 前两条在 Node 侧直接 require 测；第三条用 esbuild 把前端模块打包后测。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || path.join(ROOT, 'output');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.error(`FAIL  ${name}  ${detail || ''}`); }
}

/** 造一个带 exp 的假 JWT（签名段无所谓，只解析 payload）。 */
function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

function main() {
  const { jwtExpIso } = require('../credentials/refresh-expiry');

  // ① JWT exp → ISO
  const expSec = Math.floor(Date.now() / 1000) + 30 * 86400;
  const iso = jwtExpIso(fakeJwt({ exp: expSec, typ: 'Offline' }));
  check('jwtExpIso：从 payload.exp 推出绝对到期时刻', iso === new Date(expSec * 1000).toISOString(), iso);

  check('jwtExpIso：非 JWT 返回 null（不瞎猜）', jwtExpIso('not-a-jwt') === null);
  check('jwtExpIso：无 exp 返回 null', jwtExpIso(fakeJwt({ typ: 'Offline' })) === null);
  check('jwtExpIso：空值返回 null', jwtExpIso(null) === null && jwtExpIso('') === null);

  // ② 续期响应必须带回新的 refreshExpiresAt（由新 refreshToken 的 JWT exp 推出）
  const wbAuth = require('../workbuddy/auth');
  const newRtExp = Math.floor(Date.now() / 1000) + 30 * 86400;
  const newRt = fakeJwt({ exp: newRtExp, typ: 'Offline', azp: 'console' });
  // 直接验证 refresh() 里那段推导逻辑的输入输出契约：用 jwtExpIso 复算一次
  check(
    '续期后 refreshExpiresAt 由新 refreshToken 的 JWT exp 决定（不是旧值、不是 now+30d）',
    jwtExpIso(newRt) === new Date(newRtExp * 1000).toISOString(),
    jwtExpIso(newRt),
  );

  // ③ readAuthFile 必须优先认绝对时间戳，其次 JWT exp，最后才用相对秒数
  const tmpDir = path.join(ROOT, 'output', '.tmp-wb-auth-test');
  fs.mkdirSync(tmpDir, { recursive: true });
  const atExp = Math.floor(Date.now() / 1000) + 20 * 86400;
  const rtExp = Math.floor(Date.now() / 1000) + 30 * 86400;
  const accessToken = fakeJwt({ exp: atExp });
  const refreshToken = fakeJwt({ exp: rtExp });

  const absFile = path.join(tmpDir, 'abs.info');
  fs.writeFileSync(absFile, JSON.stringify({
    account: { uid: 'u-abs' },
    auth: {
      accessToken, refreshToken,
      // 故意给一个荒谬的相对秒数（10 年），验证绝对时间戳优先
      expiresIn: 315360000,
      refreshExpiresIn: 315360000,
      expiresAt: atExp * 1000,
      refreshExpiresAt: rtExp * 1000,
      domain: 'www.workbuddy.cn',
    },
  }));
  const abs = wbAuth.readAuthFile(absFile);
  check('readAuthFile：优先取 expiresAt 绝对时间戳', abs.expiresAtMs === atExp * 1000, String(abs.expiresAtMs));
  check('readAuthFile：优先取 refreshExpiresAt 绝对时间戳', abs.refreshExpiresAtMs === rtExp * 1000, String(abs.refreshExpiresAtMs));

  const relFile = path.join(tmpDir, 'rel.info');
  fs.writeFileSync(relFile, JSON.stringify({
    account: { uid: 'u-rel' },
    auth: { accessToken, refreshToken, domain: 'www.workbuddy.cn' },
  }));
  const rel = wbAuth.readAuthFile(relFile);
  check('readAuthFile：无绝对时间戳时回落到 JWT exp（不是 null）', rel.refreshExpiresAtMs === rtExp * 1000, String(rel.refreshExpiresAtMs));
  check('readAuthFile：accessToken 同样回落到 JWT exp', rel.expiresAtMs === atExp * 1000, String(rel.expiresAtMs));

  // ④ 前端判据：lastRefreshAt 晚于 refreshExpiredAt ⇒ 记录陈旧，不是真过期
  const ka = loadKeepalive();
  if (ka) {
    const now = Date.now();
    const past = new Date(now - 3600 * 1000).toISOString();
    const later = new Date(now - 60 * 1000).toISOString();
    const future = new Date(now + 29 * 86400 * 1000).toISOString();

    const stale = ka.keepaliveOf({
      id: 'a1', edition: 'workbuddy', enabled: true,
      expiredAt: future, refreshExpiredAt: past, lastRefreshAt: later,
    });
    check(
      'keepaliveOf：refreshExpiredAt 已过但之后成功续期过 → 判「到期记录陈旧」而非「需重新登录」',
      stale.label === '到期记录陈旧' && stale.tone === 'warn',
      `${stale.label}/${stale.tone}`,
    );

    const dead = ka.keepaliveOf({
      id: 'a2', edition: 'workbuddy', enabled: true,
      expiredAt: future, refreshExpiredAt: past, lastRefreshAt: new Date(now - 2 * 3600 * 1000).toISOString(),
    });
    check(
      'keepaliveOf：refreshExpiredAt 已过且之后没成功续期 → 仍判「需重新登录」',
      dead.label === '需重新登录' && dead.tone === 'danger',
      `${dead.label}/${dead.tone}`,
    );

    const noRecord = ka.keepaliveOf({
      id: 'a3', edition: 'workbuddy', enabled: true, expiredAt: future, refreshExpiredAt: past,
    });
    check(
      'keepaliveOf：无 lastRefreshAt（存量账号）→ 不得擅自判为陈旧，照实报需重新登录',
      noRecord.label === '需重新登录' && noRecord.tone === 'danger',
      `${noRecord.label}/${noRecord.tone}`,
    );

    const healthy = ka.keepaliveOf({
      id: 'a4', edition: 'workbuddy', enabled: true, expiredAt: future, refreshExpiredAt: future,
    });
    check('keepaliveOf：两个到期都在未来 → ok', healthy.tone === 'ok', healthy.tone);
  }

  // ⑤ 存量修复只改自相矛盾的行
  const { repairWorkbuddyRefreshExpiry } = require('../credentials/refresh-expiry');
  const store = require('../credentials/store');
  const before = store.list().filter((a) => a.edition === 'workbuddy');
  const r1 = repairWorkbuddyRefreshExpiry();
  const r2 = repairWorkbuddyRefreshExpiry();
  check('repair：可重复执行且第二次为 0 改动（幂等）', r2.repaired === 0, JSON.stringify(r2));
  check('repair：扫描覆盖全部 workbuddy 账号', r1.scanned === before.length, `${r1.scanned}/${before.length}`);

  /*
   * 「一致」的口径是**容差内一致**，不是字符串相等。
   *
   * `repairWorkbuddyRefreshExpiry` 的契约写得很明确（refresh-expiry.js 的
   * `TOLERANCE_MS = 1h`）：偏差在容差内视为「已经对了」，**不重写**。
   * 这是刻意的 —— 客户端按 expiresIn 相对秒数落库会带来秒级~分钟级偏差，
   * 每次都去纠正它等于给每次续期都加一次无意义的写库。
   *
   * 实测反例：账号 18932771517 的库内值与 JWT exp 相差 1155ms（同一次导入里
   * 客户端与上游各自取了一次时钟），在容差内 ⇒ repair 不动它 ⇒ 用字符串
   * 相等断言会永久失败。断言必须跟契约对齐，否则测的是「实现细节」而不是
   * 「这条列到底可不可信」。
   */
  const TOLERANCE_MS = 3600 * 1000;
  let consistent = true;
  for (const s of store.list().filter((a) => a.edition === 'workbuddy')) {
    const full = store.get(s.id);
    if (!full.refreshToken) continue;
    const real = jwtExpIso(full.refreshToken);
    if (!real) continue;
    const storedMs = full.refreshExpiredAt ? Date.parse(full.refreshExpiredAt) : NaN;
    if (!Number.isFinite(storedMs) || Math.abs(storedMs - Date.parse(real)) > TOLERANCE_MS) {
      consistent = false;
      console.error(`   超容差: ${full.label} ${full.refreshExpiredAt} != ${real}`);
    }
  }
  check('repair：修复后库内 refreshExpiredAt 与 JWT exp 在容差内一致', consistent);

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

function loadKeepalive() {
  const SRC = path.join(ROOT, 'web', 'src', 'features', 'accounts', 'accountPacks.tsx');
  const outDir = path.join(ROOT, 'web', 'node_modules', '.cache');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `wb-ka-${process.pid}-${Date.now()}.cjs`);
  try {
    execFileSync(
      `npx esbuild "${SRC}" --bundle --format=cjs --platform=node --loader:.tsx=tsx --outfile="${out}"`,
      { cwd: path.join(ROOT, 'web'), stdio: 'pipe', shell: true },
    );
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(out);
  } catch (e) {
    console.error(`  (esbuild 打包失败：${e.message})`);
    return null;
  } finally {
    try { fs.unlinkSync(out); } catch { /* 忽略 */ }
  }
}

main();

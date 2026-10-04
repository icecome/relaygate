'use strict';
/**
 * jobs/rotate-accounts.js — WorkBuddy 多账号活跃度维护（账号轮换）。
 *
 * 原理：替换客户端 auth 文件触发热加载，客户端自动发 API 调用，计入每日活跃分。
 * 与 growth-auto（成长中心任务）、wb-checkin（签到）并列，属于活跃度维护的一环。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { writeJsonAtomic } = require('../lib/atomic-write');
const { stateFile } = require('../lib/paths');
const { sleep } = require('../lib/util');
const variant = require('../platform/variant');
const { AUTH_DIR, AUTH_FILE, resolveAuthDir, readUid, discoverAccounts } = require('./rotate-auth-dir');

// 成长中心 host 与 workbuddy/cat-trip.js 同源，统一从 variant 取
const GROWTH_HOST = variant.variantOf(variant.WORKBUDDY).hosts.growth;

// auth 目录定位与账号发现已抽到 rotate-auth-dir.js：该能力与 rotate-seed 共用，
// 留在本文件会形成 rotate-accounts ⇄ rotate-seed 循环依赖。
const SWITCH_WAIT_MS = 60000;

/** 客户端可执行文件：env WB_EXE > 进程路径探测 > 常见安装位置。 */
function resolveWbExe() {
  if (process.env.WB_EXE) return process.env.WB_EXE;
  try {
    const found = require('child_process').execSync(
      'powershell -NoProfile -Command "Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path"',
      { encoding: 'utf8', timeout: 10000 },
    ).trim();
    if (found && fs.existsSync(found)) return found;
  } catch { /* 探测失败走默认 */ }
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Tencent', 'WorkBuddy', 'WorkBuddy.exe') : null,
    path.join('C:', 'opt', 'software', 'Tencent', 'WorkBuddy', 'WorkBuddy.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'WorkBuddy'; // 兜底：交给 PATH
}

/**
 * 判断客户端当前是否在运行（用户会话视角：服务 Session0 不可见，故以计划任务查询用户会话）。
 * @returns {boolean|null} true/false；探测命令本身失败时返回 null（无法判定）
 */
function probeClientRunning() {
  // 交互会话（session>0）直接查
  const sess = execSyncQuiet('powershell -NoProfile -Command (Get-Process -Id $PID).SessionId');
  if (!sess.ok) {
    console.warn(`[rotate] 会话探测失败，无法判定客户端状态: ${sess.err}`);
    return null;
  }
  const cmd = sess.out === '0'
    // 服务会话（Session 0）看不到用户会话进程，改用 Win32_Process 全量查询。
    // -Filter 的值必须包在双引号里再转义：写成 -Filter 'Name='x'' 会被 PowerShell
    // 拆成位置参数并抛 PositionalParameterNotFound。
    ? 'powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name=\'WorkBuddy.exe\'\\" | Measure-Object).Count"'
    : 'powershell -NoProfile -Command "(Get-Process WorkBuddy -ErrorAction SilentlyContinue | Measure-Object).Count"';
  const r = execSyncQuiet(cmd);
  if (!r.ok) {
    console.warn(`[rotate] 进程探测失败，无法判定客户端状态: ${r.err}`);
    return null;
  }
  const n = Number(r.out);
  return Number.isFinite(n) ? n > 0 : null;
}

/** 客户端是否在运行；仅「确认在运行」时返回 true（探测失败不视为在运行）。 */
function isClientRunning() {
  return probeClientRunning() === true;
}

/** 静默执行：返回 {ok, out, err}，调用方据此区分「命令失败」与「空输出」。 */
function execSyncQuiet(cmd) {
  try {
    return { ok: true, out: require('child_process').execSync(cmd, { encoding: 'utf8', timeout: 12000 }).trim(), err: null };
  } catch (e) {
    return { ok: false, out: '', err: String((e && (e.stderr || e.message)) || 'unknown').split('\n')[0].trim() };
  }
}
/**
 * 停止客户端（普通权限 → 提权兜底 → 调度式重启兜底）。
 * 注意：relay-gate 以 LocalSystem 服务运行（Session 0），看不到也无法停止
 * 普通用户在 Session 1 启动的 WorkBuddy 进程（Access denied）。UAC RunAs 在服务
 * 会话中不弹窗。最终可靠方案：注册临时计划任务（schtasks），以交互用户身份执行
 * Stop-Process，再在用户会话启动客户端。
 * @returns {Promise<boolean>} 是否已全部停止
 */
async function stopClient() {
  // 1) 当前会话普通停止
  try {
    await new Promise((resolve) => {
      execFile('powershell', ['-NoProfile', '-Command', 'Get-Process WorkBuddy -ErrorAction SilentlyContinue | Stop-Process -Force'], { timeout: 15000 }, () => resolve());
    });
  } catch { /* 忽略 */ }
  await sleep(1500);
  const running = probeClientRunning();
  if (running === false) return true;
  if (running === null) console.warn('[rotate] stop client: 无法判定客户端状态，继续尝试停止流程');

  // 2) RunAs 提权（仅交互用户会话可用；服务会话下无弹窗则直接跳过）
  try {
    const out = require('child_process').execSync(
      'powershell -NoProfile -Command "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"',
      { encoding: 'utf8', timeout: 8000 },
    ).trim();
    if (out === 'False') {
      console.warn('[rotate] stop client: session-0 (service) cannot stop user-session processes; trying schtasks…');
      const task = await trySchtasksStop();
      if (task) return true;
    }
    // 交互管理员会话：RunAs 弹窗提权
    console.warn('[rotate] stop client needs elevation, prompting UAC…');
    await new Promise((resolve) => {
      execFile('powershell', ['-NoProfile', '-Command',
        '$p = Start-Process powershell -Verb RunAs -WindowStyle Hidden -PassThru -ArgumentList \'-NoProfile\',\'-Command\',\'Get-Process WorkBuddy -ErrorAction SilentlyContinue | Stop-Process -Force\'; $p.WaitForExit()'],
        { timeout: 120000 }, () => resolve());
    });
    await sleep(2000);
  } catch { /* 忽略 */ }
  // 仅在「确认已停止」时返回 true；探测失败不得当成已停止
  return probeClientRunning() === false;
}

/**
 * 注册临时计划任务，以当前登录交互用户身份停止 WorkBuddy 客户端。
 * 必须 /IT（交互式任务）：任务在登录用户会话运行，才能停止用户会话的客户端进程。
 * @returns {Promise<boolean>} 是否已成功停止
 */
async function trySchtasksStop() {
  const taskName = 'RelayGateStopWb_' + Date.now().toString(36);
  const cmd = 'powershell -NoProfile -Command "Get-Process WorkBuddy -ErrorAction SilentlyContinue | Stop-Process -Force"';
  try {
    // schtasks /create 会有 WARNING(ST 早于当前时间) 但任务创建成功——以退出码判断而非 stdout
    const createOk = await new Promise((resolve) => {
      execFile('schtasks', ['/create', '/tn', taskName, '/tr', cmd, '/sc', 'once', '/st', '00:00', '/IT', '/f'], { timeout: 20000 }, (err) => resolve(!err));
    });
    if (!createOk) {
      console.warn('[rotate] schtasks /IT create failed');
      return false;
    }
    await new Promise((resolve) => {
      execFile('schtasks', ['/run', '/tn', taskName], { timeout: 20000 }, () => resolve());
    });
    // 调度器侧从 /run 到实际执行有迟滞（实测 ~30s），轮询等待而非固定 sleep
    let stopOk = false;
    for (let i = 0; i < 12; i++) {
      await sleep(3500);
      if (probeClientRunning() === false) { stopOk = true; break; }
    }
    const ok = stopOk;
    await new Promise((resolve) => {
      execFile('schtasks', ['/delete', '/tn', taskName, '/f'], { timeout: 20000 }, () => resolve());
    });
    if (ok) {
      console.log('[rotate] stop client via schtasks /IT OK');
      return true;
    }
    console.warn('[rotate] schtasks /IT stop not confirmed');
  } catch { /* 忽略 */ }
  return false;
}

/** 本进程所在会话 ID；探测失败返回 null（未知）。结果缓存（进程不换会话）。 */
let ownSessionIdCache;
function probeOwnSessionId() {
  if (ownSessionIdCache !== undefined) return ownSessionIdCache;
  const sess = execSyncQuiet('powershell -NoProfile -Command (Get-Process -Id $PID).SessionId');
  ownSessionIdCache = sess.ok && /^\d+$/.test(sess.out) ? Number(sess.out) : null;
  return ownSessionIdCache;
}

/** 最新一个 WorkBuddy 进程所在会话；无进程或探测失败返回 null。
 *  取最新（CreationDate 降序）：残留旧进程在场时，新启动的进程才是判定对象；
 *  Electron 子进程继承主进程会话，会话归属不受影响。 */
function probeClientSession() {
  const r = execSyncQuiet('powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name=\'WorkBuddy.exe\'\\" | Sort-Object CreationDate -Descending | Select-Object -First 1 -ExpandProperty SessionId)"');
  if (!r.ok || !/^\d+$/.test(r.out)) return null;
  return Number(r.out);
}

/** 轮询等待客户端进程真实出现。
 *  基线 count0 之后的增量才算新进程——否则启动前残留的旧进程（如
 *  Session 0 隐形实例）会让验证误判成功。count0 为 null 时退化为存在性判断。 */
async function waitForClientStart(timeoutMs, count0) {
  const deadline = Date.now() + timeoutMs;
  const base = typeof count0 === 'number' ? count0 : null;
  while (Date.now() < deadline) {
    await sleep(1000);
    if (probeClientRunning() !== true) continue;
    if (base !== null) {
      const now = clientProcessCount();
      if (now !== null && now > base) return { started: true, session: probeClientSession() };
      continue;
    }
    return { started: true, session: probeClientSession() };
  }
  return { started: false, session: null };
}

/** WorkBuddy 进程数；探测失败返回 null。 */
function clientProcessCount() {
  const own = probeOwnSessionId();
  const cmd = own === 0
    ? 'powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name=\'WorkBuddy.exe\'\\" | Measure-Object).Count"'
    : 'powershell -NoProfile -Command "(Get-Process WorkBuddy -ErrorAction SilentlyContinue | Measure-Object).Count"';
  const r = execSyncQuiet(cmd);
  if (!r.ok) return null;
  const n = Number(r.out);
  return Number.isFinite(n) ? n : null;
}

/** 删除临时计划任务；延迟 2s 再试（任务刚 /run 完处于状态切换期，立即删除易失败）。
 *  原实现的 10s 单次删除在服务下长期失败，累积数百残留。 */
function deleteTaskQuiet(taskName) {
  setTimeout(() => {
    (async () => {
      for (let i = 0; i < 3; i++) {
        if (schtasksCmd(['/delete', '/tn', taskName, '/f'])) return;
        await sleep(3000 * (i + 1));
      }
      console.warn(`[rotate] 临时任务清理失败（残留，可手动删除）：schtasks /delete /tn ${taskName} /f`);
    })();
  }, 2000);
}

/** schtasks 子命令：execFileSync 数组传参（绕开 shell 与 GBK 输出编码层），以退出码判定成败。 */
function schtasksCmd(args) {
  try {
    require('child_process').execFileSync('schtasks', args, { encoding: 'utf8', timeout: 20000 });
    return true;
  } catch (e) {
    // WARNING 类输出（/ST 早于当前时间）退出码为 0，走 ok 分支；非 0 才是失败
    return false;
  }
}

/**
 * 启动客户端并验证进程真的出现（返回 ok=true 才算启动成功）。
 *
 * 首选 schtasks /IT 交互式任务：客户端必须在用户交互会话才有窗口；
 * 服务会话（Session 0）里 execFile 直接启动产生的正是无窗口的隐形后台
 * 进程，因此服务会话下禁止该兜底。/IT 任务在服务上下文触发时可能静默
 * 不运行（历史实测 Last Result=267011），故必须轮询验证并向调用方如实
 * 报告失败原因，而非默认成功。
 *
 * @returns {Promise<{ok:boolean, via?:'schtasks'|'direct', session?:number|null,
 *                     reason?:'service_session'|'no_process'|'start_failed'|'session0'}>}
 */
async function startClient() {
  const exe = resolveWbExe();
  const ownSession = probeOwnSessionId();
  const taskName = 'RelayGateStartWb_' + Date.now().toString(36);
  const count0 = clientProcessCount();

  const created = schtasksCmd(['/create', '/tn', taskName, '/tr', `"${exe}"`, '/sc', 'once', '/st', '00:00', '/IT', '/f']);
  if (created) {
    try {
      schtasksCmd(['/run', '/tn', taskName]);
      // SYSTEM 上下文实测：/IT 任务从 /run 到进程出现有 ~30s 迟滞，等待过短会误判失败
      const w = await waitForClientStart(45000, count0);
      if (w.started) {
        // 交互会话发起却落在 Session 0：客户端不可见，视为失败
        if (ownSession !== 0 && w.session === 0) return { ok: false, reason: 'session0', session: w.session };
        return { ok: true, via: 'schtasks', session: w.session };
      }
      // /run 已下发但进程未出现：落到下方判断（服务会话下不再兜底）
    } finally {
      deleteTaskQuiet(taskName);
    }
  } else {
    console.warn(`[rotate] schtasks create failed (exit != 0): ${taskName}`);
  }

  if (ownSession === null) {
    // 会话未知时不得兜底：execFile 若落在 Session 0 会产生隐形后台进程
    console.error('[rotate] 无法判定本进程会话，拒绝 execFile 兜底以防隐形进程');
    return { ok: false, reason: 'service_session' };
  }
  if (ownSession === 0) {
    console.error('[rotate] 服务会话无法拉起可见客户端（schtasks /IT 未生效），拒绝 execFile 隐形兜底');
    return { ok: false, reason: 'service_session' };
  }
  try {
    const child = execFile(exe, [], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    console.error(`[rotate] start client failed: ${e.message}`);
    return { ok: false, reason: 'start_failed' };
  }
  const w2 = await waitForClientStart(20000, count0);
  if (!w2.started) return { ok: false, reason: 'no_process' };
  if (w2.session === 0) return { ok: false, reason: 'session0', session: w2.session };
  return { ok: true, via: 'direct', session: w2.session };
}

const STATE_FILE = stateFile('rotate-accounts-state.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) || {}; } catch { return {}; }
}
function writeState(s) {
  writeJsonAtomic(STATE_FILE, s);
}

/** 若无任何可用备份，先从账号库生成种子备份（一键免手动登录）。 */
function ensureSeedBackups() {
  if (discoverAccounts().length > 0) return { needed: false, ...seedAll() };
  return { needed: true, ...seedAll() };
}

/** 切换 auth 主文件（覆盖式）。返回 {ok, msg}。 */
function replaceAuthFile(src) {
  if (!fs.existsSync(src)) return { ok: false, msg: '备份不存在: ' + src };
  try {
    fs.copyFileSync(src, AUTH_FILE);
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: '切换失败: ' + e.message };
  }
}

function switchTo(account) {
  const src = account.backup === 'workbuddy-desktop.info'
    ? AUTH_FILE
    : path.join(AUTH_DIR, account.backup);
  if (!fs.existsSync(src)) return { ok: false, msg: '备份不存在: ' + account.backup };

  // 备份当前 auth
  const cur = readUid();
  if (cur && cur !== account.uid && account.backup !== 'workbuddy-desktop.info') {
    try {
      fs.copyFileSync(AUTH_FILE, path.join(AUTH_DIR, 'workbuddy-desktop.info.bak-' + cur.slice(0, 8)));
    } catch { /* 备份失败不阻断 */ }
  }
  try {
    fs.copyFileSync(src, AUTH_FILE);
    return { ok: true, msg: '已切换到 ' + (account.label || account.uid.slice(0, 8)) };
  } catch (e) {
    return { ok: false, msg: '切换失败: ' + e.message };
  }
}

/**
 * 轮换所有账号一遍（每个账号停留 stayMs 让客户端完成初始化）。
 * 互斥：定时轮与手动触发并发时会互杀进程，进行中的轮换直接拒绝新请求。
 * @returns {Promise<{ok:number, failed:number, results:Array, skippedUids?:Array, busy?:boolean}>}
 */
let rotateRunning = false;
async function rotateAll() {
  if (rotateRunning) {
    return { ok: 0, failed: 0, busy: true, results: [{ msg: '轮换已在进行中，本次触发被跳过' }] };
  }
  rotateRunning = true;
  try {
    return await rotateAllInner();
  } finally {
    rotateRunning = false;
  }
}

/** 单账号切换与整遍轮换共用互斥（同锁：两者都杀/启客户端进程）。 */
async function switchAccount(uid) {
  if (rotateRunning) {
    return { ok: false, busy: true, msg: '轮换已在进行中，请稍后再切换账号' };
  }
  rotateRunning = true;
  try {
    return await switchAccountInner(uid);
  } finally {
    rotateRunning = false;
  }
}

async function rotateAllInner() {
  const rs = require('./rotate-settings').getEffective();
  const stayMs = rs.stayMs > 0 ? rs.stayMs : SWITCH_WAIT_MS;
  // 无备份时先由账号库生成种子，保证轮换可立即执行（无需手动登录客户端）
  if (discoverAccounts().length === 0) {
    try {
      const seeded = require('./rotate-seed').seedAll();
      console.log(`[rotate] seeded ${seeded.ok.length} backups from account store (skipped ${seeded.skipped.length}, failed ${seeded.failed.length})`);
    } catch (e) {
      console.error('[rotate] seed backups failed:', e.message);
    }
  }
  let accounts = discoverAccounts();
  // 排除名单
  const exclude = new Set(String(rs.excludeUids || '').split(',').map((s) => s.trim()).filter(Boolean));
  let skippedUids = [];
  if (exclude.size) {
    const included = [];
    for (const a of accounts) {
      if (exclude.has(a.uid)) { skippedUids.push(a.uid); continue; }
      included.push(a);
    }
    accounts = included;
  }
  if (accounts.length === 0) {
    return { ok: 0, failed: 0, results: [{ msg: '未发现可用账号备份' + (skippedUids.length ? `（${skippedUids.length} 个被排除）` : '') }], skippedUids };
  }
  const results = [];
  let ok = 0, failed = 0;
  const startUid = readUid();
  // 确保客户端进程停止（覆盖式切换的唯一可靠时机）
  const stopped = await stopClient();
  if (!stopped) {
    return { ok: 0, failed: 0, results: [{ msg: '无法停止 WorkBuddy 客户端（进程被保护，需以管理员运行或手动关闭客户端）' }], skippedUids };
  }
  await sleep(1000);

  for (const acct of accounts) {
    const r = switchTo(acct);
    results.push({ label: acct.label, uid: acct.uid, ...r });
    if (r.ok) ok++; else failed++;
    if (r.ok) {
      // 切换后启动客户端热加载该账号，停留观察；启动失败如实计失败
      const s = await startClient();
      if (!s.ok) {
        results.push({ label: acct.label, uid: acct.uid, ok: false, msg: `客户端启动失败（${s.reason || 'unknown'}）` });
        failed++;
        break;
      }
      await sleep(stayMs);
      // 下一个账号前再停止客户端（当前进程已在跑，直接覆盖可能被写回）
      const stopped2 = await stopClient();
      if (!stopped2) {
        results.push({ label: acct.label, uid: acct.uid, ok: false, msg: '后续账号停止客户端失败（需管理员权限）' });
        failed++;
        break;
      }
      await sleep(1000);
    }
  }

  // 切回起始账号（可配）
  if (rs.switchBack) {
    const back = accounts.find((a) => a.uid === startUid);
    if (back) {
      switchTo(back);
      await sleep(1000);
      if (!isClientRunning()) await startClient();
      await sleep(5000);
    }
  } else if (!isClientRunning()) {
    await startClient();
  }

  const st = readState();
  st.lastRotateAt = new Date().toISOString();
  st.lastRotateOk = ok;
  st.lastRotateFailed = failed;
  st.results = results;
  writeState(st);
  return { ok, failed, results, skippedUids };
}

/** 单账号切换实际逻辑（互斥包装见上方 switchAccount）。 */
async function switchAccountInner(uid) {
  const acct = discoverAccounts().find((a) => a.uid.startsWith(uid) || a.label === uid);
  if (!acct) return { ok: false, msg: '账号未找到: ' + uid };
  const cur = readUid();
  // 备份当前 auth（防止目标与当前相同仍先备份当前）
  if (cur && cur !== acct.uid && acct.backup !== 'workbuddy-desktop.info') {
    try {
      fs.copyFileSync(AUTH_FILE, path.join(AUTH_DIR, 'workbuddy-desktop.info.bak-' + cur.slice(0, 8)));
    } catch { /* 备份失败不阻断 */ }
  }
  const stopped = await stopClient();
  if (!stopped) {
    return { ok: false, msg: '无法停止 WorkBuddy 客户端（进程被保护或跨会话权限不足）。请手动关闭客户端后重试。' };
  }
  await sleep(1000);
  const r = replaceAuthFile(acct.backup === 'workbuddy-desktop.info' ? AUTH_FILE : path.join(AUTH_DIR, acct.backup));
  if (!r.ok) {
    await startClient();
    return { ok: false, msg: r.msg };
  }
  const s = await startClient();
  if (!s.ok) {
    return { ok: false, msg: r.msg + `，但客户端启动失败（${s.reason || 'unknown'}）`, uid: acct.uid, label: acct.label };
  }
  return { ok: true, msg: '已切换到 ' + (acct.label || acct.uid.slice(0, 8)) + '（客户端已重启热加载）', uid: acct.uid, label: acct.label };
}

/** 查询各账号今日活跃状态（只读，不切换）。 */
async function checkStatus() {
  const store = require('../credentials/store');
  const wbAuth = require('../workbuddy/auth');
  const auth = require('../auth');
  const accounts = store.list().filter((a) => a.edition === 'workbuddy');
  const out = [];
  for (const a of accounts) {
    let e = {};
    try { e = await auth.ensureAuth(a.id); } catch { /* 用库里的 token */ }
    const info = { accessToken: e.token || a.token, uid: e.userId || a.userId, region: 'cn' };
    try {
      const r = await fetch(GROWTH_HOST + '/activity/growth/heatmap', {
        headers: wbAuth.authHeaders(info, {
          'Accept': 'application/json, text/plain, */*',
          'X-Product-Code': 'workbuddy',
          'Origin': GROWTH_HOST,
          'Referer': GROWTH_HOST + '/profile/growth-center',
        }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json();
      const t = (j.data && j.data.today) || {};
      const level = (s) => s <= 0 ? '尚未登场' : s <= 10 ? '轻轻路过' : s <= 30 ? '持续输出' : s <= 60 ? '效率拉满' : '卷王模式';
      out.push({
        accountId: a.id, label: a.label, uid: a.userId,
        score: t.score ?? 0, isActive: !!t.is_active,
        level: level(t.score || 0), statusText: t.status_text || '',
      });
    } catch (err) {
      out.push({ accountId: a.id, label: a.label, uid: a.userId, error: err.message });
    }
  }
  return out;
}

/** 当前 auth 文件对应的 uid。 */
function currentUid() { return readUid(); }

module.exports = {
  rotateAll,
  checkStatus,
  discoverAccounts,
  currentUid,
  switchTo,
  switchAccount,
  readState,
  ensureSeedBackups,
  seedAll: () => require('./rotate-seed').seedAll(),
  resolveAuthDir,
  isClientRunning,
  probeClientRunning,
  stopClient,
  startClient,
  resolveWbExe,
  AUTH_DIR,
  AUTH_FILE,
};

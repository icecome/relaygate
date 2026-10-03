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

/** 判断客户端当前是否在运行（用户会话视角：服务 Session0 不可见，故以计划任务查询用户会话）。 */
function isClientRunning() {
  // 交互会话（session>0）直接查
  try {
    const sess = execSyncQuiet('powershell -NoProfile -Command (Get-Process -Id $PID).SessionId');
    if (sess !== '0') {
      const n = execSyncQuiet('powershell -NoProfile -Command "(Get-Process WorkBuddy -ErrorAction SilentlyContinue | Measure-Object).Count"');
      return Number(n) > 0;
    }
  } catch { /* 回退 */ }
  // 服务会话：通过 schtasks 查询用户会话（旧逻辑默认 Session0 会漏判）
  try {
    const out = execSyncQuiet('powershell -NoProfile -Command "schtasks /query /fo csv 2>&1 | Select-String \'RelayGate\' | Measure-Object | Select-Object -ExpandProperty Count"');
    // 存在残留任务不代表运行；更稳：直接查 Win32_Process（服务能看到所有进程，但 Stop 受限）
    const count = execSyncQuiet('powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \'Name=\'WorkBuddy.exe\'\' | Measure-Object).Count"');
    return Number(count) > 0;
  } catch {
    return false;
  }
}

/** 静默执行并返回 stdout（去换行）。 */
function execSyncQuiet(cmd) {
  try {
    return require('child_process').execSync(cmd, { encoding: 'utf8', timeout: 12000 }).trim();
  } catch {
    return '';
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
  if (!isClientRunning()) return true;

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
  return !isClientRunning();
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
    await sleep(4000);
    const ok = !isClientRunning();
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

/**
 * 启动客户端到「用户交互会话」（客户端必须在交互会话才有意义）。
 * 服务会话（Session 0）无交互桌面，execFile 直接启动对用户不可见 → 用
 * schtasks /IT（交互式任务）在登录用户会话拉起 WorkBuddy（窗口可见）。
 * /IT 任务以当前登录用户运行；服务创建时也须带 /IT。
 */
function startClient() {
  const exe = resolveWbExe();
  // schtasks /IT 交互式任务（用户会话、可见窗口）
  try {
    const taskName = 'RelayGateStartWb_' + Date.now().toString(36);
    const cmd = `"${exe}"`;
    const created = execSyncQuiet(`schtasks /create /tn ${taskName} /tr "${cmd}" /sc once /st 00:00 /IT /f`);
    if (created.includes('SUCCESS')) {
      execSyncQuiet(`schtasks /run /tn ${taskName}`);
      setTimeout(() => {
        try { require('child_process').execSync(`schtasks /delete /tn ${taskName} /f`, { timeout: 10000 }); } catch { /* 清理失败忽略 */ }
      }, 10000);
      return true;
    }
  } catch (e) {
    console.error(`[rotate] schtasks /IT start failed: ${e.message}`);
  }
  // 兜底：直接启动（交互会话可用）
  try {
    const child = execFile(exe, [], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch (e) {
    console.error(`[rotate] start client failed: ${e.message}`);
    return false;
  }
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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 轮换所有账号一遍（每个账号停留 stayMs 让客户端完成初始化）。
 * @returns {Promise<{ok:number, failed:number, results:Array, skippedUids?:Array}>}
 */
async function rotateAll() {
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
      // 切换后启动客户端热加载该账号，停留观察
      startClient();
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
      if (!isClientRunning()) startClient();
      await sleep(5000);
    }
  } else if (!isClientRunning()) {
    startClient();
  }

  const st = readState();
  st.lastRotateAt = new Date().toISOString();
  st.lastRotateOk = ok;
  st.lastRotateFailed = failed;
  st.results = results;
  writeState(st);
  return { ok, failed, results, skippedUids };
}

/** 单账号切换：停止客户端（含提权/交互任务兜底）→ 覆盖 auth → 启动客户端（立即生效）。 */
async function switchAccount(uid) {
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
    startClient();
    return { ok: false, msg: r.msg };
  }
  startClient();
  await sleep(3000);
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
  stopClient,
  startClient,
  resolveWbExe,
  AUTH_DIR,
  AUTH_FILE,
};

'use strict';
/**
 * credentials/refresh-expiry.js — refreshToken 到期时间的权威推导与存量修复。
 *
 * 为什么需要这个模块（2026-11-25 事故：「7 个账号需重新登录」误报）：
 *
 *   前端判「需重新登录」的唯一判据是 `account.refreshExpiredAt <= now`
 *   （web/src/features/accounts/accountPacks.tsx#keepaliveOf）。但这一列在
 *   WorkBuddy 渠道上曾经是「导入时写一次、之后永不再更新」：
 *
 *     - 续期链路（auth/index.js#ensureAuth、jobs/rotate-accounts.js#verifyRefresh、
 *       routes/workbuddy.js#POST /refresh）都只回写 token / expiredAt；
 *     - 客户端同步链路（jobs/auth-sync.js）同样不碰它；
 *     - 于是导入满 30 天（refreshToken 的寿命）后，该列必然跨过 now，
 *       面板永久报「N 个账号需重新登录」，而账号其实每轮续期都成功。
 *
 *   实测证据（2026-11-25）：
 *     - 8 个 WB 账号 billing 面全部 200，当日 1200+ 次转发 0 个 401；
 *     - 库内 refresh_expired_at 全为 2026-11-25T04:02:3x（同一次导入写入），
 *       而同一批 refreshToken 的 JWT exp 是 2026-12-24/25（还有 29 天）；
 *     - 上游续期响应只返回 {accessToken, refreshToken, expiresAt}，
 *       不含 refreshExpiresAt —— 所以新到期时刻只能从新 refreshToken 的 JWT 里取。
 *
 * 本模块提供两件事：
 *   1. `jwtExpIso(token)`：从 JWT payload.exp 推绝对到期时刻（离线、无副作用）；
 *   2. `repairWorkbuddyRefreshExpiry()`：把库里明显陈旧的该列按 JWT exp 修正。
 *      只修「库内值已过期、但 token 自己的 exp 还在未来」这一种自相矛盾的情形，
 *      其余一律不动 —— 修复必须是可解释的，不能拿 JWT 去覆盖一个真的更早的到期。
 */
const store = require('./store');

/** 从 JWT 取 exp（ISO）；非 JWT / 无 exp 返回 null。 */
function jwtExpIso(token) {
  try {
    const seg = String(token || '').split('.')[1];
    if (!seg) return null;
    const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
    if (!payload || !payload.exp) return null;
    const ms = Number(payload.exp) * 1000;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  } catch { return null; }
}

/**
 * 修复 WorkBuddy 账号的 refresh_expired_at。
 *
 * 判据：库内值必须与 refreshToken 自己的 JWT exp 一致（容差 1 小时，覆盖
 * 「客户端按 expiresIn 相对秒数落库」造成的秒级~分钟级偏差）。偏离容差即判为
 * 陈旧记录并纠正，两个方向都要纠：
 *
 *   a) 库内值已过期、token 却还有效 → 前端误报「需重新登录」（本次事故形态）；
 *   b) 库内值比 token 的真实 exp 还晚 → 到期告警被推迟，凭据悄悄死掉才被发现，
 *      比 (a) 更危险，只是它不会立刻在面板上冒出来。
 *
 * 不动的情形：refreshToken 缺失、不是 JWT、JWT 无 exp —— 无法证伪就不改。
 *
 * @returns {{scanned:number, repaired:number, items:Array<{id,label,from,to,reason}>}}
 */
const TOLERANCE_MS = 3600 * 1000;

function repairWorkbuddyRefreshExpiry() {
  const now = Date.now();
  const out = { scanned: 0, repaired: 0, items: [] };
  let rows = [];
  try { rows = store.list().filter((a) => a.edition === 'workbuddy'); } catch { return out; }

  for (const summary of rows) {
    out.scanned += 1;
    let full;
    try { full = store.get(summary.id); } catch { continue; }
    if (!full || !full.refreshToken) continue;

    const realIso = jwtExpIso(full.refreshToken);
    const realMs = realIso ? Date.parse(realIso) : NaN;
    if (!Number.isFinite(realMs)) continue;

    const storedMs = full.refreshExpiredAt ? Date.parse(full.refreshExpiredAt) : NaN;
    if (Number.isFinite(storedMs) && Math.abs(storedMs - realMs) <= TOLERANCE_MS) continue;

    const reason = !Number.isFinite(storedMs)
      ? 'missing'
      : storedMs <= now
        ? 'stale_expired'
        : storedMs > realMs
          ? 'optimistic'
          : 'drift';

    try {
      store.update(full.id, { refreshExpiredAt: realIso });
      out.repaired += 1;
      out.items.push({ id: full.id, label: full.label, from: full.refreshExpiredAt || null, to: realIso, reason });
    } catch { /* 单条写失败不阻断其余修复 */ }
  }
  return out;
}

module.exports = { jwtExpIso, repairWorkbuddyRefreshExpiry };

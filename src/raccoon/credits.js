'use strict';
/**
 * raccoon/credits.js —— Raccoon 积分（余额 + 一次性登录奖励 + 账单）。
 *
 * ## ⚠️ 三个来源的语义（关键，别混）
 *
 * | 来源 | 金额 | 触发方式 | 本模块 |
 * |---|---|---|---|
 * | 新人注册礼包 | 3000 | 注册时服务端自动发放 | 不涉及（用户注册即有） |
 * | 桌面端登录奖励 | 3000 | `POST …/login/points/grant` | ✅ `claimLoginReward` |
 * | 每日积分发放 | 300 | **服务端按日自动发放，无端点** | ❌ 不实现 |
 *
 * ⚠️ **每日 300 没有签到端点** —— 实测账号注册后 1 分钟就收到 `daily_grant` 账单。
 * 故**不能**把它实现成签到按钮：不存在可调用的端点，按钮必然失败。
 * 一次性的是「桌面端登录奖励」，语义是 onboarding 任务，不是每日签到。
 *
 * ## 计量口径（本仓库的硬约束）
 *
 * Raccoon 的积分单位是 **credit**（与 Trae/WorkBuddy 同口径），所以
 * `points/v1/balance` 的 `available_points` **可以**写进 `accounts.balance`。
 * 但**不写** `entitlement_snapshot.packs`：余额 API 只给总数与分池数，
 * 没有每个包的到期时间，写成 packs 会让 FEFO 排序与「3 日内到期积分」读到一个
 * 没有到期时间的包。分池明细写进独立的 `raccoonPoints` 键，不被任何积分消费方读取。
 * （ZCode 的教训是反方向：token 单位绝不能进积分口径。）
 */
const store = require('../credentials/store');
const client = require('./client');
const product = require('./product');

/**
 * 查询积分余额。
 *
 * ⚠️ 只读：`GET points/v1/balance`。在「打开面板」这类高频路径上**绝不**触碰
 * 写端点（参考项目里 Loomy 的 `first-login` 踩过「打开面板即意外触发签到」的坑）。
 *
 * @returns {Promise<{available:number, packages:Array<{name:string,remaining:number}>}|null>}
 *          查不到时返回 null（面板显示原因，**不是** 0）
 */
async function fetchBalance(acct) {
  const credential = client.credentialOf(acct);
  const r = await client.request({
    method: 'GET',
    path: 'pointsBalance',
    headers: product.desktopHeaders(credential),
  });
  const data = client.unwrap(r.envelope, { method: 'GET', path: 'pointsBalance', status: r.status });
  if (!data) return null;
  const available = readNumber(data.available_points);
  // `available_points` 是核心字段：没有它就说明响应形状不对，不编造数字
  if (available === undefined) return null;

  // 各池分开列，让用户看出「注册礼包 / 每日 / 会员 / 充值」是独立来源
  const packages = [];
  const reward = readNumber(data.reward_points);
  const daily = readNumber(data.daily_points);
  const monthly = readNumber(data.monthly_points);
  const topup = readNumber(data.topup_points);
  if (reward !== undefined) packages.push({ name: '奖励积分', remaining: reward });
  if (daily !== undefined) packages.push({ name: '每日积分', remaining: daily });
  if (monthly !== undefined && monthly > 0) packages.push({ name: '会员积分', remaining: monthly });
  if (topup !== undefined) packages.push({ name: '充值积分', remaining: topup });
  // 极端情形（服务端只给 total 不给分项）也要有至少一个包，否则 UI 空列表
  if (!packages.length) packages.push({ name: '可用积分', remaining: available });

  return { available, packages };
}

/** 读成有限数字；非法返回 undefined（**不编造 0**）。 */
function readNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 刷新并回写账号库的积分。
 *
 * 写入口径（三处，勿改）：
 *   - `accounts.balance` ← `available_points`（credit 口径，面板余额列读它）
 *   - `entitlement_snapshot.raccoonPoints` ← 分池明细 + 时间戳（隔离键，无消费方）
 *   - **不写** `entitlement_snapshot.packs`（无到期时间，写进去会污染 FEFO）
 */
async function refreshBalance(acct) {
  const stored = store.get(acct.id) || acct;
  const balance = await fetchBalance(stored);
  if (!balance) {
    throw new client.RaccoonApiError('raccoon 积分余额响应形状不符（缺 available_points）');
  }
  const prev = stored.entitlementSnapshot && typeof stored.entitlementSnapshot === 'object'
    ? stored.entitlementSnapshot
    : {};
  return store.update(stored.id, {
    balance: balance.available,
    entitlementSnapshot: {
      ...prev,
      // 独立键：所有积分消费方（creditTotals / summarizeExpiry / FEFO）都不读它
      raccoonPoints: {
        available: balance.available,
        packages: balance.packages,
        updatedAt: new Date().toISOString(),
      },
    },
  });
}

/**
 * 领取「桌面端登录奖励」（一次性，幂等）。
 *
 * ⚠️ **不是每日签到**：该端点是幂等一次性的（已领过返回 `granted:false`）。
 * ⚠️ 需要 `X-Client-Platform` 头（标识「来自桌面端」），缺了会被拒 —— 见
 * `product.headers`（默认就带）。
 *
 * @returns {Promise<{result:'claimed'|'already'|'failed', points?:number, message:string, code?:number|null}>}
 *          本函数**不抛错**（失败也返回 failed），保证批量领取不因单账号中断。
 */
async function claimLoginReward(acct) {
  const credential = client.credentialOf(acct);
  let r;
  try {
    r = await client.request({
      method: 'POST',
      path: 'loginRewardGrant',
      headers: product.desktopHeaders(credential),
    });
  } catch (e) {
    return { result: 'failed', message: e.message, code: null };
  }
  if (!r.envelope || r.envelope.code !== 0) {
    return {
      result: 'failed',
      message: client.envelopeMessage(r.envelope, '领取登录奖励失败'),
      code: r.envelope ? r.envelope.code : null,
    };
  }
  // ⚠️ 幂等判据是 `granted`（重复领取同样 HTTP 200 + granted:false），
  // 故映射成 already 而**不是** claimed —— 后者会让用户以为每天都真的加了额度。
  if (!r.envelope.data || r.envelope.data.granted !== true) {
    return { result: 'already', message: '该账号已领取过桌面端登录奖励（每号一次）', code: 0 };
  }
  const popup = r.envelope.data.popup && typeof r.envelope.data.popup === 'object' ? r.envelope.data.popup : {};
  const points = readNumber(popup.points) || product.LOGIN_REWARD_POINTS;
  return { result: 'claimed', points, message: `已领取桌面端登录奖励 +${points} 积分`, code: 0 };
}

/**
 * 查询「桌面端登录奖励」是否已领。
 *
 * 判据：`GET points/v1/bills` 里已有 `biz_type === 'reward_grant'` 且
 * `event_name === '桌面端登录奖励'` 的记录。
 *
 * ⚠️ **不能靠 balance 推断** —— 余额是多个来源的合计，无法区分某一项是否已领。
 * ⚠️ **不能只按 `biz_type === 'reward_grant'` 判定** ——「新人注册礼包」也是
 * `reward_grant`，把它算作登录奖励会让新用户一开始就显示「已领取」。
 * ⚠️ **服务端没有单独的奖励状态端点**（实测），故只能查账单明细。
 * ⚠️ 查询失败时保守返回 `claimed:false` —— 宁可让用户多点一次（服务端幂等、
 * 无害），也不要误报「已领」而让他真的错过。
 */
async function fetchOnboardingStatus(acct) {
  const credential = client.credentialOf(acct);
  let r;
  try {
    r = await client.request({
      method: 'GET',
      path: 'pointsBills',
      headers: product.desktopHeaders(credential),
      query: { 'paging.limit': 50, 'paging.offset': 0 },
    });
  } catch {
    return { claimed: false, points: product.LOGIN_REWARD_POINTS, detail: '账单查询失败' };
  }
  if (!r.envelope || r.envelope.code !== 0 || !r.envelope.data) {
    return { claimed: false, points: product.LOGIN_REWARD_POINTS, detail: '账单查询失败' };
  }
  const items = Array.isArray(r.envelope.data.items) ? r.envelope.data.items : [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (item.biz_type !== 'reward_grant') continue;
    if (item.event_name !== product.LOGIN_REWARD_EVENT_NAME) continue;
    const points = readNumber(item.points);
    return {
      claimed: true,
      points: points !== undefined && points > 0 ? points : product.LOGIN_REWARD_POINTS,
      detail: '账单中已有桌面端登录奖励记录',
    };
  }
  return { claimed: false, points: product.LOGIN_REWARD_POINTS, detail: '账单中暂无登录奖励记录' };
}

module.exports = {
  fetchBalance,
  refreshBalance,
  claimLoginReward,
  fetchOnboardingStatus,
  readNumber,
};

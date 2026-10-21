'use strict';
/**
 * raccoon/credits.js —— Raccoon 积分（余额 + 一次性登录奖励 + 账单）。
 *
 * ## ⚠️ 四个来源的语义（关键，别混）
 *
 * | 来源 | 金额 | 触发方式 | 本模块 |
 * |---|---|---|---|
 * | 新人注册礼包 | 3000 | 注册时服务端自动发放 | 不涉及（用户注册即有） |
 * | 桌面端登录奖励 | 3000 | `POST …/login/points/grant` | ✅ `claimLoginReward` |
 * | 每日积分发放 | 300 | 服务端按日自动发放（**无领取端点**） | ✅ `fetchDailyUsage` / `touchDailyKeepalive` |
 * | 服务异常补偿 | 不定 | 服务端手动补偿 | 不涉及 |
 *
 * ## 每日积分的真实规则（2026-10-16 从客户端 i18n 原文实证）
 *
 * 客户端 `dailyGrantRule` 三语文案逐字一致：
 * **「每日积分每天 00:00 发放，默认当日 24:00 清零，当天登录后有效期延长至 7 天。」**
 * 账单侧的对应文案是 `billDescription.notLoggedIn`＝「当日未登录」、
 * `sameDayEnd`＝「当日 24:00」。
 *
 * ⚠️ 所以「不能做签到按钮」是对的（**没有领取端点**），但**不等于无事可做**：
 * 存在一个每天必须发生一次的等价动作 ——「当天登录」。不做它，当天 300 分
 * 只活到 24:00、次日被 `daily_expire` 整额清零（本机 2026-10-14 实测即如此，
 * 当天没开桌面端 → 1 天期 → 次日清零）。
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
const { localDateKey } = require('../lib/util');

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
 * 判据：账单里已有 `biz_type === 'reward_grant'` 且
 * `event_name === '桌面端登录奖励'` 的记录。
 *
 * ⚠️ **必须用 `type=income` 过滤**（2026-10-15 端到端实测修正的 P1 bug）：
 * `points/v1/bills` 默认（不带 type，等同 `type=all`）按**时间倒序**返回，
 * 一个活跃账号最近 50 条几乎全是「桌面端 LLM 对话消耗」（负向 `desktop` 账单），
 * 而一次性登录奖励是账号早期（注册当天）发的正向账单，会被完全挤出窗口 ——
 * 于是 `claimed` 恒返回 false，面板错误地一直提示「可领取」。
 * 加 `type=income` 后服务端只回正向账单（本账号实测仅 4 条，含该奖励记录），
 * 奖励账单必然在窗口内。
 *
 * ⚠️ **不能靠 balance 推断** —— 余额是多个来源的合计，无法区分某一项是否已领。
 * ⚠️ **不能只按 `biz_type === 'reward_grant'` 判定** ——「新人注册礼包」也是
 * `reward_grant`（`event_name` 不同），把它算作登录奖励会让新用户一开始就显示
 * 「已领取」。故仍须比对 `event_name`。
 * ⚠️ **服务端没有单独的奖励状态端点**（实测），故只能查账单明细。
 * ⚠️ 查询失败时保守返回 `claimed:false` —— 宁可让用户多点一次（服务端幂等、
 * 无害），也不要误报「已领」而让他真的错过。
 */
async function fetchOnboardingStatus(acct) {
  const credential = client.credentialOf(acct);
  let items = [];
  // income 账单（发放类）很稀疏；limit 200 覆盖绝大多数账号的全部发放记录。
  // 若哪天某账号发放账单超过 200 条，登录奖励（账号最早期那条）会落进下一页，
  // 故这里按需翻页直到取全或到达上限，而不是只取第一页。
  const limit = 200;
  const maxPages = 5;
  let offset = 0;
  for (let page = 0; page < maxPages; page += 1) {
    let r;
    try {
      r = await client.request({
        method: 'GET',
        path: 'pointsBills',
        headers: product.desktopHeaders(credential),
        query: { 'paging.limit': limit, 'paging.offset': offset, type: 'income' },
      });
    } catch {
      // 首页就失败 → 保守判未领；已有部分页则用已取到的部分继续判定
      if (page === 0) {
        return { claimed: false, points: product.LOGIN_REWARD_POINTS, detail: '账单查询失败' };
      }
      break;
    }
    if (!r.envelope || r.envelope.code !== 0 || !r.envelope.data) {
      if (page === 0) {
        return { claimed: false, points: product.LOGIN_REWARD_POINTS, detail: '账单查询失败' };
      }
      break;
    }
    const batch = Array.isArray(r.envelope.data.items) ? r.envelope.data.items : [];
    items = items.concat(batch);
    // 取到不足一页 = 已到底
    if (batch.length < limit) break;
    offset += batch.length;
  }

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

/**
 * 每日积分运营视图（**只读**：balance + 两页账单）。
 *
 * 语义见 `product.summarizeDailyPoints`：每日 300 不能领（无端点），但会过期，
 * 所以这里回答的是「今天还剩多少 / 什么时候作废 / 历史作废了多少」。
 *
 * 用 `type=income` 与 `type=expense` 两次取数（实测 `type` 只接受这三个枚举值：
 * all/income/expense，其它值回 `100002 params_invalid_error`）。
 * 任一页失败都**不抛错**：账单只是运营视图，拿不到就把对应字段留空，
 * 让面板显示「未知」而不是整块报错。
 */
async function fetchDailyUsage(acct) {
  const credential = client.credentialOf(acct);
  const headers = product.desktopHeaders(credential);

  const balance = await fetchBalanceRaw(acct).catch(() => null);

  // income 页取发放账单；expense 页取作废账单。limit 100 足够覆盖每日发放
  // （发放类账单很稀疏：本机账号 3 天历史只有 4 条）。
  const bills = async (type) => {
    try {
      const r = await client.request({
        method: 'GET',
        path: 'pointsBills',
        headers,
        query: { 'paging.limit': 100, 'paging.offset': 0, type },
      });
      if (!r.envelope || r.envelope.code !== 0 || !r.envelope.data) return [];
      return Array.isArray(r.envelope.data.items) ? r.envelope.data.items : [];
    } catch {
      return [];
    }
  };
  const [incomeItems, expenseItems] = await Promise.all([bills('income'), bills('expense')]);

  const summary = product.summarizeDailyPoints({
    balance: balance || {},
    incomeItems,
    expenseItems,
  });
  // 两页都取空 = 账单面完全不可用（网络或鉴权失败），如实标出来，
  // 否则面板会把「查不到」显示成「没有发放记录」——那是另一种误导。
  summary.billsAvailable = incomeItems.length > 0 || expenseItems.length > 0;
  summary.balanceAvailable = !!balance;
  return summary;
}

/** 余额的**原始**响应（不写库、不做 packages 归一），供运营视图复用。 */
async function fetchBalanceRaw(acct) {
  const credential = client.credentialOf(acct);
  const r = await client.request({
    method: 'GET',
    path: 'pointsBalance',
    headers: product.desktopHeaders(credential),
  });
  return client.unwrap(r.envelope, { method: 'GET', path: 'pointsBalance', status: r.status }) || null;
}

/**
 * 执行一次「当日登录」保活，并**如实报告**当日每日积分的有效期状态。
 *
 * ## ⚠️ 2026-10-20 订正：本函数**不能**触发每日积分发放（早期判断错误）
 *
 * 早期注释写「网关侧代打这一下，等价于替用户当天开一次客户端，把 300 分从
 * 「当天作废」变成「7 天窗口」」——**这个前提是错的**，且与同期的另一条结论
 * （`desktop/v1/login/points/grant` 是**一次性**端点，没有每日发放端点）
 * 自相矛盾。我当时读到了正确证据，却推出了矛盾结论，未加验证即写成功能。
 *
 * 2026-10-19/20 连续两天实测穷举（全量账单扫描 + 所有可调端点）证实：
 *
 * | 探测 | 结果 |
 * |---|---|
 * | `POST desktop/v1/login/points/grant` | 200 `granted:false`，**不触发发放** |
 * | grant + `X-Client-Device-ID`（客户端 UA 里的设备标识） | 仍不触发 |
 * | `POST auth/v1/refresh`（access 当 refresh） | 不触发 |
 * | `balance` / `model_catalog` / `bills` / `user_info` | 均不触发 |
 * | IAM `last_login_at` | 停留不动，**不因网关调用更新** |
 *
 * 时间戳交叉验证：10-18 两笔 daily_grant 的 `created_at`（22:46:05 / 22:42:24）
 * 与客户端本地 `mcp.system.json` 写盘时刻（22:42:15）**精确同步** ——
 * 那是**桌面客户端真实运行时**产生的。规则原文（i18n `dailyGrantRule`）：
 * 「每日积分每天 00:00 发放，默认当日 24:00 清零，**当天登录后**有效期延长至 7 天。」
 * ⇒ **发放载体是真实客户端登录，网关代打无法复刻。**
 *
 * ## 因此本函数的职责改为「如实观测」
 *
 * 保留 grant 调用（幂等无副作用，且是唯一语义相关的可调端点），但**不再声称
 * 它发放积分**。函数按事实分类返回，绝不伪造 ok：
 *   - `ok:true`                  当日已延长到 7 天
 *   - `reason:'not_extended'`    上游发了但仍是 1 天（我们该做而没做成）
 *   - `reason:'upstream_not_granted'` 上游**未产生**当日 daily_grant ——
 *                                  无可延长对象，**不是网关故障**（10-20 实证）
 *   - `reason:'grant_failed'`    登录请求本身失败
 *
 * ## 副作用边界（重要）
 *
 * - `desktop/v1/login/points/grant` 幂等：已领过回 `granted:false`，不重复发分，
 *   也不改动当日已发的 daily_grant。
 * - 本函数**不**写任何账号库字段，也不改余额 —— 纯「调用 + 观测」。
 *
 * @param {object} acct 账号记录（含 token / refreshToken）
 * @returns {Promise<{ok:boolean, reason?:string, granted?:boolean,
 *                    grantAt?:string, expireAt?:string, validityDays?:number|null,
 *                    dailyRemaining?:number|null, message:string}>}
 */
async function touchDailyKeepalive(acct) {
  const credential = client.credentialOf(acct);
  const headers = product.desktopHeaders(credential);

  // 1) 读当日 daily_grant（发放前调用也能拿到昨天的记录，据此判"今天是否已发"）
  const readToday = async () => {
    try {
      const r = await client.request({
        method: 'GET', path: 'pointsBills', headers,
        query: { 'paging.limit': 100, 'paging.offset': 0, type: 'income' },
      });
      if (!r.envelope || r.envelope.code !== 0 || !r.envelope.data) return null;
      const items = Array.isArray(r.envelope.data.items) ? r.envelope.data.items : [];
      const todayKey = localDateKey();
      // 用 grant_at 的本地日期判定「今天那一笔」：created_at 是入账时刻（可能是
      // 当天任意时刻），而 grant_at 才是规则里的发放日 00:00。
      const grants = items.filter((x) => x && x.biz_type === product.DAILY_GRANT_BIZ_TYPE);
      const today = grants.find((x) => typeof x.grant_at === 'string'
        && localDateKey(new Date(x.grant_at)) === todayKey);
      return today || null;
    } catch {
      return null;
    }
  };

  const before = await readToday();

  // 2) 触发「真实登录」。
  //    ⚠️ 2026-10-20 订正：每日积分发放载体是**真实登录**，不是 grant。有密码的
  //    账号走 login_with_password（唯一可编程复刻的真实登录），换出完整令牌对并
  //    落库；没密码的账号只能退化为打 grant（幂等、无副作用，但不触发发放）。
  let granted = null;
  let grantErr = null;
  let relogged = false;
  if (typeof acct.raccoonPassword === 'string' && acct.raccoonPassword.length > 0
    && typeof acct.raccoonPhone === 'string' && acct.raccoonPhone.length > 0) {
    try {
      const auth = require('./auth');
      const { account, credential } = await auth.loginWithPassword({
        nationCode: acct.raccoonNationCode || '86',
        phone: acct.raccoonPhone,
        password: acct.raccoonPassword,
      });
      relogged = true;
      // 密码登录成功 = 真实登录 = 发放已触发；顺带更新账号的令牌对。
      //
      // ⚠️ 必须写 **account.id**（persistLogin 实际落库的那条），不能写 acct.id：
      // persistLogin 按 userId/手机号去重，命中的可能不是传进来的 acct（库里同
      // 一身份存在多条记录时尤其明显）。写 acct.id 会造成同一份新凭据被写进
      // 两条账号（实测可复现），而真正被上游刷新过的那条反而没更新。
      const targetId = account && account.id ? account.id : acct.id;
      if (credential && credential.refresh_token) {
        const store = require('../credentials/store');
        try {
          store.update(targetId, {
            token: credential.access_token,
            refreshToken: credential.refresh_token,
            // 成功换票 = 一次成功续期，记判据位（见 auth/index.js#wbNeedsRefresh）
            lastRefreshAt: new Date().toISOString(),
          });
        } catch { /* 令牌更新失败不阻塞保活结果判定 */ }
      }
    } catch (e) {
      grantErr = `密码登录失败：${e.message}`;
    }
  } else {
    try {
      const r = await client.request({
        method: 'POST',
        path: 'loginRewardGrant',
        headers,
      });
      if (r.envelope && r.envelope.code === 0) granted = !!r.envelope.data?.granted;
      else grantErr = client.envelopeMessage(r.envelope, 'grant 请求失败');
    } catch (e) {
      grantErr = e.message;
    }
  }

  // 3) 再读一次，看当日那笔的 expire 是否落在 grant 之后 7 天
  const after = await readToday();
  const record = after || before;
  if (!record) {
    // ⚠️ 2026-10-20 实证（重要区分）：这里可能不是「我们没延长」，而是
    // **上游根本没发今日的 daily_grant**。实测连续两天（10-19/10-20）
    // 全量账单扫描（含不带 type 的 20 条全量）确认上游未产生任何
    // daily_grant / daily_expire 记录，且我们穷举了所有可调端点
    // （grant / refresh / balance / catalog / 加 X-Client-Device-ID 的 grant）
    // 全部无法触发当日发放；IAM 的 last_login_at 也停留在上次真实登录时刻
    // 不因我们的调用而更新。对照：桌面客户端真实运行时（10-18 22:42）
    // 会立即产生 daily_grant。⇒ **发放载体是「真实客户端登录」**。
    //
    // 因此这里不能简单报「失败」——那是误导。上报一个独立的 reason
    // `upstream_not_granted`，由上层区分「上游没发」与「我们没生效」。
    // 若刚做过密码真实登录（relogged）仍未产生账单，说明上游当日确实不发，
    // 此时更不该告警 —— 附上 relogged 让上层与面板看清已尽力。
    return {
      ok: false,
      reason: 'upstream_not_granted',
      granted,
      relogged,
      message: grantErr
        ? `当日每日积分账单尚未产生（上游未发放），且登录请求失败：${grantErr}`
        : (relogged
          ? '已用密码做真实登录（正常应触发发放），但上游仍未产生今日 daily_grant；'
            + '属上游当日未发放，无可延长对象。'
          : '上游尚未产生今日 daily_grant 账单；本账号未配置密码（无法做真实登录），'
            + '仅能观测。配置密码后可由网关每日代登触发发放。'),
    };
  }

  const validityDays = validityDaysOf(record);
  const extended = validityDays !== null && validityDays > 1;
  if (grantErr && !extended) {
    return {
      ok: false, reason: 'grant_failed', granted, relogged,
      grantAt: record.grant_at, expireAt: record.expire_at, validityDays,
      message: `当日登录请求失败：${grantErr}`,
    };
  }
  if (!extended) {
    return {
      ok: false, reason: 'not_extended', granted, relogged,
      grantAt: record.grant_at, expireAt: record.expire_at, validityDays,
      message: `当日每日积分仍是 ${validityDays ?? '?'} 天有效期（未延长到 7 天）`
        + (relogged ? '；已做密码真实登录但仍未延长，请联系上游。' : '，请确认当天已登录桌面端或重试。'),
    };
  }

  return {
    ok: true, granted,
    grantAt: record.grant_at, expireAt: record.expire_at, validityDays,
    relogged,
    message: validityDays === 7
      ? '当日每日积分已延长至 7 天有效期'
      : `当日每日积分有效期 ${validityDays} 天（>1 天，已延长）`,
  };
}
/**
 * 账单的 `grant_at` → `expire_at` 有效期天数（**官方口径：含发放当日的天数**）。
 *
 * 官方文案「当日 24:00 清零」＝ **1 天**、「延长至 7 天」＝ **7 天**：
 *   - 当天清零：grant 10-16 00:00 → expire 10-16 23:59:59，日历差 0 → 1 天
 *   - 延长：grant 10-16 00:00 → expire 10-22 23:59:59，日历差 6 → 7 天
 * 故公式为 `日历差 + 1`（与客户端文案、账单实测逐一对齐）。
 * 时间字段非法时返回 null（与客户端模块 34917 的哨兵值判据同思路）。
 */
function validityDaysOf(record) {
  if (!record || typeof record !== 'object') return null;
  const grant = typeof record.grant_at === 'string' ? Date.parse(record.grant_at) : Number.NaN;
  const expire = typeof record.expire_at === 'string' ? Date.parse(record.expire_at) : Number.NaN;
  if (!Number.isFinite(grant) || !Number.isFinite(expire)) return null;
  if (expire < grant) return null;
  const g = new Date(grant); const e = new Date(expire);
  const g0 = new Date(g.getFullYear(), g.getMonth(), g.getDate()).getTime();
  const e0 = new Date(e.getFullYear(), e.getMonth(), e.getDate()).getTime();
  const calendarDiff = Math.round((e0 - g0) / 86_400_000);
  return calendarDiff + 1;
}

module.exports = {
  fetchBalance,
  refreshBalance,
  claimLoginReward,
  fetchOnboardingStatus,
  fetchDailyUsage,
  touchDailyKeepalive,
  validityDaysOf,
  readNumber,
};

'use strict';
/**
 * credentials/entitlement-view.js — 权益的「首页摘要」投影（纯计算，无 IO）。
 *
 * 为什么需要它：凭据列表每 60 秒轮询一次，而每个账号的权益包最多 65 条
 * （实测 23 个账号共 743 条包），把完整 packs 数组下发给列表，单次响应
 * 121 KB、两个端点每轮共 242 KB。列表页真正用到的只有六个聚合值，
 * 详情在用户点开时才按需拉一个账号的完整 packs。
 *
 * 口径必须与其余消费方一致，因此这里**不重新定义规则**，只调用
 * `credentials/credits.js` 的 `naturalDayDiff` 与 `roundCredits`——
 * 那正是 `summarizeExpiry`（3/7 日临期金额）与 `summarizeFefo`（先到期先用）
 * 用的同一套日历日判定。任何自定义的毫秒除法都会让面板与调度算出
 * 相差一天的两个数（这是本项目已经踩过的口径漂移）。
 *
 * 单位边界：只处理积分口径（credit，量级 1e3）。ZCode 的 token 桶
 * （tokenBuckets，量级 1e8）、Qoder 的 quota、Raccoon 的 raccoonPoints
 * 都在各自的隔离键里，本模块**不读也不碰**它们。
 */
const { naturalDayDiff, roundCredits } = require('./credits');

/** 临期提醒窗口：与 pack 展示、credit-alerts 一致，7 个自然日。 */
const NOTICE_DAYS = 7;

/**
 * 哪些平台的 packs 是**积分**口径。
 *
 * ZCode 必须排除：它的额度是 token（量级 1e8），后端刻意只写
 * entitlement_snapshot.tokenBuckets，不写 packs（见 upstream/balance.js 的
 * refreshZcodeBalance 注释）。但历史快照里确实残留过 packs——实测一条
 * `meter:'model_usage'`、`limit:1e8` 的桶就躺在该账号的快照里，那是
 * 「token 被误写进积分口径」的痕迹，也正是 src/test/unit.test.js:4435
 * 明令禁止的状态。只要有人读它，1 亿 token 就会变成 1 亿积分。
 *
 * 因此判定不靠「有没有 packs」，而靠「这个平台的 packs 是不是积分」。
 * 白名单而不是黑名单：将来新增平台若忘了在这里登记，它的 packs 会被忽略
 * （宁可少显示一个数，也不要把别的计量单位当成积分）。
 */
const CREDIT_PACK_PLATFORMS = new Set(['trae', 'workbuddy']);

/**
 * 账号的 edition → 平台 id。
 *
 * 与 src/platform/variant.js 的 variantOf 同规则：WorkBuddy 的历史值含
 * 'wb' 前缀变体，其余（cn/sg/us/manual）归 Trae。这里不 require variant.js
 * 是为了让本模块保持零依赖的纯计算（它会被单测直接调用）。
 */
function platformOfEdition(edition) {
  const raw = String(edition || '').toLowerCase();
  if (raw === 'zcode') return 'zcode';
  if (raw === 'qoder') return 'qoder';
  if (raw === 'raccoon') return 'raccoon';
  if (raw === 'workbuddy' || raw.startsWith('wb')) return 'workbuddy';
  return 'trae';
}

/** 该账号的 packs 是否可以按积分口径读取。 */
function isCreditCaliber(account) {
  return CREDIT_PACK_PLATFORMS.has(platformOfEdition(account && account.edition));
}

/**
 * 单个账号的权益摘要。
 *
 * 可用判定（与前端 packsOf 及后端 summarizeFefo 同口径）：
 *   - 已用尽：非 unlimited 且 remaining === 0
 *   - 已过期：expireTime 存在且不晚于当前时刻
 * 两者任一命中即不可用；`unlimited` 包（remaining 为 null）过期才算失效。
 *
 * @param {Array<object>} [packs] entitlement_snapshot.packs
 * @param {number} [nowMs]
 */
function digestOf(packs, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const empty = {
    total: 0, usable: 0, usableAmount: 0, unlimited: 0,
    expiring7d: 0, soonestDays: null, soonestAmount: 0,
  };
  if (!Array.isArray(packs) || !packs.length) return empty;

  let total = 0;
  let usable = 0;
  let usableAmount = 0;
  let unlimited = 0;
  let expiring7d = 0;
  let soonestDays = null;
  let soonestAmount = 0;

  for (const p of packs) {
    if (!p || typeof p !== 'object') continue;
    total += 1;

    const isUnlimited = p.unlimited === true;
    const remaining = typeof p.remaining === 'number' && Number.isFinite(p.remaining)
      ? p.remaining
      : null;
    const expireMs = typeof p.expireTime === 'number' && p.expireTime > 0
      ? p.expireTime * 1000
      : null;

    // 已过期：以真实时刻判定，不用日历日——今天 23:59 到期的包现在仍可用
    const expired = expireMs != null && expireMs <= now;
    // 已用尽：unlimited 包没有「用尽」概念
    const exhausted = !isUnlimited && remaining === 0;
    if (expired || exhausted) continue;

    usable += 1;
    if (isUnlimited) {
      // 不限量不计入金额（与前端 creditTotals 一致），只计个数
      unlimited += 1;
      continue;
    }
    if (remaining != null) usableAmount += remaining;

    if (expireMs == null) continue;
    const days = naturalDayDiff(p.expireTime, now);
    if (days == null) continue;
    if (days <= NOTICE_DAYS && remaining != null) expiring7d += remaining;
    if (soonestDays == null || days < soonestDays) {
      soonestDays = days;
      soonestAmount = remaining == null ? 0 : remaining;
    }
  }

  return {
    total,
    usable,
    usableAmount: roundCredits(usableAmount),
    unlimited,
    expiring7d: roundCredits(expiring7d),
    soonestDays,
    soonestAmount: roundCredits(soonestAmount),
  };
}

/**
 * 全库汇总（列表页统计条用）。
 *
 * 只累加**积分口径**的账号。ZCode/Qoder/Raccoon 的额度不在 packs 里，
 * 天然不计入——这与前端 creditTotals 的口径声明一致：这个总数只覆盖
 * Trae 与 WorkBuddy，界面必须写明，不能让用户拿它去对四平台之和。
 *
 * @param {Array<{packs?:object[], edition?:string, enabled?:boolean}>} accounts
 * @param {number} [nowMs]
 */
function rollupOf(accounts, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  const out = {
    usableAmount: 0, usable: 0, accounts: 0, unlimited: 0, expiring7d: 0, total: 0,
  };
  if (!Array.isArray(accounts)) return out;
  for (const a of accounts) {
    // 只累加积分口径的账号：ZCode 的 token、Qoder 的配额、Raccoon 的分池
    // 都有各自的隔离键，它们的 packs（若有残留）不得进这个总额。
    if (!a || !isCreditCaliber(a)) continue;
    if (!Array.isArray(a.packs) || !a.packs.length) continue;
    const d = digestOf(a.packs, now);
    if (!d.usable) continue;
    out.accounts += 1;
    out.usable += d.usable;
    out.usableAmount += d.usableAmount;
    out.unlimited += d.unlimited;
    out.expiring7d += d.expiring7d;
    out.total += d.total;
  }
  out.usableAmount = roundCredits(out.usableAmount);
  out.expiring7d = roundCredits(out.expiring7d);
  return out;
}

/**
 * 列表行的精简投影：把 packs 换成摘要。
 *
 * 同时去掉两类「详情才需要、列表用不到」的大字段：
 *   - devices：设备指纹派生参数（Tencent 系字段集），列表零消费；
 *   - fingerprint：ZCode 设备档案，同上。
 * 二者合计在 23 个账号上约 6 KB，但真正的体积来自 743 条 packs（≈100 KB）。
 *
 * tokenBuckets / quota / raccoonPoints 刻意保留：三者都是聚合后的小对象
 * （实测各 ≤ 1 KB），且列表的「额度」列直接渲染它们，去掉就得为每个账号
 * 再发一次请求——那正是这次要消除的模式。
 */
function slimAccount(account, nowMs) {
  const { packs, devices, fingerprint, ...rest } = account;
  // 非积分口径的平台（ZCode / Qoder / Raccoon）：摘要一律清零并标记口径，
  // 不读它们的 packs —— ZCode 的残留 packs 是 token 数（见 CREDIT_PACK_PLATFORMS 注释）。
  const credit = isCreditCaliber(account);
  return {
    ...rest,
    packDigest: credit
      ? digestOf(Array.isArray(packs) ? packs : [], nowMs)
      : { total: 0, usable: 0, usableAmount: 0, unlimited: 0, expiring7d: 0, soonestDays: null, soonestAmount: 0 },
    /** 该行的 packs 是否属于积分口径；前端据此决定要不要显示「权益包」相关文案 */
    packCaliber: credit ? 'credit' : platformOfEdition(account && account.edition),
  };
}

module.exports = {
  digestOf,
  rollupOf,
  slimAccount,
  isCreditCaliber,
  platformOfEdition,
  CREDIT_PACK_PLATFORMS,
  NOTICE_DAYS,
};

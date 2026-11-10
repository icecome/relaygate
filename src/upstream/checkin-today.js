'use strict';
/**
 * upstream/checkin-today.js — 「本自然日各平台已签到多少号」的只读统计。
 *
 * 为什么需要（2026-11-03 实测）：签到通知与面板只报**单次批次**的
 * claimed / already，于是并发或补跑场景下会出现
 * 「Trae 签到 3 · 已签 5」这种看起来像 5 个号失败、实际 8 个号全部领完的文案。
 * 批次视角无法区分「已签=今天别人/别的轮次已经领过」与「失败」，
 * 必须叠加一个跨批次的今日口径，通知才如实。
 *
 * 判据：accounts.last_checkin_at 的**本地日期**等于今天。
 *   checkinAccount / wbCheckinAccount 在 claimed、already、disabled 三种结果上
 *   都会写 last_checkin_at（见 upstream/checkin.js#alreadyResult 与
 *   upstream/wb-checkin.js），所以「今日有签到动作且上游确认过状态」即计入。
 *   刻意不把 last_checkin_result 的 claim_http_* / claim_code_* 计入——那是失败。
 */
const store = require('../credentials/store');
const variant = require('../platform/variant');
const { localDateKey } = require('../lib/util');

/** 计入「今日已履约」的结果标记。 */
const SIGNED_RESULTS = new Set(['claimed', 'already', 'device_already', 'disabled']);

/**
 * 按平台统计今日签到覆盖度。
 * @param {string[]} [platformIds] 需要统计的平台（默认所有声明 checkin 能力的平台）
 * @returns {Record<string, {total:number, signed:number, unsigned:string[]}>}
 */
function todayCoverage(platformIds) {
  const today = localDateKey();
  const out = {};
  const ids = platformIds && platformIds.length
    ? platformIds
    : Object.keys(variant.VARIANTS || {}).filter((id) => variant.can(id, 'checkin'));
  for (const id of ids) {
    const accounts = store.list().filter((a) => a.enabled && variant.can(a.edition, 'checkin') && variant.normalizeEdition(a.edition) === id);
    const signed = accounts.filter((a) => {
      const at = a.lastCheckinAt;
      if (!at) return false;
      // 只认「上游确认过的履约结果」。claim_http_* / claim_code_* / status_fail /
      // claim_unconfirmed 同样会写 last_checkin_at，把它们计入会把失败读成已签。
      if (!SIGNED_RESULTS.has(a.lastCheckinResult)) return false;
      // ISO 串直接取前 10 位会跨时区错位（UTC 与本地差 8 小时），显式转本地日期
      const d = new Date(at);
      if (Number.isNaN(d.getTime())) return false;
      return localDateKey(d) === today;
    });
    const signedIds = new Set(signed.map((a) => a.id));
    out[id] = {
      total: accounts.length,
      signed: signed.length,
      unsigned: accounts.filter((a) => !signedIds.has(a.id)).map((a) => a.label || a.id),
    };
  }
  return out;
}

/**
 * 把今日覆盖度压成一句可直接进通知的文案。
 * @param {Record<string, {total:number,signed:number,unsigned:string[]}>} coverage
 * @param {string} [platformId] 只报单平台时传 id
 */
function coverageText(coverage, platformId) {
  const ids = platformId ? [platformId] : Object.keys(coverage);
  return ids
    .filter((id) => coverage[id])
    .map((id) => {
      const c = coverage[id];
      const label = variant.variantOf(id).label || id;
      return `${label} 今日 ${c.signed}/${c.total}`;
    })
    .join(' · ');
}

module.exports = { todayCoverage, coverageText, SIGNED_RESULTS };

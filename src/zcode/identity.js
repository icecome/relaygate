'use strict';
/**
 * zcode/identity.js — 上游身份头与追踪头的单一事实源。
 *
 * ZCode 上游按「客户端身份头 + 追踪头」识别请求来源，实测行为：
 *   - billing 面（preview / claim / balance）缺头或头形不对 → 400 code 3001
 *     parameter error；
 *   - messages 面（转发通道，当前未启用）头形不对 → 405 code 3012
 *     "unusual activity"，属真风控信号，命中即应隔离账号。
 *
 * 因此本模块只产出「billing 运营面」用的头集，转发面的头形（trace 头的
 * 三件套与「start-plan 不发 x-query-id/x-session-id」等禁忌）在接入转发时
 * 另行补齐并单独验证，不在此处推测。
 *
 * 字段顺序与取值对齐官方客户端 asar 的 pio 头集合（与 zcode2api/app/identity.py
 * 同源实测，非拷贝：同一上游契约）。
 */
const crypto = require('crypto');
const variant = require('../platform/variant');
const fingerprint = require('./fingerprint');

const V = variant.variantOf(variant.ZCODE);

/** ZCode 客户端版本（billing 面必填，缺则 3007/3001）。 */
function appVersion() {
  return String(process.env.ZCODE_APP_VERSION || '3.14.4').trim();
}

/** 官方客户端标题：X-Title = "Z Code@{sourceTitle}"，桌面端 sourceTitle=electron。 */
const TITLE = V.identity.title;

/**
 * 账号的 billing 身份头。
 *
 * @param {object} fp accounts.fingerprint（zcode/fingerprint.js 的成套桌面档案）
 * @param {{token?:string}} [auth]
 * @returns {Record<string,string>}
 */
function identityHeaders(fp, auth = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'HTTP-Referer': V.identity.referer,
    'User-Agent': `ZCode/${appVersion()}`,
    'X-Title': TITLE,
    'X-ZCode-Agent': V.identity.agent,
    'X-ZCode-App-Version': appVersion(),
    // billing 面要求 <platform>-<arch> 形态（实测与 messages 面同形）
    'X-Platform': fingerprint.platformFull(fp),
    'X-Release-Channel': V.identity.releaseChannel,
    'X-Client-Language': fp.language,
    'X-Client-Timezone': fp.timezone,
    'X-Os-Category': fingerprint.osCategory(fp),
    'X-Os-Version': fp.osVersion,
    'X-Device-Mid': fp.deviceMid,
    'x-request-id': crypto.randomUUID(),
  };
  const token = String(auth.token || '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const apiKey = String(auth.apiKey || '').trim();
  if (apiKey) headers['x-api-key'] = apiKey;
  return headers;
}

/** 激活事件上报用头（官方端点不校验登录态，故不带 Authorization）。 */
function eventHeaders() {
  return {
    'Content-Type': 'application/json',
    'HTTP-Referer': V.identity.referer,
    'User-Agent': `ZCode/${appVersion()}`,
    'X-Title': TITLE,
    'X-ZCode-App-Version': appVersion(),
  };
}

module.exports = { identityHeaders, eventHeaders, appVersion, TITLE, V };
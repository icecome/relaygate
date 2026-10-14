'use strict';
/**
 * lib/version-defaults.js — Trae 客户端版本指纹默认值与取值函数（m-35：从 lib/auth.js 抽出，
 * auth 与 headers 共用，避免拆分后出现两份声明）。
 *
 * 与 TraeWorkAssistant 实测可用的 SOLO 线指纹一致（0.1.50 / 20260811）；
 * 旧值 3.3.67 / 20260401 与当前在售客户端脱节，易被上游风控识别。
 *
 * m-35 拆分回归修复：getIdeVersion / getAppVersion / getIdeVersionCode 一并收敛到此。
 * 此前它们只存在于 lib/headers.js，而 lib/auth.js 的 exchangeToken 也在调用这三个
 * 函数，运行即抛 ReferenceError，Trae 账号 token 全部无法自动续期。
 *
 * 依赖方向：本模块是叶子模块，绝不 require lib/auth（auth 要 require 本模块，
 * 反向引用会构成加载环，也被守门测试「全库无双向依赖」拒绝）。需要按登录态
 * 选 CN/SG 默认值时，由调用方把 edition 作为参数传进来；缺省按 CN（与拆分前
 * 取不到登录态时的缺省值一致）。
 */
const clientMeta = require('./client-meta');

const DEFAULT_IDE_VERSION_CN = '0.1.50';
const DEFAULT_IDE_VERSION_SG = '0.1.50';
const DEFAULT_IDE_VERSION_CODE = '20260811';

/**
 * 版本指纹：env 覆盖 > 真实客户端 manifest > 内置默认（按 edition 选 CN/SG）。
 * @param {string} [edition] 调用方解析出的登录态 edition（'cn' | 'sg'），缺省按 CN
 */
function getIdeVersion(edition) {
  if (process.env.TRAE_IDE_VERSION) return process.env.TRAE_IDE_VERSION;
  const meta = clientMeta.readRealClientMeta();
  if (meta && meta.appVersion) return meta.appVersion;
  return String(edition || 'cn').toLowerCase() === 'sg'
    ? DEFAULT_IDE_VERSION_SG
    : DEFAULT_IDE_VERSION_CN;
}

/** x-app-version：真实客户端 appVersion，绝不回退到 'default'。 */
function getAppVersion(edition) {
  if (process.env.TRAE_APP_VERSION) return process.env.TRAE_APP_VERSION;
  const meta = clientMeta.readRealClientMeta();
  if (meta && meta.appVersion) return meta.appVersion;
  return getIdeVersion(edition);
}

function getIdeVersionCode() {
  if (process.env.TRAE_IDE_VERSION_CODE) return process.env.TRAE_IDE_VERSION_CODE;
  const meta = clientMeta.readRealClientMeta();
  if (meta && meta.buildVersion) return meta.buildVersion;
  return DEFAULT_IDE_VERSION_CODE;
}

module.exports = {
  DEFAULT_IDE_VERSION_CN,
  DEFAULT_IDE_VERSION_SG,
  DEFAULT_IDE_VERSION_CODE,
  getIdeVersion,
  getAppVersion,
  getIdeVersionCode,
};

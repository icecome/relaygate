'use strict';
/**
 * lib/headers.js — 设备指纹与上游请求头组装（m-35 拆分自 lib/auth.js）。
 *
 * 职责单一：把账号（authInfo）+ 设备信息渲染成 Trae 上游要求的完整请求头
 * （普通 JSON / SSE 流式两形态）。设备信息优先取账号自带 telemetry（免本机
 * 登录的关键：每账号携带独立指纹，脱离本机 storage.json）。
 *
 * 依赖方向：本模块对 auth 的引用（本机登录态兜底 / host 解析）全部走
 * 调用期延迟 require——auth 尾部会 require 本模块做委托导出，顶部互相
 * require 会形成加载环（Node circular dependency 警告）。延迟到调用期
 * 两个模块均已完整导出，与本仓库 model-access/pool 的既有惯例一致。
 */
const { v4: uuidv4 } = require('./uuid');
const { hashDeviceId } = require('./util');
// m-35 拆分回归修复：版本指纹（getIdeVersion/getAppVersion/getIdeVersionCode）
// 实现下沉 version-defaults.js。这三个函数此前只存在于本模块，而 lib/auth.js 的
// exchangeToken 也在调用它们 → 运行时 ReferenceError，Trae 账号无法续期。
// 放在 version-defaults 里，auth 与 headers 各自 require 同一实现，无加载环。
const {
  getIdeVersion, getAppVersion, getIdeVersionCode,
} = require('./version-defaults');

/** auth 相关兜底依赖在调用期解析（见文件头依赖方向说明）。 */
function authRef() {
  return require('./auth');
}

function getDeviceInfo(deviceOverrides) {
  const auth = authRef();
  const o = deviceOverrides || {};
  let machineId = '';
  let sqmId = '';
  let devDeviceId = '';
  // 账号已自带设备时直接使用，不再依赖本机 storage.json（免本机登录关键）
  if (o.machineId == null || o.devDeviceId == null) {
    try {
      const authInfo = auth.getAuthInfo();
      const storage = auth.readStorageJsonByEdition(authInfo._edition || auth.detectEdition()) || {};
      machineId = storage['telemetry.machineId'] || '';
      sqmId = storage['telemetry.sqmId'] || '';
      devDeviceId = storage['telemetry.devDeviceId'] || '';
    } catch (e) { /* 免本机场景无本机登录态，忽略并继续 */ }
  }
  machineId = o.machineId != null ? o.machineId : machineId;
  sqmId = o.sqmId != null ? o.sqmId : sqmId;
  devDeviceId = o.devDeviceId != null ? o.devDeviceId : devDeviceId;
  return {
    cpu: o.cpu || process.env.TRAE_CPU || 'Intel',
    device_id: o.deviceId || hashDeviceId(machineId) || process.env.TRAE_DEVICE_ID || '',
    machine_id: o.machineId || machineId || process.env.TRAE_MACHINE_ID || '',
    device_model: o.deviceModel || process.env.TRAE_DEVICE_MODEL || '82RF',
    os_name: o.osName || process.env.TRAE_OS_NAME || 'windows',
    os_version: o.osVersion || process.env.TRAE_OS_VERSION || 'Windows 10'
  };
}

function buildCommonHeaders(authInfo) {
  // 优先使用账号自带设备信息（免本机登录：每账号携带 telemetry，脱离本机 storage.json）
  const deviceInfo = getDeviceInfo(authInfo && authInfo.devices);
  // edition 取自登录态：CN/SG 内置默认指纹不同（0.1.50 当前一致，声明仍分开）
  const edition = authInfo && authInfo._edition;
  // trace 头形态对齐 Trae 官方客户端（TTNet）：
  //   x-tt-trace-id = "00-<id>-<id>-01"，x-custom-trace-id 取其前 16 字符，
  //   x-flow-traceparent = "04-<id32>-<id>-01"
  const traceId = `00-${uuidv4().replace(/-/g, '')}-${uuidv4().replace(/-/g, '')}-01`;
  const flowParentId = traceId.slice(3, 35);
  return {
    'Content-Type': 'application/json',
    'Authorization': `Cloud-IDE-JWT ${authInfo.token}`,
    'X-Cloudide-Token': authInfo.token,
    'x-ide-token': authInfo.token,
    'user-agent': 'TraeClient/TTNet',
    'x-app-id': process.env.TRAE_APP_ID || '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'x-app-version': getAppVersion(edition),
    'app-version': getIdeVersion(edition),
    'x-ide-version-code': getIdeVersionCode(),
    'x-app-version-code': getIdeVersionCode(),
    'x-custom-trace-id': traceId.slice(0, 16),
    'x-tt-trace-id': traceId,
    'x-flow-traceparent': `04-${flowParentId}-${uuidv4().replace(/-/g, '')}-01`,
    'x-device-brand': deviceInfo.device_model,
    'x-device-cpu': deviceInfo.cpu,
    'x-device-id': deviceInfo.device_id,
    'x-machine-id': deviceInfo.machine_id,
    'x-os-version': deviceInfo.os_version,
    'x-device-type': deviceInfo.os_name,
    'x-ide-version': getIdeVersion(edition),
    'x-ide-version-type': 'stable',
    'request-traffic-type': 'prod',
    'package-type': 'stable_cn',
    'x-lgw-req-sdk-type': '3',
    'x-lscbd-aid': '787976',
    'x-lscbd-platform': 'windows',
    'x-ss-dp': '787976',
    'referer': `${authRef().getApiHost()}${process.env.TRAE_UPSTREAM_CHAT_PATH || '/api/agent/v3/llm_utils_chat'}`,
    'x-uid': authInfo.userId || ''
  };
}

function buildStreamHeaders(authInfo, deviceIds, requestId, lastEventId) {
  const headers = buildCommonHeaders(authInfo, deviceIds);
  headers['Accept'] = 'text/event-stream';
  headers['X-Request-ID'] = requestId || uuidv4();
  headers['X-Trae-Request-ID'] = headers['X-Request-ID'];
  if (lastEventId) {
    headers['Last-Event-ID'] = lastEventId;
  }
  return headers;
}

module.exports = { getDeviceInfo, getIdeVersion, getAppVersion, getIdeVersionCode, buildCommonHeaders, buildStreamHeaders };

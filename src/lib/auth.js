const fs = require('fs');
const path = require('path');
const os = require('os');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('./uuid');
const { decryptAuthData: decryptTcAuthData, isTcEncrypted } = require('./trae-decrypt');
const { hashDeviceId } = require('./util');
const { writeFileAtomic } = require('./atomic-write');
const variant = require('../platform/variant');

const TRAE_HOSTS = variant.variantOf(variant.TRAE).hosts;

function getTraeDataDir() {
  const envDir = process.env.TRAE_DATA_DIR;
  if (envDir) return envDir;
  const edition = detectEdition();
  if (edition === 'cn') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN');
  }
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Trae');
}

function detectEdition() {
  const envEdition = process.env.TRAE_EDITION;
  if (envEdition) return envEdition.toLowerCase();

  const cnPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN', 'User', 'globalStorage', 'storage.json');
  const sgPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Trae', 'User', 'globalStorage', 'storage.json');

  const cnExists = fs.existsSync(cnPath);
  const sgExists = fs.existsSync(sgPath);

  if (cnExists && !sgExists) return 'cn';
  if (!cnExists && sgExists) return 'sg';
  if (cnExists && sgExists) {
    try {
      const cnStat = fs.statSync(cnPath);
      const sgStat = fs.statSync(sgPath);
      return cnStat.mtime > sgStat.mtime ? 'cn' : 'sg';
    } catch (e) {
      return 'sg';
    }
  }
  return 'sg';
}

function getStorageJsonPath(edition) {
  const ed = edition || detectEdition();
  const dataDir = ed === 'cn'
    ? path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN')
    : path.join(os.homedir(), 'AppData', 'Roaming', 'Trae');
  return path.join(dataDir, 'User', 'globalStorage', 'storage.json');
}

function readStorageJson() {
  const storagePath = getStorageJsonPath();
  if (!fs.existsSync(storagePath)) {
    throw new Error(`storage.json not found at: ${storagePath}`);
  }
  const raw = fs.readFileSync(storagePath, 'utf-8');
  return JSON.parse(raw);
}

function isEncryptedAuthData(raw) {
  if (!raw || typeof raw !== 'string') return true;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('"')) return false;
  return true;
}

function readStorageJsonByEdition(edition) {
  const dataDir = edition === 'cn'
    ? path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN')
    : path.join(os.homedir(), 'AppData', 'Roaming', 'Trae');
  const storagePath = path.join(dataDir, 'User', 'globalStorage', 'storage.json');
  if (!fs.existsSync(storagePath)) return null;
  const raw = fs.readFileSync(storagePath, 'utf-8');
  return JSON.parse(raw);
}

let _cachedAuthInfo = null;
let _cachedAuthSig = null; // 缓存读取时 storage.json 的 mtimeMs:size 指纹，用于感知切号/换凭据

// storage.json 内容指纹：桌面端切换账号会覆盖 iCubeAuthInfo://icube.cloudide
// （该文件 mtime/size 随之变化）。指纹不变说明凭据未变，可直接用缓存。
function getStorageSig() {
  try {
    const p = getStorageJsonPath(detectEdition());
    if (!fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch (e) {
    return null;
  }
}

function getAuthInfo() {
  if (_cachedAuthInfo && !isTokenExpired(_cachedAuthInfo)) {
    const sig = getStorageSig();
    if (sig === null || sig === _cachedAuthSig) {
      return _cachedAuthInfo;
    }
    // storage.json 变化（例如 Trae 桌面端切换了账号）→ 丢弃缓存重新加载
    console.log('[auth] storage.json changed (account switched?), reloading auth info');
    _cachedAuthInfo = null;
  }

  const edition = detectEdition();
  const editions = [edition, edition === 'cn' ? 'sg' : 'cn'];

  for (const ed of editions) {
    try {
      const dataDir = ed === 'cn'
        ? path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN')
        : path.join(os.homedir(), 'AppData', 'Roaming', 'Trae');

      try {
        const auth = decryptTcAuthData(dataDir);
        console.log(`[auth] Using ${ed.toUpperCase()} edition auth data (decrypted)`);
        _cachedAuthInfo = {
          token: auth.token,
          refreshToken: auth.refreshToken,
          expiredAt: auth.expiredAt,
          refreshExpiredAt: auth.refreshExpiredAt,
          tokenReleaseAt: auth.tokenReleaseAt,
          userId: auth.userId,
          host: auth.host,
          userRegion: auth.userRegion,
          account: auth.account,
          _edition: ed,
          _wasEncrypted: true
        };
        _cachedAuthSig = getStorageSig();
        return _cachedAuthInfo;
      } catch (decryptErr) {
        console.log(`[auth] ${ed.toUpperCase()} decryption failed: ${decryptErr.message}, trying plaintext`);
      }

      const storage = readStorageJsonByEdition(ed);
      if (!storage) continue;

      const authKey = 'iCubeAuthInfo://icube.cloudide';
      const authRaw = storage[authKey];
      if (!authRaw) continue;

      if (isEncryptedAuthData(authRaw)) {
        console.log(`[auth] ${ed.toUpperCase()} edition auth data is encrypted and decryption failed, skipping`);
        continue;
      }

      const auth = JSON.parse(authRaw);
      console.log(`[auth] Using ${ed.toUpperCase()} edition auth data (plaintext)`);
      _cachedAuthInfo = {
        token: auth.token,
        refreshToken: auth.refreshToken,
        expiredAt: auth.expiredAt,
        refreshExpiredAt: auth.refreshExpiredAt,
        tokenReleaseAt: auth.tokenReleaseAt,
        userId: auth.userId,
        host: auth.host,
        userRegion: auth.userRegion,
        account: auth.account,
        _edition: ed,
        _wasEncrypted: false
      };
      _cachedAuthSig = getStorageSig();
      return _cachedAuthInfo;
    } catch (e) {
      console.log(`[auth] Failed to read ${ed.toUpperCase()} edition: ${e.message}`);
      continue;
    }
  }

  const manualToken = process.env.TRAE_MANUAL_TOKEN;
  if (manualToken && manualToken.startsWith('eyJ')) {
    console.log('[auth] Using manual token from TRAE_MANUAL_TOKEN env');
    const apiHost = process.env.TRAE_API_HOST || TRAE_HOSTS.agentCn;
    try {
      const parts = manualToken.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      const expMs = payload.exp * 1000;
      const isExpired = Date.now() > expMs;
      if (isExpired) {
        console.log('[auth] Manual token is expired, exp:', new Date(expMs).toISOString());
      }
      _cachedAuthInfo = {
        token: manualToken,
        refreshToken: null,
        expiredAt: new Date(expMs).toISOString(),
        refreshExpiredAt: null,
        tokenReleaseAt: null,
        userId: payload.data?.id || null,
        host: apiHost,
        userRegion: null,
        account: null,
        _edition: 'manual'
      };
      _cachedAuthSig = getStorageSig();
      return _cachedAuthInfo;
    } catch (e) {
      _cachedAuthInfo = {
        token: manualToken,
        refreshToken: null,
        expiredAt: null,
        refreshExpiredAt: null,
        tokenReleaseAt: null,
        userId: null,
        host: apiHost,
        userRegion: null,
        account: null,
        _edition: 'manual'
      };
      _cachedAuthSig = getStorageSig();
      return _cachedAuthInfo;
    }
  }

  throw new Error('No readable auth info found in any edition. CN edition data is encrypted and SG edition data is not available.');
}

function getDeviceIds() {
  const edition = detectEdition();
  const editions = [edition, edition === 'cn' ? 'sg' : 'cn'];
  for (const ed of editions) {
    const storage = readStorageJsonByEdition(ed);
    if (storage && storage['telemetry.machineId']) {
      return {
        machineId: storage['telemetry.machineId'] || '',
        sqmId: storage['telemetry.sqmId'] || '',
        devDeviceId: storage['telemetry.devDeviceId'] || ''
      };
    }
  }
  return { machineId: '', sqmId: '', devDeviceId: '' };
}

function isTokenExpired(authInfo) {
  if (!authInfo || !authInfo.expiredAt) return true;
  const expiry = new Date(authInfo.expiredAt);
  if (isNaN(expiry.getTime())) return true; // Invalid date = treat as expired
  return expiry < new Date();
}

function isTokenExpiringSoon(authInfo, minutesThreshold) {
  if (!authInfo || !authInfo.expiredAt) return true;
  const expiresAt = new Date(authInfo.expiredAt);
  if (isNaN(expiresAt.getTime())) return true; // Invalid date = treat as expiring
  const threshold = minutesThreshold || 30;
  const warningTime = new Date(Date.now() + threshold * 60 * 1000);
  return expiresAt < warningTime;
}

// Default Trae API hosts (overridable via env). These are shared Trae-client
// endpoints (not per-user secrets); defaults are required for the wrapper to work.
const DEFAULT_HOST_CN = process.env.TRAE_HOST_CN || TRAE_HOSTS.agentCn;
const DEFAULT_HOST_SG = process.env.TRAE_HOST_SG || TRAE_HOSTS.agentSg;
const DEFAULT_HOST_US = process.env.TRAE_HOST_US || TRAE_HOSTS.agentUs;

// Default IDE version/device info (overridable via env). Used as fallback when
// Trae's manifest.json cannot be read. Update when Trae CN/SG releases new builds.
// 2026-09-12: 对齐 TraeWorkAssistant 实测可用的 SOLO 线指纹（0.1.50 / 20260811），
// 旧值 3.3.67 / 20260401 与当前在售客户端脱节，易被上游风控识别。
const DEFAULT_IDE_VERSION_CN = '0.1.50';
const DEFAULT_IDE_VERSION_SG = '0.1.50';
const DEFAULT_IDE_VERSION_CODE = '20260811';

// 上游聊天端点路径（构造 referer 用；默认值与 src/config.js 保持一致）
const TRAE_CHAT_PATH = process.env.TRAE_UPSTREAM_CHAT_PATH || '/api/agent/v3/llm_utils_chat';

function getApiHost() {
  const envHost = process.env.TRAE_API_HOST;
  if (envHost) return envHost;

  try {
    const authInfo = getAuthInfo();
    const authEdition = authInfo._edition;
    if (authEdition === 'cn') {
      return DEFAULT_HOST_CN;
    }
    const region = (authInfo.userRegion?.region || authInfo.userRegion || '').toString().toUpperCase();
    if (region === 'US') return DEFAULT_HOST_US;
    return DEFAULT_HOST_SG;
  } catch (e) {
    return DEFAULT_HOST_SG;
  }
}

function getAuthHost() {
  const envHost = process.env.TRAE_AUTH_HOST;
  if (envHost) return envHost;

  try {
    const authInfo = getAuthInfo();
    if (authInfo._edition === 'cn') {
      return DEFAULT_HOST_CN;
    }
    return DEFAULT_HOST_SG;
  } catch (e) {
    return DEFAULT_HOST_SG;
  }
}

async function exchangeToken(refreshToken, opts = {}) {
  // OAuth（SOLO 线）账号需用自己的 ClientID/authHost 换新——refreshToken 与 ClientID 绑定
  const authHost = opts.host || getAuthHost();
  const url = `${authHost}/cloudide/api/v3/trae/oauth/ExchangeToken`;

  const body = {
    ClientID: opts.clientId || process.env.TRAE_OAUTH_CLIENT_ID || 'ono9krqynydwx5',
    RefreshToken: refreshToken,
    ClientSecret: process.env.TRAE_OAUTH_CLIENT_SECRET || '-',
    UserID: ''
  };

  // 刷新请求与业务请求保持一致的客户端外观：UA/app_id/版本头由真实客户端元数据
  // 提供，缺省回落内置默认值。裸 JSON POST（无 UA 无版本头）是登录面易识别特征。
  const headers = {
    'Content-Type': 'application/json',
    'user-agent': 'TraeClient/TTNet',
    'x-app-id': process.env.TRAE_APP_ID || '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'x-app-version': getAppVersion(),
    'x-ide-version': getIdeVersion(),
    'x-app-version-code': getIdeVersionCode(),
    'x-ide-version-code': getIdeVersionCode(),
    'package-type': 'stable_cn',
    'request-traffic-type': 'prod',
  };

  const fetchOptions = {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  };

  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || '';
  if (proxyUrl) {
    try {
      if (proxyUrl.startsWith('socks')) {
        const { SocksProxyAgent } = require('socks-proxy-agent');
        fetchOptions.agent = new SocksProxyAgent(proxyUrl);
      } else {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        fetchOptions.agent = new HttpsProxyAgent(proxyUrl);
      }
    } catch (e) {
      console.error(`[auth] proxy setup failed: ${e.message}`);
    }
  }

  let resp;
  try {
    resp = await fetch(url, fetchOptions);
  } catch (e) {
    throw new Error(`ExchangeToken network error: ${e.message}`);
  }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`ExchangeToken failed: ${resp.status} ${errText}`);
  }

  return normalizeExchangeResult(await resp.json());
}

/** 时间字段兼容 ISO / 秒 / 毫秒时间戳；无法解析返回 null。 */
function toIsoTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    return new Date(v > 1e12 ? v : v * 1000).toISOString();
  }
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function jwtExpIso(token) {
  try {
    const seg = String(token).replace(/^Cloud-IDE-JWT\s+/, '').split('.')[1];
    const payload = JSON.parse(Buffer.from(seg, 'base64').toString());
    return payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * 归一化 ExchangeToken 响应为 {token, refreshToken, expiredAt, …}。
 * 兼容三种形态：data 信封 / 平铺 / Result 信封（api.trae.cn）。
 */
function normalizeExchangeResult(body) {
  const apiErr = body && body.ResponseMetadata && body.ResponseMetadata.Error;
  if (apiErr && apiErr.Code) {
    throw new Error(`ExchangeToken failed: code=${apiErr.Code} ${apiErr.Message || ''}`);
  }
  if (body && typeof body.code === 'number' && body.code !== 0) {
    throw new Error(`ExchangeToken failed: code=${body.code} ${body.message || ''}`);
  }

  const data = body && body.data ? body.data : body;
  const result = body && body.Result ? body.Result : null;
  const token = (data && (data.access_token || data.token)) || (result && result.Token) || null;
  if (!token) throw new Error('ExchangeToken response has no access token');

  const refreshToken = (data && (data.refresh_token || data.refreshToken)) || (result && result.RefreshToken) || null;
  const expiredRaw = (data && (data.expiredAt || data.expire_at || data.expires_at))
    || (result && (result.TokenExpireAt || result.ExpiredAt))
    || null;

  return {
    token,
    refreshToken,
    expiredAt: toIsoTime(expiredRaw) || jwtExpIso(token),
    refreshExpiredAt: toIsoTime((data && (data.refreshExpiredAt || data.refresh_expired_at)) || (result && result.RefreshTokenExpireAt) || null),
    tokenReleaseAt: toIsoTime((data && data.tokenReleaseAt) || (result && result.TokenReleaseAt) || null),
  };
}

let _refreshPromise = null; // Mutex for token refresh

async function refreshTokenIfNeeded() {
  const authInfo = getAuthInfo();

  if (authInfo._edition === 'manual') {
    if (!isTokenExpired(authInfo)) {
      return authInfo;
    }
    throw new Error('Manual token expired. Please update TRAE_MANUAL_TOKEN in .env file.');
  }

  if (!isTokenExpiringSoon(authInfo, 30)) {
    return authInfo;
  }

  // Mutex: if a refresh is already in progress, wait for it
  if (_refreshPromise) {
    return _refreshPromise;
  }

  _refreshPromise = (async () => {
    console.log(`Token expiring soon or expired (at ${authInfo.expiredAt}), attempting refresh...`);

    try {
      const result = await exchangeToken(authInfo.refreshToken);
      if (result && result.token) {
        const newAuth = {
          ...authInfo,
          token: result.token,
          refreshToken: result.refreshToken || authInfo.refreshToken,
          expiredAt: result.expiredAt,
          refreshExpiredAt: result.refreshExpiredAt || authInfo.refreshExpiredAt,
          tokenReleaseAt: result.tokenReleaseAt || authInfo.tokenReleaseAt
        };

        if (authInfo._wasEncrypted) {
          console.log(`Token refreshed successfully (in-memory only, original data was encrypted), new expiry: ${newAuth.expiredAt}`);
          _cachedAuthInfo = newAuth;
          return newAuth;
        }

        const storage = readStorageJsonByEdition(authInfo._edition || detectEdition());
        const authKey = 'iCubeAuthInfo://icube.cloudide';
        storage[authKey] = JSON.stringify({
          token: newAuth.token,
          refreshToken: newAuth.refreshToken,
          expiredAt: newAuth.expiredAt,
          refreshExpiredAt: newAuth.refreshExpiredAt,
          tokenReleaseAt: newAuth.tokenReleaseAt,
          userId: newAuth.userId,
          host: newAuth.host,
          userRegion: newAuth.userRegion,
          account: newAuth.account
        });

        const storagePath = getStorageJsonPath(authInfo._edition);
        writeFileAtomic(storagePath, JSON.stringify(storage, null, '\t'));
        console.log(`Token refreshed successfully, new expiry: ${newAuth.expiredAt}`);
        _cachedAuthInfo = newAuth;
        return newAuth;
      } else {
        console.error('Token refresh returned no token');
        if (isTokenExpired(authInfo)) {
          throw new Error('Token expired and refresh returned no token. Please restart Trae IDE to re-authenticate.');
        }
        return authInfo;
      }
    } catch (err) {
      console.error(`Token refresh failed: ${err.message}`);
      if (isTokenExpired(authInfo)) {
        throw new Error('Token expired and refresh failed. Please restart Trae IDE to re-authenticate.');
      }
    } finally {
      _refreshPromise = null; // Clear mutex
    }

    return authInfo;
  })();

  return _refreshPromise;
}

/** 探测真实 Trae/TraeWork 安装目录，返回 { dir, appVersion, buildVersion } 或 null。 */
// 客户端元数据缓存：headersFor 每请求会调此函数 5 次，
// 而候选目录常不存在（每次 5 轮 existsSync），高并发下同步 IO 会阻塞事件循环。
// 用 TTL 缓存（含 null 结果），客户端升级后最多延迟一个 TTL 生效。
const CLIENT_META_TTL_MS = (() => {
  const n = Number(process.env.TRAE_CLIENT_META_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 5 * 60 * 1000;
})();
let _clientMetaCache = null;
let _clientMetaAt = 0;
const CLIENT_META_UNSET = 0; // _clientMetaAt 初始值：0 表示尚未扫描过

function readRealClientMeta() {
  const now = Date.now();
  if (_clientMetaAt !== CLIENT_META_UNSET && now - _clientMetaAt < CLIENT_META_TTL_MS) {
    return _clientMetaCache;
  }
  _clientMetaCache = scanRealClientMeta();
  _clientMetaAt = now;
  return _clientMetaCache;
}

function scanRealClientMeta() {
  // 客户端安装目录候选：TRAE_CLIENT_DIR 优先（非标准安装位置时用），
  // 其余为 Windows 常见安装路径。
  const candidates = [
    process.env.TRAE_CLIENT_DIR,
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Trae SOLO CN'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Trae SOLO'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Trae-CN'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Trae'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      const manifestPath = path.join(dir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const productPath = path.join(dir, 'resources', 'app', 'product.json');
      let buildVersion = '';
      try {
        if (fs.existsSync(productPath)) {
          buildVersion = JSON.parse(fs.readFileSync(productPath, 'utf-8')).buildVersion || '';
        }
      } catch (e) { /* ignore */ }
      return {
        dir,
        appVersion: manifest.appVersion || '',
        buildVersion: buildVersion || manifest.buildVersion || '',
      };
    } catch (e) {
      continue;
    }
  }
  return null;
}

/** 清空客户端元数据缓存（测试或客户端升级后手动刷新用）。 */
function resetClientMetaCache() {
  _clientMetaCache = null;
  _clientMetaAt = 0;
}

function getIdeVersion() {
  // Explicit env override takes highest priority
  if (process.env.TRAE_IDE_VERSION) return process.env.TRAE_IDE_VERSION;

  // Try to read from real installed client's manifest.json
  const meta = readRealClientMeta();
  if (meta && meta.appVersion) return meta.appVersion;

  try {
    const authInfo = getAuthInfo();
    if (authInfo._edition === 'cn') return DEFAULT_IDE_VERSION_CN;
    return DEFAULT_IDE_VERSION_SG;
  } catch (e) {
    return DEFAULT_IDE_VERSION_CN;
  }
}

/** x-app-version：真实客户端 appVersion，绝不回退到 'default'。 */
function getAppVersion() {
  if (process.env.TRAE_APP_VERSION) return process.env.TRAE_APP_VERSION;
  const meta = readRealClientMeta();
  if (meta && meta.appVersion) return meta.appVersion;
  return getIdeVersion();
}

function getIdeVersionCode() {
  if (process.env.TRAE_IDE_VERSION_CODE) return process.env.TRAE_IDE_VERSION_CODE;
  const meta = readRealClientMeta();
  if (meta && meta.buildVersion) return meta.buildVersion;
  return DEFAULT_IDE_VERSION_CODE;
}

function getDeviceInfo(deviceOverrides) {
  const o = deviceOverrides || {};
  let machineId = '';
  let sqmId = '';
  let devDeviceId = '';
  // 账号已自带设备时直接使用，不再依赖本机 storage.json（免本机登录关键）
  if (o.machineId == null || o.devDeviceId == null) {
    try {
      const authInfo = getAuthInfo();
      const storage = readStorageJsonByEdition(authInfo._edition || detectEdition()) || {};
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

function buildCommonHeaders(authInfo, deviceIds) {
  // 优先使用账号自带设备信息（免本机登录：每账号携带 telemetry，脱离本机 storage.json）
  const deviceInfo = getDeviceInfo(authInfo && authInfo.devices);
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
    'x-app-version': getAppVersion(),
    'app-version': getIdeVersion(),
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
    'x-ide-version': getIdeVersion(),
    'x-ide-version-type': 'stable',
    'request-traffic-type': 'prod',
    'package-type': 'stable_cn',
    'x-lgw-req-sdk-type': '3',
    'x-lscbd-aid': '787976',
    'x-lscbd-platform': 'windows',
    'x-ss-dp': '787976',
    'referer': `${getApiHost()}${TRAE_CHAT_PATH}`,
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

module.exports = {
  getTraeDataDir,
  getStorageJsonPath,
  readStorageJson,
  getAuthInfo,
  getDeviceIds,
  getDeviceInfo,
  isTokenExpired,
  isTokenExpiringSoon,
  getApiHost,
  getAuthHost,
  getIdeVersion,
  getIdeVersionCode,
  getAppVersion,
  readRealClientMeta,
  resetClientMetaCache,
  exchangeToken,
  normalizeExchangeResult,
  refreshTokenIfNeeded,
  buildCommonHeaders,
  buildStreamHeaders,
  hashDeviceId,
  detectEdition
};

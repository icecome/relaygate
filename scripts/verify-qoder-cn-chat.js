'use strict';
/**
 * Qoder CN 对话端点验证（老版 COSY 协议）。
 *
 * v2 文档记录国际版走新版 `POST api2-v2.qoder.sh/model/v1/chat/completions`（纯 Bearer）。
 * 本脚本验证国内版：qoder2api-hub 对 CN 用的是**老版**：
 *   POST https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation
 *        ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
 *   Authorization: Bearer COSY.<payload>.<sig>     ← md5(payload\ncosyKey\ndate\nbody\npath)
 *   x-model-key: <catalog key>                     ← 模型路由靠这个头，不在 body
 *   cosy-*: key/user/machineid/machinetoken/machinetype/date/version
 *   Content-Type: application/json
 *   Body: qoder_encode(json)                       ← 自定义 Base64 变体
 *
 * 同时也探测新版路径在 CN 是否可用（决定能否免签名）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const APP_DIR = path.join(process.env.APPDATA, 'com.qodercn.app.stable');
const CN_GATEWAY = 'https://gateway.qoder.com.cn';
const OLD_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation'
  + '?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';
const NEW_PATH = '/model/v1/chat/completions';

// ---- Qoder 自定义 Base64 变体（qoder_sign.py: QODER_CUSTOM_ALPHABET）----
const CUSTOM = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!';
const STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const S2C = {}; for (let i = 0; i < 64; i++) S2C[STD[i]] = CUSTOM[i];
function qoderEncode(buf) {
  const std = Buffer.from(buf).toString('base64');
  const n = std.length, a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = '';
  for (const ch of rearranged) out += (ch === '=' ? '$' : S2C[ch]);
  return out;
}

// ---- 官方客户端硬编码 RSA 公钥（qoder_sign.py: SERVER_PUB_PEM，1024 位）----
// Node crypto 的 PEM 解析比 Python 的更严（会拒绝某些 DER 编码细节），
// 故直接用 modulus/exponent 构造，与 PEM 内容等价。
const RSA_N_B64 = 'APIyB+XNNi4pY67BEcPbej7+TXOJOjz9RGg4nATKXacSnbkmbjtgDalKvHq+BjPeaJgBiDjxofjcdLKbYWANgahs/pel0ZDye9tNt+hWc+9yJ/ylbi58CPCSdgm7iWqfJL4XggmaZgFqW/3D8f91a/yeiNe13FvWjC/RaAiOgDrzs8=';
const RSA_E = 65537;

function rsaWrapTempKey(tempKey) {
  const n = BigInt('0x' + Buffer.from(RSA_N_B64, 'base64').toString('hex'));
  const m = BigInt('0x' + Buffer.from(tempKey, 'utf8').toString('hex'));
  const c = modPow(m, BigInt(RSA_E), n);
  return Buffer.from(c.toString(16).padStart(256, '0'), 'hex').toString('base64');
}
function modPow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}

const COSY_VERSION = '0.4.3';   // 客户端版本（cosy-version）
const IDE_VERSION = '0.4.3';

function dpapiUnprotect(buf) {
  const ps = [
    'Add-Type -AssemblyName System.Security',
    '$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    '$out = [System.Security.Cryptography.ProtectedData]::Unprotect($in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($out)',
  ].join('; ');
  return Buffer.from(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    input: buf.toString('base64'), encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  }).trim(), 'base64');
}
function decryptV10(blob, key) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.slice(3, 15));
  const ct = blob.slice(15);
  d.setAuthTag(ct.slice(ct.length - 16));
  return Buffer.concat([d.update(ct.slice(0, ct.length - 16)), d.final()]);
}

// ---- 取 CN token ----
const state = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'Local State'), 'utf8'));
const key = dpapiUnprotect(Buffer.from(state.os_crypt.encrypted_key, 'base64').slice(5));
const auth = JSON.parse(decryptV10(fs.readFileSync(path.join(APP_DIR, 'auth.v1.dat')), key).toString('utf8'));
const token = auth.token;
const uid = (auth.user || {}).id;

// ---- 稳定设备指纹派生（qoder_fingerprint.py 同构：md5(salt:uid)）----
const derive = (salt) => crypto.createHash('md5').update(`${salt}:${uid}`).digest('hex');

function cosyHeaders(bodyEnc, url, modelKey) {
  // 会话密钥：uuid4 hex 前 16 位（与 qoder_sign.py 一致，刻意保持兼容）
  const tempKey = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const cosyKey = rsaWrapTempKey(tempKey);

  // info = base64(AES-128-CBC(identity_json, key=iv=tempKey))
  const identity = {
    machineId: derive('machine'),
    machineToken: crypto.createHash('sha512').update(`machinetoken:${uid}`).digest('base64url').slice(0, 43),
    machineType: derive('machinetype').replace(/-/g, '').slice(0, 18),
    nickname: (auth.user || {}).name || '',
    osPlatform: 'win32',
    arch: 'x64',
    version: IDE_VERSION,
    runtime: 'electron',
    channel: 'stable',
  };
  const identityJson = JSON.stringify(identity, Object.keys(identity).sort());
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(tempKey, 'utf8'), Buffer.from(tempKey, 'utf8'));
  const info = Buffer.concat([cipher.update(identityJson, 'utf8'), cipher.final()]).toString('base64');

  // payload = base64(sorted-compact)
  const payloadObj = {
    cosyVersion: COSY_VERSION,
    ideVersion: IDE_VERSION,
    info,
    requestId: crypto.randomUUID(),
    version: '1',
  };
  const payload = Buffer.from(JSON.stringify(payloadObj, Object.keys(payloadObj).sort())).toString('base64');

  const date = String(Math.floor(Date.now() / 1000));
  // path 去掉 /algo 前缀
  const pathStripped = new URL(url).pathname.replace(/^\/algo/, '');
  const sigRaw = `${payload}\n${cosyKey}\n${date}\n${bodyEnc}\n${pathStripped}`;
  const sig = crypto.createHash('md5').update(sigRaw).digest('hex');

  return {
    'Authorization': `Bearer COSY.${payload}.${sig}`,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'cosy-key': cosyKey,
    'cosy-user': uid,
    'cosy-machineid': identity.machineId,
    'cosy-machinetoken': identity.machineToken,
    'cosy-machinetype': identity.machineType,
    'cosy-date': date,
    'cosy-version': COSY_VERSION,
    'x-model-key': modelKey,
  };
}

(async () => {
  console.log('='.repeat(66));
  console.log('Qoder 国内版（CN）对话端点验证');
  console.log('='.repeat(66));
  console.log('uid:', uid, '| token:', `${String(token).slice(0, 6)}…`);
  console.log('qoderEncode("{\\"x\\":1}") =', qoderEncode(Buffer.from('{"x":1}')));

  const MODEL = process.env.QODER_CN_MODEL || 'qmodel';

  // ===== A. 新版路径在 CN 是否可用（纯 Bearer）=====
  console.log('\n[A] 新版路径（纯 Bearer）在 CN 是否可用');
  console.log(`    POST ${CN_GATEWAY}${NEW_PATH}  model=${MODEL}`);
  try {
    const r = await fetch(CN_GATEWAY + NEW_PATH, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Request-ID': crypto.randomUUID(),
        'X-Session-ID': crypto.randomUUID(),
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
        stream_options: { include_usage: true },
        metadata: { context: { request_id: crypto.randomUUID(), request_set_id: crypto.randomUUID(), session_id: crypto.randomUUID(), task_id: 'common', client_type: 'qodercli' } },
      }),
      signal: AbortSignal.timeout(45000),
    });
    const t = await r.text();
    console.log('    HTTP', r.status, '| len', t.length);
    console.log('   ', t.slice(0, 300).replace(/\n/g, ' '));
  } catch (e) { console.log('    失败:', e.message); }

  // ===== B. 老版 COSY 路径 =====
  console.log('\n[B] 老版 COSY 路径');
  console.log(`    POST ${CN_GATEWAY}${OLD_PATH}`);
  const bodyObj = {
    chat_task: 'FREE_INPUT',
    chat_context: {
      chatPrompt: '',
      extra: { context: [], modelConfig: { is_reasoning: false, key: MODEL }, originalContent: { type: 'text', text: 'ping' } },
      features: [],
      imageUrls: null,
      text: { type: 'text', text: 'ping' },
    },
    image_urls: null,
    is_reply: true,
    is_retry: false,
    session_id: crypto.randomUUID(),
    session_type: 'qoder',
    agent_id: 'agent_common',
    task_id: 'common',
    model_config: { key: MODEL, display_name: MODEL, model: '', format: 'openai', is_vl: false, is_reasoning: false, api_key: '', url: '', source: 'system', max_input_tokens: 180000 },
    messages: [{ role: 'user', content: 'ping', response_meta: { id: '', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens_details: { cached_tokens: 0 } }, reasoning_content_signature: '' } }],
    tools: [],
    request_id: crypto.randomUUID(),
    request_set_id: crypto.randomUUID(),
    chat_record_id: crypto.randomUUID(),
    stream: true,
    version: '3',
    parameters: { max_tokens: 4096 },
    aliyun_user_type: 'personal_professional_trial',
    business: { product: 'qoder-cn', version: COSY_VERSION, type: 'agent', id: crypto.randomUUID(), name: 'ping', begin_at: Date.now(), stage: 'start' },
  };
  const bodyEnc = qoderEncode(Buffer.from(JSON.stringify(bodyObj), 'utf8'));
  console.log('    body(encoded) len:', bodyEnc.length);
  const url = CN_GATEWAY + OLD_PATH;
  const h = cosyHeaders(bodyEnc, url, MODEL);
  console.log('    x-model-key:', h['x-model-key']);
  console.log('    Authorization:', h.Authorization.slice(0, 40) + '…');
  try {
    const r = await fetch(url, { method: 'POST', headers: h, body: bodyEnc, signal: AbortSignal.timeout(60000) });
    const t = await r.text();
    console.log('    HTTP', r.status, '| len', t.length);
    console.log('   ', t.slice(0, 500).replace(/\n/g, ' '));
    if (/llm_model_result|content|delta/.test(t)) console.log('\n    >>> 老版 COSY 协议可用');
  } catch (e) { console.log('    失败:', e.message); }
})().catch((e) => { console.error('\n执行失败:', e.message); process.exitCode = 1; });

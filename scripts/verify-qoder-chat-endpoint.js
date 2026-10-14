'use strict';
/**
 * 验证 Qoder 新版 chat 端点是否可用（纯 Bearer，OpenAI 兼容）。
 * 依据：QoderGateway/docs/qoder-protocol-research.md §2
 *   POST https://api2-v2.qoder.sh/model/v1/chat/completions
 * 本脚本用本机解出的 dt- token 打一次最小请求，确认：
 *   1. 端点和头形态正确（能拿到 SSE / JSON）
 *   2. 是否能返回 usage（决定积分计费口径）
 *   3. 免费模型 qfmodel（Qwen3.8-Flash）是否可调用
 *
 * 只读性质：发一条 "ping" 消息，不产生业务副作用。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const APP_DIR = path.join(process.env.APPDATA, 'com.qoder.app.stable');

function dpapiUnprotect(buf) {
  const ps = [
    'Add-Type -AssemblyName System.Security',
    '$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    '$out = [System.Security.Cryptography.ProtectedData]::Unprotect($in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($out)',
  ].join('; ');
  return Buffer.from(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    input: buf.toString('base64'), encoding: 'utf8', windowsHide: true,
  }).trim(), 'base64');
}

function decryptV10(blob, key) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.slice(3, 15));
  const ct = blob.slice(15);
  d.setAuthTag(ct.slice(ct.length - 16));
  return Buffer.concat([d.update(ct.slice(0, ct.length - 16)), d.final()]);
}

// ---- 取本机 token ----
const state = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'Local State'), 'utf8'));
const ekBlob = Buffer.from(state.os_crypt.encrypted_key, 'base64');
const key = dpapiUnprotect(ekBlob.slice(5));
const auth = JSON.parse(decryptV10(fs.readFileSync(path.join(APP_DIR, 'auth.v1.dat')), key).toString('utf8'));
const token = auth.token;
console.log('token prefix:', String(token).slice(0, 3), 'len:', token.length);

// ---- 打一次最小 chat 请求 ----
const BASE = process.env.QODER_CHAT_BASE || 'https://api2-v2.qoder.sh';
const MODEL = process.env.QODER_CHAT_MODEL || 'lite'; // 参考实现验证过可用的最小档
const url = `${BASE}/model/v1/chat/completions`;
const body = {
  model: MODEL,
  messages: [{ role: 'user', content: 'ping' }],
  stream: true,
  stream_options: { include_usage: true },
  metadata: {
    context: {
      request_id: crypto.randomUUID(),
      request_set_id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      task_id: 'common',
      client_type: 'qodercli',
    },
  },
};

(async () => {
  console.log(`\nPOST ${url}\nmodel: ${MODEL}\n`);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Request-ID': crypto.randomUUID(),
        'X-Session-ID': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    console.log('HTTP', resp.status, resp.statusText);
    console.log('content-type:', resp.headers.get('content-type'));
    const text = await resp.text();
    console.log('body length:', text.length);
    const head = text.slice(0, 600);
    console.log('--- head ---\n' + head);
    if (text.includes('raw_usage') || /"usage"/.test(text)) {
      console.log('\n>>> 响应含 usage（可用于积分计费口径）');
    }
    if (text.includes('error') || resp.status >= 400) {
      console.log('\n>>> 上游报错，需核对头/模型名');
    } else {
      console.log('\n>>> 新版协议可用（纯 Bearer，无签名）');
    }
  } catch (e) {
    console.log('请求失败:', e.message);
  }
})();

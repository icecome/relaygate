'use strict';
/**
 * Qoder 国内版/国际版差异全量对比（终版）。
 * 汇总：凭据、端点、域名、活动、模型目录、协议形态，输出可直接引用的事实表。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REALMS = {
  intl: { label: '国际版 (Global)', appDir: 'com.qoder.app.stable', home: '.qoder', domain: 'qoder.sh' },
  cn: { label: '国内版 (China)', appDir: 'com.qodercn.app.stable', home: '.qoder-cn', domain: 'qoder.com.cn' },
};

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
const decryptV10 = (blob, key) => {
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.slice(3, 15));
  const ct = blob.slice(15);
  d.setAuthTag(ct.slice(ct.length - 16));
  return Buffer.concat([d.update(ct.slice(0, ct.length - 16)), d.final()]);
};
function loadAuth(realm) {
  const cfg = REALMS[realm];
  const dir = path.join(process.env.APPDATA, cfg.appDir);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'Local State'), 'utf8'));
  const key = dpapiUnprotect(Buffer.from(state.os_crypt.encrypted_key, 'base64').slice(5));
  const data = JSON.parse(decryptV10(fs.readFileSync(path.join(dir, 'auth.v1.dat')), key).toString('utf8'));
  return { cfg, data };
}

(async () => {
  try {
  const out = [];
  const L = (s) => { out.push(s); console.log(s); };

  const a = loadAuth('intl'), b = loadAuth('cn');
  const ua = (a.data.user || {}), ub = (b.data.user || {});

  L('# Qoder 国内版 / 国际版差异（本机实测）\n');
  L('## 1. 账号与凭据\n');
  L('| 项 | 国际版 | 国内版 |');
  L('|---|---|---|');
  L(`| app 目录 | \`%APPDATA%\\\\${REALMS.intl.appDir}\` | \`%APPDATA%\\\\${REALMS.cn.appDir}\` |`);
  L(`| home 目录 | \`~\\\\${REALMS.intl.home}\` | \`~\\\\${REALMS.cn.home}\` |`);
  L(`| 主域名 | ${REALMS.intl.domain} | ${REALMS.cn.domain} |`);
  L(`| uid | \`${ua.id}\` | \`${ub.id}\` |`);
  L(`| 账号 | ${ua.email || ua.name} (${ua.source || 'n/a'}) | ${ub.email || ub.name} (${ub.source || 'n/a'}) |`);
  L(`| token | \`${String(a.data.token).slice(0, 6)}…\` len=${String(a.data.token).length} | \`${String(b.data.token).slice(0, 6)}…\` len=${String(b.data.token).length} |`);
  L(`| expiresAt | ${a.data.expiresAt} | ${b.data.expiresAt} |`);
  L('| 加密链路 | 同左：os_crypt v10 + DPAPI | 同左：os_crypt v10 + DPAPI |');

  L('\n## 2. 服务端点（客户端实证）\n');
  for (const realm of ['intl', 'cn']) {
    const f = path.join(process.env.USERPROFILE, REALMS[realm].home, '.cache', 'endpoint-cache.json');
    L(`**${REALMS[realm].label}**`);
    if (fs.existsSync(f)) {
      const e = JSON.parse(fs.readFileSync(f, 'utf8')).entries.prod;
      L(`- openapi: \`${e.openapiEndpoint}\``);
      L(`- center : \`${e.centerEndpoint}\``);
      L(`- infer  : \`${e.endpoint}\``);
      L(`- fast   : \`${e.fastEndpoint}\``);
    } else L('- （无缓存）');
    L('');
  }
  L('> 关键差异：**国际版按职能拆多域名**（openapi/center/infer 各自独立），');
  L('> **国内版统一走 `gateway.qoder.com.cn` 单域名**。国内版的 `/model/v1/*`（新版 OpenAI 兼容面）');
  L('> 实测返回 503 —— 该面在国际版才是 `api2-v2.qoder.sh`。');

  L('\n## 3. 对话协议\n');
  L('| 项 | 国际版 | 国内版 |');
  L('|---|---|---|');
  L('| 新版 OpenAI 兼容 | `POST api2-v2.qoder.sh/model/v1/chat/completions`（纯 Bearer，**实测 200**） | `gateway.qoder.com.cn/model/v1/*`（**实测 503**） |');
  L('| 老版 COSY | `POST api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation` | `POST gateway.qoder.com.cn/algo/api/v2/...`（**实测 200**，model/list 已通） |');
  L('| 签名 | Bearer COSY.payload.sig = md5(payload\\ncosyKey\\ndate\\nbody\\npath) | 同左（cosyVersion=`1.1.64`） |');
  L('| 请求体 | `qoder_encode(json)`（自定义 Base64 变体） | 同左 |');
  L('| 模型路由 | `x-model-key` 头 | 同左 |');

  L('\n## 4. 积分活动（双区域均 200）\n');
  L('| 端点 | 国际版 | 国内版 |');
  L('|---|---|---|');
  L('| 活动列表 | `openapi.qoder.sh/sash/api/v1/me/campaigns` | `openapi.qoder.com.cn/sash/api/v1/me/campaigns` |');
  L('| 领取 | `POST /sash/api/v1/me/campaigns/{id}/claim` | 同左（**实测已领 100 credits**） |');
  L('| 活动文案 URL | `docs.qoder.com/events/100credits` | `docs.qoder.cn/events/100credits` |');
  L('| 活动 key | `act-20261013-517` | `act-20261013-250` |');
  L('| 文案 | 「每天领 100 Credits / 每日 10:00（UTC+8）刷新，领取后 30 天有效」 | 同左（逐字一致） |');
  L('| 幂等 | `replayed: true`，同 grantId | 同左（**实测 2 次重复 claim，额度不变**） |');

  L('\n## 5. 额度结构\n');
  L('| 项 | 国际版 | 国内版 |');
  L('|---|---|---|');
  L('| userType | `personal_professional_trial` | 同左 |');
  L('| usageType | `credits` | 同左 |');
  L('| userQuota | 300 | 300 |');
  L('| addOnQuota | 100（领取后出现） | 100（领取后出现） |');
  L('| expiresAt | 2026-10-27 | 2026-10-27 |');

  L('\n## 6. 模型目录\n');
  L('| 项 | 国际版 | 国内版 |');
  L('|---|---|---|');
  L('| 模型数 | 18 | 14 |');
  L('| 获取方式 | QMC v1 本机缓存（`catalog-v6`）或 `qmodel` 列表 | COSY `/algo/api/v2/model/list`（实测 200） |');
  L('| 限免模型 | `qfmodel` (Qwen3.8-Flash) `is_free=true price_factor=0` | 同左（**双区域一致**） |');
  L('| 国际版独有 | `ultimate`/`fast`/`performance`/`efficient`/`smodel`(Sonus)/`cmodel`(Cantus) | — |');
  L('| 国内版独有 | — | `q37fmodel`(Qwen3.7-Flash)、`gm51model`(GLM-5.2)、`mmodel`(MiniMax-M2.7) |');
  L('| 同名不同值 | `mmodel`=MiniMax-**M3** price 0.2 | `mmodel`=MiniMax-**M2.7** price 0.2 |');
  L('| CN 特色活动 | — | `qmodel_38max` 带错峰 4 折（22:00–08:00 UTC+8，`idle_time_model_credit_discount`） |');

  L('\n## 7. 对 RelayGate 接入的影响\n');
  L('1. **凭据层可统一**：两侧 os_crypt v10 + DPAPI 完全同构，`src/qoder/local.js` 只需按 app 目录名分叉。');
  L('2. **端点层必须分叉**：CN 的 `/model/v1/*` 不可用（503），对话转发只能走 COSY 老协议；');
  L('   国际版可走新版纯 Bearer。**这意味着「转发面」在国内版需要实现 COSY 签名，工作量显著上升。**');
  L('3. **运营面（签到/额度）可统一**：`/sash/api/v1/me/campaigns` + `/api/v2/quota/usage` 双区域同构，');
  L('   仅域名不同。这是 P1/P2 的主要工作，且**国内版已实测可领**。');
  L('4. **限免模型双区域一致**：`qfmodel` price_factor=0，可用于「今日消耗」计量的 0 消耗特判。');
  L('5. **注意国内版 catalog 是动态 COSY 拉取，不是本机缓存**：目录同步要走签名链路。');

  fs.writeFileSync(path.join(__dirname, '..', '..', '..', 'logs', 'qoder-realm-diff.md'), out.join('\n'));
  L(`\n\n（已写入 logs/qoder-realm-diff.md）`);
  } catch (e) {
    console.error('失败:', e && e.stack ? e.stack : e);
    process.exitCode = 1;
  }
})().catch((e) => { console.error('外层失败:', e && e.stack ? e.stack : e); process.exitCode = 1; });

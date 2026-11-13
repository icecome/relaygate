'use strict';
/**
 * repair-model-key-access.js —— 修复「单个模型调用提示 API 密钥失效」。
 *
 * 症状（2026-11-07 现场）：
 *   - 聚合虚拟模型（vm/*）调用正常；
 *   - 直接调后端单个模型（glm-5.3 / doubao-1-6 / wb/glm-5.3 …）返回 403，
 *     type=auth_error，客户端把 403 显示成「API 密钥失效」。
 *
 * 两个叠加根因，本脚本把**数据侧**那一半修好（代码侧那一半在本次提交里）：
 *   R1  scopes 迁移把 NULL 写成了 ["models:read"]：
 *       `canUseModel` → `canInvokeModel` 要求 models:invoke，缺则
 *       `403 access denied: scope_missing:models:invoke`。
 *       虚拟模型分支不校验 scope，所以只有聚合模型能用。
 *   R2  「WB 独有」判定只看静态 WB_MODELS 名单：glm-5.3 / glm-5.1 / glm-4.7 /
 *       minimax-m3 / kimi-k2.6 … 这些 Trae 上游实测**也能调**（本脚本会实测），
 *       却被判 platform_mismatch 拒掉。
 *
 * 本脚本做四件事（全部幂等，可反复跑）：
 *   1. 物化 NULL/空 scopes → 平台默认（含 models:invoke）
 *   2. 修复「只有 models:read、一个 invoke 都没有」的坏行
 *   3. 实测 Trae 与 WorkBuddy 的模型归属，写入 .trae-api/model-ownership.json
 *   4. 逐把访问密钥打印「虚拟模型 / Trae 单模型 / WB 单模型」的判定结果
 *
 * 用法：
 *   node scripts/repair-model-key-access.js              # 只修数据 + 打印判定
 *   node scripts/repair-model-key-access.js --no-probe   # 跳过上游实测（离线环境）
 *   node scripts/repair-model-key-access.js --json       # 机器可读输出
 *
 * ⚠️ 代码侧修复需要重启进程才生效（model-access / openai 路由是加载期求值的）。
 */
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const NO_PROBE = args.includes('--no-probe');
const AS_JSON = args.includes('--json');

const apiKeys = require('../src/credentials/api-keys');
const ownership = require('../src/models/platform-ownership');
const { canUseModel } = require('../src/middleware/model-access');

/** 用于展示判定的样本模型（覆盖三类：虚拟 / Trae 单模型 / WB 单模型）。 */
const SAMPLES = [
  { tag: 'virtual', model: 'vm/long-context' },
  { tag: 'trae', model: 'doubao-1-6' },
  { tag: 'trae', model: 'glm-5.3' },
  { tag: 'wb', model: 'wb/glm-5.3' },
  { tag: 'wb', model: 'wb/hy3' },
];

const out = { steps: [], keys: [], probes: null };

function log(...a) { if (!AS_JSON) console.log(...a); }

(async () => {
  // ---- 1/2. scope 数据修复 ----
  const materialized = apiKeys.ensureModelsReadScope();
  out.steps.push({ step: 'materialize-scopes', changed: materialized });
  log(`[1] scopes 物化（NULL/空 → 平台默认，补 models:read）：${materialized.length} 把 ${materialized.length ? '→ ' + materialized.join(', ') : ''}`);

  const repaired = apiKeys.ensureInvokeScope();
  out.steps.push({ step: 'repair-invoke-scope', changed: repaired.map((r) => r.id) });
  log(`[2] invoke scope 修复（只有 models:read 的坏行）：${repaired.length} 把`);
  for (const r of repaired) {
    log(`    ${r.id} (${r.platform}) ${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}`);
  }

  // ---- 3. 归属实测 ----
  if (!NO_PROBE) {
    log('[3] 上游归属取证（Trae 目录 + WorkBuddy 目录 + 逐名字实测）…');
    try {
      const catalog = require('../src/models/catalog');
      const cat = await catalog.listWithStatus({ force: true });
      log(`    Trae 目录：${cat.models.length} 个可见项（source=${cat.source}）`);
    } catch (e) {
      log(`    Trae 目录拉取失败（跳过，仍用本地登记表）：${e.message}`);
    }
    try {
      const wbChat = require('../src/workbuddy/chat');
      const wbModels = await wbChat.modelCatalog(true);
      log(`    WorkBuddy 目录：${wbModels.length} 个`);
    } catch (e) {
      log(`    WorkBuddy 目录拉取失败（跳过，仍用静态名单）：${e.message}`);
    }

    // 逐名字实测（这是判「WB 独占」的强证据来源）：
    //   Trae 实测成功 → traeServes 正向证据；实测明确失败（模型不存在/参数非法）
    //   → traeConfirmedAbsent，只有这种证据才允许判独占。
    const probeNames = require('../src/workbuddy/model-ids').WB_MODELS
      .filter((id) => id !== 'auto' && id !== 'default');
    log(`    逐名字实测 Trae：${probeNames.length} 个 WB 名单项（每个一次最小调用，约 ${probeNames.length} 次往返）…`);
    const { llmUtilsChat } = require('../src/upstream/client');
    const { normalizeTraeMessages } = require('../src/transform/request');
    const pool = require('../src/credentials/pool');
    for (const m of probeNames) {
      try {
        await pool.run(
          (accountId) => llmUtilsChat(normalizeTraeMessages([{ role: 'user', content: 'ping' }]), m, false, { accountId, max_tokens: 8 }),
          { maxSwitches: 1, edition: 'trae' },
        );
        ownership.recordProbe(m, true, { platform: 'trae' });
        log(`      OK    ${m}`);
      } catch (e) {
        // 池空/限流/网络属「本次没探成」：不写归属表（写 false 等于给
        // 「Trae 不服务」投票，2026-11-13 池空误写 deepseek-v4.1-flash 的
        // 同款事故）。只有明确的模型级失败才算证据。
        const { isPoolUnavailableError, isModelRateLimitError } = require('../src/upstream/errors');
        if (isPoolUnavailableError(e) || isModelRateLimitError(e)) {
          log(`      SKIP  ${m}  ${String(e.message).slice(0, 90)}（池空/限流，不计入归属证据）`);
        } else {
          ownership.recordProbe(m, false, { platform: 'trae', note: String(e.message).slice(0, 120) });
          log(`      FAIL  ${m}  ${String(e.message).slice(0, 90)}`);
        }
      }
    }
    out.probes = ownership.stats();
  }

  // 归属摘要：两平台都服务的名字（这些以前被误判成 WB 独有）
  const wbList = require('../src/workbuddy/model-ids').WB_MODELS;
  const shared = wbList.filter((id) => ownership.traeServes(id) && ownership.workBuddyServes(id));
  const wbOnly = wbList.filter((id) => ownership.isWorkBuddyExclusive(id));
  out.steps.push({ step: 'ownership', shared, wbOnly });
  log(`[3] 两平台同名（以前被误判 WB 独有 → 现在 Trae 密钥可调）：${shared.length} 个`);
  log(`    ${shared.join(', ') || '(无)'}`);
  log(`[3] 真 WB 独有（Trae 密钥仍拒绝）：${wbOnly.length} 个`);
  log(`    ${wbOnly.join(', ') || '(无)'}`);

  // ---- 4. 逐密钥判定 ----
  log('\n[4] 访问密钥判定（修复后应当：平台密钥能调本平台单模型；虚拟模型照旧可用）');
  for (const r of apiKeys.listKeys({ kind: 'access' })) {
    const plain = apiKeys.revealKeyPlain(r.id);
    const rec = plain ? apiKeys.verifyAccessKey(plain) : null;
    const row = {
      id: r.id,
      label: r.label,
      platform: r.platform,
      enabled: r.enabled,
      scopes: r.scopes,
      resources: r.resources,
      verifiable: !!rec,
      verdicts: {},
    };
    log(`\n  — ${r.id}  label=${r.label}  platform=${r.platform}  enabled=${r.enabled}`);
    log(`    scopes=${JSON.stringify(r.scopes)}  resources=${JSON.stringify(r.resources)}`);
    if (!rec) {
      log('    （无明文备份：历史密钥无法重建记录，判定跳过；需要时在面板「重置」生成新明文）');
      out.keys.push(row);
      continue;
    }
    for (const s of SAMPLES) {
      const v = canUseModel(rec.platform, s.model, rec);
      row.verdicts[s.model] = v.ok ? 'ALLOW' : `DENY(${v.reason || 'denied'})`;
      log(`    ${s.tag.padEnd(8)} ${s.model.padEnd(18)} ${v.ok ? 'ALLOW' : 'DENY  ' + v.message}`);
    }
    out.keys.push(row);
  }

  if (AS_JSON) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    log('\n完成。代码侧修复（model-access / openai 路由 / catalog 归属快照）需要重启进程生效：');
    log('  Windows 服务：重启 RelayGate 服务；或手动：start.bat');
    log('  重启后复验：node scripts/repro-key-scope.js');
  }
})().catch((e) => {
  console.error('修复脚本失败：', e.stack || e.message);
  process.exit(1);
});

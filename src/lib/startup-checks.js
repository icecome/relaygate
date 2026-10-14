'use strict';
/**
 * lib/startup-checks.js — 启动期健康校验。
 *
 * 目的：把「静默降级」变成「明确失败」。此前的失败模式是：
 *   - DB 打不开 → 进程照常启动、端口照常监听，但每个请求 500；
 *   - encrypt.key 丢失 → 静默生成新 key，库里所有密文从此解不开（不可逆）；
 *   - 配置文件损坏 → 静默回退成空对象，面板仍显示「一切正常」。
 * 这些并非「运行中才暴露」的问题，而是启动时就已知的事实。
 *
 * 每个检查返回 { name, ok, detail, fatal }：
 *   - fatal:true  → 调用方应拒绝启动（退出码 1）
 *   - fatal:false → 记入 /health 的 checks，让面板可见
 */

/**
 * 加密密钥与既有密文是否兼容。
 *
 * 判断依据：本进程是否新生成 key（crypto.wasKeyGenerated()）+ 库里是否存在
 * 非空密文列。两者同时成立 = 旧 key 已丢失，继续启动等于放弃全部凭据。
 *
 * @param {{wasKeyGenerated:()=>boolean}} cryptoMod
 * @param {()=>object|null} getDb 取连接（可能抛）
 */
function checkEncryptionKey(cryptoMod, getDb) {
  let generated = false;
  try {
    // 先强制解析一次密钥：本模块的「是否新生成」标志只有在真正取过 key 之后才准确。
    cryptoMod.getEncryptionKey();
    generated = cryptoMod.wasKeyGenerated();
  } catch (e) {
    return { name: 'encryptKey', ok: false, fatal: true, detail: `加密密钥不可用：${e.message}` };
  }
  if (!generated) {
    return { name: 'encryptKey', ok: true, detail: '密钥来自配置或既有文件' };
  }
  // 新生成的 key：只有库里确实存有密文时才是灾难
  let cipherRows = 0;
  try {
    const db = getDb();
    if (!db) return { name: 'encryptKey', ok: true, detail: '数据库尚未就绪，跳过密文检查' };
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM accounts
         WHERE (token_enc IS NOT NULL AND token_enc != '')
            OR (refresh_token_enc IS NOT NULL AND refresh_token_enc != '')
            OR (api_key_enc IS NOT NULL AND api_key_enc != '')`,
      )
      .get();
    cipherRows = Number(row && row.n) || 0;
  } catch (e) {
    return { name: 'encryptKey', ok: true, detail: `密文检查失败：${e.message}`, fatal: false };
  }
  if (cipherRows > 0) {
    return {
      name: 'encryptKey',
      ok: false,
      fatal: true,
      detail:
        `检测到 ${cipherRows} 个账号存有加密凭据，但 ${cryptoMod.KEY_ENV_VAR} 缺失并已重新生成。` +
        '继续启动会导致这些 token 永远无法解密。请从备份恢复 .trae-api/encrypt.key，' +
        '或显式设置 TRAE_API_ENCRYPT_KEY；确认要放弃既有凭据时，可先清空 accounts 表再启动。',
    };
  }
  return { name: 'encryptKey', ok: true, detail: '新生成的密钥（库中暂无密文）' };
}

/** 数据库可用性（能执行一次最简单的查询）。 */
function checkDatabase(getDb) {
  try {
    const db = getDb();
    if (!db) return { name: 'db', ok: false, fatal: true, detail: '数据库连接不可用' };
    db.prepare('SELECT 1').get();
    return { name: 'db', ok: true, detail: 'ok' };
  } catch (e) {
    return { name: 'db', ok: false, fatal: true, detail: `数据库不可用：${e.message}` };
  }
}

/** 模型配置是否可用（区分「未配置」与「读失败」）。 */
function checkModelConfig(config, fsMod, pathMod) {
  const file = pathMod.join(config.ROOT, 'model-config.json');
  if (!fsMod.existsSync(file)) {
    return { name: 'modelConfig', ok: false, detail: 'model-config.json 不存在，所有模型将走兜底分支' };
  }
  let parsed;
  try {
    parsed = JSON.parse(fsMod.readFileSync(file, 'utf8'));
  } catch (e) {
    return { name: 'modelConfig', ok: false, detail: `model-config.json 解析失败：${e.message}` };
  }
  // 直接读文件内容统计（而不是 config.modelConfig）：校验的对象是「这份文件」，
  // 且启动时 config.modelConfig 尚未填充，读它会误报为 0。
  const n = Object.keys((parsed && parsed.models) || {}).length;
  if (n === 0) {
    return { name: 'modelConfig', ok: false, detail: 'model-config.json 中没有任何模型' };
  }
  return { name: 'modelConfig', ok: true, detail: `${n} 个模型` };
}

/** 模型路由配置是否可用。 */
function checkModelRouter(config, fsMod, pathMod) {
  const file = pathMod.join(config.ROOT, 'model-router.json');
  if (!fsMod.existsSync(file)) {
    return { name: 'modelRouter', ok: true, detail: '未配置虚拟模型（可选）' };
  }
  try {
    const raw = JSON.parse(fsMod.readFileSync(file, 'utf8'));
    const n = Object.keys((raw && raw.virtualModels) || {}).length;
    return { name: 'modelRouter', ok: true, detail: `${n} 个虚拟模型` };
  } catch (e) {
    return {
      name: 'modelRouter',
      ok: false,
      detail: `model-router.json 解析失败：${e.message}（vm/* 会被当作物理模型发给上游，必然 400）`,
    };
  }
}

/**
 * 跑全部启动检查。
 * @returns {{checks: object[], fatal: object|null, warnings: string[]}}
 */
function runAll({ config, cryptoMod, getDb, fsMod, pathMod }) {
  const checks = [
    checkDatabase(getDb),
    checkEncryptionKey(cryptoMod, getDb),
    checkModelConfig(config, fsMod, pathMod),
    checkModelRouter(config, fsMod, pathMod),
  ];
  const fatal = checks.find((c) => c.fatal && !c.ok) || null;
  const warnings = checks.filter((c) => !c.ok && !c.fatal).map((c) => `${c.name}: ${c.detail}`);
  return { checks, fatal, warnings };
}

module.exports = { runAll, checkDatabase, checkEncryptionKey, checkModelConfig, checkModelRouter };
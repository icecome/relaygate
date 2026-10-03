const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');
const { stateFile, legacyStateDir } = require('./paths');

const ALGORITHM = 'aes-256-gcm';
const KEY_ENV_VAR = 'TRAE_API_ENCRYPT_KEY';

// 密钥文件位置：{workspaceDir}/.trae-api/encrypt.key。
// 读取时回退旧位置 {ROOT}/.trae-api/encrypt.key —— 这是硬要求：该密钥用于解密
// 账号库中既有 token，若因位置变更找不到旧密钥就会重新生成一把，导致所有已存
// 账号无法解密（不可逆）。因此「旧文件存在」时绝不允许走生成分支。
function keyFile() {
  return stateFile('encrypt.key');
}

function legacyKeyFile() {
  return path.join(legacyStateDir(), 'encrypt.key');
}

/** 已存在的密钥文件路径（新位置优先）；都没有返回 null。 */
function existingKeyFile() {
  if (fs.existsSync(keyFile())) return keyFile();
  if (fs.existsSync(legacyKeyFile())) return legacyKeyFile();
  return null;
}

function normalizeKey(key) {
  if (key.length < 64) key = key.padEnd(64, '0');
  return Buffer.from(key.substring(0, 64), 'hex');
}

function getEncryptionKey() {
  let key = process.env[KEY_ENV_VAR];
  if (key) return normalizeKey(key);

  // 未显式配置时，从持久化密钥文件读取；缺失则生成一次并落盘。
  // 禁止静默随机：否则重启后随机 key 会导致旧密文无法解密，凭据尽丢。
  try {
    const existing = existingKeyFile();
    if (existing) {
      key = fs.readFileSync(existing, 'utf-8').trim();
      if (key) {
        // 从旧位置读到：顺手复制到新位置，后续统一读写新位置。
        // 旧文件保留不删——回退到旧版本代码时仍需用它解密。
        if (existing !== keyFile()) writeFileAtomic(keyFile(), key);
        return normalizeKey(key);
      }
    }
    key = crypto.randomBytes(32).toString('hex');
    if (!writeFileAtomic(keyFile(), key)) throw new Error('write failed');
    process.env[KEY_ENV_VAR] = key;
    return normalizeKey(key);
  } catch (e) {
    throw new Error(`[crypto] encryption key cannot be persisted (${e.message}); set ${KEY_ENV_VAR} explicitly`);
  }
}

function encrypt(text) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText) {
  const key = getEncryptionKey();
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted text format');
  }
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = {
  encrypt,
  decrypt,
  getEncryptionKey
};

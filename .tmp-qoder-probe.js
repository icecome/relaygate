'use strict';
// 一次性只读探针：列出 accounts 表里 qoder 账号的保活相关字段（不解密 token 明文）。
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.join(__dirname, 'output', '.trae-api', 'trae-relay.db');
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare(
  `SELECT id, label, edition, qoder_realm, user_id, host, source, mode, enabled,
          expired_at, refresh_expired_at, last_refresh_at, last_keepalive_at,
          last_keepalive_result, last_checkin_at, last_checkin_result,
          (token_enc IS NOT NULL) AS has_token,
          (refresh_token_enc IS NOT NULL) AS has_rt,
          length(token_enc) AS token_len, length(refresh_token_enc) AS rt_len
     FROM accounts WHERE edition = 'qoder' ORDER BY qoder_realm, id`
).all();
console.log(JSON.stringify(rows, null, 2));
db.close();

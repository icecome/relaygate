'use strict';
/**
 * routes/status.js — 运维快照。
 * 鉴权：authenticateAdminOrPublic —— STATUS_PUBLIC=true 时免鉴权，否则要求管理密钥。
 * 该端点会返回账号池规模与调度状态，公网暴露前请确认 STATUS_PUBLIC 的取值。
 */
const { Router } = require('express');
const pool = require('../credentials/pool');
const scheduler = require('../jobs/scheduler');
const sticky = require('../session/sticky');
const store = require('../credentials/store');
const availability = require('../models/availability');
const config = require('../config');
const { authenticateAdminOrPublic } = require('../middleware/auth');

const router = Router();

function buildStatus() {
  const accounts = store.list();
  return {
    ts: new Date().toISOString(),
    accounts: {
      total: accounts.length,
      enabled: accounts.filter((a) => a.enabled).length,
      cooling: accounts.filter((a) => pool.inCooldown(a)).length,
      withBalance: accounts.filter((a) => typeof a.balance === 'number').length,
    },
    pool: pool.snapshot(),
    scheduler: scheduler.snapshot(),
    sticky: { entries: sticky.size() },
    models: {
      upstreamFunction: config.upstreamFunction || null,
      upstreamChatPath: config.upstreamChatPath,
      unavailable: availability.snapshot().filter((m) => m.status === 'unavailable').length,
    },
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
  };
}

router.get('/status', authenticateAdminOrPublic, (req, res) => {
  res.json(buildStatus());
});

module.exports = router;
module.exports.buildStatus = buildStatus;

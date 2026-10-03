'use strict';
/**
 * routes/status.js — 运维快照（免转发鉴权；公网请限制暴露）。
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

'use strict';
/**
 * routes/admin-notify.js — 通知渠道与自定义事件端点。
 * 挂载前缀：/v1/admin（见 index.js）。
 */
const { Router } = require('express');
const { authenticateAdmin } = require('../middleware/auth');
const { notifyDetail } = require('../notify');

const router = Router();
const admin = (req, res, next) => authenticateAdmin(req, res, next);

/** 通知渠道配置（读写本机 notify-settings.json；env 作兜底）。 */
router.get('/notify/settings', admin, (req, res) => {
  const notify = require('../notify');
  const settings = require('../notify/settings');
  res.json({
    object: 'notify_settings',
    ...settings.getEffective(),
    activeChannels: notify.activeChannels(),
    configuredChannels: notify.configuredChannels(),
    running: notify.enabled(),
  });
});

router.post('/notify/settings', admin, (req, res) => {
  try {
    const settings = require('../notify/settings');
    const notify = require('../notify');
    const effective = settings.save(req.body || {});
    res.json({
      object: 'notify_settings',
      ...effective,
      activeChannels: notify.activeChannels(),
      configuredChannels: notify.configuredChannels(),
      running: notify.enabled(),
    });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 通知测试（返回逐渠道结果；绕过去重，可反复点）。 */
router.post('/notify/test', admin, async (req, res) => {
  try {
    const r = await notifyDetail('scheduler_error', {
      message: 'test notification from dashboard',
    }, '通知测试', { force: true });
    res.json({ ok: r.delivered, enabled: r.enabled, results: r.results });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 通知事件自定义（增/删）。 */
router.get('/notify/events', admin, (req, res) => {
  const s = require('../notify/settings');
  const eff = s.getEffective();
  const keyed = Object.entries(eff.events || {}).map(([id, enabled]) => ({ id, enabled: enabled !== false }));
  res.json({ object: 'notify_events', builtin: s.EVENTS, data: keyed });
});

router.post('/notify/events', admin, (req, res) => {
  try {
    const s = require('../notify/settings');
    const id = String((req.body || {}).event || '').trim();
    const enabled = req.body?.enabled !== false;
    if (!s.addEvent(id, enabled)) {
      return res.status(400).json({ error: { message: '事件名仅允许小写字母/数字/下划线（以字母开头），长度 ≤64', type: 'invalid_request_error' } });
    }
    res.json({ ok: true, event: { id, enabled } });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

/** 删除自定义事件（内置事件不可删）。 */
router.post('/notify/events/remove', admin, (req, res) => {
  try {
    const s = require('../notify/settings');
    const id = String((req.body || {}).event || '').trim();
    if (!id) return res.status(400).json({ error: { message: 'event required', type: 'invalid_request_error' } });
    if (s.EVENTS.includes(id)) {
      return res.status(400).json({ error: { message: '内置事件不可删除，可关闭', type: 'invalid_request_error' } });
    }
    const removed = s.removeEvent(id);
    res.json({ ok: removed, removed });
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'internal_error' } });
  }
});

module.exports = router;
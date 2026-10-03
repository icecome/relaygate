'use strict';
/**
 * routes/dashboard.js — 旧版 public/dashboard.html 兼容；重定向到 React 面板。
 * GET /dashboard → /
 */
const { Router } = require('express');

const router = Router();

router.get('/dashboard', (req, res) => {
  res.redirect(302, '/');
});

module.exports = router;

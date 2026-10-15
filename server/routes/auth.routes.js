'use strict';

/**
 * 认证接口（公开，不需要登录）
 * GET  /api/auth/status   初始化状态 / 当前登录态
 * POST /api/auth/setup    首次初始化（创建管理员，仅允许一次）
 * POST /api/auth/login    登录
 * POST /api/auth/logout   退出登录
 * GET  /api/auth/me       当前登录信息（需登录）
 */
const express = require('express');
const auth = require('../services/auth.service');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get(
  '/status',
  wrap(async (req, res) => {
    res.json({ ok: true, ...(await auth.getStatus(req)) });
  })
);

router.post(
  '/setup',
  wrap(async (req, res) => {
    const { token, username } = await auth.setup(req.body || {}, req);
    res.setHeader('Set-Cookie', auth.buildSessionCookie(token, req));
    res.status(201).json({ ok: true, username });
  })
);

router.post(
  '/login',
  wrap(async (req, res) => {
    const { token, username } = await auth.login(req.body || {}, req);
    res.setHeader('Set-Cookie', auth.buildSessionCookie(token, req));
    res.json({ ok: true, username });
  })
);

router.post(
  '/logout',
  wrap(async (req, res) => {
    await auth.destroySession(auth.getSessionToken(req));
    res.setHeader('Set-Cookie', auth.buildClearCookie(req));
    res.json({ ok: true });
  })
);

router.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    res.json({ ok: true, admin: req.admin });
  })
);

module.exports = router;

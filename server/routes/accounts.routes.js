'use strict';

/**
 * 账号相关接口
 * GET    /api/accounts                列表（q / status / sort）
 * POST   /api/accounts                新增（mode=token 或 password）
 * POST   /api/accounts/auto-token     账号密码登录 GitHub 并自动创建全权限 Token
 *                                      （需额外验证时返回 428 + 验证会话）
 * POST   /api/accounts/auto-token/verify  提交验证码继续完成（body: verifyId, code）
 * POST   /api/accounts/auto-token/resend  重新发送验证码（body: verifyId）
 * GET    /api/accounts/:id            详情
 * PATCH  /api/accounts/:id            更新（note/email/login/token/password）
 * DELETE /api/accounts/:id            删除
 * POST   /api/accounts/:id/verify     重新验证
 * GET    /api/accounts/:id/repos      该账号的仓库列表
 * GET    /api/accounts/:id/secret     读取凭据明文（field=token|password）
 * GET    /api/accounts/:id/remote     生成带凭据的 Git 克隆地址
 */
const express = require('express');
const service = require('../services/account.service');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get(
  '/',
  wrap(async (req, res) => {
    const accounts = await service.list({ q: req.query.q, status: req.query.status, sort: req.query.sort });
    res.json({ ok: true, total: accounts.length, accounts });
  })
);

router.post(
  '/',
  wrap(async (req, res) => {
    const account = await service.create(req.body || {});
    res.status(201).json({ ok: true, account });
  })
);

// 注意：必须注册在 /:id 之前
router.post(
  '/auto-token',
  wrap(async (req, res) => {
    const result = await service.createWithAutoToken(req.body || {});
    // 需要额外验证（邮箱验证码 / 两步验证）：返回 428 + 验证会话，前端切换验证码输入视图
    if (result && result.needsVerify) {
      return res.status(428).json({ ok: false, code: 'NEED_VERIFY', ...result });
    }
    res.status(201).json({ ok: true, account: result.account, meta: result.meta });
  })
);

router.post(
  '/auto-token/verify',
  wrap(async (req, res) => {
    const { verifyId, code, note, email } = req.body || {};
    const { account, meta } = await service.verifyAutoToken({ verifyId, code, note, email });
    res.status(201).json({ ok: true, account, meta });
  })
);

router.post(
  '/auto-token/resend',
  wrap(async (req, res) => {
    const { verifyId } = req.body || {};
    res.json({ ok: true, ...(await service.resendAutoToken({ verifyId })) });
  })
);

router.get(
  '/:id',
  wrap(async (req, res) => {
    res.json({ ok: true, account: await service.getById(req.params.id) });
  })
);

router.patch(
  '/:id',
  wrap(async (req, res) => {
    res.json({ ok: true, account: await service.update(req.params.id, req.body || {}) });
  })
);

router.delete(
  '/:id',
  wrap(async (req, res) => {
    res.json({ ok: true, removed: await service.remove(req.params.id) });
  })
);

router.post(
  '/:id/verify',
  wrap(async (req, res) => {
    res.json({ ok: true, account: await service.refresh(req.params.id) });
  })
);

router.get(
  '/:id/repos',
  wrap(async (req, res) => {
    const result = await service.listRepos(req.params.id, {
      page: req.query.page,
      perPage: req.query.perPage,
    });
    res.json({ ok: true, ...result });
  })
);

router.get(
  '/:id/secret',
  wrap(async (req, res) => {
    const field = req.query.field === 'password' ? 'password' : 'token';
    res.json({ ok: true, ...(await service.revealSecret(req.params.id, field)) });
  })
);

router.get(
  '/:id/remote',
  wrap(async (req, res) => {
    res.json({ ok: true, ...(await service.buildRemote(req.params.id, req.query.repo)) });
  })
);

module.exports = router;

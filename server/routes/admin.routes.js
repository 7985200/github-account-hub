'use strict';

/**
 * 管理员接口（全部需要登录）
 * GET   /api/admin/profile       当前管理员信息
 * PATCH /api/admin/profile       重置用户名（需当前密码）
 * PATCH /api/admin/password      重置密码（需当前密码；成功后所有旧会话失效）
 * GET   /api/admin/proxy         读取代理设置
 * PUT   /api/admin/proxy         保存代理设置（即时生效）
 * POST  /api/admin/proxy/test    测试指定代理配置的连通性（不保存）
 */
const express = require('express');
const config = require('../config');
const auth = require('../services/auth.service');
const settings = require('../services/settings.service');
const proxy = require('../services/proxy.service');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get(
  '/profile',
  wrap(async (req, res) => {
    res.json({ ok: true, admin: req.admin });
  })
);

router.patch(
  '/profile',
  wrap(async (req, res) => {
    const body = req.body || {};
    const result = await auth.changeUsername(
      { currentPassword: body.currentPassword, username: body.username },
      req.admin.id
    );
    res.json({ ok: true, ...result });
  })
);

router.patch(
  '/password',
  wrap(async (req, res) => {
    const body = req.body || {};
    const { token } = await auth.changePassword(
      { currentPassword: body.currentPassword, newPassword: body.newPassword },
      req.admin.id,
      req
    );
    res.setHeader('Set-Cookie', auth.buildSessionCookie(token, req));
    res.json({ ok: true, message: '密码已重置，其他设备的登录已失效' });
  })
);

router.get(
  '/proxy',
  wrap(async (req, res) => {
    const all = await settings.getAll();
    res.json({
      ok: true,
      webProxy: all.web_proxy,
      apiViaProxy: all.api_via_proxy === '1',
      defaults: settings.defaults(),
      candidates: ['direct', ...config.webLogin.proxyCandidates],
    });
  })
);

router.put(
  '/proxy',
  wrap(async (req, res) => {
    const body = req.body || {};
    const webProxy = proxy.normalizeProxy(body.webProxy);
    if (!proxy.validateProxyConfig(webProxy)) {
      return res.status(400).json({ ok: false, error: '代理地址格式不正确（示例：http://127.0.0.1:7897，或 auto / direct）' });
    }
    await settings.set('web_proxy', webProxy);
    await settings.set('api_via_proxy', body.apiViaProxy ? '1' : '0');
    proxy.invalidateChannelCache();
    await proxy.checkChannel().catch(() => null); // 预热一次
    const all = await settings.getAll();
    res.json({ ok: true, webProxy: all.web_proxy, apiViaProxy: all.api_via_proxy === '1' });
  })
);

router.post(
  '/proxy/test',
  wrap(async (req, res) => {
    const body = req.body || {};
    const webProxy = proxy.normalizeProxy(body.webProxy) || 'auto';
    if (!proxy.validateProxyConfig(webProxy)) {
      return res.status(400).json({ ok: false, error: '代理地址格式不正确（示例：http://127.0.0.1:7897，或 auto / direct）' });
    }
    const web = await proxy.testChannelConfig(webProxy);
    res.json({ ok: true, web, target: 'github.com' });
  })
);

module.exports = router;

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
      webProxy: proxy.maskProxy(all.web_proxy),
      apiViaProxy: all.api_via_proxy === '1',
      proxyUser: all.web_proxy_user || '',
      hasProxyPass: !!(all.web_proxy_pass || ''),
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
    /* 地址里内联的 user:pass@ 拆到独立字段保存，web_proxy 只留无凭据地址，
       否则 GET /proxy 会把密码原样回显到前端 */
    let storedProxy = webProxy;
    const incomingUser = body.proxyUser === undefined ? (await settings.get('web_proxy_user')) || '' : String(body.proxyUser || '').trim();
    let incomingPass = body.proxyPass === undefined ? (await settings.get('web_proxy_pass')) || '' : String(body.proxyPass || '');
    try {
      const parsed = new URL(webProxy);
      if (parsed.username || parsed.password) {
        if (body.proxyUser === undefined) incomingUser = decodeURIComponent(parsed.username);
        if (body.proxyPass === undefined) incomingPass = decodeURIComponent(parsed.password);
        parsed.username = '';
        parsed.password = '';
        storedProxy = parsed.toString().replace(/\/$/, '');
      }
    } catch {
      /* auto / direct 不需要解析 */
    }
    await settings.set('web_proxy', storedProxy);
    await settings.set('api_via_proxy', body.apiViaProxy ? '1' : '0');
    /* 代理认证：用户名直接存；密码未传（undefined）表示「保持不变」 */
    if (body.proxyUser !== undefined) await settings.set('web_proxy_user', String(body.proxyUser || '').trim());
    if (body.proxyPass !== undefined) await settings.set('web_proxy_pass', String(body.proxyPass || ''));
    proxy.invalidateChannelCache();
    await proxy.checkChannel().catch(() => null); // 预热一次
    const all = await settings.getAll();
    const fresh = await settings.getAll();
    res.json({
      ok: true,
      webProxy: fresh.web_proxy,
      apiViaProxy: fresh.api_via_proxy === '1',
      proxyUser: fresh.web_proxy_user || '',
      hasProxyPass: !!(fresh.web_proxy_pass || ''),
    });
  })
);

router.post(
  '/proxy/test',
  wrap(async (req, res) => {
    const body = req.body || {};
    let webProxy = proxy.normalizeProxy(body.webProxy) || 'auto';
    if (!proxy.validateProxyConfig(webProxy)) {
      return res.status(400).json({
        ok: false,
        error: '代理地址格式不正确（示例：http://127.0.0.1:7897、socks5://127.0.0.1:1080，或 auto / direct）',
      });
    }
    /* 测试时也要带上认证信息，否则测的还是无认证通道 */
    webProxy = proxy.injectAuth(webProxy, body.proxyUser, body.proxyPass);
    const web = await proxy.testChannelConfig(webProxy);
    res.json({ ok: true, web, target: 'github.com' });
  })
);

module.exports = router;

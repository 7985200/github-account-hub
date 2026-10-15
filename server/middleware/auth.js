'use strict';

/**
 * 认证中间件：校验 httpOnly Cookie 中的会话
 * 未登录统一返回 401 + code=UNAUTHORIZED（前端据此跳转登录页）
 */
const auth = require('../services/auth.service');

async function requireAuth(req, res, next) {
  try {
    const token = auth.getSessionToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: '未登录', code: 'UNAUTHORIZED' });
    }
    const session = await auth.validateSession(token);
    if (!session) {
      return res.status(401).json({ ok: false, error: '登录已过期，请重新登录', code: 'SESSION_EXPIRED' });
    }
    req.admin = session.admin;
    req.sessionToken = token;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth };

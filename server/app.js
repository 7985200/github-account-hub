'use strict';

/**
 * Express 应用装配：中间件 -> 静态资源 -> 认证 -> 接口路由 -> 错误兜底
 */
const express = require('express');
const path = require('path');
const config = require('./config');
const { requestLogger, notFoundHandler, errorHandler } = require('./middleware/error');
const { requireAuth } = require('./middleware/auth');

const authRoutes = require('./routes/auth.routes');
const accountsRoutes = require('./routes/accounts.routes');
const logsRoutes = require('./routes/logs.routes');
const actionsRoutes = require('./routes/actions.routes');
const adminRoutes = require('./routes/admin.routes');
const systemRoutes = require('./routes/system.routes');

const app = express();

app.disable('x-powered-by');
// 信任本机反代（Nginx/宝塔等）转发的 X-Forwarded-For/Proto；
// 直连请求（非 loopback）不受影响，避免伪造
app.set('trust proxy', 'loopback');

/* 头像上传：图片以 base64 传输（1MB 图片 ≈ 1.4MB base64），单独放宽上限；
   body-parser 解析过一次后会置 req._body，下面的全局 256kb 解析器会自动跳过 */
app.use('/api/accounts/:id/avatar', express.json({ limit: '3mb' }));

app.use(express.json({ limit: '256kb' }));
app.use(requestLogger);

// 静态资源（前端；登录页 login.html 亦在其中，API 层已做访问控制）
app.use(
  express.static(config.publicDir, {
    index: 'index.html',
    etag: true,
    maxAge: 0,
    setHeaders(res, filePath) {
      if (path.extname(filePath) === '.html') res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// 认证接口（公开：status / setup / login / logout；me 内部鉴权）
app.use('/api/auth', authRoutes);

// 访问控制闸门：除白名单外的所有 API 均需登录
const PUBLIC_API_PATHS = new Set(['/health']);
app.use('/api', (req, res, next) => {
  if (PUBLIC_API_PATHS.has(req.path)) return next();
  return requireAuth(req, res, next);
});

// REST API（受保护）
app.use('/api/accounts', accountsRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/actions', actionsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', systemRoutes);

// 兜底
app.use('/api', notFoundHandler);
app.use(errorHandler);

module.exports = app;

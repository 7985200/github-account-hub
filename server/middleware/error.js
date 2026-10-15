'use strict';

const logger = require('../utils/logger');

/** 404 兜底 */
function notFoundHandler(req, res) {
  res.status(404).json({ ok: false, error: `接口不存在：${req.method} ${req.originalUrl}` });
}

/** 统一错误出口 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // body-parser 类错误 -> 友好提示（不外泄解析器内部信息）
  if (err && err.type === 'entity.parse.failed') {
    logger.warn(`${req.method} ${req.originalUrl} -> 400（JSON 解析失败）`);
    return res.status(400).json({ ok: false, error: '请求数据格式错误（JSON 解析失败）' });
  }
  if (err && err.type === 'entity.too.large') {
    logger.warn(`${req.method} ${req.originalUrl} -> 413（请求体过大）`);
    return res.status(413).json({ ok: false, error: '请求体过大' });
  }

  const status = Number.isInteger(err.status) ? err.status : 500;
  // 显式带 status 的属于业务错误（消息面向用户）；意外错误统一隐去内部细节
  const isBusinessError = Number.isInteger(err.status);
  const message = isBusinessError ? err.message || '请求处理失败' : '服务器内部错误';
  const payload = { ok: false, error: message };
  if (err.code) payload.code = err.code;

  if (status >= 500) {
    logger.error(`${req.method} ${req.originalUrl} 处理失败`, {
      message: err.message,
      stack: (err.stack || '').split('\n')[1],
    });
  } else {
    logger.warn(`${req.method} ${req.originalUrl} -> ${status}`, { message });
  }
  res.status(status).json(payload);
}

/** 访问日志 */
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
}

module.exports = { notFoundHandler, errorHandler, requestLogger };

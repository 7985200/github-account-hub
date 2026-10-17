'use strict';

/**
 * 系统接口
 * GET /api/health        服务 + 数据库状态（公开，供监控探活）
 * GET /api/stats         统计聚合（SQL 计算）
 * GET /api/proxy-check   网页登录通道检测（自动创建 Token 功能用）
 */
const express = require('express');
const db = require('../db/pool');
const logger = require('../utils/logger');
const service = require('../services/account.service');
const proxy = require('../services/proxy.service');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get(
  '/health',
  wrap(async (req, res) => {
    /* 这个接口是公开的（探活/监控用），不能回传数据库版本、连接数、错误原文等内部信息，
       否则未登录即可拿到指纹；明细只写日志。 */
    let databaseError = null;
    try {
      await db.inspect();
    } catch (err) {
      databaseError = err.message;
      logger.error('健康检查：数据库不可用', { error: err.message });
    }
    res.status(databaseError ? 503 : 200).json({ ok: !databaseError });
  })
);

router.get(
  '/stats',
  wrap(async (req, res) => {
    res.json({ ok: true, ...(await service.getStats()) });
  })
);

router.get(
  '/proxy-check',
  wrap(async (req, res) => {
    const result = await proxy.checkChannel();
    res.json({ ok: true, ...result });
  })
);

module.exports = router;

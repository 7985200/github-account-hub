'use strict';

/**
 * 系统接口
 * GET /api/health        服务 + 数据库状态（公开，供监控探活）
 * GET /api/stats         统计聚合（SQL 计算）
 * GET /api/proxy-check   网页登录通道检测（自动创建 Token 功能用）
 */
const express = require('express');
const os = require('os');
const config = require('../config');
const db = require('../db/pool');
const service = require('../services/account.service');
const proxy = require('../services/proxy.service');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get(
  '/health',
  wrap(async (req, res) => {
    let database = null;
    let databaseError = null;
    try {
      database = await db.inspect();
    } catch (err) {
      databaseError = err.message;
    }
    res.json({
      ok: !databaseError,
      service: {
        name: 'GitHub 多账号管家',
        version: require('../../package.json').version,
        env: config.env,
        host: config.host,
        port: config.port,
        node: process.version,
        uptimeSec: Math.round(process.uptime()),
        platform: `${os.type()} ${os.release()}`,
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      database: database
        ? { status: 'connected', ...database }
        : { status: 'error', error: databaseError },
    });
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

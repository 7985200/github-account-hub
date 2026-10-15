'use strict';

/**
 * 操作日志接口
 * GET /api/logs?page=&pageSize=&accountId=&level=&action=
 */
const express = require('express');
const service = require('../services/account.service');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get(
  '/',
  wrap(async (req, res) => {
    const result = await service.listLogs({
      page: req.query.page,
      pageSize: req.query.pageSize,
      accountId: req.query.accountId,
      level: req.query.level,
      action: req.query.action,
    });
    res.json({ ok: true, ...result });
  })
);

module.exports = router;

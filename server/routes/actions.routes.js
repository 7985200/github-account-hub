'use strict';

/**
 * 批量动作接口
 * GET  /api/actions/repo-info?repo=owner/name     查询目标仓库信息
 * GET  /api/actions/user-info?username=octocat    查询目标用户信息
 * POST /api/actions/star                          批量 Star / 取消 Star
 *      body: { accountIds: [1,2], repo: "owner/name", action: "star"|"unstar" }
 * POST /api/actions/follow                        批量关注 / 取消关注
 *      body: { accountIds: [1,2], username: "octocat", action: "follow"|"unfollow" }
 * POST /api/actions/fork                          批量复刻仓库
 *      body: { accountIds: [1,2], repo: "owner/name" }
 */
const express = require('express');
const service = require('../services/account.service');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get(
  '/repo-info',
  wrap(async (req, res) => {
    res.json({ ok: true, repo: await service.getRepoInfo(req.query.repo) });
  })
);

router.get(
  '/user-info',
  wrap(async (req, res) => {
    res.json({ ok: true, user: await service.getTargetUserInfo(req.query.username) });
  })
);

router.post(
  '/star',
  wrap(async (req, res) => {
    const { accountIds, repo, action } = req.body || {};
    res.json({ ok: true, ...(await service.batchStar({ accountIds, repo, action })) });
  })
);

router.post(
  '/follow',
  wrap(async (req, res) => {
    const { accountIds, username, action } = req.body || {};
    res.json({ ok: true, ...(await service.batchFollow({ accountIds, username, action })) });
  })
);

router.post(
  '/fork',
  wrap(async (req, res) => {
    const { accountIds, repo } = req.body || {};
    res.json({ ok: true, ...(await service.batchFork({ accountIds, repo })) });
  })
);

module.exports = router;

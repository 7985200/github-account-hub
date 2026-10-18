'use strict';

/**
 * 账号业务逻辑层
 * 所有数据库读写、加密解密、GitHub 校验都收敛在这里，路由层只做参数搬运。
 */
const { query, withTransaction } = require('../db/pool');
const github = require('./github.service');
const githubLogin = require('./github-login.service');
const githubWeb = require('./github-web.service');
const { encrypt, decrypt, maskSecret, tokenKind } = require('../utils/crypto');
const { maskProxy } = require('./proxy.service');
const logger = require('../utils/logger');

class ApiError extends Error {
  constructor(status, message, code = '') {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

const PASSWORD_AUTH_DISABLED_MSG =
  'GitHub 已于 2021-08 停用「账号密码」直接认证 API / Git 操作。该账号已加密保存为本地凭据，' +
  '如需仓库列表、克隆地址、配额等在线能力，请为该账号补充 Personal Access Token。';

// 工具

function safeParse(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 数据库行 -> 对外安全结构（绝不带出密文） */
function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    login: row.login,
    email: row.email,
    note: row.note,
    tokenKind: row.token_kind,
    tokenHint: row.token_hint,
    hasToken: !!row.token_enc,
    hasPassword: !!row.password_enc,
    scopes: safeParse(row.scopes, []),
    profile: safeParse(row.profile, null),
    rateLimit: safeParse(row.rate_limit, null),
    status: row.status,
    statusMessage: row.status_message,
    lastVerifiedAt: row.last_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findRow(id) {
  const rows = await query('SELECT * FROM accounts WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function writeLog(action, detail, { accountId = null, level = 'info' } = {}, conn = null) {
  const sql = 'INSERT INTO activity_logs (account_id, action, level, detail) VALUES (?, ?, ?, ?)';
  const params = [accountId, action, level, String(detail || '').slice(0, 800)];
  if (conn) await conn.execute(sql, params);
  else await query(sql, params);
}

// 查询

async function list({ q = '', status = '', sort = 'recent' } = {}) {
  const where = [];
  const params = [];
  if (q) {
    where.push('(login LIKE ? OR note LIKE ? OR email LIKE ?)');
    const like = `%${String(q).trim()}%`;
    params.push(like, like, like);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const orderMap = {
    recent: 'created_at DESC, id DESC',
    oldest: 'created_at ASC, id ASC',
    login: 'login ASC',
    verified: 'last_verified_at DESC',
  };
  const sql = `SELECT * FROM accounts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${
    orderMap[sort] || orderMap.recent
  }`;
  const rows = await query(sql, params);
  return rows.map(toPublic);
}

async function getById(id) {
  const row = await findRow(id);
  if (!row) throw new ApiError(404, '账号不存在或已被删除');
  return toPublic(row);
}

async function getStats() {
  const [agg] = await query(
    `SELECT
       COUNT(*)                                                        AS total,
       COALESCE(SUM(status = 'active'), 0)                             AS active,
       COALESCE(SUM(status IN ('invalid', 'error')), 0)                AS abnormal,
       COALESCE(SUM(status = 'password-only'), 0)                      AS passwordOnly,
       COALESCE(SUM(status = 'unverified'), 0)                         AS unverified,
       COALESCE(SUM(CAST(profile ->> '$.publicRepos' AS SIGNED)), 0)   AS publicRepos,
       COALESCE(SUM(CAST(profile ->> '$.starred'     AS SIGNED)), 0)   AS starred,
       COALESCE(SUM(CAST(profile ->> '$.followers'   AS SIGNED)), 0)   AS followers,
       COALESCE(SUM(JSON_LENGTH(scopes)), 0)                           AS grantedScopes
     FROM accounts`
  );
  const [logAgg] = await query(
    `SELECT COUNT(*) AS totalLogs,
            COALESCE(SUM(level = 'warn'), 0)  AS warnLogs,
            COALESCE(SUM(level = 'error'), 0) AS errorLogs
       FROM activity_logs`
  );
  const actionTop = await query(
    `SELECT action, COUNT(*) AS count FROM activity_logs GROUP BY action ORDER BY count DESC, action ASC LIMIT 5`
  );

  /* 近 7 天操作趋势（缺失日期补零） */
  const trendRows = await query(
    `SELECT DATE(created_at) AS day, COUNT(*) AS count
       FROM activity_logs
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
      GROUP BY DATE(created_at)
      ORDER BY day ASC`
  );
  const trendMap = new Map(trendRows.map((r) => [String(r.day).slice(0, 10), Number(r.count)]));
  const trend = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    trend.push({ day: key, count: trendMap.get(key) || 0 });
  }

  /* API 配额汇总（仅统计有配额快照的账号） */
  const [quotaAgg] = await query(
    `SELECT COUNT(*) AS accountsWithQuota,
            COALESCE(SUM(CAST(rate_limit ->> '$.remaining' AS SIGNED)), 0) AS remaining,
            COALESCE(SUM(CAST(rate_limit ->> '$.limit'     AS SIGNED)), 0) AS total
       FROM accounts
      WHERE rate_limit IS NOT NULL`
  );

  /* Top 账号（按点 Star 数，用于对比条形图） */
  const topAccounts = (
    await query(
      `SELECT login,
              COALESCE(CAST(profile ->> '$.starred'     AS SIGNED), 0) AS starred,
              COALESCE(CAST(profile ->> '$.publicRepos' AS SIGNED), 0) AS repos,
              COALESCE(CAST(profile ->> '$.followers'   AS SIGNED), 0) AS followers
         FROM accounts
        WHERE profile IS NOT NULL
        ORDER BY starred DESC, repos DESC
        LIMIT 6`
    )
  ).map((r) => ({
    login: r.login || '(未命名)',
    starred: Number(r.starred),
    repos: Number(r.repos),
    followers: Number(r.followers),
  }));
  return {
    accounts: {
      total: Number(agg.total),
      active: Number(agg.active),
      abnormal: Number(agg.abnormal),
      passwordOnly: Number(agg.passwordOnly),
      unverified: Number(agg.unverified),
      publicRepos: Number(agg.publicRepos),
      starred: Number(agg.starred),
      followers: Number(agg.followers),
      grantedScopes: Number(agg.grantedScopes),
    },
    logs: {
      total: Number(logAgg.totalLogs),
      warn: Number(logAgg.warnLogs),
      error: Number(logAgg.errorLogs),
      topActions: actionTop.map((r) => ({ action: r.action, count: Number(r.count) })),
    },
    quota: {
      accountsWithQuota: Number(quotaAgg.accountsWithQuota),
      remaining: Number(quotaAgg.remaining),
      total: Number(quotaAgg.total),
    },
    trend,
    topAccounts,
  };
}

// 写入

async function create(payload = {}) {
  const mode = payload.mode === 'password' ? 'password' : 'token';
  let token = '';
  let password = '';

  if (mode === 'token') {
    token = String(payload.token || '').trim();
    if (!token) throw new ApiError(400, '请填写 Personal Access Token');
  } else {
    password = String(payload.password || '');
    if (!String(payload.login || '').trim()) throw new ApiError(400, '请填写 GitHub 账号或邮箱');
    if (!password) throw new ApiError(400, '请填写密码');
    if (payload.token) token = String(payload.token).trim();
  }

  const record = {
    mode,
    login: String(payload.login || '').trim().slice(0, 120),
    email: String(payload.email || '').trim().slice(0, 190),
    note: String(payload.note || '').trim().slice(0, 190),
    token_enc: token ? encrypt(token) : null,
    password_enc: password ? encrypt(password) : null,
    token_kind: token ? tokenKind(token) : '',
    token_hint: token ? maskSecret(token) : '',
  };
  /* 「账号密码」方式补充了 Token 即升级为 Token 模式，避免状态已验证而徽章仍是「密码」 */
  if (token) record.mode = 'token';

  const id = await withTransaction(async (conn) => {
    const [result] = await conn.execute(
      `INSERT INTO accounts (mode, login, email, note, token_enc, password_enc, token_kind, token_hint, status, status_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unverified', '')`,
      [record.mode, record.login, record.email, record.note, record.token_enc, record.password_enc, record.token_kind, record.token_hint]
    );
    await writeLog(
      'account.create',
      `新增账号${record.login ? ` ${record.login}` : ''}（${
        record.mode === 'token' ? `Token · ${record.token_kind || 'unknown'}` : '账号密码'
      }）`,
      { accountId: result.insertId },
      conn
    );
    return result.insertId;
  });

  const account = await refresh(id);
  logger.info(`账号已创建 #${id}`, { login: account.login, mode, status: account.status });
  return account;
}

async function update(id, patch = {}) {
  const row = await findRow(id);
  if (!row) throw new ApiError(404, '账号不存在或已被删除');

  const sets = [];
  const params = [];
  const touched = [];

  if (patch.note !== undefined) {
    sets.push('note = ?');
    params.push(String(patch.note).trim().slice(0, 190));
    touched.push('备注');
  }
  if (patch.email !== undefined) {
    sets.push('email = ?');
    params.push(String(patch.email).trim().slice(0, 190));
    touched.push('邮箱');
  }
  if (patch.login !== undefined && String(patch.login).trim()) {
    sets.push('login = ?');
    params.push(String(patch.login).trim().slice(0, 120));
    touched.push('登录名');
  }
  if (patch.token !== undefined && String(patch.token).trim()) {
    const token = String(patch.token).trim();
    sets.push('token_enc = ?', 'token_kind = ?', 'token_hint = ?', 'mode = ?');
    params.push(encrypt(token), tokenKind(token), maskSecret(token), 'token');
    touched.push('Token');
  }
  if (patch.password !== undefined && String(patch.password)) {
    sets.push('password_enc = ?');
    params.push(encrypt(String(patch.password)));
    touched.push('密码');
  }

  if (!sets.length) throw new ApiError(400, '没有需要更新的字段');

  params.push(id);
  await query(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, params);
  await writeLog('account.update', `更新账号 ${row.login || `#${id}`}：${touched.join('、')}`, {
    accountId: id,
  });

  if (patch.token !== undefined || patch.password !== undefined) return refresh(id);
  return getById(id);
}

async function remove(id) {
  const row = await findRow(id);
  if (!row) throw new ApiError(404, '账号不存在或已被删除');
  await withTransaction(async (conn) => {
    await writeLog('account.delete', `删除账号 ${row.login || `#${id}`}（${row.mode === 'token' ? 'Token' : '账号密码'}）`, {
      accountId: id,
    }, conn);
    await conn.execute('DELETE FROM accounts WHERE id = ?', [id]);
  });
  logger.info(`账号已删除 #${id}`, { login: row.login });
  return { id: Number(id), login: row.login };
}

// 验证

async function refresh(id) {
  const row = await findRow(id);
  if (!row) throw new ApiError(404, '账号不存在或已被删除');

  const token = row.token_enc ? decrypt(row.token_enc) : null;
  const password = row.password_enc ? decrypt(row.password_enc) : null;

  const patch = {};
  let logAction = 'account.verify';
  let logLevel = 'info';
  let logDetail = '';

  if (token) {
    const res = await github.fetchUser({ token });
    if (res.ok && res.data && res.data.login) {
      const profile = github.normalizeProfile(res.data);
      const scopes = github.parseScopes(res.headers);
      /* 附带查询「点 Star 总数」（用于统计看板；失败不影响验证结果） */
      const starred = await github.fetchStarredCount({ token });
      if (starred !== null) profile.starred = starred;
      patch.login = profile.login;
      patch.profile = JSON.stringify(profile);
      patch.scopes = JSON.stringify(scopes);
      patch.rate_limit = JSON.stringify(github.parseRateLimit(res.headers));
      patch.status = 'active';
      patch.status_message = 'Token 验证通过';
      if (!row.email && res.data.email) patch.email = res.data.email;
      logDetail = `Token 验证通过：${profile.login}（权限 ${scopes.length} 项，仓库 ${profile.publicRepos}${
        starred !== null ? `，Star ${starred}` : ''
      }）`;
    } else {
      patch.status = res.transport ? 'error' : 'invalid';
      patch.status_message = res.transport ? res.message : `Token 无效或已过期：${res.message}`;
      logLevel = 'warn';
      logDetail = `Token 验证失败：${patch.status_message}`;
    }
  } else if (password) {
    const res = await github.fetchUser({ basic: { login: row.login, password } });
    if (res.ok && res.data && res.data.login) {
      // 少数企业端点仍可能放行，能通就当作有效
      const profile = github.normalizeProfile(res.data);
      patch.login = profile.login;
      patch.profile = JSON.stringify(profile);
      patch.scopes = JSON.stringify(github.parseScopes(res.headers));
      patch.rate_limit = JSON.stringify(github.parseRateLimit(res.headers));
      patch.status = 'active';
      patch.status_message = '基础认证可用，建议改用 Token';
      logDetail = `基础认证通过：${profile.login}`;
    } else {
      patch.status = res.transport ? 'error' : 'password-only';
      patch.status_message = res.transport ? res.message : PASSWORD_AUTH_DISABLED_MSG;
      logLevel = res.transport ? 'warn' : 'info';
      logDetail = '密码凭据已保存；GitHub 现已停用密码直连认证';
    }
  } else {
    patch.status = 'unverified';
    patch.status_message = '缺少可用凭据';
    logLevel = 'warn';
    logDetail = '账号缺少凭据，无法验证';
  }

  const sets = Object.keys(patch).map((k) => `${k} = ?`).concat('last_verified_at = NOW()');
  const params = Object.values(patch);
  params.push(id);
  await query(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, params);
  await writeLog(logAction, logDetail, { accountId: id, level: logLevel });

  return getById(id);
}

// 凭据读取

async function revealSecret(id, field) {
  const row = await findRow(id);
  if (!row) throw new ApiError(404, '账号不存在或已被删除');
  if (field === 'password') {
    if (!row.password_enc) throw new ApiError(404, '该账号没有保存密码');
    await writeLog('secret.reveal', '查看密码明文', { accountId: id, level: 'warn' });
    return { field: 'password', value: decrypt(row.password_enc) || '' };
  }
  if (!row.token_enc) throw new ApiError(404, '该账号还没有 Token');
  await writeLog('secret.reveal', '查看 Token 明文', { accountId: id, level: 'warn' });
  return { field: 'token', value: decrypt(row.token_enc) || '' };
}

// 仓库 / 克隆地址

async function listRepos(id, { page = 1, perPage = 100 } = {}) {
  const row = await findRow(id);
  if (!row) throw new ApiError(404, '账号不存在或已被删除');
  const token = row.token_enc ? decrypt(row.token_enc) : null;
  if (!token) throw new ApiError(400, '该账号没有 Token，无法拉取仓库列表');

  const effectivePerPage = clampInt(perPage, 1, 100, 100);
  const res = await github.fetchRepos({
    token,
    page: clampInt(page, 1, 50, 1),
    perPage: effectivePerPage,
  });
  if (!res.ok) throw new ApiError(res.transport ? 502 : 400, `拉取仓库失败：${res.message}`);

  const repos = Array.isArray(res.data) ? res.data.map(github.normalizeRepo) : [];
  /* Link 头 rel="last" 的页号换算真实总数；不足一页时就是当前条数 */
  const link = res.headers && typeof res.headers.get === 'function' ? String(res.headers.get('link') || '') : '';
  const lastPage = (link.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/) || [])[1];
  /* Link 头只有页号、没有末页条数：当前不在末页时额外取一次末页，
     否则 (lastPage-1)*perPage 会把不满页的末页当成满页多算。 */
  let total = repos.length;
  if (lastPage) {
    const last = Number(lastPage);
    const onLastPage = !/[?&]page=\d+[^>]*>;\s*rel="next"/.test(link);
    if (onLastPage) {
      total = (last - 1) * effectivePerPage + repos.length;
    } else {
      const tail = await github.fetchRepos({ token, page: last, perPage: effectivePerPage });
      const tailCount = tail.ok && Array.isArray(tail.data) ? tail.data.length : effectivePerPage;
      total = (last - 1) * effectivePerPage + tailCount;
    }
  }
  await writeLog('repos.fetch', `拉取仓库列表：${repos.length} 个`, { accountId: id });
  return { total, repos, rateLimit: github.parseRateLimit(res.headers) };
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function buildRemote(id, repo) {
  const row = await findRow(id);
  if (!row) throw new ApiError(404, '账号不存在或已被删除');
  if (!REPO_PATTERN.test(String(repo || ''))) throw new ApiError(400, '仓库格式应为 owner/repo');
  const token = row.token_enc ? decrypt(row.token_enc) : null;
  if (!token) throw new ApiError(400, '该账号没有 Token，无法生成带凭据的克隆地址');

  const login = row.login || 'git';
  const auth = `https://${encodeURIComponent(login)}:${encodeURIComponent(token)}@github.com/${repo}.git`;
  return {
    repo,
    login,
    plain: `https://github.com/${repo}.git`,
    ssh: `git@github.com:${repo}.git`,
    authed: auth,
    cloneCommand: `git clone ${auth}`,
    setUrlCommand: `git remote set-url origin ${auth}`,
    masked: `https://${login}:${'•'.repeat(12)}@github.com/${repo}.git`,
  };
}

// 批量 Star

const STAR_DELAY_MS = 400; // 账号之间的执行间隔，降低触发 GitHub 风控的概率
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 解析仓库输入：支持 owner/repo、完整链接、SSH 地址 */
function parseRepoInput(input) {
  let s = String(input || '').trim();
  s = s
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .trim();
  if (!REPO_PATTERN.test(s)) {
    throw new ApiError(400, '仓库格式应为 owner/repo，或直接粘贴 GitHub 仓库链接');
  }
  return s;
}

/** 用第一个可用 Token 的账号查询目标仓库信息 */
async function getRepoInfo(repoInput) {
  const repo = parseRepoInput(repoInput);
  const rows = await query('SELECT * FROM accounts WHERE token_enc IS NOT NULL ORDER BY id ASC');
  if (!rows.length) throw new ApiError(400, '还没有带 Token 的账号，无法查询仓库信息');

  let lastError = '';
  let sawNotFound = false;
  for (const row of rows) {
    const token = decrypt(row.token_enc);
    if (!token) continue;
    const res = await github.fetchRepo({ token, repo });
    if (res.ok && res.data) {
      const d = res.data;
      return {
        fullName: d.full_name,
        description: d.description || '',
        private: !!d.private,
        stars: d.stargazers_count || 0,
        forks: d.forks_count || 0,
        openIssues: d.open_issues_count || 0,
        language: d.language || '',
        htmlUrl: d.html_url || '',
        owner: d.owner ? { login: d.owner.login, avatarUrl: d.owner.avatar_url || '' } : null,
        queriedBy: row.login || null,
      };
    }
    /* 404 只说明「这个账号无权访问」：私有仓库可能对后续账号可见，继续尝试 */
    if (res.status === 404) {
      sawNotFound = true;
      lastError = `仓库不存在或无权访问：${repo}`;
      continue;
    }
    lastError = res.message;
  }
  if (sawNotFound) throw new ApiError(404, `仓库不存在或无权访问：${repo}（已尝试全部 ${rows.length} 个账号）`);
  throw new ApiError(502, `查询仓库失败：${lastError || '未知错误'}`);
}

/**
 * 批量 Star / 取消 Star
 * 串行执行（每账号间隔 STAR_DELAY_MS），预检区分「本次新增」与「之前已操作」
 */
async function batchStar({ accountIds, repo: repoInput, action = 'star' } = {}) {
  const repo = parseRepoInput(repoInput);
  if (action !== 'star' && action !== 'unstar') throw new ApiError(400, '不支持的操作类型');

  const ids = Array.from(
    new Set(
      (Array.isArray(accountIds) ? accountIds : [])
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0)
    )
  );
  if (!ids.length) throw new ApiError(400, '请至少选择一个账号');

  const rows = [];
  for (const id of ids) {
    const row = await findRow(id);
    if (row) rows.push(row);
  }
  if (!rows.length) throw new ApiError(404, '所选账号均不存在');

  const results = [];
  for (const row of rows) {
    const base = { accountId: Number(row.id), login: row.login || `#${row.id}` };
    const token = row.token_enc ? decrypt(row.token_enc) : null;

    if (!token) {
      results.push({ ...base, status: 'skipped', message: '该账号没有 Token，已跳过' });
      continue;
    }

    // 预检：区分「本次新增」与「之前已操作」，同时尽早暴露 Token 问题
    const check = await github.checkStarred({ token, repo });
    if (check.transport) {
      results.push({ ...base, status: 'failed', message: check.message });
      await sleep(STAR_DELAY_MS);
      continue;
    }
    if (check.status === 401) {
      results.push({ ...base, status: 'failed', message: 'Token 无效或已过期' });
      await sleep(STAR_DELAY_MS);
      continue;
    }
    if (action === 'star' && check.status === 204) {
      results.push({ ...base, status: 'already', message: '之前已 Star' });
      await sleep(STAR_DELAY_MS);
      continue;
    }
    if (action === 'unstar' && check.status === 404) {
      results.push({ ...base, status: 'already', message: '未 Star，无需取消' });
      await sleep(STAR_DELAY_MS);
      continue;
    }

    const res =
      action === 'star'
        ? await github.starRepo({ token, repo })
        : await github.unstarRepo({ token, repo });

    if (res.ok) {
      results.push({
        ...base,
        status: action === 'star' ? 'starred' : 'unstarred',
        message: action === 'star' ? 'Star 成功' : '已取消 Star',
      });
    } else {
      results.push({ ...base, status: 'failed', message: res.message || `执行失败（HTTP ${res.status}）` });
    }
    await sleep(STAR_DELAY_MS);
  }

  const summary = {
    total: results.length,
    success: results.filter((r) => r.status === 'starred' || r.status === 'unstarred').length,
    already: results.filter((r) => r.status === 'already').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
  };

  await writeLog(
    action === 'star' ? 'star.batch' : 'unstar.batch',
    `批量${action === 'star' ? ' Star ' : '取消 Star '}${repo}：成功 ${summary.success}、已存在 ${summary.already}、跳过 ${summary.skipped}、失败 ${summary.failed}`,
    { level: summary.failed ? 'warn' : 'info' }
  );

  return { repo, action, summary, results };
}

// 批量关注

const USERNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** 解析用户名输入：支持 用户名、@用户名、GitHub 主页链接 */
function parseUsernameInput(input) {
  let s = String(input || '').trim();
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/^@/, '');
  s = s.split(/[/?#]/)[0].trim();
  if (!USERNAME_PATTERN.test(s)) {
    throw new ApiError(400, '用户名格式不正确（支持 用户名、@用户名 或 GitHub 主页链接）');
  }
  return s;
}

/** 用第一个可用 Token 的账号查询目标用户资料 */
async function getTargetUserInfo(input) {
  const username = parseUsernameInput(input);
  const rows = await query('SELECT * FROM accounts WHERE token_enc IS NOT NULL ORDER BY id ASC');
  if (!rows.length) throw new ApiError(400, '还没有带 Token 的账号，无法查询用户信息');

  let lastError = '';
  let sawNotFound = false;
  for (const row of rows) {
    const token = decrypt(row.token_enc);
    if (!token) continue;
    const res = await github.fetchUserProfile({ token, username });
    if (res.ok && res.data) {
      const d = res.data;
      return {
        login: d.login,
        name: d.name || '',
        avatarUrl: d.avatar_url || '',
        htmlUrl: d.html_url || '',
        bio: d.bio || '',
        company: d.company || '',
        location: d.location || '',
        publicRepos: d.public_repos || 0,
        followers: d.followers || 0,
        following: d.following || 0,
        createdAt: d.created_at || '',
        queriedBy: row.login || null,
      };
    }
    if (res.status === 404) {
      sawNotFound = true;
      lastError = `用户不存在：${username}`;
      continue;
    }
    lastError = res.message;
  }
  if (sawNotFound) throw new ApiError(404, lastError || `用户不存在：${username}`);
  throw new ApiError(502, `查询用户失败：${lastError || '未知错误'}`);
}

/**
 * 批量关注 / 取消关注
 * 串行执行（每账号间隔 STAR_DELAY_MS），预检区分「本次新增」与「之前已关注」
 */
async function batchFollow({ accountIds, username: usernameInput, action = 'follow' } = {}) {
  const username = parseUsernameInput(usernameInput);
  if (action !== 'follow' && action !== 'unfollow') throw new ApiError(400, '不支持的操作类型');

  const ids = Array.from(
    new Set(
      (Array.isArray(accountIds) ? accountIds : [])
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0)
    )
  );
  if (!ids.length) throw new ApiError(400, '请至少选择一个账号');

  const rows = [];
  for (const id of ids) {
    const row = await findRow(id);
    if (row) rows.push(row);
  }
  if (!rows.length) throw new ApiError(404, '所选账号均不存在');

  const results = [];
  for (const row of rows) {
    const base = { accountId: Number(row.id), login: row.login || `#${row.id}` };
    const token = row.token_enc ? decrypt(row.token_enc) : null;

    if (!token) {
      results.push({ ...base, status: 'skipped', message: '该账号没有 Token，已跳过' });
      continue;
    }

    const check = await github.checkFollowing({ token, username });
    if (check.transport) {
      results.push({ ...base, status: 'failed', message: check.message });
      await sleep(STAR_DELAY_MS);
      continue;
    }
    if (check.status === 401) {
      results.push({ ...base, status: 'failed', message: 'Token 无效或已过期' });
      await sleep(STAR_DELAY_MS);
      continue;
    }
    if (action === 'follow' && check.status === 204) {
      results.push({ ...base, status: 'already', message: '之前已关注' });
      await sleep(STAR_DELAY_MS);
      continue;
    }
    if (action === 'unfollow' && check.status === 404) {
      results.push({ ...base, status: 'already', message: '未关注，无需取消' });
      await sleep(STAR_DELAY_MS);
      continue;
    }

    const res =
      action === 'follow'
        ? await github.followUser({ token, username })
        : await github.unfollowUser({ token, username });

    if (res.ok) {
      results.push({
        ...base,
        status: action === 'follow' ? 'followed' : 'unfollowed',
        message: action === 'follow' ? '关注成功' : '已取消关注',
      });
    } else {
      results.push({ ...base, status: 'failed', message: res.message || `执行失败（HTTP ${res.status}）` });
    }
    await sleep(STAR_DELAY_MS);
  }

  const summary = {
    total: results.length,
    success: results.filter((r) => r.status === 'followed' || r.status === 'unfollowed').length,
    already: results.filter((r) => r.status === 'already').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
  };

  await writeLog(
    action === 'follow' ? 'follow.batch' : 'unfollow.batch',
    `批量${action === 'follow' ? '关注' : '取消关注'} @${username}：成功 ${summary.success}、已存在 ${summary.already}、跳过 ${summary.skipped}、失败 ${summary.failed}`,
    { level: summary.failed ? 'warn' : 'info' }
  );

  return { username, action, summary, results };
}

/**
 * 通过「网页登录」自动获取 Token 并入库：
 *   账号 + 密码 → 模拟登录 GitHub → 自动创建全权限（51 项）永不过期 Token → 保存
 *
 * 安全约定：
 *   - 密码仅用于换取 Token，本地不落库、不写日志（用完即弃）
 *   - 拿到的 Token 与手动添加一样，经 AES-256-GCM 加密存储
 */
async function createWithAutoToken(payload = {}) {
  const login = String(payload.login || '').trim();
  const password = String(payload.password || '');
  if (!login) throw new ApiError(400, '请填写 GitHub 账号或邮箱');
  if (!password) throw new ApiError(400, '请填写密码');

  let result;
  try {
    result = await githubLogin.loginAndCreateToken({
      login,
      password,
      description: String(payload.tokenNote || 'ghhub-auto').trim().slice(0, 190) || 'ghhub-auto',
    });
  } catch (err) {
    if (err instanceof githubLogin.WebLoginError) {
      await writeLog('account.auto-token', `自动获取 Token 失败：${err.message}`, {
        level: 'warn',
      });
      throw new ApiError(err.httpStatus || 502, err.message, err.code);
    }
    logger.error('自动获取 Token 异常', { login, error: err.message });
    throw new ApiError(502, `自动获取 Token 失败：${err.message}`);
  }

  // 需要额外验证（邮箱验证码 / 两步验证）→ 交由前端继续交互，不作为错误
  if (result && result.needsVerify) {
    await writeLog(
      'account.auto-token',
      `自动获取 Token 需要额外验证（${result.verifyType}），已建立验证会话`,
      { level: 'info' }
    );
    return {
      needsVerify: true,
      verifyId: result.verifyId,
      verifyType: result.verifyType,
      hint: result.hint,
      codeLength: result.codeLength || 0,
      expiresInSec: result.expiresInSec,
    };
  }

  // 用拿到的 Token 走标准创建流程（refresh 会真实调用 GitHub API 二次验证）
  const account = await create({
    mode: 'token',
    token: result.token,
    login,
    note: payload.note,
    email: payload.email,
  });

  await writeLog(
    'account.auto-token',
    `通过网页登录自动创建全权限 Token（权限 ${result.scopes.length} 项、永不过期，耗时 ${(result.durationMs / 1000).toFixed(1)}s）`,
    { accountId: account.id }
  );
  return {
    account,
    meta: { scopes: result.scopes.length, channel: maskProxy(result.channel), durationMs: result.durationMs, note: result.note },
  };
}

// 自动获取 Token：验证码续接

/**
 * 提交验证码（邮箱验证码 / 两步验证码），继续完成「密码换 Token」
 * @returns {{account:object, meta:object}}
 */
async function verifyAutoToken({ verifyId, code, note, email } = {}) {
  let result;
  try {
    result = await githubLogin.submitVerificationCode({ verifyId, code });
  } catch (err) {
    if (err instanceof githubLogin.WebLoginError) {
      await writeLog('account.auto-token', `验证码验证未通过：${err.message}`, { level: 'warn' });
      throw new ApiError(err.httpStatus || 502, err.message, err.code);
    }
    logger.error('验证码验证异常', { error: err.message });
    throw new ApiError(502, `验证失败：${err.message}`);
  }

  const account = await create({
    mode: 'token',
    token: result.token,
    login: result.login,
    note,
    email,
  });
  await writeLog(
    'account.auto-token',
    `验证码通过后自动创建全权限 Token（权限 ${result.scopes.length} 项、永不过期，耗时 ${(result.durationMs / 1000).toFixed(1)}s）`,
    { accountId: account.id }
  );
  return {
    account,
    meta: { scopes: result.scopes.length, channel: maskProxy(result.channel), durationMs: result.durationMs, note: result.note },
  };
}

/** 重新发送验证码 */
async function resendAutoToken({ verifyId } = {}) {
  try {
    return await githubLogin.resendVerificationCode({ verifyId });
  } catch (err) {
    if (err instanceof githubLogin.WebLoginError) {
      throw new ApiError(err.httpStatus || 502, err.message, err.code);
    }
    throw new ApiError(502, `重发失败：${err.message}`);
  }
}

// 批量复刻（Fork）

const FORK_DELAY_MS = 800; // 复刻请求较重，账号间隔放宽
const FORK_NEW_WINDOW_MS = 90 * 1000; // 响应中 created_at 在此窗口内视为「本次新建」

/**
 * 批量复刻仓库（fork 到各账号名下）
 * 判别「本次新建 / 之前已复刻」：fork 前先查该账号名下是否已有同名 fork（精确预检），
 * 并以响应中 fork 的 created_at 时间窗兜底（覆盖「fork 时改过名」的边缘情况）。
 */
async function batchFork({ accountIds, repo: repoInput } = {}) {
  const repo = parseRepoInput(repoInput);
  const repoName = repo.split('/')[1];

  const ids = Array.from(
    new Set(
      (Array.isArray(accountIds) ? accountIds : [])
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0)
    )
  );
  if (!ids.length) throw new ApiError(400, '请至少选择一个账号');

  const rows = [];
  for (const id of ids) {
    const row = await findRow(id);
    if (row) rows.push(row);
  }
  if (!rows.length) throw new ApiError(404, '所选账号均不存在');

  const results = [];
  for (const row of rows) {
    const base = { accountId: Number(row.id), login: row.login || `#${row.id}` };
    const token = row.token_enc ? decrypt(row.token_enc) : null;

    if (!token) {
      results.push({ ...base, status: 'skipped', message: '该账号没有 Token，已跳过' });
      continue;
    }

    // 精确预检：该账号名下是否已存在同名 fork（fork 默认与源仓库同名）
    if (row.login) {
      const check = await github.fetchRepo({ token, repo: `${row.login}/${repoName}` });
      if (check.status === 401) {
        results.push({ ...base, status: 'failed', message: 'Token 无效或已过期' });
        await sleep(FORK_DELAY_MS);
        continue;
      }
      if (
        check.ok &&
        check.data &&
        check.data.fork &&
        check.data.parent &&
        String(check.data.parent.full_name).toLowerCase() === repo.toLowerCase()
      ) {
        results.push({ ...base, status: 'already', message: '之前已复刻', forkFullName: check.data.full_name });
        await sleep(FORK_DELAY_MS);
        continue;
      }
    }

    const res = await github.forkRepo({ token, repo });
    if (res.ok && res.data && res.data.full_name) {
      // 兜底：预检未命中但返回的 fork 已存在较久（如 fork 时改过名）
      const createdMs = Date.parse(res.data.created_at || '');
      const looksOld = Number.isFinite(createdMs) && Date.now() - createdMs > FORK_NEW_WINDOW_MS;
      results.push({
        ...base,
        status: looksOld ? 'already' : 'forked',
        message: looksOld ? '之前已复刻' : '复刻成功',
        forkFullName: res.data.full_name,
      });
    } else {
      results.push({ ...base, status: 'failed', message: res.message || `执行失败（HTTP ${res.status}）` });
    }
    await sleep(FORK_DELAY_MS);
  }

  const summary = {
    total: results.length,
    success: results.filter((r) => r.status === 'forked').length,
    already: results.filter((r) => r.status === 'already').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
  };

  await writeLog(
    'fork.batch',
    `批量复刻 ${repo}：成功 ${summary.success}、已存在 ${summary.already}、跳过 ${summary.skipped}、失败 ${summary.failed}`,
    { level: summary.failed ? 'warn' : 'info' }
  );

  return { repo, action: 'fork', summary, results };
}

// 日志

async function listLogs({ page = 1, pageSize = 20, accountId = '', level = '', action = '' } = {}) {
  const where = [];
  const params = [];
  if (accountId) {
    where.push('account_id = ?');
    params.push(accountId);
  }
  if (level) {
    where.push('level = ?');
    params.push(level);
  }
  if (action) {
    where.push('action = ?');
    params.push(action);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRow] = await query(`SELECT COUNT(*) AS total FROM activity_logs ${whereSql}`, params);
  const total = Number(countRow.total);

  const size = clampInt(pageSize, 5, 100, 20);
  const current = clampInt(page, 1, 100000, 1);
  const offset = (current - 1) * size;

  const rows = await query(
    `SELECT l.id, l.account_id, l.action, l.level, l.detail, l.created_at,
            a.login AS account_login
       FROM activity_logs l
       LEFT JOIN accounts a ON a.id = l.account_id
       ${whereSql}
       ORDER BY l.id DESC
       LIMIT ${size} OFFSET ${offset}`,
    params
  );

  return {
    total,
    page: current,
    pageSize: size,
    pages: Math.max(1, Math.ceil(total / size)),
    items: rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      accountLogin: r.account_login || '',
      action: r.action,
      level: r.level,
      detail: r.detail,
      createdAt: r.created_at,
    })),
  };
}

// 资料自定义（基本资料 / 状态 / 社交链接 / 邮箱）

const STATUS_MESSAGE_MAX = 80;

/** 取出账号的 Token 明文；没有 Token 时给出可操作的提示 */
async function requireToken(row) {
  if (!row.token_enc) {
    throw new ApiError(
      400,
      '该账号没有 Token，无法读写 GitHub 资料。请先用「密码换 Token」把它升级为全权限账号。',
      'NO_TOKEN'
    );
  }
  return decrypt(row.token_enc);
}

/** 把最新资料写回本地快照，保持列表 / 统计同步 */
async function persistProfile(id, profile, fallbackEmail = '') {
  if (!profile) return;
  await query('UPDATE accounts SET login = ?, email = ?, profile = ? WHERE id = ?', [
    profile.login,
    profile.email || fallbackEmail || '',
    JSON.stringify(profile),
    id,
  ]);
}

/**
 * 聚合「编辑资料」面板需要的全部数据
 * 读取失败的分区只降级为空值并附带 warnings，不整体失败
 */
async function getProfileEditor(id) {
  const row = await findRow(id);
  if (!row) throw new ApiError(404, '账号不存在或已被删除');
  const token = await requireToken(row);

  const [userRes, statusRes, socialRes, emailRes] = await Promise.all([
    github.fetchUser({ token }),
    github.fetchUserStatus({ token }),
    github.listSocialAccounts({ token }),
    github.listEmails({ token }),
  ]);

  if (!userRes.ok || !userRes.data || !userRes.data.login) {
    throw new ApiError(userRes.transport ? 502 : 400, `读取 GitHub 资料失败：${userRes.message}`, 'GITHUB_ERROR');
  }

  const profile = github.normalizeProfile(userRes.data);
  await persistProfile(id, profile, row.email);

  return {
    accountId: Number(id),
    profile,
    status: statusRes.ok ? statusRes.data : null,
    socialAccounts: socialRes.ok ? (socialRes.data || []).map((x) => ({ provider: x.provider, url: x.url })) : [],
    emails: emailRes.ok
      ? (emailRes.data || []).map((x) => ({
          email: x.email,
          primary: !!x.primary,
          verified: !!x.verified,
          visibility: x.visibility || 'private',
        }))
      : [],
    limits: { bioMax: github.BIO_MAX, statusMax: STATUS_MESSAGE_MAX },
    fields: github.EDITABLE_PROFILE_FIELDS,
    warnings: [
      statusRes.ok ? '' : `状态读取失败：${statusRes.message}`,
      socialRes.ok ? '' : `社交链接读取失败：${socialRes.message}`,
      emailRes.ok ? '' : `邮箱读取失败：${emailRes.message}`,
    ].filter(Boolean),
  };
}

/** 保存基本资料（对应 GitHub PATCH /user） */
async function saveProfile(id, patch = {}) {
  const row = await findRow(id);
  if (!row) throw new ApiError(404, '账号不存在或已被删除');
  const token = await requireToken(row);

  const fields = {};
  for (const key of github.EDITABLE_PROFILE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const raw = patch[key];
    if (key === 'hireable') fields[key] = raw === true || raw === 'true' || raw === 1 || raw === '1';
    else if (raw === null || raw === undefined) fields[key] = '';
    else fields[key] = String(raw).trim();
  }
  if (!Object.keys(fields).length) throw new ApiError(400, '没有需要更新的字段', 'EMPTY_PATCH');

  if (typeof fields.bio === 'string' && [...fields.bio].length > github.BIO_MAX) {
    throw new ApiError(400, `简介最多 ${github.BIO_MAX} 个字符（当前 ${[...fields.bio].length} 个）`, 'BIO_TOO_LONG');
  }

  const res = await github.updateUserProfile({ token, fields });
  if (!res.ok) throw new ApiError(res.transport ? 502 : 400, `保存失败：${res.message}`, 'GITHUB_ERROR');

  /* GitHub 的返回值就是权威结果，直接拿它刷新本地快照 */
  const profile = github.normalizeProfile(res.data);
  await persistProfile(id, profile, row.email);
  await writeLog('account.profile', `更新资料：${Object.keys(fields).join('、')}`, { accountId: id });

  return { profile, updated: Object.keys(fields) };
}

/** 设置自定义状态（GraphQL 专属能力，GitHub 没有对应 REST 端点） */
async function saveStatus(id, payload = {}) {
  const row = await findRow(id);
  if (!row) throw new ApiError(404, '账号不存在或已被删除');
  const token = await requireToken(row);

  const emoji = typeof payload.emoji === 'string' ? payload.emoji.trim() : undefined;
  const message = typeof payload.message === 'string' ? payload.message.trim() : undefined;
  if (message && [...message].length > STATUS_MESSAGE_MAX) {
    throw new ApiError(400, `状态文字最多 ${STATUS_MESSAGE_MAX} 个字符`, 'STATUS_TOO_LONG');
  }

  let expiresAt;
  if (Object.prototype.hasOwnProperty.call(payload, 'expiresAt')) {
    if (!payload.expiresAt) {
      expiresAt = null;
    } else {
      const d = new Date(payload.expiresAt);
      if (Number.isNaN(d.getTime())) throw new ApiError(400, '状态过期时间格式不正确', 'BAD_EXPIRES');
      if (d.getTime() <= Date.now()) throw new ApiError(400, '状态过期时间必须晚于当前时间', 'BAD_EXPIRES');
      expiresAt = d.toISOString();
    }
  }

  const res = await github.changeUserStatus({
    token,
    emoji,
    message,
    limitedAvailability:
      Object.prototype.hasOwnProperty.call(payload, 'limitedAvailability') ? !!payload.limitedAvailability : undefined,
    expiresAt,
  });
  if (!res.ok) throw new ApiError(res.transport ? 502 : 400, `设置状态失败：${res.message}`, 'GITHUB_ERROR');

  const detail = res.data
    ? `设置状态：${res.data.emoji || '（无表情）'} ${res.data.message || ''}`.trim()
    : '清除状态';
  await writeLog('account.status', detail, { accountId: id });
  return res.data;
}

/** 清除自定义状态 */
async function clearStatus(id) {
  const row = await findRow(id);
  if (!row) throw new ApiError(404, '账号不存在或已被删除');
  const token = await requireToken(row);

  const res = await github.changeUserStatus({ token, emoji: '', message: '' });
  if (!res.ok) throw new ApiError(res.transport ? 502 : 400, `清除状态失败：${res.message}`, 'GITHUB_ERROR');
  await writeLog('account.status', '清除状态', { accountId: id });
  return null;
}

/**
 * 全量设置社交链接
 * GitHub 只提供「批量新增」与「批量删除」，这里做差集后按需调用，保证幂等
 */
async function saveSocialAccounts(id, urls = []) {
  const row = await findRow(id);
  if (!row) throw new ApiError(404, '账号不存在或已被删除');
  const token = await requireToken(row);

  const want = [];
  for (const raw of Array.isArray(urls) ? urls : []) {
    const u = String(raw || '').trim();
    if (!u) continue;
    if (!/^https?:\/\/\S+$/i.test(u)) throw new ApiError(400, `社交链接必须以 http(s):// 开头：${u}`, 'BAD_URL');
    if (!want.includes(u)) want.push(u);
  }
  if (want.length > 10) throw new ApiError(400, '社交链接最多 10 条', 'TOO_MANY_URLS');

  const curRes = await github.listSocialAccounts({ token });
  if (!curRes.ok) throw new ApiError(curRes.transport ? 502 : 400, `读取现有社交链接失败：${curRes.message}`, 'GITHUB_ERROR');
  const cur = (curRes.data || []).map((x) => x.url);

  const toAdd = want.filter((u) => !cur.includes(u));
  const toDel = cur.filter((u) => !want.includes(u));

  /* 顺序很关键：先加后删。
     反过来的话，一旦「加」失败，旧的链接已经被删掉，用户数据就丢在半更新状态；
     先加则最坏情况只是多出几条待删链接，重试即可收敛。 */
  if (toAdd.length) {
    const r = await github.addSocialAccounts({ token, urls: toAdd });
    if (!r.ok) {
      throw new ApiError(r.transport ? 502 : 400, `添加社交链接失败（已保留原有链接）：${r.message}`, 'GITHUB_ERROR');
    }
  }
  if (toDel.length) {
    const r = await github.deleteSocialAccounts({ token, urls: toDel });
    if (!r.ok) {
      throw new ApiError(
        r.transport ? 502 : 400,
        `新增已生效，但移除旧链接失败：${r.message}（可重试）`,
        'PARTIAL_FAILED'
      );
    }
  }

  await writeLog('account.social', `社交链接更新：新增 ${toAdd.length} 条、移除 ${toDel.length} 条`, { accountId: id });

  const after = await github.listSocialAccounts({ token });
  return {
    socialAccounts: after.ok ? (after.data || []).map((x) => ({ provider: x.provider, url: x.url })) : [],
    added: toAdd,
    removed: toDel,
  };
}

/** 设置主邮箱在个人主页的可见性（public / private） */
async function setEmailVisibility(id, visibility) {
  const row = await findRow(id);
  if (!row) throw new ApiError(404, '账号不存在或已被删除');
  const token = await requireToken(row);

  const v = visibility === 'public' ? 'public' : 'private';
  const res = await github.setEmailVisibility({ token, visibility: v });
  /* GitHub 对「值没有变化」会返回 422 Email visibility is unchanged. —— 语义上等同成功 */
  const unchanged = !res.ok && /unchanged/i.test(res.message || '');
  if (!res.ok && !unchanged) {
    throw new ApiError(res.transport ? 502 : 400, `设置邮箱可见性失败：${res.message}`, 'GITHUB_ERROR');
  }
  await writeLog(
    'account.profile',
    `主邮箱可见性设为 ${v === 'public' ? '公开' : '私有'}${unchanged ? '（原本已是）' : ''}`,
    { accountId: id }
  );
  return { visibility: (res.data && res.data.visibility) || v, unchanged };
}

/**
 * 上传头像
 * GitHub 实测没有任何头像 API（/user/avatar 404、GraphQL 无相关 mutation），
 * 只能走网页会话：账密登录 → 解析 /settings/profile 的头像表单 → multipart 提交。
 * 密码仅用于本次登录，不落库、不写日志。
 */
async function uploadAvatar(id, { password, filename, mime, data } = {}) {
  const row = await findRow(id);
  if (!row) throw new ApiError(404, '账号不存在或已被删除');

  const loginName = row.login || row.email;
  if (!loginName) throw new ApiError(400, '该账号缺少登录名，无法建立网页会话', 'NO_LOGIN');

  const base64 = String(data || '').replace(/^data:[^,]+,/, '');
  if (!base64) throw new ApiError(400, '没有收到图片数据', 'BAD_IMAGE');
  /* Buffer.from(..., 'base64') 对非法字符是静默忽略而非抛错，因此不包 try/catch，
     改为靠下面的长度 + 魔术字节校验兜底 */
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) throw new ApiError(400, '图片数据为空或不是合法的 base64', 'BAD_IMAGE');
  if (buf.length > githubWeb.MAX_BYTES) {
    throw new ApiError(400, `图片不能超过 1MB（当前 ${Math.round(buf.length / 1024)}KB）`, 'BAD_IMAGE');
  }
  /* 校验文件头魔术字节：不能只信前端声明的 mime */
  const head4 = buf.subarray(0, 4).toString('latin1');
  const isPng = head4 === '\x89PNG';
  const isJpg = head4.slice(0, 2) === '\xff\xd8';
  const isGif = head4.slice(0, 3) === 'GIF';
  if (!isPng && !isJpg && !isGif) {
    throw new ApiError(400, '图片格式无法识别（仅支持 PNG / JPG / GIF）', 'BAD_IMAGE');
  }
  const realMime = isPng ? 'image/png' : isJpg ? 'image/jpeg' : 'image/gif';
  if (mime && mime !== realMime) {
    throw new ApiError(400, `图片实际格式（${realMime}）与声明的 ${mime} 不一致`, 'BAD_IMAGE');
  }

  /* 密码不再是必填：如果之前登录过并且 Cookie 还有效，直接用保存的会话。
     只有没有可用会话时才会要求输入密码（由 github-web 抛 NEED_PASSWORD / SESSION_EXPIRED）。 */

  /* 先用 API 记下「当前头像地址」，作为是否真的改成功的唯一依据。
     不能用网页里的 img src 判断 —— 那个地址会带邮箱哈希，看起来变了其实图没换。
     内容签名比对共用一个 dispatcher，用完即关（否则每次上传都会泄漏连接池）。 */
  const tokenForCheck = row.token_enc ? decrypt(row.token_enc) : null;
  let checkDispatcher = null;
  let avatarBefore = '';
  if (tokenForCheck) {
    try {
      checkDispatcher = await githubWeb.webDispatcher();
    } catch (err) {
      if (err && err.code === 'PROXY_UNAVAILABLE') {
        throw new ApiError(503, err.message, 'PROXY_UNAVAILABLE');
      }
      throw err;
    }
    try {
      const u0 = await github.fetchUser({ token: tokenForCheck });
      if (u0.ok && u0.data) {
        /* 比较的是图片内容签名，不是 URL —— 换头像后 URL 字符串不变 */
        avatarBefore = await githubWeb.avatarSignature(u0.data.avatar_url, checkDispatcher);
      }
    } catch (err) {
      /* 拿不到上传前签名只影响变更检测，不阻断上传 */
      logger.warn('记录上传前头像签名失败（继续上传）', { accountId: id, error: err.message });
    }
  }

  try {
    let result;
    try {
      /* awaitVerify=true：若 GitHub 要求邮箱/设备验证码，返回 428 + verifyId 让前端输入，
         图片与账号 id 暂存在服务端会话里，等验证通过后继续上传（与「密码换 Token」同一套机制） */
      result = await githubWeb.uploadAvatar({
        login: loginName,
        password,
        buffer: buf,
        mime: realMime,
        filename,
        awaitVerify: true,
        payload: { accountId: Number(id), buffer: buf, mime: realMime, filename },
      });
    } catch (err) {
      throw asApiError(err, 'WEB_UPLOAD_FAILED');
    }

    if (result && result.needsVerify) {
      await writeLog('account.avatar', `上传头像需要额外验证（${result.verifyType || '未知类型'}），已进入验证码流程`, {
        accountId: id,
        level: 'warn',
      });
      return {
        needsVerify: true,
        verifyId: result.verifyId,
        verifyType: result.verifyType,
        hint: result.hint,
        codeLength: result.codeLength || 0,
        expiresInSec: result.expiresInSec,
      };
    }

    /* 用 API 复核：地址没变就说明裁剪确认没生效，不能报成功 */
    if (tokenForCheck && avatarBefore) {
      /* 头像 CDN 有缓存，刚提交完立刻比对会拿到旧图。重试几次再判定，避免假失败。 */
      let avatarAfter = '';
      for (let i = 0; i < 4; i += 1) {
        if (i) await new Promise((resolve) => setTimeout(resolve, 2500));
        const u1 = await github.fetchUser({ token: tokenForCheck });
        avatarAfter = u1.ok && u1.data
          ? await githubWeb.avatarSignature(u1.data.avatar_url, checkDispatcher)
          : '';
        if (avatarAfter && avatarAfter !== avatarBefore) break;
      }
      if (avatarAfter && avatarAfter === avatarBefore) {
        /* 头像内容没变只说明「和上次一样」，不等于失败（重复上传同一张图就是这种情况），
           所以只记日志，不阻断流程。 */
        await writeLog('account.avatar', '头像内容与上传前一致（可能是同一张图）', { accountId: id, level: 'warn' });
        logger.warn('头像内容与上传前一致，按成功处理', { accountId: id });
      }
    }

    return finalizeAvatar(id, row, result);
  } finally {
    if (checkDispatcher && typeof checkDispatcher.close === 'function') {
      checkDispatcher.close().catch(() => {});
    }
  }
}

/** 上传完成后的收尾：回读正式头像地址、落库、写日志 */
async function finalizeAvatar(id, row, result) {
  let avatarUrl = '';
  const token = row.token_enc ? decrypt(row.token_enc) : null;
  if (token) {
    const u = await github.fetchUser({ token });
    if (u.ok && u.data && u.data.login) {
      const profile = github.normalizeProfile(u.data);
      avatarUrl = profile.avatarUrl;
      await persistProfile(id, profile, row.email);
    }
  }
  await writeLog('account.avatar', '更新头像（网页会话通道）', { accountId: id });
  return {
    avatarUrl,
    formAction: result.formAction,
    fileField: result.fileField,
    httpStatus: result.status,
    usedFormAction: result.formAction,
  };
}

/** 把网页通道的异常统一转成带 code 的 ApiError */
function asApiError(err, fallbackCode) {
  if (err && err.name === 'WebLoginError') {
    return new ApiError(err.httpStatus || 502, err.message, err.code || fallbackCode);
  }
  return err;
}

/**
 * 提交头像上传流程中要求的验证码（邮箱验证码 / 两步验证码）
 * 验证通过后会拿到已验证的网页会话，接着把暂存的图片真正传上去。
 */
async function verifyAvatarUpload({ verifyId, code, routeAccountId } = {}) {
  if (!verifyId) throw new ApiError(400, '缺少验证会话标识', 'BAD_REQUEST');
  const codeValue = String(code || '').trim();
  if (!codeValue) throw new ApiError(400, '请输入验证码', 'BAD_REQUEST');

  let out;
  try {
    out = await githubLogin.submitVerificationCode({ verifyId, code: codeValue });
  } catch (err) {
    throw asApiError(err, 'VERIFY_FAILED');
  }

  if (!out || !out.sessionReady || !out.session) {
    throw new ApiError(500, '验证已通过，但未取得网页会话', 'NO_SESSION');
  }

  /* 会话一交接过来就由本函数负责：下面任何提前失败都必须释放 dispatcher */
  try {
    const payload = out.payload || {};
    if (routeAccountId && payload.accountId && Number(routeAccountId) !== Number(payload.accountId)) {
      throw new ApiError(400, '验证会话与当前账号不匹配，请回到发起上传的账号面板继续', 'VERIFY_MISMATCH');
    }
    const id = Number(payload.accountId);
    const row = id ? await findRow(id) : null;
    if (!row) throw new ApiError(404, '账号不存在或已被删除（验证会话可能已过期）', 'VERIFY_EXPIRED');
    if (!payload.buffer || !payload.buffer.length) {
      throw new ApiError(410, '图片数据已失效，请重新选择图片', 'IMAGE_EXPIRED');
    }

    if (out.session.settingsStatus && out.session.settingsStatus !== 200) {
      throw new ApiError(428, `验证通过，但仍无法打开个人资料设置页（HTTP ${out.session.settingsStatus}），请重试`, 'SETTINGS_UNAVAILABLE');
    }
    const result = await githubWeb.uploadAvatarWithSession({
      jar: out.session.jar,
      dispatcher: out.session.dispatcher,
      settingsHtml: out.session.settingsHtml,
      buffer: payload.buffer,
      mime: payload.mime,
      filename: payload.filename,
      login: out.session.login,
    });
    return finalizeAvatar(id, row, result);
  } catch (err) {
    throw asApiError(err, 'WEB_UPLOAD_FAILED');
  } finally {
    /* 会话用完即弃 */
    githubLogin.closeSessionDispatcher(out.session);
  }
}

/** 重新发送验证码（头像上传流程） */
async function resendAvatarCode({ verifyId } = {}) {
  if (!verifyId) throw new ApiError(400, '缺少验证会话标识', 'BAD_REQUEST');
  try {
    return await githubLogin.resendVerificationCode({ verifyId });
  } catch (err) {
    throw asApiError(err, 'RESEND_FAILED');
  }
}

module.exports = {
  ApiError,
  list,
  getById,
  getStats,
  create,
  createWithAutoToken,
  update,
  remove,
  refresh,
  revealSecret,
  listRepos,
  buildRemote,
  parseRepoInput,
  getRepoInfo,
  batchStar,
  parseUsernameInput,
  getTargetUserInfo,
  batchFollow,
  batchFork,
  verifyAutoToken,
  resendAutoToken,
  listLogs,
  /* 资料自定义 */
  getProfileEditor,
  saveProfile,
  saveStatus,
  clearStatus,
  saveSocialAccounts,
  setEmailVisibility,
  uploadAvatar,
  verifyAvatarUpload,
  resendAvatarCode,
};

'use strict';

/**
 * 账号业务逻辑层
 * 所有数据库读写、加密解密、GitHub 校验都收敛在这里，路由层只做参数搬运。
 */
const { query, withTransaction } = require('../db/pool');
const github = require('./github.service');
const githubLogin = require('./github-login.service');
const { encrypt, decrypt, maskSecret, tokenKind } = require('../utils/crypto');
const logger = require('../utils/logger');

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const PASSWORD_AUTH_DISABLED_MSG =
  'GitHub 已于 2021-08 停用「账号密码」直接认证 API / Git 操作。该账号已加密保存为本地凭据，' +
  '如需仓库列表、克隆地址、配额等在线能力，请为该账号补充 Personal Access Token。';

/* ----------------------------- 工具 ----------------------------- */

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

/* ----------------------------- 查询 ----------------------------- */

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
  return {
    accounts: {
      total: Number(agg.total),
      active: Number(agg.active),
      abnormal: Number(agg.abnormal),
      passwordOnly: Number(agg.passwordOnly),
      unverified: Number(agg.unverified),
      publicRepos: Number(agg.publicRepos),
      followers: Number(agg.followers),
      grantedScopes: Number(agg.grantedScopes),
    },
    logs: {
      total: Number(logAgg.totalLogs),
      warn: Number(logAgg.warnLogs),
      error: Number(logAgg.errorLogs),
      topActions: actionTop.map((r) => ({ action: r.action, count: Number(r.count) })),
    },
  };
}

/* ----------------------------- 写入 ----------------------------- */

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

  const id = await withTransaction(async (conn) => {
    const [result] = await conn.execute(
      `INSERT INTO accounts (mode, login, email, note, token_enc, password_enc, token_kind, token_hint, status, status_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unverified', '')`,
      [record.mode, record.login, record.email, record.note, record.token_enc, record.password_enc, record.token_kind, record.token_hint]
    );
    await writeLog(
      'account.create',
      `新增账号${record.login ? ` ${record.login}` : ''}（${
        mode === 'token' ? `Token · ${record.token_kind || 'unknown'}` : '账号密码'
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
    sets.push('token_enc = ?', 'token_kind = ?', 'token_hint = ?');
    params.push(encrypt(token), tokenKind(token), maskSecret(token));
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

/* ----------------------------- 验证 ----------------------------- */

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
      patch.login = profile.login;
      patch.profile = JSON.stringify(profile);
      patch.scopes = JSON.stringify(scopes);
      patch.rate_limit = JSON.stringify(github.parseRateLimit(res.headers));
      patch.status = 'active';
      patch.status_message = 'Token 验证通过';
      if (!row.email && res.data.email) patch.email = res.data.email;
      logDetail = `Token 验证通过：${profile.login}（权限 ${scopes.length} 项，仓库 ${profile.publicRepos}）`;
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

/* ----------------------------- 凭据读取 ----------------------------- */

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

/* ----------------------------- 仓库 / 克隆地址 ----------------------------- */

async function listRepos(id, { page = 1, perPage = 100 } = {}) {
  const row = await findRow(id);
  if (!row) throw new ApiError(404, '账号不存在或已被删除');
  const token = row.token_enc ? decrypt(row.token_enc) : null;
  if (!token) throw new ApiError(400, '该账号没有 Token，无法拉取仓库列表');

  const res = await github.fetchRepos({
    token,
    page: clampInt(page, 1, 50, 1),
    perPage: clampInt(perPage, 1, 100, 100),
  });
  if (!res.ok) throw new ApiError(res.transport ? 502 : 400, `拉取仓库失败：${res.message}`);

  const repos = Array.isArray(res.data) ? res.data.map(github.normalizeRepo) : [];
  await writeLog('repos.fetch', `拉取仓库列表：${repos.length} 个`, { accountId: id });
  return { total: repos.length, repos, rateLimit: github.parseRateLimit(res.headers) };
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

/* ----------------------------- 批量 Star ----------------------------- */

const STAR_DELAY_MS = 400; // 账号之间的执行间隔，降低触发 GitHub 风控的概率
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 解析仓库输入：支持 owner/repo、完整链接、SSH 地址 */
function parseRepoInput(input) {
  let s = String(input || '').trim();
  s = s
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/[/?#]+$/, '')
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
    if (res.status === 404) throw new ApiError(404, `仓库不存在或无权访问：${repo}`);
    lastError = res.message;
  }
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

/* ----------------------------- 批量关注 ----------------------------- */

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
    if (res.status === 404) throw new ApiError(404, `用户不存在：${username}`);
    lastError = res.message;
  }
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
      throw new ApiError(err.httpStatus || 502, err.message);
    }
    logger.error('自动获取 Token 异常', { login, error: err.message });
    throw new ApiError(502, `自动获取 Token 失败：${err.message}`);
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
    meta: { scopes: result.scopes.length, channel: result.channel, durationMs: result.durationMs, note: result.note },
  };
}

/* ----------------------------- 批量复刻（Fork） ----------------------------- */

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

/* ----------------------------- 日志 ----------------------------- */

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
  listLogs,
};

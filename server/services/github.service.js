'use strict';

/**
 * GitHub REST API 封装
 * - 统一 User-Agent / API 版本头
 * - 区分「传输层错误」与「接口层错误」，供上层落库为不同状态
 * - 支持经代理访问（代理设置见「菜单 → 代理设置」，墙内服务器可开启）
 */
const { fetch } = require('undici'); // 必须用 undici 的 fetch：全局 fetch 与本项目 undici 的 ProxyAgent 不兼容（UND_ERR_INVALID_ARG）
const config = require('../config');
const proxy = require('./proxy.service');
const logger = require('../utils/logger');

function buildHeaders({ token, basic } = {}) {
  const headers = {
    'User-Agent': config.github.userAgent,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (basic && basic.login) {
    headers.Authorization = `Basic ${Buffer.from(`${basic.login}:${basic.password}`, 'utf8').toString('base64')}`;
  }
  return headers;
}

function extractMessage(res, data) {
  if (res.ok) return '';
  const base = (data && data.message) || `HTTP ${res.status}`;
  if (data && Array.isArray(data.errors) && data.errors.length) {
    const extra = data.errors
      .map((e) => e.message || e.field || (typeof e === 'string' ? e : JSON.stringify(e)))
      .join('；');
    return `${base}（${extra}）`;
  }
  return base;
}

/**
 * 把 GitHub 的账号级错误翻译成面向用户的中文提示。
 * 原始错误仍由调用方写入服务端日志与操作日志，界面只展示这段可读文案。
 */
const ACCOUNT_ERROR_HINTS = [
  {
    re: /(?:sorry[.!,]?\s*)?\b(?:your\s+|this\s+)?account\s+(?:(?:has\s+been|was|is(?:\s+currently)?)\s+)?(?:suspended|locked)\b/i,
    message: '该账号因违反服务条款、存在安全风险或异常活动，被平台方主动暂停了访问权限，完整错误请看日志',
  },
  {
    re: /(?:sorry[.!,]?\s*)?\b(?:your\s+|this\s+)?account\s+(?:(?:has\s+been|was|is(?:\s+currently)?)\s+)?flagged\b/i,
    message: '该账号被 GitHub 标记为存在风险，访问权限受限，完整错误请看日志',
  },
  {
    re: /(?:sorry[.!,]?\s*)?\b(?:your\s+|this\s+)?account\s+(?:(?:has\s+been|was|is(?:\s+currently)?)\s+)?disabled\b/i,
    message: '该账号已被 GitHub 停用，无法继续访问，完整错误请看日志',
  },
];

/** 命中账号级封禁/暂停类错误时返回中文提示，否则返回空串 */
function explainAccountError(message, status) {
  /* 账号级封禁通常是 401/403；其它状态码不参与判定，避免把限流/仓库权限错误误判 */
  if (status && status !== 401 && status !== 403) return '';
  const text = String(message || '');
  if (!text) return '';
  for (const item of ACCOUNT_ERROR_HINTS) {
    if (item.re.test(text)) return item.message;
  }
  return '';
}

/**
 * 发起一次 GitHub API 调用
 * @returns {{ok:boolean, transport:boolean, status:number, message:string, headers:Headers|null, data:any}}
 */
async function call(apiPath, options = {}) {
  const url = new URL(config.github.apiBase + apiPath);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
  }

  const init = { method: options.method || 'GET', headers: buildHeaders(options) };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  try {
    const dispatcher = await proxy.getApiDispatcher();
    const res = await fetch(url, {
      ...init,
      ...(dispatcher ? { dispatcher } : {}),
      signal: AbortSignal.timeout(options.timeout || config.github.timeout),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      logger.warn(`GitHub API ${res.status} ${apiPath}`, { message: (data && data.message) || text.slice(0, 120) });
    }
    return {
      ok: res.ok,
      transport: false,
      status: res.status,
      message: extractMessage(res, data),
      headers: res.headers,
      data,
    };
  } catch (err) {
    const message =
      err && err.name === 'TimeoutError' ? `请求 GitHub 超时（${config.github.timeout}ms）` : `网络错误：${err.message}`;
    logger.warn(`GitHub API 传输失败 ${apiPath}`, { message });
    return { ok: false, transport: true, status: 0, message, headers: null, data: null };
  }
}

function fetchUser({ token, basic }) {
  return call('/user', { token, basic });
}

function fetchRepos({ token, page = 1, perPage = 100 }) {
  return call('/user/repos', {
    token,
    query: {
      per_page: perPage,
      page,
      sort: 'updated',
      direction: 'desc',
      affiliation: 'owner,collaborator,organization_member',
    },
  });
}

function fetchRateLimit({ token }) {
  return call('/rate_limit', { token });
}

/* ---------------- Star 相关 ---------------- */

/** Star 仓库（幂等：已 Star 时 GitHub 同样返回 204） */
function starRepo({ token, repo }) {
  return call(`/user/starred/${repo}`, { method: 'PUT', token });
}

/** 取消 Star（幂等） */
function unstarRepo({ token, repo }) {
  return call(`/user/starred/${repo}`, { method: 'DELETE', token });
}

/** 查询是否已 Star：204=已 Star，404=未 Star */
function checkStarred({ token, repo }) {
  return call(`/user/starred/${repo}`, { token });
}

/** 查询目标仓库信息（存在性 / Star 数 / 可见性） */
function fetchRepo({ token, repo }) {
  return call(`/repos/${repo}`, { token });
}

/**
 * 查询账号「点 Star 的总数」（该账号给别人仓库加星的数量）
 * 技巧：per_page=1 时 Link 响应头的 rel="last" 页号即为总数，单次请求即可
 */
async function fetchStarredCount({ token }) {
  const res = await call('/user/starred', { token, query: { per_page: 1 } });
  if (!res.ok) return null;
  const link = res.headers && typeof res.headers.get === 'function' ? String(res.headers.get('link') || '') : '';
  const m = link.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  if (m) return Number(m[1]);
  return Array.isArray(res.data) ? res.data.length : 0;
}

/* ---------------- Follow 相关 ---------------- */

/** 关注用户（幂等：已关注时 GitHub 同样返回 204） */
function followUser({ token, username }) {
  return call(`/user/following/${username}`, { method: 'PUT', token });
}

/** 取消关注（幂等） */
function unfollowUser({ token, username }) {
  return call(`/user/following/${username}`, { method: 'DELETE', token });
}

/** 查询是否已关注：204=已关注，404=未关注 */
function checkFollowing({ token, username }) {
  return call(`/user/following/${username}`, { token });
}

/**
 * 复刻（Fork）目标仓库到当前账号名下
 * 已复刻时 GitHub 不会重复创建，直接返回现有 fork（202）
 */
function forkRepo({ token, repo }) {
  return call(`/repos/${repo}/forks`, { token, method: 'POST', body: {} });
}

/** 查询目标用户资料 */
function fetchUserProfile({ token, username }) {
  return call(`/users/${username}`, { token });
}

/* ---------------- 个人资料编辑（PATCH /user） ---------------- */

/**
 * GitHub 官方 REST 支持的资料字段白名单
 * 已实测确认：/user/avatar、/user/status、/user/profile 均不存在（404），
 * 头像只能走网页上传，状态只能走 GraphQL，其余字段全部由本接口承载。
 */
const EDITABLE_PROFILE_FIELDS = [
  'name',
  'email',
  'blog',
  'twitter_username',
  'company',
  'location',
  'hireable',
  'bio',
];

const BIO_MAX = 160;

/** 更新当前认证用户的资料（只透传白名单字段，避免误传导致 422） */
function updateUserProfile({ token, fields = {} }) {
  const body = {};
  for (const key of EDITABLE_PROFILE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) body[key] = fields[key];
  }
  if (!Object.keys(body).length) {
    return Promise.resolve({ ok: false, transport: false, status: 422, message: '没有需要更新的字段', headers: null, data: null });
  }
  return call('/user', { method: 'PATCH', token, body });
}

/* ---------------- GraphQL（状态能力只在 GraphQL 上） ---------------- */

/**
 * 发起 GraphQL 调用（GitHub 的「状态」没有 REST 端点，只能走 GraphQL）
 * 复用与 REST 相同的代理通道与超时策略
 */
async function graphql({ token, query: gql, variables }) {
  const url = `${config.github.apiBase.replace(/\/$/, '')}/graphql`;
  try {
    const dispatcher = await proxy.getApiDispatcher();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': config.github.userAgent,
      },
      body: JSON.stringify({ query: gql, variables }),
      ...(dispatcher ? { dispatcher } : {}),
      signal: AbortSignal.timeout(config.github.timeout),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const gqlError = data && Array.isArray(data.errors) && data.errors.length ? data.errors[0].message : '';
    if (!res.ok || gqlError) {
      logger.warn(`GitHub GraphQL ${res.status}`, { message: gqlError || text.slice(0, 120) });
      return {
        ok: false,
        transport: false,
        status: res.status,
        message: gqlError || `HTTP ${res.status}`,
        headers: res.headers,
        data,
      };
    }
    return { ok: true, transport: false, status: res.status, message: '', headers: res.headers, data };
  } catch (err) {
    const message =
      err && err.name === 'TimeoutError' ? `请求 GitHub 超时（${config.github.timeout}ms）` : `网络错误：${err.message}`;
    logger.warn('GitHub GraphQL 传输失败', { message });
    return { ok: false, transport: true, status: 0, message, headers: null, data: null };
  }
}

const STATUS_FIELDS = `
  fragment StatusFields on UserStatus {
    emoji
    message
    indicatesLimitedAvailability
    expiresAt
    createdAt
    updatedAt
  }
`;

/** 读取当前账号的自定义状态 */
async function fetchUserStatus({ token }) {
  const q = `query { viewer { status { ...StatusFields } } } ${STATUS_FIELDS}`;
  const res = await graphql({ token, query: q });
  if (!res.ok) return res;
  return { ...res, data: (res.data && res.data.data && res.data.data.viewer && res.data.data.viewer.status) || null };
}

/** 设置自定义状态（emoji 支持原生表情或 :shortcode:） */
async function changeUserStatus({ token, emoji, message, limitedAvailability, expiresAt }) {
  const input = {};
  if (emoji !== undefined) input.emoji = emoji === '' ? null : emoji;
  if (message !== undefined) input.message = message === '' ? null : message;
  if (limitedAvailability !== undefined) input.limitedAvailability = !!limitedAvailability;
  if (expiresAt !== undefined) input.expiresAt = expiresAt || null;

  const q = `mutation($input: ChangeUserStatusInput!) {
    changeUserStatus(input: $input) { status { ...StatusFields } }
  } ${STATUS_FIELDS}`;
  const res = await graphql({ token, query: q, variables: { input } });
  if (!res.ok) return res;
  return { ...res, data: (res.data && res.data.data && res.data.data.changeUserStatus && res.data.data.changeUserStatus.status) || null };
}

/* ---------------- 社交链接（REST 专有） ---------------- */

function listSocialAccounts({ token }) {
  return call('/user/social_accounts', { token });
}

/** 全量设置：GitHub 只提供「批量新增」和「批量删除」，不提供替换 */
function addSocialAccounts({ token, urls }) {
  return call('/user/social_accounts', { method: 'POST', token, body: { account_urls: urls } });
}

function deleteSocialAccounts({ token, urls }) {
  return call('/user/social_accounts', { method: 'DELETE', token, body: { account_urls: urls } });
}

/* ---------------- 邮箱 ---------------- */

function listEmails({ token }) {
  return call('/user/emails', { token });
}

function setEmailVisibility({ token, visibility }) {
  return call('/user/email/visibility', { method: 'PATCH', token, body: { visibility } });
}

function parseScopes(headers) {
  if (!headers) return [];
  return String(headers.get('x-oauth-scopes') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseRateLimit(headers) {
  if (!headers) return null;
  const limit = Number(headers.get('x-ratelimit-limit'));
  const remaining = Number(headers.get('x-ratelimit-remaining'));
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return null;
  return {
    limit,
    remaining,
    resetAt: Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : null,
  };
}

/** 只保留业务需要的资料字段，避免把整个响应塞进数据库 */
function normalizeProfile(user) {
  if (!user || !user.login) return null;
  return {
    id: user.id,
    login: user.login,
    name: user.name || '',
    avatarUrl: user.avatar_url || '',
    htmlUrl: user.html_url || '',
    bio: user.bio || '',
    company: user.company || '',
    location: user.location || '',
    blog: user.blog || '',
    email: user.email || '',
    twitterUsername: user.twitter_username || '',
    hireable: !!user.hireable,
    publicRepos: user.public_repos || 0,
    publicGists: user.public_gists || 0,
    followers: user.followers || 0,
    following: user.following || 0,
    createdAt: user.created_at || '',
    updatedAt: user.updated_at || '',
  };
}

function normalizeRepo(repo) {
  return {
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    private: !!repo.private,
    fork: !!repo.fork,
    archived: !!repo.archived,
    description: repo.description || '',
    language: repo.language || '',
    stars: repo.stargazers_count || 0,
    forks: repo.forks_count || 0,
    openIssues: repo.open_issues_count || 0,
    size: repo.size || 0,
    defaultBranch: repo.default_branch || '',
    updatedAt: repo.updated_at || '',
    htmlUrl: repo.html_url || '',
  };
}

module.exports = {
  call,
  fetchUser,
  fetchRepos,
  fetchRateLimit,
  fetchRepo,
  fetchStarredCount,
  starRepo,
  unstarRepo,
  checkStarred,
  followUser,
  unfollowUser,
  checkFollowing,
  forkRepo,
  fetchUserProfile,
  parseScopes,
  parseRateLimit,
  normalizeProfile,
  normalizeRepo,
  explainAccountError,
  /* 资料编辑 */
  EDITABLE_PROFILE_FIELDS,
  BIO_MAX,
  updateUserProfile,
  graphql,
  fetchUserStatus,
  changeUserStatus,
  listSocialAccounts,
  addSocialAccounts,
  deleteSocialAccounts,
  listEmails,
  setEmailVisibility,
};

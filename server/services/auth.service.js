'use strict';

/**
 * 管理员认证服务
 * - 密码：scrypt 加盐哈希（Node 内置，无第三方依赖），存储格式 scrypt:salthex:hashhex
 * - 会话：32 字节随机 token，httpOnly Cookie 携带，服务端 admin_sessions 表可撤销
 * - 登录限速：同 IP 15 分钟内失败 10 次锁定 15 分钟（防暴力破解，公网部署必备）
 */
const crypto = require('crypto');
const { query, withTransaction } = require('../db/pool');
const logger = require('../utils/logger');

const COOKIE_NAME = 'ghhub_session';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILS = 10;
const RATE_LOCK_MS = 15 * 60 * 1000;

class AuthError extends Error {
  constructor(status, message, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ----------------------------- 密码哈希 ----------------------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/* ----------------------------- Cookie 工具 ----------------------------- */

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
      if (k) {
        try {
          out[k] = decodeURIComponent(v);
        } catch {
          /* 畸形编码按原值处理：不能让一个坏 Cookie 把整个请求打成 500 */
          out[k] = v;
        }
      }
  }
  return out;
}

function isSecureRequest(req) {
  const mode = String(process.env.COOKIE_SECURE || 'auto').toLowerCase();
  if (mode === '1' || mode === 'true') return true;
  if (mode === '0' || mode === 'false') return false;
  if (req.secure) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

function buildSessionCookie(token, req) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function buildClearCookie(req) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function getSessionToken(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] || '';
}

/* ----------------------------- 登录限速 ----------------------------- */

const rateMap = new Map(); // ip -> { count, firstAt, lockedUntil }

function rateLimitCheck(ip) {
  const rec = rateMap.get(ip);
  if (!rec) return;
  const now = Date.now();
  if (rec.lockedUntil && now < rec.lockedUntil) {
    const mins = Math.ceil((rec.lockedUntil - now) / 60000);
    throw new AuthError(429, `尝试次数过多，请 ${mins} 分钟后再试`, 'RATE_LIMITED');
  }
  if (now - rec.firstAt > RATE_WINDOW_MS) rateMap.delete(ip);
}

function rateLimitFail(ip) {
  const now = Date.now();
  let rec = rateMap.get(ip);
  if (!rec || now - rec.firstAt > RATE_WINDOW_MS) rec = { count: 0, firstAt: now, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= RATE_MAX_FAILS) rec.lockedUntil = now + RATE_LOCK_MS;
  rateMap.set(ip, rec);
}

function rateLimitReset(ip) {
  rateMap.delete(ip);
}

/* ----------------------------- 数据访问 ----------------------------- */

async function getAdminRow() {
  const rows = await query('SELECT * FROM admin_users ORDER BY id ASC LIMIT 1');
  return rows[0] || null;
}

function toAdminPublic(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

async function writeLog(action, detail, level = 'info') {
  try {
    await query('INSERT INTO activity_logs (account_id, action, level, detail) VALUES (NULL, ?, ?, ?)', [
      action,
      level,
      String(detail || '').slice(0, 800),
    ]);
  } catch (err) {
    logger.warn('写认证日志失败', { error: err.message });
  }
}

/* ----------------------------- 会话 ----------------------------- */

async function createSession(adminId, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const ua = String((req && req.headers['user-agent']) || '').slice(0, 250);
  await query('INSERT INTO admin_sessions (token, admin_id, user_agent, expires_at) VALUES (?, ?, ?, ?)', [
    token,
    adminId,
    ua,
    new Date(Date.now() + SESSION_TTL_MS),
  ]);
  // 顺手清理过期会话
  query('DELETE FROM admin_sessions WHERE expires_at < NOW()').catch(() => {});
  return token;
}

async function validateSession(token) {
  if (!token || token.length !== 64) return null;
  const rows = await query('SELECT * FROM admin_sessions WHERE token = ? AND expires_at > NOW() LIMIT 1', [token]);
  const session = rows[0];
  if (!session) return null;
  query('UPDATE admin_sessions SET last_seen_at = NOW() WHERE token = ?', [token]).catch(() => {});
  const admin = await getAdminRow();
  if (!admin || Number(admin.id) !== Number(session.admin_id)) return null;
  return { session, admin: toAdminPublic(admin) };
}

async function destroySession(token) {
  if (!token) return;
  await query('DELETE FROM admin_sessions WHERE token = ?', [token]);
}

async function destroyAllSessions(adminId) {
  await query('DELETE FROM admin_sessions WHERE admin_id = ?', [adminId]);
}

/* ----------------------------- 业务 ----------------------------- */

async function getStatus(req) {
  const admin = await getAdminRow();
  if (!admin) return { initialized: false, username: null, loggedIn: false };
  const session = await validateSession(getSessionToken(req));
  /* 该接口公开：未登录时不回显管理员用户名，避免向匿名访客泄露登录名 */
  return { initialized: true, username: session ? admin.username : null, loggedIn: !!session };
}

function validateUsername(username) {
  const u = String(username || '').trim();
  if (!u) throw new AuthError(400, '请填写用户名');
  if (u.length < 2 || u.length > 64) throw new AuthError(400, '用户名长度需在 2-64 个字符之间');
  if (!/^[A-Za-z0-9_.@-]+$/.test(u)) throw new AuthError(400, '用户名仅支持字母、数字、下划线、点、@ 和短横线');
  return u;
}

function validatePassword(password) {
  const p = String(password || '');
  if (!p) throw new AuthError(400, '请填写密码');
  if (p.length < 8) throw new AuthError(400, '密码至少 8 位');
  if (p.length > 128) throw new AuthError(400, '密码过长');
  return p;
}

function validateCredential(username, password) {
  return { username: validateUsername(username), password: validatePassword(password) };
}

/** 首次初始化（仅允许一次） */
async function setup({ username, password }, req) {
  const cred = validateCredential(username, password);
  const existing = await getAdminRow();
  if (existing) throw new AuthError(409, '系统已初始化，请直接登录', 'ALREADY_INITIALIZED');

  const id = await withTransaction(async (conn) => {
    const [result] = await conn.execute('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)', [
      cred.username,
      hashPassword(cred.password),
    ]);
    return result.insertId;
  });

  const token = await createSession(id, req);
  await writeLog('auth.setup', `初始化完成，管理员：${cred.username}`);
  logger.info(`管理员初始化完成：${cred.username}`);
  return { token, username: cred.username };
}

/** 登录 */
async function login({ username, password }, req) {
  const ip = (req && (req.ip || req.socket.remoteAddress)) || 'unknown';
  rateLimitCheck(ip);

  const admin = await getAdminRow();
  if (!admin) throw new AuthError(400, '系统尚未初始化，请先创建管理员账号', 'NOT_INITIALIZED');

  const okUser = String(username || '').trim() === admin.username;
  const okPass = verifyPassword(password, admin.password_hash);
  if (!okUser || !okPass) {
    rateLimitFail(ip);
    await writeLog('auth.login', `登录失败：用户名或密码错误（${ip}）`, 'warn');
    throw new AuthError(401, '用户名或密码错误', 'BAD_CREDENTIALS');
  }

  rateLimitReset(ip);
  await query('UPDATE admin_users SET last_login_at = NOW() WHERE id = ?', [admin.id]);
  const token = await createSession(admin.id, req);
  await writeLog('auth.login', `登录成功（${ip}）`);
  return { token, username: admin.username };
}

/** 修改用户名（需当前密码确认） */
async function changeUsername({ currentPassword, username: newUsername }, adminId) {
  const admin = await getAdminRow();
  if (!admin || Number(admin.id) !== Number(adminId)) throw new AuthError(401, '登录状态异常，请重新登录');
  if (!verifyPassword(currentPassword, admin.password_hash)) {
    throw new AuthError(401, '当前密码不正确', 'BAD_PASSWORD');
  }
  const cred = { username: validateUsername(newUsername) };
  if (cred.username === admin.username) throw new AuthError(400, '新用户名与当前用户名相同');

  await query('UPDATE admin_users SET username = ? WHERE id = ?', [cred.username, admin.id]);
  await writeLog('admin.username', `管理员用户名变更：${admin.username} → ${cred.username}`);
  logger.info(`管理员用户名已变更：${admin.username} → ${cred.username}`);
  return { username: cred.username };
}

/** 修改密码（需当前密码确认；成功后踢出所有会话并重发当前会话） */
async function changePassword({ currentPassword, newPassword }, adminId, req) {
  const admin = await getAdminRow();
  if (!admin || Number(admin.id) !== Number(adminId)) throw new AuthError(401, '登录状态异常，请重新登录');
  if (!verifyPassword(currentPassword, admin.password_hash)) {
    throw new AuthError(401, '当前密码不正确', 'BAD_PASSWORD');
  }
  const cred = { password: validatePassword(newPassword) };
  if (verifyPassword(cred.password, admin.password_hash)) {
    throw new AuthError(400, '新密码不能与当前密码相同');
  }

  await query('UPDATE admin_users SET password_hash = ? WHERE id = ?', [hashPassword(cred.password), admin.id]);
  await destroyAllSessions(admin.id); // 踢出所有会话（含其他设备）
  const token = await createSession(admin.id, req); // 为当前客户端重发会话
  await writeLog('admin.password', '管理员密码已重置（所有旧会话已失效）');
  logger.info('管理员密码已重置');
  return { token };
}

module.exports = {
  AuthError,
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  parseCookies,
  buildSessionCookie,
  buildClearCookie,
  getSessionToken,
  getStatus,
  setup,
  login,
  validateSession,
  destroySession,
  changeUsername,
  changePassword,
  toAdminPublic,
};

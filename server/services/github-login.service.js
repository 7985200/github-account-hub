'use strict';

/**
 * GitHub 网页登录服务
 * 模拟浏览器登录 GitHub → 自动创建「全权限 + 永不过期」Personal Access Token
 *
 * 原理（全部为真实 HTTP 交互，无浏览器依赖）：
 *   1. GET  /login                → 取一次性 CSRF token + 匿名会话 cookie
 *   2. POST /session              → 提交「账号 + 密码」，换取登录态 user_session
 *   3. GET  /settings/tokens/new  → 取创建表单 CSRF token + 全部可选权限列表
 *   4. POST /settings/tokens      → 提交「51 项权限全选 + No expiration」
 *   5. 从落地页解析只显示一次的 Token 明文（ghp_xxx）
 *
 * 重要约束：
 *   - github.com 无法直连（国内网络），必须经本地代理访问，代理地址见 config.webLogin
 *   - 密码仅用于本次登录，不落库、不写日志（用完即弃）
 *   - 账号若启用两步验证（2FA），流程会中断并返回明确错误码
 */

const { fetch, ProxyAgent } = require('undici');
const crypto = require('crypto');
const config = require('../config');
const proxy = require('./proxy.service');
const logger = require('../utils/logger');

const ORIGIN = 'https://github.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TOKEN_PATTERN = /ghp_[A-Za-z0-9]{36}/;

class WebLoginError extends Error {
  constructor(code, message, httpStatus = 502) {
    super(message);
    this.name = 'WebLoginError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/* ----------------------------- Cookie 管理 ----------------------------- */

class CookieJar {
  constructor() {
    this.map = new Map();
  }
  get size() {
    return this.map.size;
  }
  has(name) {
    return this.map.has(name);
  }
  capture(headers) {
    const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const raw of list) {
      const pair = String(raw).split(';')[0];
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (/expires=Thu, 01 Jan 1970/i.test(raw) || value === '') this.map.delete(name);
      else this.map.set(name, value);
    }
  }
  header() {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/* ----------------------------- HTTP 辅助 ----------------------------- */

async function request(url, opts = {}, { jar, dispatcher }) {
  const headers = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(opts.headers || {}),
  };
  if (jar && jar.size) headers.Cookie = jar.header();

  const res = await fetch(url, {
    dispatcher,
    redirect: 'manual',
    ...opts,
    headers,
    signal: AbortSignal.timeout(config.webLogin.timeout),
  });
  if (jar) jar.capture(res.headers);
  const text = await res.text().catch(() => '');
  return { status: res.status, headers: res.headers, text };
}

function extractCsrf(html) {
  const m = String(html).match(/name="authenticity_token" value="([^"]+)"/);
  return m ? m[1] : '';
}

/**
 * 提取 GitHub 页面 flash 提示文本（错误/警告文案）
 * 注意：必须校验提取结果非空才返回 —— GitHub 的 flash 容器内常先出现空白文本节点，
 *       若不过滤会拿到空串并提前返回（历史 bug：导致「密码错误」被误判为未知错误）
 */
function extractFlashError(html) {
  const s = String(html);
  const patterns = [
    // 最精确：flash 文本容器（错误/警告文案所在节点）
    /js-flash-alert[^>]*>\s*(?:<[^>]+>\s*)*([^<]{4,300})/i,
    // 次选：flash-error 容器内的首个有效文本
    /flash-error[\s\S]{0,600}?<[^>]*>\s*([^<]{4,300})/i,
    // 兜底：任意 role=alert 容器
    /role="alert"[\s\S]{0,400}?([^<]{4,300})</i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    const text = m && m[1] ? m[1].replace(/\s+/g, ' ').trim() : '';
    if (text && text.length >= 4) return text;
  }
  return '';
}

/**
 * 生成唯一的 Token 备注名（GitHub 不允许同账号下 Note 重名）
 * 格式：<base>-YYYYMMDD-HHmm-<4位随机>  例：ghhub-auto-20261015-1452-3af9
 */
function buildTokenNote(base) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}`;
  const rand = crypto.randomBytes(2).toString('hex');
  const safeBase = String(base || 'ghhub-auto').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ghhub-auto';
  return `${safeBase}-${stamp}-${rand}`;
}

/* ----------------------------- 验证会话管理 ----------------------------- */
/**
 * 当 GitHub 要求额外验证（邮箱验证码 / 两步验证）时，需要保持登录会话（cookie jar）
 * 供用户输入验证码后继续 —— 会话仅存内存，10 分钟过期，不落库、不写日志
 */
const pendingVerifications = new Map(); // verifyId -> { jar, dispatcher, login, description, channel, createdAt, verifyType, codeForm, resendForm, hint }
const VERIFY_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 30;

function sweepPending() {
  const now = Date.now();
  for (const [id, s] of pendingVerifications) {
    if (now - s.createdAt > VERIFY_TTL_MS) {
      if (s.dispatcher && typeof s.dispatcher.close === 'function') s.dispatcher.close().catch(() => {});
      pendingVerifications.delete(id);
    }
  }
}

function putPending(entry) {
  sweepPending();
  // 超出上限时淘汰最旧的一条（同时释放其 dispatcher）
  if (pendingVerifications.size >= MAX_PENDING) {
    const oldest = [...pendingVerifications.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) {
      if (oldest[1].dispatcher && typeof oldest[1].dispatcher.close === 'function') {
        oldest[1].dispatcher.close().catch(() => {});
      }
      pendingVerifications.delete(oldest[0]);
    }
  }
  const verifyId = `v_${crypto.randomBytes(12).toString('hex')}`;
  pendingVerifications.set(verifyId, { ...entry, verifyId, createdAt: Date.now() });
  return verifyId;
}

function takePending(verifyId) {
  sweepPending();
  const sess = pendingVerifications.get(String(verifyId || ''));
  if (!sess) {
    throw new WebLoginError('VERIFY_EXPIRED', '验证会话已过期，请重新输入账号密码', 410);
  }
  return sess;
}

function dropPending(verifyId) {
  const sess = pendingVerifications.get(String(verifyId || ''));
  if (sess) {
    if (sess.dispatcher && typeof sess.dispatcher.close === 'function') sess.dispatcher.close().catch(() => {});
    pendingVerifications.delete(String(verifyId));
  }
}

/* ----------------------------- 验证页面解析 ----------------------------- */
/** 邮箱脱敏：l***@qq.com */
function maskEmail(email) {
  const at = String(email).indexOf('@');
  if (at <= 0) return String(email);
  const user = String(email).slice(0, at);
  const domain = String(email).slice(at);
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(3, user.length - 1))}${domain}`;
}

/**
 * 动态解析 GitHub 验证页面的表单结构（不硬编码字段名，抗改版）
 * @returns {{codeForm:object|null, resendForm:object|null, verifyType:string, hint:string, alreadySent:boolean}}
 */
function parseVerifyPage(html, location) {
  const src = String(html || '');
  const forms = [];
  for (const fm of src.match(/<form[^>]*>[\s\S]*?<\/form>/gi) || []) {
    const action = (fm.match(/action="([^"]*)"/i) || [])[1] || '';
    const method = ((fm.match(/method="([^"]*)"/i) || [])[1] || 'post').toLowerCase();
    const inputs = [...fm.matchAll(/<input[^>]*>/gi)]
      .map((t) => {
        const tag = t[0];
        return {
          name: (tag.match(/name="([^"]*)"/i) || [])[1] || '',
          value: (tag.match(/value="([^"]*)"/i) || [])[1] || '',
          type: ((tag.match(/type="([^"]*)"/i) || [])[1] || 'text').toLowerCase(),
        };
      })
      .filter((i) => i.name);
    if (inputs.length) forms.push({ action, method, inputs });
  }

  // 验证码表单：优先字段名含 otp/code/verification/pin 的可见输入
  let codeForm = null;
  for (const f of forms) {
    const codeInput = f.inputs.find(
      (i) => i.type !== 'hidden' && /otp|code|verification|pin|device/i.test(i.name)
    );
    if (codeInput) {
      codeForm = { action: f.action, method: f.method, hidden: f.inputs.filter((i) => i.type === 'hidden'), codeField: codeInput.name };
      break;
    }
  }
  if (!codeForm) {
    for (const f of forms) {
      const textInput = f.inputs.find((i) => ['text', 'tel', 'number', 'password'].includes(i.type));
      if (textInput) {
        codeForm = { action: f.action, method: f.method, hidden: f.inputs.filter((i) => i.type === 'hidden'), codeField: textInput.name };
        break;
      }
    }
  }

  // 重发/发送验证码表单（action 或按钮文案含 resend/send code 等）
  let resendForm = null;
  for (const f of forms) {
    if (/resend|send[_-]?code|new[_-]?code|retry/i.test(f.action)) {
      resendForm = { action: f.action, method: f.method, hidden: f.inputs.filter((i) => i.type === 'hidden') };
      break;
    }
  }

  // 验证类型：两步验证（验证器 App / 短信） vs 设备/邮箱验证
  const lower = src.toLowerCase();
  const loc = String(location || '').toLowerCase();
  let verifyType = 'email';
  if (/two-factor|two_factor|2fa/.test(loc) || /authenticator app|authentication code|two-factor/.test(lower)) {
    verifyType = /sms|text message|phone/.test(lower) ? 'sms' : 'totp';
  }

  // 是否已自动发送过验证码
  const alreadySent = /we (sent|emailed)|sent a (code|message)|has been sent|check your (email|inbox)/i.test(src);

  // 提示文案：尽量提取 GitHub 的原文（含脱敏邮箱）
  let hint = '';
  const sentLine = src.match(/((?:we |)(?:sent|emailed)[^<]{0,120}(?:code|link)[^<]{0,120})/i);
  if (sentLine) hint = sentLine[1].replace(/\s+/g, ' ').trim().slice(0, 160);
  const emailMatch = src.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) {
    const masked = maskEmail(emailMatch[0]);
    hint = hint ? `${hint}（${masked}）` : `验证码已发送至 ${masked}`;
  }

  return { codeForm, resendForm, verifyType, hint, alreadySent };
}

/* ----------------------------- 主流程 ----------------------------- */

/**
 * 登录 GitHub 并创建全权限（51 项）永不过期 Token
 * @param {{ login: string, password: string, description?: string }} payload
 * @returns {Promise<{ token: string, scopes: string[], channel: string, durationMs: number }>}
 */
async function loginAndCreateToken({ login, password, description = 'ghhub-auto' } = {}) {
  const username = String(login || '').trim();
  const pwd = String(password || '');
  if (!username) throw new WebLoginError('BAD_REQUEST', '请填写 GitHub 账号或邮箱', 400);
  if (!pwd) throw new WebLoginError('BAD_REQUEST', '请填写密码', 400);

  let channel;
  try {
    channel = await proxy.resolveWebChannel();
  } catch (err) {
    throw new WebLoginError('PROXY_UNAVAILABLE', err.message, 503);
  }
  const dispatcher = channel === 'direct' ? undefined : new ProxyAgent(channel);
  const jar = new CookieJar();
  const t0 = Date.now();
  let keepSession = false; // 需要额外验证时保持会话（dispatcher 交由验证会话持有）

  try {
    /* 1. 登录页 */
    const loginPage = await request(`${ORIGIN}/login`, {}, { jar, dispatcher });
    if (loginPage.status !== 200) {
      throw new WebLoginError('NETWORK', `无法打开 GitHub 登录页（HTTP ${loginPage.status}）`, 502);
    }
    const csrf1 = extractCsrf(loginPage.text);
    if (!csrf1) throw new WebLoginError('NETWORK', '登录页结构异常（未找到 CSRF token）', 502);

    /* 2. 提交账号密码 */
    const body = new URLSearchParams({
      login: username,
      password: pwd,
      authenticity_token: csrf1,
      commit: 'Sign in',
    });
    const res2 = await request(
      `${ORIGIN}/session`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${ORIGIN}/login`,
          Origin: ORIGIN,
        },
        body: body.toString(),
      },
      { jar, dispatcher }
    );

    /* 3. 判定登录态：直接尝试打开 Token 创建页（已登录才可访问）
     *    —— 不依赖 GitHub 的跳转语义（设备验证/2FA/改版都不会误判），
     *       未通过时再依据登录响应的证据分级给出准确原因 */
    const newPage = await request(`${ORIGIN}/settings/tokens/new`, {}, { jar, dispatcher });
    if (newPage.status !== 200) {
      const loc = String(res2.headers.get('location') || '');
      const flash = res2.status === 200 ? extractFlashError(res2.text) : '';
      logger.warn('网页登录未通过', {
        login: username,
        loginStatus: res2.status,
        location: loc,
        flash: flash.slice(0, 140),
        tokenPageStatus: newPage.status,
      });

      // ① 明确的密码错误（GitHub 在登录页回显的 flash 文案）
      if (/incorrect username or password|invalid.{0,12}(login|credentials)/i.test(flash)) {
        throw new WebLoginError('BAD_CREDENTIALS', '登录失败：账号或密码错误', 401);
      }
      // ② 人机验证 / 风控（无法自动完成）
      if (/data-sitekey|octocaptcha-frame|unusual activity|suspicious.{0,20}(activity|login)/i.test(res2.text)) {
        throw new WebLoginError(
          'CAPTCHA',
          'GitHub 要求人机验证（图形验证码/风控）。请先在浏览器中用该账号登录一次，或改用「Token 添加」方式。',
          403
        );
      }
      // ③ 需要额外验证（邮箱验证码 / 两步验证）→ 建立验证会话，用户输入验证码后继续
      const verifyCtx = await tryBuildVerification({ res2, loc, jar, dispatcher, login: username });
      if (verifyCtx) {
        keepSession = true; // dispatcher 交由验证会话持有，不在 finally 中关闭
        const verifyId = putPending({
          jar,
          dispatcher,
          login: username,
          description,
          channel,
          verifyType: verifyCtx.verifyType,
          hint: verifyCtx.hint,
          codeForm: verifyCtx.codeForm,
          resendForm: verifyCtx.resendForm,
          verifyPageUrl: verifyCtx.verifyPageUrl,
        });
        logger.info('登录需要额外验证，已建立验证会话', {
          login: username,
          verifyType: verifyCtx.verifyType,
        });
        return {
          needsVerify: true,
          verifyId,
          verifyType: verifyCtx.verifyType,
          hint: verifyCtx.hint,
          expiresInSec: Math.floor(VERIFY_TTL_MS / 1000),
        };
      }
      // ④ 有明确的回显文案 → 原样带出
      if (flash) {
        throw new WebLoginError('BAD_CREDENTIALS', `登录失败：${flash}`, 401);
      }
      // ⑤ 其他未知情况 → 明确说明并给出可操作建议
      throw new WebLoginError(
        'NEED_VERIFY',
        `登录未完成（GitHub 响应 ${res2.status}${loc ? `，跳转 ${loc}` : ''}）。请稍后重试，或改用「Token 添加」方式。`,
        428
      );
    }
    /* 已登录 → 创建 Token（复用共享实现） */
    const created = await createTokenWithSession({ jar, dispatcher, login: username, description, tokenPage: newPage });
    const durationMs = Date.now() - t0;
    logger.info('网页登录自动创建 Token 成功', {
      login: username,
      scopes: created.scopes.length,
      channel,
      note: created.note,
      durationMs,
    });
    return { token: created.token, scopes: created.scopes, channel, durationMs, note: created.note };
  } finally {
    if (!keepSession && dispatcher && typeof dispatcher.close === 'function') dispatcher.close().catch(() => {});
  }
}

/* ----------------------------- 共享：用已登录会话创建 Token ----------------------------- */
/**
 * 前提：会话已登录（调用方需先确认能打开 Token 创建页）
 * @returns {{token:string, scopes:string[], note:string}}
 */
async function createTokenWithSession({ jar, dispatcher, login, description, tokenPage }) {
  const csrf2 = extractCsrf(tokenPage.text);
    const scopes = [
      ...new Set(
        [...tokenPage.text.matchAll(/name="oauth_access\[scopes\]\[\]" value="([^"]+)"/g)].map((m) => m[1])
      ),
    ];
    if (!csrf2 || !scopes.length) {
      throw new WebLoginError('CREATE_FAILED', 'Token 创建页结构异常（未取到表单或权限列表）', 502);
    }

    /* 4+5. 提交创建（权限全选 + 永不过期）；Note 重名时自动换名重试 */
    let token = '';
    let usedNote = '';
    let lastError = '';
    for (let attempt = 0; attempt < 3 && !token; attempt += 1) {
      let csrf = csrf2;
      if (attempt > 0) {
        // 重试前刷新表单，确保 CSRF 最新
        // eslint-disable-next-line no-await-in-loop
        const page2 = await request(`${ORIGIN}/settings/tokens/new`, {}, { jar, dispatcher });
        csrf = extractCsrf(page2.text) || csrf2;
      }

      const note = buildTokenNote(description);
      const form = new URLSearchParams();
      form.append('authenticity_token', csrf);
      form.append('oauth_access[description]', note);
      form.append('oauth_access[default_expires_at]', 'none');
      for (const s of scopes) form.append('oauth_access[scopes][]', s);

      // eslint-disable-next-line no-await-in-loop
      let res4 = await request(
        `${ORIGIN}/settings/tokens`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: `${ORIGIN}/settings/tokens/new`,
            Origin: ORIGIN,
          },
          body: form.toString(),
        },
        { jar, dispatcher }
      );

      /* 跟随重定向，从落地页解析 Token 明文 */
      let hops = 0;
      while (res4.status >= 300 && res4.status < 400 && hops < 5) {
        const loc = String(res4.headers.get('location') || '');
        if (!loc) break;
        // eslint-disable-next-line no-await-in-loop
        res4 = await request(loc.startsWith('http') ? loc : `${ORIGIN}${loc}`, {}, { jar, dispatcher });
        hops += 1;
      }

      token = (res4.text.match(TOKEN_PATTERN) || [])[0];
      if (token) {
        usedNote = note;
        break;
      }

      const reason = extractFlashError(res4.text);
      lastError = `HTTP ${res4.status}${reason ? `：${reason}` : '：未在页面中找到 Token 明文'}`;
    if (/already been taken/i.test(reason) && attempt < 2) {
      logger.warn('Token 备注名冲突，自动换名重试', { login, attempt: attempt + 2 });
      continue;
    }
      break;
    }

  if (!token) {
    throw new WebLoginError('CREATE_FAILED', `Token 创建失败（${lastError}）`, 502);
  }
  return { token, scopes, note: usedNote };
}

/* ----------------------------- 验证续接（邮箱验证码 / 两步验证） ----------------------------- */

/** 尝试建立验证会话：访问验证页 → 解析表单 → 必要时自动触发发送验证码 */
async function tryBuildVerification({ loc, jar, dispatcher, login }) {
  let target = '';
  if (loc && /^https?:/i.test(loc)) target = loc;
  else if (loc && /sessions|two-factor|verify/i.test(loc)) target = `${ORIGIN}${loc}`;
  else target = `${ORIGIN}/sessions/verified-device`;

  let page;
  try {
    page = await request(target, {}, { jar, dispatcher });
  } catch (err) {
    logger.warn('验证页访问失败', { target, error: err.message });
    return null;
  }
  if (page.status !== 200) {
    logger.warn('验证页响应异常', { target, status: page.status });
    return null;
  }

  const parsed = parseVerifyPage(page.text, loc || target);
  if (!parsed.codeForm) {
    logger.warn('未能解析出验证码表单', {
      target,
      pageSize: page.text.length,
      snippet: page.text.replace(/\s+/g, ' ').slice(0, 200),
    });
    return null;
  }

  // 自动触发发送验证码（页面未提示已发送、且存在可用的重发表单时）
  if (!parsed.alreadySent && parsed.resendForm) {
    try {
      const form = new URLSearchParams();
      for (const i of parsed.resendForm.hidden) form.append(i.name, i.value);
      await request(
        new URL(parsed.resendForm.action, ORIGIN).toString(),
        {
          method: (parsed.resendForm.method || 'post').toUpperCase(),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: target, Origin: ORIGIN },
          body: form.toString(),
        },
        { jar, dispatcher }
      );
      logger.info('已自动触发验证码发送', { login, target });
    } catch (err) {
      logger.warn('自动触发验证码发送失败（GitHub 通常已自动发送，继续）', { error: err.message });
    }
  }

  const fallbackHint =
    parsed.verifyType === 'totp'
      ? '请输入两步验证器（Authenticator App）中的 6 位验证码'
      : parsed.verifyType === 'sms'
        ? '请输入手机短信收到的验证码'
        : '验证码已发送至该账号的绑定邮箱，请查收后输入';

  return {
    codeForm: parsed.codeForm,
    resendForm: parsed.resendForm,
    verifyType: parsed.verifyType,
    hint: parsed.hint || fallbackHint,
    verifyPageUrl: target,
  };
}

/**
 * 提交验证码，继续完成登录与 Token 创建
 * @returns {{token, scopes, channel, durationMs, note, login}}
 */
async function submitVerificationCode({ verifyId, code } = {}) {
  const sess = takePending(verifyId);
  const codeValue = String(code || '').replace(/\D/g, '').slice(0, 10);
  if (!codeValue) throw new WebLoginError('BAD_REQUEST', '请输入验证码', 400);
  if (!sess.codeForm) throw new WebLoginError('VERIFY_EXPIRED', '验证会话无效，请重新开始', 410);

  const t0 = Date.now();
  const form = new URLSearchParams();
  for (const i of sess.codeForm.hidden) form.append(i.name, i.value);
  form.append(sess.codeForm.codeField, codeValue);

  const res = await request(
    new URL(sess.codeForm.action, ORIGIN).toString(),
    {
      method: (sess.codeForm.method || 'post').toUpperCase(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: sess.verifyPageUrl || `${ORIGIN}/`,
        Origin: ORIGIN,
      },
      body: form.toString(),
    },
    { jar: sess.jar, dispatcher: sess.dispatcher }
  );

  // 探测登录态
  const tokenPage = await request(`${ORIGIN}/settings/tokens/new`, {}, { jar: sess.jar, dispatcher: sess.dispatcher });
  if (tokenPage.status !== 200) {
    const loc = String(res.headers.get('location') || '');
    const flash = res.status === 200 ? extractFlashError(res.text) : '';
    logger.warn('验证码提交后仍未登录', {
      login: sess.login,
      status: res.status,
      location: loc,
      flash: flash.slice(0, 140),
      tokenPageStatus: tokenPage.status,
    });
    throw new WebLoginError('BAD_CODE', flash || '验证码不正确或已失效，请重新输入', 400);
  }

  // 登录成功 → 创建 Token
  let created;
  try {
    created = await createTokenWithSession({
      jar: sess.jar,
      dispatcher: sess.dispatcher,
      login: sess.login,
      description: sess.description,
      tokenPage,
    });
  } catch (err) {
    dropPending(verifyId);
    throw err;
  }
  dropPending(verifyId);
  logger.info('验证码通过，网页登录自动创建 Token 成功', {
    login: sess.login,
    scopes: created.scopes.length,
    channel: sess.channel,
  });
  return {
    token: created.token,
    scopes: created.scopes,
    channel: sess.channel,
    durationMs: Date.now() - t0,
    note: created.note,
    login: sess.login,
  };
}

/** 重新发送验证码 */
async function resendVerificationCode({ verifyId } = {}) {
  const sess = takePending(verifyId);
  if (!sess.resendForm) {
    throw new WebLoginError('RESEND_UNAVAILABLE', '该验证方式暂不支持自动重发，请稍候重试', 409);
  }
  const form = new URLSearchParams();
  for (const i of sess.resendForm.hidden) form.append(i.name, i.value);
  const res = await request(
    new URL(sess.resendForm.action, ORIGIN).toString(),
    {
      method: (sess.resendForm.method || 'post').toUpperCase(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: sess.verifyPageUrl || `${ORIGIN}/`,
        Origin: ORIGIN,
      },
      body: form.toString(),
    },
    { jar: sess.jar, dispatcher: sess.dispatcher }
  );

  if (res.status >= 400) {
    const reason = extractFlashError(res.text);
    throw new WebLoginError('RESEND_FAILED', reason || `重发失败（HTTP ${res.status}）`, 502);
  }
  return { hint: '验证码已重新发送' };
}

module.exports = {
  loginAndCreateToken,
  submitVerificationCode,
  resendVerificationCode,
  WebLoginError,
};

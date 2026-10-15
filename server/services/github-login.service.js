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

function extractFlashError(html) {
  const s = String(html);
  const m = s.match(/flash-error[\s\S]{0,400}?<[^>]*>([^<]{4,220})</i);
  if (m) return m[1].trim();
  const m2 = s.match(/js-flash-alert[^>]*>\s*(?:<[^>]+>\s*)?([^<]{4,220})/i);
  if (m2) return m2[1].trim();
  const m3 = s.match(/role="alert"[\s\S]{0,300}?([^<]{4,220})</i);
  return m3 ? m3[1].trim() : '';
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

    if (res2.status >= 300 && res2.status < 400) {
      const loc = String(res2.headers.get('location') || '');
      if (/two-factor|two_factor|2fa/i.test(loc)) {
        throw new WebLoginError(
          'TWO_FACTOR',
          '该账号启用了两步验证（2FA），暂不支持自动登录。请手动创建 Token 后以 Token 方式添加。',
          428
        );
      }
      if (/\/login/.test(loc)) {
        throw new WebLoginError('BAD_CREDENTIALS', '登录失败：账号或密码错误', 401);
      }
      if (!jar.has('user_session')) {
        throw new WebLoginError('BAD_CREDENTIALS', '登录失败：账号或密码错误', 401);
      }
    } else if (res2.status === 200) {
      const page = res2.text;
      const flash = extractFlashError(page);
      // 明确的密码错误文案优先判定（避免误伤）
      if (/incorrect username or password|invalid.{0,12}(login|credentials)|账号或密码/i.test(flash)) {
        throw new WebLoginError('BAD_CREDENTIALS', '登录失败：账号或密码错误', 401);
      }
      // 真正的验证挑战特征（区别于页面 feature flags 中的 captcha 字样）
      if (
        /data-sitekey|octocaptcha-frame|verify-device|unusual activity|suspicious.{0,20}(activity|login)|confirm your (identity|password)/i.test(
          page
        )
      ) {
        throw new WebLoginError(
          'CAPTCHA',
          'GitHub 要求人工验证（验证码/风控）。请先在浏览器中用该账号登录一次 GitHub，再回到这里重试。',
          403
        );
      }
      throw new WebLoginError('BAD_CREDENTIALS', `登录失败：${flash || '账号或密码错误'}`, 401);
    } else {
      throw new WebLoginError('NETWORK', `登录请求异常（HTTP ${res2.status}）`, 502);
    }

    /* 3. Token 创建页 */
    const newPage = await request(`${ORIGIN}/settings/tokens/new`, {}, { jar, dispatcher });
    if (newPage.status !== 200) {
      throw new WebLoginError('CREATE_FAILED', `无法打开 Token 创建页（HTTP ${newPage.status}）`, 502);
    }
    const csrf2 = extractCsrf(newPage.text);
    const scopes = [
      ...new Set(
        [...newPage.text.matchAll(/name="oauth_access\[scopes\]\[\]" value="([^"]+)"/g)].map((m) => m[1])
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
        logger.warn('Token 备注名冲突，自动换名重试', { login: username, attempt: attempt + 2 });
        continue;
      }
      break;
    }

    if (!token) {
      throw new WebLoginError('CREATE_FAILED', `Token 创建失败（${lastError}）`, 502);
    }

    const durationMs = Date.now() - t0;
    logger.info('网页登录自动创建 Token 成功', {
      login: username,
      scopes: scopes.length,
      channel,
      note: usedNote,
      durationMs,
    });
    return { token, scopes, channel, durationMs, note: usedNote };
  } finally {
    if (dispatcher && typeof dispatcher.close === 'function') dispatcher.close().catch(() => {});
  }
}

module.exports = {
  loginAndCreateToken,
  WebLoginError,
};

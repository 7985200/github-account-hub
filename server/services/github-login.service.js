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
const fs = require('fs');
const path = require('path');
const config = require('../config');
const proxy = require('./proxy.service');
const logger = require('../utils/logger');
const { pruneDebugFiles } = require('../utils/debug-files');

// 目标站点（可用 GITHUB_WEB_ORIGIN 覆盖，便于自动化测试与 GitHub Enterprise）
const ORIGIN = process.env.GITHUB_WEB_ORIGIN || 'https://github.com';
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
/**
 * 判断提取到的文案是否「可以给用户看」。
 * GitHub 的页面里混有未渲染的前端模板占位符（实测会取到 `{{ message }}`），
 * 这类文本必须丢弃，否则会原样弹给用户。
 */
function isDisplayableMessage(text) {
  const t = String(text || '').trim();
  if (t.length < 4 || t.length > 300) return false;
  if (/\{\{|\}\}|\$\{|<%|%>/.test(t)) return false; // 模板占位符
  if (/[<>]|="|class=|id=/.test(t)) return false; // HTML 属性泄漏（弱兜底正则可能把标签属性带出来）
  if (/^[\s\W_]+$/.test(t)) return false; // 纯符号
  if (!/[A-Za-z\u4e00-\u9fa5]/.test(t)) return false; // 至少含一个中英文字母
  return true;
}

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
    if (isDisplayableMessage(text)) return text;
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
/* verifyId -> { jar, dispatcher, login, description, channel, createdAt,
   verifyType, codeForm, resendForm, hint, purpose, payload }
   purpose: 'token'（默认，验证后建 Token）| 'avatar'（验证后继续头像上传） */
const pendingVerifications = new Map();
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

/**
 * 取出 pending 并从表中移除，但**不关闭 dispatcher** —— 用于把已验证的会话
 * 交接给调用方继续使用（如头像上传）。调用方用完需自行 close。
 */
function takeOutPending(verifyId) {
  const sess = takePending(verifyId);
  pendingVerifications.delete(String(verifyId));
  return sess;
}

/** 关闭某条 pending 的 dispatcher（不抛错） */
function closeSessionDispatcher(sess) {
  if (sess && sess.dispatcher && typeof sess.dispatcher.close === 'function') {
    sess.dispatcher.close().catch(() => {});
  }
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
        const maxLen = Number((tag.match(/maxlength="(\d+)"/i) || [])[1] || 0);
        return {
          name: (tag.match(/name="([^"]*)"/i) || [])[1] || '',
          value: (tag.match(/value="([^"]*)"/i) || [])[1] || '',
          type: ((tag.match(/type="([^"]*)"/i) || [])[1] || 'text').toLowerCase(),
          maxLength: Number.isFinite(maxLen) ? maxLen : 0,
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
      codeForm = {
        action: f.action,
        method: f.method,
        hidden: f.inputs.filter((i) => i.type === 'hidden'),
        codeField: codeInput.name,
        codeLength: codeInput.maxLength || 0,
      };
      break;
    }
  }
  if (!codeForm) {
    for (const f of forms) {
      const textInput = f.inputs.find((i) => ['text', 'tel', 'number', 'password'].includes(i.type));
      if (textInput) {
        codeForm = {
          action: f.action,
          method: f.method,
          hidden: f.inputs.filter((i) => i.type === 'hidden'),
          codeField: textInput.name,
          codeLength: textInput.maxLength || 0,
        };
        break;
      }
    }
  }

  // 兜底：GitHub 部分页面为 React 渲染，表单数据内嵌在 <script type="application/json"> 中
  if (!codeForm) {
    const embedded = src.match(
      /<script[^>]*type="application\/json"[^>]*data-target="react-app\.embeddedData"[^>]*>([\s\S]*?)<\/script>/i
    );
    if (embedded) {
      try {
        const flat = JSON.stringify(JSON.parse(embedded[1]));
        const token = (flat.match(/"authenticity_token":"([^"]+)"/) || [])[1] || '';
        const fieldMatch = flat.match(/"(otp|verification_code|user_verification_code|code)"/i);
        if (token && fieldMatch) {
          codeForm = {
            action: location || '/sessions/verified-device',
            method: 'post',
            hidden: [{ name: 'authenticity_token', value: token }],
            codeField: fieldMatch[1],
            codeLength: 0, // React 内嵌数据里拿不到 maxlength，交给前端按宽松策略处理
          };
        }
      } catch {
        /* 忽略：解析失败则继续走后续兜底 */
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

  // 验证类型：从「发送提示句」判断（页面导航等噪声含 mobile/email 等词，不能整页匹配）
  const lower = src.toLowerCase();
  const loc = String(location || '').toLowerCase();
  const sentSentence = ((src.match(/(?:we |)(?:sent|emailed)[^<]{0,160}/i) || [''])[0] || '').toLowerCase();
  const probe = sentSentence || lower;
  let verifyType = 'email';
  if (/authenticator app|authentication app/.test(probe)) {
    verifyType = 'totp';
  } else if (/via email|by email|email to|to your email|email address|check your (email|inbox)/.test(probe)) {
    verifyType = 'email';
  } else if (/via sms|text message|phone number|mobile number|sms/.test(probe)) {
    verifyType = 'sms';
  } else if (/two-factor|two_factor|2fa/.test(loc)) {
    verifyType = 'totp';
  }

  // 是否已自动发送过验证码
  const alreadySent = /we (sent|emailed)|sent a (code|message)|has been sent|check your (email|inbox)/i.test(src);

  // 中文提示（提取脱敏邮箱，不直接透出 GitHub 英文原文）
  // 注意：GitHub 页面上的邮箱可能本身已脱敏（含 * 字符），正则需兼容
  const emailMatch = src.match(/[a-zA-Z0-9._%+*-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const maskedEmail = emailMatch ? maskEmail(emailMatch[0]) : '';
  let hint = '';
  if (verifyType === 'totp') {
    hint = '请输入两步验证器（Authenticator App）中的 6 位验证码';
  } else if (verifyType === 'sms') {
    hint = '验证码已发送至该账号绑定的手机号，请查收后输入';
  } else {
    hint = maskedEmail
      ? `验证码已发送至邮箱 ${maskedEmail}，请查收后输入`
      : '验证码已发送至该账号绑定的邮箱，请查收后输入';
  }

  return { codeForm, resendForm, verifyType, hint, alreadySent };
}

/* ----------------------------- 主流程 ----------------------------- */

/**
 * 登录 GitHub 并创建全权限（51 项）永不过期 Token
 * @param {{ login: string, password: string, description?: string }} payload
 * @returns {Promise<{ token: string, scopes: string[], channel: string, durationMs: number }>}
 */
/**
 * 识别 GitHub 登录页上的「非密码错误的拦截原因」。
 *
 * 背景：新版登录页把 flash 文案交给前端渲染，服务端 HTML 里只留 `{{ message }}` 占位符；
 * 真实原因反而以**正文纯文本**出现，例如限流提示：
 *   "There have been several failed attempts to sign in from this account or IP address.
 *    Please wait a while and try again later."
 * 若不做识别，用户会看到「登录未完成（HTTP 302）」这种毫无帮助的提示，
 * 甚至被误导为「账号或密码错误」。
 *
 * @returns {{code:string, message:string, httpStatus:number}|null}
 */
function detectLoginBlocker(html) {
  const src = String(html || '');
  const text = src
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  if (/several failed attempts to sign in/i.test(text) || /try again later/i.test(text) && /failed attempts/i.test(text)) {
    return {
      code: 'RATE_LIMITED',
      message:
        'GitHub 检测到该账号或当前 IP 短时间内登录失败次数过多，已临时限制登录。请等待一段时间（通常几十分钟到数小时）后再试。',
      httpStatus: 429,
    };
  }
  if (/account has been (suspended|flagged|locked)/i.test(text)) {
    return { code: 'ACCOUNT_BLOCKED', message: '该 GitHub 账号已被限制或封禁，无法通过网页登录。', httpStatus: 403 };
  }
  if (/unusual activity|verify your identity|we need to verify/i.test(text)) {
    return {
      code: 'NEED_VERIFY',
      message: 'GitHub 要求先进行身份验证（非常用设备/异常活动）。请在浏览器中先用该账号登录一次后再试。',
      httpStatus: 428,
    };
  }
  return null;
}


/**
 * 按「真实浏览器」的方式拼登录表单。
 * 关键：登录页除 login/password 外还有 timestamp、timestamp_secret、蜜罐
 * required_field_xxx、webauthn-* 等字段，浏览器会全部提交。
 * 只挑 4 个字段提交，可能被判为非正常请求而返回通用的凭据错误。
 */
/**
 * 密码被拒时的统一提示。
 * 实测：GitHub 对「密码确实不对」和「静默拒绝（代理/机房 IP、高风险账号）」
 * 返回的是同一句 Incorrect username or password.，且不会有任何限流提示；
 * 这种情况下等多久都不会恢复（实测静默 70 分钟仍失败），所以不能引导用户"等一会儿再试"。
 */
const BAD_CREDENTIALS_HINT =
  '登录失败：GitHub 返回「Incorrect username or password.」，且没有出现限流提示。只有两种可能：' +
  '① 该账号当前的密码已经不是这里填写的密码；' +
  '② GitHub 对当前出口 IP 或该账号做了静默拒绝（机房/代理 IP、新注册账号常见，表现就是这句通用错误）。' +
  '建议先在浏览器里换一个网络，用同一密码登录一次确认；或改用「Token 添加」方式。';

function attrOf(tag, name) {
  const re = new RegExp(`(?<![-\\w])${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return '';
  return (m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '').trim();
}

function buildLoginBody(html, { login, password }) {
  const src = String(html || '');
  const formMatch = src.match(/<form[^>]*action="\/session"[^>]*>([\s\S]*?)<\/form>/i);
  const scope = formMatch ? formMatch[1] : src;
  const body = new URLSearchParams();
  for (const tag of scope.match(/<input\b[^>]*>/gi) || []) {
    const type = (attrOf(tag, 'type') || 'text').toLowerCase();
    if (['submit', 'button', 'file', 'image', 'reset'].includes(type)) continue;
    const name = attrOf(tag, 'name');
    if (!name) continue;
    if (name === 'login') { body.append(name, login); continue; }
    if (name === 'password') { body.append(name, password); continue; }
    body.append(name, attrOf(tag, 'value'));
  }
  if (!body.has('commit')) body.append('commit', 'Sign in');
  return body;
}

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
  const dispatcher = channel === 'direct' ? undefined : proxy.buildDispatcher(channel);
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
    // 按浏览器的方式提交登录页的完整表单（含 timestamp / 蜜罐等字段）
    const body = buildLoginBody(loginPage.text, { login: username, password: pwd });
    logger.info('提交登录表单', { login: username, fields: [...body.keys()].length });
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

    /* 3a. 登录响应直接指向验证页（设备验证 / 两步验证）→ 立即建立验证会话
     *     关键：必须先于 Token 页探测执行 —— 实测在验证待完成时请求未授权的
     *     /settings/tokens/new 会破坏 GitHub 的验证会话，导致验证页变 404 */
    const loc2 = String(res2.headers.get('location') || '');
    if (/verified-device|two-factor|two_factor|sessions\/(verified|two)/i.test(loc2)) {
      const ctx = await tryBuildVerification({ loc: loc2, jar, dispatcher, login: username });
      if (ctx) {
        keepSession = true; // dispatcher 交由验证会话持有，不在 finally 中关闭
        const verifyId = putPending({
          jar,
          dispatcher,
          login: username,
          description,
          channel,
          verifyType: ctx.verifyType,
          hint: ctx.hint,
          codeForm: ctx.codeForm,
          resendForm: ctx.resendForm,
          verifyPageUrl: ctx.verifyPageUrl,
        });
        logger.info('登录需要额外验证，已建立验证会话', { login: username, verifyType: ctx.verifyType });
        return {
          needsVerify: true,
          verifyId,
          verifyType: ctx.verifyType,
          hint: ctx.hint,
          codeLength: ctx.codeLength || 0,
          expiresInSec: Math.floor(VERIFY_TTL_MS / 1000),
        };
      }
      logger.warn('登录响应指向验证页但未能建立验证会话', { login: username, location: loc2 });
    }

    /* 3b. 判定登录态：直接尝试打开 Token 创建页（已登录才可访问）
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
        // 用户拿这个 id 找 GitHub 支持时，对方才能查到这次拒登的具体原因
        requestId: String(res2.headers.get('x-github-request-id') || ''),
        tokenPageStatus: newPage.status,
      });

      // ⓪ 先排除「非密码错误」的拦截（限流 / 封禁 / 要求身份验证）——必须早于密码错误判断
      const blocker = detectLoginBlocker(res2.text);
      if (blocker) {
        logger.warn('网页登录被 GitHub 拦截', { login: username, code: blocker.code });
        throw new WebLoginError(blocker.code, blocker.message, blocker.httpStatus);
      }

      // ① 明确的密码错误（GitHub 在登录页回显的 flash 文案）
      if (/incorrect username or password|invalid.{0,12}(login|credentials)/i.test(flash)) {
        throw new WebLoginError('BAD_CREDENTIALS', BAD_CREDENTIALS_HINT, 401);
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
        `GitHub 要求设备/邮箱验证，但未能自动识别验证页面（响应 ${res2.status}${loc ? `，跳转 ${loc}` : ''}）。` +
          '可先在浏览器中登录一次该账号后重试，或改用「Token 添加」方式。',
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

/** 保存验证页 HTML 供诊断（解析失败时），返回文件路径 */
function saveVerifyDebug(html, url, login) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    /* 验证页含 CSRF token 与脱敏邮箱，只保留最近 5 份 */
    pruneDebugFiles(config.dataDir, 'verify-debug-', 5);
    const file = path.join(config.dataDir, `verify-debug-${Date.now()}.html`);
    fs.writeFileSync(
      file,
      `<!-- url: ${url}\n     login: ${login}\n     time: ${new Date().toISOString()} -->\n${html}`,
      'utf8'
    );
    return file;
  } catch (err) {
    logger.warn('保存验证页诊断文件失败', { error: err.message });
    return '';
  }
}

/** 尝试建立验证会话：访问验证页 → 解析表单 → 必要时自动触发发送验证码 */
async function tryBuildVerification({ loc, jar, dispatcher, login }) {
  let target = '';
  if (loc && /^https?:/i.test(loc)) target = loc;
  else if (loc && /sessions|two-factor|verify/i.test(loc)) target = `${ORIGIN}${loc}`;
  else target = `${ORIGIN}/sessions/verified-device`;

  /* 访问验证页：手动跟随重定向（GitHub 常先 302 到带参数的验证页） */
  let page = null;
  let current = target;
  for (let hop = 0; hop < 6; hop += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      page = await request(current, { headers: { Referer: `${ORIGIN}/login` } }, { jar, dispatcher });
    } catch (err) {
      logger.warn('验证页访问失败', { target: current, error: err.message });
      return null;
    }
    if (page.status >= 300 && page.status < 400) {
      const next = String(page.headers.get('location') || '');
      if (!next) break;
      current = next.startsWith('http') ? next : `${ORIGIN}${next}`;
      continue;
    }
    break;
  }
  const finalUrl = current;

  if (!page || page.status !== 200) {
    logger.warn('验证页响应异常', { target: finalUrl, status: page ? page.status : 'n/a' });
    if (page && page.text) saveVerifyDebug(page.text, finalUrl, login);
    return null;
  }

  const parsed = parseVerifyPage(page.text, loc || finalUrl);
  if (!parsed.codeForm) {
    const debugFile = saveVerifyDebug(page.text, finalUrl, login);
    logger.warn('未能解析出验证码表单', {
      target: finalUrl,
      pageSize: page.text.length,
      debugFile,
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
    /* 验证码位数：0 表示页面没给 maxlength（未知），前端需按宽松策略处理 */
    codeLength: (parsed.codeForm && parsed.codeForm.codeLength) || 0,
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

  /* 非「建 Token」用途（如头像上传）：把已验证的会话交给调用方继续，
     并顺手把「个人资料设置页」拉下来（这正是头像上传要解析的页面） */
  if (sess.purpose && sess.purpose !== 'token') {
    const settings = await request(`${ORIGIN}/settings/profile`, {}, { jar: sess.jar, dispatcher: sess.dispatcher });
    const handed = takeOutPending(verifyId);
    logger.info('验证码通过，网页会话已交接给调用方', {
      login: sess.login,
      purpose: sess.purpose,
      settingsStatus: settings.status,
    });
    return {
      sessionReady: true,
      purpose: sess.purpose,
      payload: handed.payload || null,
      session: {
        jar: handed.jar,
        dispatcher: handed.dispatcher,
        login: handed.login,
        settingsHtml: settings.status === 200 ? settings.text : '',
        settingsStatus: settings.status,
        channel: proxy.maskProxy(handed.channel),
      },
      durationMs: Date.now() - t0,
    };
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
    channel: proxy.maskProxy(sess.channel),
  });
  return {
    token: created.token,
    scopes: created.scopes,
    channel: proxy.maskProxy(sess.channel),
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

/**
 * 只建立「网页登录会话」，不创建 Token。
 * 供头像上传等必须在网页侧完成的操作用（GitHub 没有头像 API）。
 *
 * @returns {{jar:CookieJar, dispatcher:*, login:string, settingsHtml:string}}
 * @throws {WebLoginError}
 *   - NEED_VERIFY(428)：本次登录触发设备/邮箱验证，调用方需提示用户改用「密码换 Token」先过验证
 *   - BAD_CREDENTIALS(401)：账号或密码错误
 */
async function openWebSession({ login, password, purpose = 'token', payload = null, awaitVerify = false } = {}) {
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
  const dispatcher = channel === 'direct' ? undefined : proxy.buildDispatcher(channel);
  const jar = new CookieJar();

  /* 从这里开始的所有路径都要保证 dispatcher 不泄漏：
     成功时把 dispatcher 交给调用方（或存进 pending 会话），失败时在这里统一关闭。 */
  try {
  /* 1. 登录页 → CSRF + 匿名会话 */
  const loginPage = await request(`${ORIGIN}/login`, {}, { jar, dispatcher });
  if (loginPage.status !== 200) {
    throw new WebLoginError('NETWORK', `无法打开 GitHub 登录页（HTTP ${loginPage.status}）`, 502);
  }
  const csrf1 = extractCsrf(loginPage.text);
  if (!csrf1) throw new WebLoginError('NETWORK', '登录页结构异常（未找到 CSRF token）', 502);

  /* 2. 提交账密（提交登录页的完整表单，不只是 4 个字段） */
  const body = buildLoginBody(loginPage.text, { login: username, password: pwd });
  logger.info('提交登录表单', { login: username, fields: [...body.keys()].length });
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

  /* 3. 设备验证 / 两步验证：建立验证会话
   *    - awaitVerify=true：把会话暂存进 pending，返回 428 + verifyId，
   *      由前端弹出验证码输入框（与「密码换 Token」完全同一套机制）
   *    - awaitVerify=false：直接抛错，由上层提示用户 */
  const loc2 = String(res2.headers.get('location') || '');
  if (/verified-device|two-factor|two_factor|sessions\/(verified|two)/i.test(loc2)) {
    const ctx = await tryBuildVerification({ loc: loc2, jar, dispatcher, login: username });
    if (ctx && awaitVerify) {
      const verifyId = putPending({
        jar,
        dispatcher,
        login: username,
        purpose,
        payload,
        channel,
        verifyType: ctx.verifyType,
        hint: ctx.hint,
        codeForm: ctx.codeForm,
        resendForm: ctx.resendForm,
        verifyPageUrl: ctx.verifyPageUrl,
      });
      logger.info('已建立验证会话（等待用户输入验证码）', {
        login: username,
        purpose,
        verifyType: ctx.verifyType,
      });
      return {
        needsVerify: true,
        verifyId,
        verifyType: ctx.verifyType,
        hint: ctx.hint,
        codeLength: ctx.codeLength || 0,
        expiresInSec: Math.floor(VERIFY_TTL_MS / 1000),
      };
    }
    throw new WebLoginError(
      'NEED_VERIFY',
      '该账号本次登录需要邮箱/设备验证码，但未能建立验证会话，请稍后重试。',
      428
    );
  }

  /* 4. 判定登录态：能打开「个人资料设置页」即为已登录，同时该页面正是待解析的头像表单来源 */
  const settings = await request(`${ORIGIN}/settings/profile`, {}, { jar, dispatcher });
  if (settings.status !== 200) {
    /* 先看是不是被限流/封禁/要求身份验证 —— 这类原因不能报成「密码错误」 */
    const blocker = detectLoginBlocker(res2.text) || detectLoginBlocker(settings.text);
    if (blocker) {
      logger.warn('网页登录被 GitHub 拦截', { login: username, code: blocker.code, from: 'openWebSession' });
      throw new WebLoginError(blocker.code, blocker.message, blocker.httpStatus);
    }
    const flash = res2.status === 200 ? extractFlashError(res2.text) : '';
    if (flash) {
      const msg = /incorrect username or password|invalid.{0,12}(login|credentials)/i.test(flash)
        ? BAD_CREDENTIALS_HINT
        : `登录失败：${flash}`;
      throw new WebLoginError('BAD_CREDENTIALS', msg, 401);
    }
    throw new WebLoginError(
      'LOGIN_FAILED',
      `登录未完成（个人资料设置页返回 HTTP ${settings.status}）。可能是 GitHub 要求额外验证或临时限制，请稍后重试。`,
      428
    );
  }

  return { jar, dispatcher, login: username, settingsHtml: settings.text };
  } catch (err) {
    if (dispatcher && typeof dispatcher.close === 'function') dispatcher.close().catch(() => {});
    throw err;
  }
}

module.exports = {
  loginAndCreateToken,
  submitVerificationCode,
  resendVerificationCode,
  openWebSession,
  WebLoginError,
  ORIGIN,
  UA,
  CookieJar,
  closeSessionDispatcher,
};

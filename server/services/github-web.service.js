'use strict';

/**
 * GitHub 网页侧操作（目前只有「头像上传」）
 *
 * 为什么必须走网页：
 *   已用真实 Token 实测确认 GitHub 没有头像 API ——
 *     GET/POST /user/avatar   → 404
 *     GET/POST /user/profile  → 404
 *     GraphQL mutation 列表   → 无任何 avatar / profile 相关 mutation
 *   官方 rest-api-description 规范中也不存在 avatar 端点。
 *
 * 头像上传不是普通表单，而是 GitHub 的 Alambic 上传：
 *   设置页里 <input type="file"> 没有 name，外层 <form> 也没有 enctype，
 *   直接 multipart POST 到 form.action 会被 GitHub 以 HTTP 400 拒绝。
 * 真实流程（与网页端 JS 一致）：
 *   1. 从设置页解析 data-upload-policy-url / data-alambic-owner-* / 策略 CSRF
 *   2. POST 策略地址申请上传策略，拿到存储表单（form.url + form.fields）与 asset 信息
 *   3. 把文件 POST 到存储表单地址（不带 GitHub Cookie、不带 GitHub CSRF）
 *   4. 用 asset.href 挂到账号：先 PUT asset.href，失败再退回表单提交
 *   5. 重新拉设置页，确认头像地址真的变了才算成功
 *
 * 所有参数都从页面动态解析，不硬编码端点，GitHub 改版后只要结构还在就能继续工作。
 * 安全约定：密码只用于本次登录，不落库、不写日志。
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
/* 必须用 undici 的 fetch 与 FormData：
   - 全局 fetch 与同项目 undici 的 ProxyAgent 不兼容
   - 全局 FormData 在 undici fetch 下不会序列化成 multipart（会变成 '[object FormData]'） */
const { fetch, FormData } = require('undici');
const loginSvc = require('./github-login.service');
const { openWebSession, WebLoginError, ORIGIN, UA } = loginSvc;
const { encrypt, decrypt } = require('../utils/crypto');
const { pruneDebugFiles } = require('../utils/debug-files');
const proxy = require('./proxy.service');
const { ProxyAgent } = require('undici');

/** 建一个走当前网页通道的 dispatcher */
async function webDispatcher() {
  const channel = await proxy.resolveWebChannel();
  return channel === 'direct' ? undefined : proxy.buildDispatcher(channel);
}

/**
 * 网页会话缓存（内存）。
 * 为什么要缓存：每次上传都重新登录一次 GitHub，一旦失败重试，
 * 就会因为「短时间多次登录」触发限流（401/429），越试越久。
 * 缓存后，重试直接复用已登录会话，不再消耗登录额度。
 */
/* 登录 Cookie 持久化存储（按账号，加密落盘）。放在 data/ 下，已在 .gitignore 内。 */
const SESSION_STORE = path.join(__dirname, '..', '..', 'data', 'web-sessions.json');

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_STORE, 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(obj) {
  try {
    fs.mkdirSync(path.dirname(SESSION_STORE), { recursive: true });
    fs.writeFileSync(SESSION_STORE, JSON.stringify(obj), 'utf8');
  } catch (err) {
    logger.warn('保存网页会话失败', { error: err.message });
  }
}

function saveStoredSession(login, jar) {
  if (!login || !jar || !jar.header()) return;
  const store = readStore();
  store[String(login)] = { enc: encrypt(jar.header()), at: Date.now() };
  writeStore(store);
}

function loadStoredSession(login) {
  const store = readStore();
  const entry = store[String(login || '')];
  if (!entry || !entry.enc) return null;
  try {
    return { header: decrypt(entry.enc), at: entry.at || 0 };
  } catch {
    return null;
  }
}

function jarFromHeader(header) {
  const jar = new loginSvc.CookieJar();
  for (const pair of String(header || '').split(';')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    jar.map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return jar;
}

const SESSION_TTL_MS = 8 * 60 * 1000;
const sessionCache = new Map(); // login -> { jar, dispatcher, at }

function getCachedSession(login) {
  const hit = sessionCache.get(String(login || ''));
  if (!hit) return null;
  if (Date.now() - hit.at > SESSION_TTL_MS) {
    sessionCache.delete(String(login));
    if (hit.dispatcher && typeof hit.dispatcher.close === 'function') hit.dispatcher.close().catch(() => {});
    return null;
  }
  return hit;
}

function putCachedSession(login, jar, dispatcher) {
  sessionCache.set(String(login || ''), { jar, dispatcher, at: Date.now() });
}

function dropCachedSession(login) {
  const key = String(login || '');
  const hit = sessionCache.get(key);
  if (hit && hit.dispatcher && typeof hit.dispatcher.close === 'function') hit.dispatcher.close().catch(() => {});
  sessionCache.delete(key);
}

const ALLOWED_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };
const MAX_BYTES = 1024 * 1024; // GitHub 头像上限 1MB

/** 把页面快照落盘，失败时便于排查（同 verify-debug 的做法） */
function saveDebug(html, login) {
  try {
    const dir = path.join(__dirname, '..', '..', 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `avatar-debug-${String(login).replace(/[^\w.-]/g, '_')}-${Date.now()}.html`);
    fs.writeFileSync(file, html, 'utf8');
    /* 只保留最近 3 个快照，避免长期堆积（页面里含邮箱与 CSRF token） */
    try {
      const kept = fs
        .readdirSync(dir)
        .filter((n) => /^avatar-debug-.*\.html$/.test(n))
        .sort()
        .slice(-3);
      for (const n of fs.readdirSync(dir)) {
        if (/^avatar-debug-.*\.html$/.test(n) && !kept.includes(n)) fs.unlinkSync(path.join(dir, n));
      }
    } catch { /* 清理失败不影响主流程 */ }
    logger.warn('头像表单解析失败，已保存页面快照', { file });
    return file;
  } catch (err) {
    logger.warn('保存头像调试快照失败', { error: err.message });
    return '';
  }
}

/** 解析 HTML 属性值（支持单双引号与无引号） */
function attr(tag, name) {
  /* 用负向后顾排除 data-* 前缀：\b 会把 data-action 里的 action 也匹配上 */
  const re = new RegExp(`(?<![-\\w])${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return '';
  return (m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '').trim();
}

/** 解码 HTML 实体（CSRF token 里可能含 &amp; 等） */
function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 相对地址补全为绝对地址 */
function toAbsolute(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return ORIGIN + (s.startsWith('/') ? '' : '/') + s;
}

/**
 * 从设置页 HTML 解析 Alambic 上传所需的全部参数。
 * 解析不到返回 null；解析到但某些字段缺失由调用方判断（便于给出「缺哪一个」的错误）。
 *
 * @returns {null|{
 *   policyUrl:string, ownerId:string, ownerType:string, policyCsrf:string,
 *   formAction:string, formMethod:string, formToken:string, methodOverride:string,
 *   declaredField:string, fileInputId:string
 * }}
 */
function parseAvatarUploadContext(html) {
  const src = String(html || '');

  /* 找带 data-upload-policy-url 的 <file-attachment>（页面上可能不止一个） */
  const tagRe = /<file-attachment\b[^>]*>/gi;
  let openTag = '';
  let tagStart = -1;
  let m;
  while ((m = tagRe.exec(src))) {
    if (attr(m[0], 'data-upload-policy-url')) {
      openTag = m[0];
      tagStart = m.index;
      break;
    }
  }
  if (!openTag) return null;

  const innerStart = tagStart + openTag.length;
  const innerEnd = src.indexOf('</file-attachment>', innerStart);
  const inner = src.slice(innerStart, innerEnd === -1 ? innerStart + 8000 : innerEnd);

  /* 策略请求用的 CSRF：file-attachment 里那个没有 name、只有 data-csrf="true" 的隐藏 input */
  const csrfInput = (inner.match(/<input\b[^>]*data-csrf\s*=\s*(?:"true"|'true'|true)[^>]*>/i) || [])[0] || '';
  const policyCsrf = csrfInput ? decodeEntities(attr(csrfInput, 'value')) : '';

  /* 包住它的 <form>：从 file-attachment 往前找最近的 <form 开标签 */
  const formStart = src.lastIndexOf('<form', tagStart);
  let formOpenTag = '';
  let formHead = '';
  if (formStart !== -1) {
    const formOpenEnd = src.indexOf('>', formStart);
    formOpenTag = src.slice(formStart, formOpenEnd === -1 ? formStart + 3000 : formOpenEnd + 1);
    formHead = src.slice(formStart, tagStart);
  }

  const tokenInput = (formHead.match(/<input\b[^>]*name\s*=\s*["']authenticity_token["'][^>]*>/i) || [])[0] || '';
  const formToken = tokenInput ? decodeEntities(attr(tokenInput, 'value')) : '';
  const methodInput = (formHead.match(/<input\b[^>]*name\s*=\s*["']_method["'][^>]*>/i) || [])[0] || '';
  const methodOverride = methodInput ? attr(methodInput, 'value').toLowerCase() : '';

  const fileInput = (inner.match(/<input\b[^>]*type\s*=\s*["']?file\b[^>]*>/i) || [])[0] || '';
  const fileInputId = attr(fileInput, 'id') || attr(openTag, 'input');

  const pickMeta = (name) => {
    const m = src.match(new RegExp('<meta[^>]*name="' + name + '"[^>]*content="([^"]*)"', 'i'));
    return m ? m[1] : '';
  };

  return {
    fetchNonce: pickMeta('fetch-nonce'),
    release: pickMeta('release'),
    policyUrl: attr(openTag, 'data-upload-policy-url'),
    ownerId: attr(openTag, 'data-alambic-owner-id'),
    ownerType: attr(openTag, 'data-alambic-owner-type'),
    policyCsrf,
    formAction: attr(formOpenTag, 'action'),
    formMethod: (attr(formOpenTag, 'method') || 'post').toLowerCase(),
    formToken,
    methodOverride,
    /* 只是页面上 file input 的 id，不是真实提交字段名（真实字段名由策略响应决定） */
    declaredField: attr(fileInput, 'name') || fileInputId || '',
    fileInputId,
  };
}

/**
 * 旧版解析：在设置页 HTML 中寻找「含 file input 的表单」。
 * 现在上传流程已改为 Alambic，这个函数仅作为兼容导出保留。
 * @returns {{action:string, fileField:string, hidden:Array<[string,string]>}|null}
 */
function parseAvatarForm(html) {
  const forms = String(html).match(/<form\b[^>]*>[\s\S]*?<\/form>/gi) || [];
  for (const form of forms) {
    const inputs = form.match(/<input\b[^>]*>/gi) || [];
    const fileInput = inputs.find((t) => /type\s*=\s*["']?file/i.test(t));
    if (!fileInput) continue;

    const action = attr(form, 'action');
    const fileField = attr(fileInput, 'name') || attr(fileInput, 'id') || 'avatar';
    const hidden = [];
    for (const t of inputs) {
      if (t === fileInput) continue;
      const type = (attr(t, 'type') || 'text').toLowerCase();
      if (['file', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
      const name = attr(t, 'name');
      if (!name) continue;
      hidden.push([name, decodeEntities(attr(t, 'value'))]);
    }
    if (/put|patch/i.test(attr(form, 'method')) && !hidden.some(([n]) => n === '_method')) {
      hidden.push(['_method', attr(form, 'method').toLowerCase()]);
    }
    return { action: action || '/settings/profile', fileField, hidden };
  }
  return null;
}

/** 摘出页面里所有表单的结构（仅用于失败诊断，不含字段值） */
function summarizeForms(html) {
  const out = [];
  const forms = String(html).match(/<form\b[^>]*>[\s\S]*?<\/form>/gi) || [];
  forms.forEach((fm, i) => {
    const inputs = (fm.match(/<input\b[^>]*>/gi) || [])
      .map((t) => ({
        name: attr(t, 'name') || '',
        type: (attr(t, 'type') || 'text').toLowerCase(),
        maxlength: attr(t, 'maxlength') || '',
        accept: attr(t, 'accept') || '',
      }))
      .filter((x) => x.name);
    out.push({
      index: i,
      action: attr(fm, 'action'),
      method: attr(fm, 'method') || 'get',
      enctype: attr(fm, 'enctype'),
      hasFile: /type\s*=\s*["']?file/i.test(fm),
      inputs,
    });
  });
  return out;
}

/** 头像上传失败时的现场快照 */
function dumpAvatarFailure(payload, { login } = {}) {
  try {
    const dir = path.join(__dirname, '..', '..', 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const stamp = Date.now();
    const safeLogin = String(login || 'unknown').replace(/[^\w.-]/g, '_');
    const htmlFile = path.join(dir, `avatar-fail-${safeLogin}-${stamp}.html`);
    const jsonFile = path.join(dir, `avatar-fail-${safeLogin}-${stamp}.json`);
    if (payload.settingsHtml) fs.writeFileSync(htmlFile, payload.settingsHtml, 'utf8');
    const meta = { ...payload };
    delete meta.settingsHtml;
    fs.writeFileSync(jsonFile, JSON.stringify(meta, null, 2), 'utf8');
    /* 快照含 CSRF token/邮箱等敏感内容，只保留最近若干份，避免无限增长 */
    pruneDebugFiles(dir, 'avatar-fail-', 10);
    pruneDebugFiles(dir, 'avatar-crop-', 10);
    logger.warn('头像上传失败，已保存现场快照', { htmlFile, jsonFile });
    return { htmlFile, jsonFile };
  } catch (err) {
    logger.warn('保存头像失败快照出错', { error: err.message });
    return null;
  }
}

/** 从设置页 HTML 里取当前头像地址 */
function parseAvatarUrl(html) {
  const src = String(html || '');
  let scope = src;
  /* 优先取资料页右侧的大头像：它在「Profile picture」区块之后，避免命中顶栏小头像 */
  const anchor = src.indexOf('avatar-upload-container');
  if (anchor !== -1) scope = src.slice(anchor);
  const big = /<img\b[^>]*class\s*=\s*"[^"]*avatar-user[^"]*"[^>]*src\s*=\s*"([^"]+)"/i.exec(scope);
  if (big) return decodeEntities(big[1]);

  const m = /<img\b[^>]*(?:class|alt|id)\s*=\s*"[^"]*avatar[^"]*"[^>]*src\s*=\s*"([^"]+)"/i.exec(src);
  if (m) return decodeEntities(m[1]);
  const m2 = /<img\b[^>]*src\s*=\s*"(https:\/\/avatars\.githubusercontent\.com\/[^"]+)"[^>]*>/i.exec(src);
  return m2 ? decodeEntities(m2[1]) : '';
}

/** 页面 <title>，用于把 GitHub 的错误页转成可读提示 */
function titleHint(html) {
  const m = /<title>([^<]*)<\/title>/i.exec(String(html || ''));
  return m ? m[1].trim().slice(0, 100) : '';
}

/** 统一的请求封装：自动带 dispatcher、不自动跟随跳转、统一超时 */
async function httpRequest(url, opts = {}, { dispatcher, label = '请求' } = {}) {
  const { timeout = 60000, ...rest } = opts;
  let res;
  try {
    res = await fetch(url, {
      ...rest,
      ...(dispatcher ? { dispatcher } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new WebLoginError('NETWORK', `${label}失败：${err.message}`, 502);
  }
  const text = await res.text().catch(() => '');
  return { status: res.status, headers: res.headers, text };
}

/** 校验图片参数（登录前先判，避免为一张不合法的图白跑一次 GitHub 登录） */
function assertImage({ buffer, mime }) {
  if (!buffer || !buffer.length) throw new WebLoginError('BAD_REQUEST', '没有收到图片数据', 400);
  if (buffer.length > MAX_BYTES) {
    throw new WebLoginError('BAD_REQUEST', `图片不能超过 1MB（当前 ${Math.round(buffer.length / 1024)}KB）`, 400);
  }
  if (!ALLOWED_MIME[mime]) {
    throw new WebLoginError('BAD_REQUEST', '头像仅支持 PNG / JPG / GIF 格式', 400);
  }
}

/** 拉取「个人资料设置页」——头像上传所需参数都在这一页 */
async function fetchSettingsPage({ jar, dispatcher }) {
  const res = await fetch(`${ORIGIN}/settings/profile`, {
    headers: { 'User-Agent': UA, Accept: 'text/html', Cookie: jar.header() },
    ...(dispatcher ? { dispatcher } : {}),
    redirect: 'manual',
  });
  /* 必须回收响应里的 Set-Cookie：GitHub 打开设置页时会轮换 _gh_sess，
     页面里的 CSRF token 是跟「新会话」绑定的。继续用旧 Cookie 配新 token，
     提交上传策略时一定被判为 CSRF 失败（422 "Your browser did something unexpected"）。 */
  if (jar && typeof jar.capture === 'function') jar.capture(res.headers);
  const html = res.status === 200 ? await res.text().catch(() => '') : '';
  return { status: res.status, html };
}

/**
 * 第一步：申请上传策略。
 * GitHub 对新版上传要求先 POST 策略地址，拿到存储表单与 asset 描述。
 * CSRF 的传法不唯一：先试 X-CSRF-Token 请求头，失败再试放进 body。
 */
async function requestUploadPolicy({ policyUrl, policyCsrf, ownerType, ownerId, fetchNonce, release, buffer, mime, filename, jar, dispatcher, login, steps }) {
  const url = toAbsolute(policyUrl);

  // 逆向结论：这个接口要 multipart/form-data，CSRF 放在表单字段里，不是请求头
  const fd = new FormData();
  fd.append('name', filename);
  fd.append('size', String(buffer.length));
  fd.append('content_type', mime);
  fd.append('authenticity_token', policyCsrf);
  if (ownerType) fd.append('owner_type', ownerType);
  if (ownerId) fd.append('owner_id', String(ownerId));

  const headers = {
    'User-Agent': UA,
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `${ORIGIN}/settings/profile`,
    Origin: ORIGIN,
  };
  if (fetchNonce) headers['X-Fetch-Nonce'] = fetchNonce;
  if (release) headers['X-GitHub-Client-Version'] = release;
  if (jar && jar.header()) headers.Cookie = jar.header();

  const res = await httpRequest(
    url,
    { method: 'POST', headers, body: fd, timeout: 60000 },
    { dispatcher, label: '申请头像上传策略' }
  );
  if (jar) jar.capture(res.headers);

  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    json = null;
  }

  const ok = res.status >= 200 && res.status < 300 && !!json;
  steps.push({
    step: 'policy',
    status: res.status,
    target: url,
    hasJson: !!json,
    ok,
    bodyHead: String(res.text || '').slice(0, 4000),
  });

  if (!ok) {
    throw new WebLoginError(
      'UPLOAD_POLICY_FAILED',
      `申请头像上传策略失败（HTTP ${res.status}）${titleHint(res.text) ? '：' + titleHint(res.text) : ''}`,
      502
    );
  }
  logger.info('头像上传：申请策略成功', { login, status: res.status, hasUploadUrl: !!json.upload_url });
  return json;
}

/**
 * 第二步：把文件 POST 到策略返回的存储表单。
 * 这里不能带 GitHub 的 Cookie 与 CSRF —— 目标是第三方存储（S3），
 * 带上 GitHub 的凭据不但没用，还可能因为字段校验不通过被拒。
 */
async function submitToStorage({ policy, buffer, mime, filename, jar, dispatcher, login, steps }) {
  const uploadUrl = policy.upload_url;
  if (!uploadUrl) throw new WebLoginError('UPLOAD_POLICY_INVALID', '上传策略里缺少 upload_url', 502);

  const fd = new FormData();
  // 同源存储才需要带上 GitHub 的 CSRF；S3 是第三方，带了反而错
  if (policy.same_origin && policy.upload_authenticity_token) {
    fd.append('authenticity_token', policy.upload_authenticity_token);
  }
  for (const [k, v] of Object.entries(policy.form || {})) {
    if (v !== null && v !== undefined && v !== '') fd.append(k, String(v));
  }
  // 文件必须最后追加：S3 的 policy 校验依赖字段顺序
  fd.append('file', new Blob([buffer], { type: mime }), filename);

  // 策略返回的 header 必须原样带上（含签名相关）
  const headers = { 'User-Agent': UA, ...(policy.header || {}) };
  // same_origin=true 说明目标是 GitHub 自有存储，仍要用会话 Cookie 做身份绑定；
  // 第三方存储（S3）则不能带，带了反而会因签名不符被拒
  if (policy.same_origin && jar && jar.header()) headers.Cookie = jar.header();

  const res = await httpRequest(
    uploadUrl,
    { method: 'POST', headers, body: fd, timeout: 120000 },
    { dispatcher, label: '上传头像到存储' }
  );

  const ok = res.status >= 200 && res.status < 300;
  steps.push({
    step: 'storage',
    status: res.status,
    target: uploadUrl,
    ok,
    fieldNames: Array.from(fd.keys ? fd.keys() : []),
    bodyHead: String(res.text || '').slice(0, 4000),
  });
  logger.info('头像上传：存储返回', { login, status: res.status, ok });

  if (!ok) {
    throw new WebLoginError(
      'UPLOAD_FAILED',
      `上传到头像存储失败（HTTP ${res.status}）${titleHint(res.text) ? '：' + titleHint(res.text) : ''}`,
      502
    );
  }

  let json = null;
  try {
    json = res.text ? JSON.parse(res.text) : null;
  } catch {
    json = null;
  }

  return {
    ok,
    status: res.status,
    json,
    digestSha: res.headers.get('x-digest-sha256') || '',
    digestHmac: res.headers.get('x-digest-sha256-hmac') || '',
  };
}

/** 第三步之一：PUT asset.href 确认资源（JSON 接口） */
async function putAsset({ policy, digestSha, digestHmac, jar, dispatcher, login, steps }) {
  const url = policy.asset_upload_url;
  if (!url || !policy.asset_upload_authenticity_token) {
    // 策略没给这两个字段就不用登记，直接靠存储响应里的 asset 即可
    steps.push({ step: 'attach', skipped: true, reason: 'policy 未提供 asset_upload_url' });
    return { skipped: true, ok: true };
  }

  const fd = new FormData();
  fd.append('authenticity_token', policy.asset_upload_authenticity_token);

  const headers = {
    'User-Agent': UA,
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `${ORIGIN}/settings/profile`,
    Origin: ORIGIN,
  };
  if (digestSha && digestHmac) {
    headers['X-Digest-Sha256'] = digestSha;
    headers['X-Digest-Sha256-Hmac'] = digestHmac;
  }
  if (jar && jar.header()) headers.Cookie = jar.header();

  const res = await httpRequest(
    toAbsolute(url),
    { method: 'PUT', headers, body: fd, timeout: 60000 },
    { dispatcher, label: '确认头像资源' }
  );
  if (jar) jar.capture(res.headers);

  const ok = res.status >= 200 && res.status < 300;
  steps.push({ step: 'attach', status: res.status, target: toAbsolute(url), ok });
  logger.info('头像上传：确认资源返回', { login, status: res.status, ok });

  return { ok, status: res.status };
}

/**
 * 取某个头像地址的「内容签名」（长度 + ETag）。
 * 注意：GitHub API 返回的 avatar_url 字符串不会因为换头像而改变，
 * 但同一个 URL 返回的图片内容会变 —— 所以只能比内容，不能比 URL。
 */
async function avatarSignature(url, dispatcher) {
  if (!url) return '';
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': UA, Accept: 'image/*' },
      ...(dispatcher ? { dispatcher } : {}),
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    const len = res.headers.get('content-length') || '';
    const etag = res.headers.get('etag') || '';
    return `${res.status}|${len}|${etag}`;
  } catch {
    return '';
  }
}

/**
 * 最后一步：确认裁剪。
 * 图片传到存储后头像并不会立刻生效，GitHub 会渲染一个裁剪页，
 * 提交该页的表单才真正把这张图设为头像。
 */
async function applyAvatarCrop({ assetId, defaultCrop, jar, dispatcher, login, steps }) {
  if (!assetId) {
    steps.push({ step: 'crop', skipped: true, reason: '拿不到 asset id' });
    return { skipped: true, ok: false };
  }
  const pageUrl = `${ORIGIN}/settings/avatars/${assetId}`;
  const page = await httpRequest(
    pageUrl,
    { headers: { 'User-Agent': UA, Accept: 'text/html', Cookie: jar.header() } },
    { dispatcher, label: '打开头像裁剪页' }
  );
  if (jar) jar.capture(page.headers);

  const html = page.text || '';
  /* 把裁剪页存下来，便于核对表单字段与其初始值 */
  try {
    const dir = path.join(__dirname, '..', '..', 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `avatar-crop-${assetId}.html`), html, 'utf8');
    pruneDebugFiles(dir, 'avatar-crop-', 10);
  } catch {
    /* 存不下不影响主流程 */
  }
  const formMatch = html.match(/<form[^>]*id="avatar-crop-form"[^>]*>([\s\S]*?)<\/form>/i);
  if (!formMatch) {
    steps.push({
      step: 'crop',
      status: page.status,
      target: pageUrl,
      ok: false,
      reason: '未找到裁剪表单',
      bodyHead: html.slice(0, 2000),
    });
    return { ok: false, status: page.status };
  }

  /* 裁剪页里除了表单自己的 authenticity_token，还有一个 data-csrf="true"
     的隐藏项（class=js-avatar-post-csrf），前端 JS 提交时会把它放进 X-CSRF-Token 头 */
  let postCsrf = '';
  const csrfTag = html.match(/<input[^>]*data-csrf="true"[^>]*>/i);
  if (csrfTag) postCsrf = decodeEntities(attr(csrfTag[0], 'value'));

  const formStart = html.indexOf(formMatch[0]);
  const formTag = html.slice(formStart, formStart + 400);
  const action = attr(formTag, 'action') || `/settings/avatars/${assetId}`;
  const target = toAbsolute(action);

  // 收集裁剪表单里的所有字段（token + 裁剪坐标）
  const fields = [];
  for (const tag of formMatch[1].match(/<input\b[^>]*>/gi) || []) {
    const type = (attr(tag, 'type') || 'text').toLowerCase();
    if (['submit', 'button', 'file', 'reset', 'image'].includes(type)) continue;
    const name = attr(tag, 'name');
    if (!name) continue;
    fields.push([name, decodeEntities(attr(tag, 'value'))]);
  }

  /* 裁剪坐标由前端 JS 拖动时写入，服务端渲染出来往往是空的。
     GitHub 在存储响应里已经算好了默认裁剪区（cropped_dimensions: "x,y,w,h"），
     这里用它补上，否则等于提交了一个 0 尺寸的裁剪，头像自然不变。 */
  const CROP_KEY = { cropped_x: 'x', cropped_y: 'y', cropped_width: 'w', cropped_height: 'h' };
  const filled = [];
  for (const [name, value] of fields) {
    const slot = CROP_KEY[name];
    if (slot && defaultCrop && defaultCrop[slot] !== undefined && (!value || value === '0')) {
      filled.push([name, String(defaultCrop[slot])]);
    } else {
      filled.push([name, value]);
    }
  }
  fields.length = 0;
  fields.push(...filled);
  /* 关键：裁剪表单的提交按钮是 <button name="op" value="save">，
     Rails 靠这个 op=save 判断「真要保存」。不带上它就只是重定向，什么都不会变。 */
  for (const tag of formMatch[1].match(/<button\b[^>]*>/gi) || []) {
    const name = attr(tag, 'name');
    if (!name) continue;
    const value = decodeEntities(attr(tag, 'value'));
    if (value) fields.push([name, value]);
  }

  const hasMethod = fields.some(([n]) => n === '_method');
  const baseFields = fields.filter(([n]) => n !== '_method');
  const token = (fields.find(([n]) => n === 'authenticity_token') || [])[1] || '';

  /**
   * 这个端点的正确传法和「申请策略」一样是 multipart，
   * 但不同版本可能不同 —— 按顺序试，任何一个 2xx/3xx 就停。
   */
  const variants = [
    { name: 'multipart+token', kind: 'multipart', withMethod: hasMethod, ajax: true },
    { name: 'multipart-no-method', kind: 'multipart', withMethod: false, ajax: true },
    { name: 'urlencoded', kind: 'urlencoded', withMethod: true, ajax: true },
    // 纯表单提交：不带 XHR 头，Accept 用 text/html，最接近用户点「保存」的行为
    { name: 'plain-form', kind: 'multipart', withMethod: hasMethod, ajax: false },
  ];

  for (const variant of variants) {
    let body;
    const headers = {
      'User-Agent': UA,
      Accept: variant.ajax ? 'application/json' : 'text/html,application/xhtml+xml',
      Referer: pageUrl,
      Origin: ORIGIN,
      Cookie: jar.header(),
    };
    if (variant.ajax) headers['X-Requested-With'] = 'XMLHttpRequest';
    if (postCsrf) headers['X-CSRF-Token'] = postCsrf;
    if (variant.kind === 'multipart') {
      body = new FormData();
      for (const [n, v] of baseFields) body.append(n, v);
      if (variant.withMethod) body.append('_method', 'put');
    } else {
      body = new URLSearchParams();
      for (const [n, v] of baseFields) body.append(n, v);
      if (variant.withMethod) body.append('_method', 'put');
      body = body.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const res = await httpRequest(
      target,
      { method: 'POST', headers, body, timeout: 60000 },
      { dispatcher, label: '提交头像裁剪' }
    );
    if (jar) jar.capture(res.headers);

    let json = null;
    try {
      json = JSON.parse(res.text);
    } catch {
      json = null;
    }

    const ok = res.status >= 200 && res.status < 400;
    steps.push({
      step: 'crop',
      variant: variant.name,
      status: res.status,
      target,
      ok,
      hasToken: !!token,
      location: res.headers.get('location') || '',
      fieldNames: baseFields.map(([n]) => n),
      cropValues: Object.fromEntries(baseFields.filter(([n]) => n.indexOf('cropped_') === 0)),
      hasPostCsrf: !!postCsrf,
      bodyHead: String(res.text || '').slice(0, 3000),
    });
    logger.info('头像裁剪提交返回', { login, variant: variant.name, status: res.status, ok });

    if (ok) return { ok: true, status: res.status, variant: variant.name, json };
  }

  return { ok: false, status: 0 };
}

/** 回读设置页，取当前头像地址 */
async function readAvatarFromSettings({ jar, dispatcher }) {
  const page = await fetchSettingsPage({ jar, dispatcher });
  return {
    status: page.status,
    html: page.html,
    avatarUrl: page.status === 200 ? parseAvatarUrl(page.html) : '',
  };
}

/**
 * 用「已登录的网页会话」执行头像上传。
 * 验证码续接的流程会复用这个函数：验证通过后拿到会话，直接调它。
 */
async function uploadAvatarWithSession({ jar, dispatcher, settingsHtml, buffer, mime, filename = 'avatar.png', login = '' } = {}) {
  assertImage({ buffer, mime });

  if (!settingsHtml) {
    const page = await fetchSettingsPage({ jar, dispatcher });
    if (page.status !== 200) {
      dropCachedSession(login);
      throw new WebLoginError('LOGIN_FAILED', `无法打开个人资料设置页（HTTP ${page.status}）`, 428);
    }
    settingsHtml = page.html;
  }

  const beforeAvatarUrl = parseAvatarUrl(settingsHtml);
  const ctx = parseAvatarUploadContext(settingsHtml);
  if (!ctx) {
    const file = saveDebug(settingsHtml, login);
    throw new WebLoginError(
      'AVATAR_FORM_NOT_FOUND',
      `未能在 GitHub 个人资料设置页找到头像上传控件${file ? '（已保存页面快照：data/' + path.basename(file) + '）' : ''}`,
      502
    );
  }

  const missing = [];
  if (!ctx.policyUrl) missing.push('data-upload-policy-url');
  if (!ctx.policyCsrf) missing.push('策略 CSRF（data-csrf）');
  if (!ctx.formAction) missing.push('表单 action');
  if (!ctx.formToken) missing.push('authenticity_token');
  if (missing.length) {
    const file = saveDebug(settingsHtml, login);
    throw new WebLoginError(
      'AVATAR_POLICY_NOT_FOUND',
      `头像上传参数不完整，缺少：${missing.join('、')}${file ? '（已保存页面快照：data/' + path.basename(file) + '）' : ''}`,
      502
    );
  }

  const steps = [];
  const diag = {
    login,
    stage: 'init',
    steps,
    parsed: {
      policyUrl: ctx.policyUrl,
      ownerId: ctx.ownerId,
      ownerType: ctx.ownerType,
      formAction: ctx.formAction,
      formMethod: ctx.formMethod,
      methodOverride: ctx.methodOverride,
      fileInputId: ctx.fileInputId,
      hasPolicyCsrf: !!ctx.policyCsrf,
      hasFormToken: !!ctx.formToken,
    },
    fileSize: buffer.length,
    mime,
    filename,
    avatarUrlBefore: beforeAvatarUrl,
    settingsHtml,
  };

  let lastHtml = settingsHtml;
  let lastRedirect = '';
  const succeed = (status, avatarUrl, fileField, target) => {
    logger.info('头像上传完成（Alambic）', {
      login,
      status,
      fileField,
      target,
      formAction: ctx.formAction,
      ownerId: ctx.ownerId,
      fileSize: buffer.length,
      avatarUrlBefore: beforeAvatarUrl,
      avatarUrlAfter: avatarUrl,
    });
    return {
      status,
      formAction: ctx.formAction,
      fileField,
      avatarUrl,
      redirect: lastRedirect,
    };
  };

  try {
    /* 1. 申请上传策略 */
    diag.stage = 'policy';
    const policy = await requestUploadPolicy({
      policyUrl: ctx.policyUrl,
      policyCsrf: ctx.policyCsrf,
      ownerType: ctx.ownerType,
      ownerId: ctx.ownerId,
      fetchNonce: ctx.fetchNonce,
      release: ctx.release,
      buffer,
      mime,
      filename,
      jar,
      dispatcher,
      login,
      steps,
    });

    diag.policy = {
      hasUploadUrl: !!policy.upload_url,
      hasHeader: !!policy.header,
      fieldNames: Object.keys(policy.form || {}),
      sameOrigin: !!policy.same_origin,
      hasAssetUploadUrl: !!policy.asset_upload_url,
    };

    // 第二步：把文件传到策略给的存储地址
    diag.stage = 'storage';
    diag.target = policy.upload_url;
    const storage = await submitToStorage({ policy, buffer, mime, filename, jar, dispatcher, login, steps });

    // 存储 201 会带回 asset，记进诊断，下一步裁剪要用它的 id
    const assetFromStorage = (storage.json && (storage.json.asset || storage.json)) || {};
    const cropAssetId = assetFromStorage.id || (policy.asset && policy.asset.id) || '';
    /* 存储响应里的默认裁剪区，例如 "46,0,367,367" → {x:46,y:0,w:367,h:367} */
    const dimsRaw = assetFromStorage.cropped_dimensions || (storage.json && storage.json.cropped_dimensions) || '';
    let defaultCrop = null;
    if (typeof dimsRaw === 'string' && dimsRaw.split(',').length === 4) {
      const [x, y, w, h] = dimsRaw.split(',').map((n) => Number(n));
      if ([x, y, w, h].every((n) => Number.isFinite(n))) defaultCrop = { x, y, w, h };
    }
    diag.storage = {
      status: storage.status,
      assetId: cropAssetId,
      assetHref: assetFromStorage.href || '',
      bodyHead: String(storage.json ? JSON.stringify(storage.json).slice(0, 800) : ''),
    };

    // 第三步：登记 asset（策略给了才需要）
    diag.stage = 'attach';
    const put = await putAsset({
      policy,
      digestSha: storage.digestSha,
      digestHmac: storage.digestHmac,
      jar,
      dispatcher,
      login,
      steps,
    });

    // 第四步：确认裁剪（图片传上去还不算生效，必须提交裁剪表单）
    diag.stage = 'crop';
    if (!put.skipped) {
      // 策略提供了登记接口时，id 可能来自登记结果
    }
    await applyAvatarCrop({ assetId: cropAssetId, defaultCrop, jar, dispatcher, login, steps });

    // 第五步：回读设置页，确认头像地址真的变了
    diag.stage = 'verify';
    let applied = '';
    for (let i = 0; i < 3 && !applied; i += 1) {
      if (i) await new Promise((resolve) => setTimeout(resolve, 900));
      const check = await readAvatarFromSettings({ jar, dispatcher });
      steps.push({
        step: 'verify',
        attempt: i + 1,
        status: check.status,
        avatarUrlBefore: beforeAvatarUrl,
        avatarUrlAfter: check.avatarUrl,
      });
      if (check.html) {
        lastHtml = check.html;
        diag.settingsHtml = check.html;
      }
      if (check.status !== 200) {
        throw new WebLoginError(
          'LOGIN_FAILED',
          `回读个人资料设置页失败（HTTP ${check.status}），网页会话可能已失效`,
          428
        );
      }
      if (check.avatarUrl && check.avatarUrl !== beforeAvatarUrl) applied = check.avatarUrl;
    }

    /* 裁剪步骤返回 2xx/3xx 就认为已提交成功。
       不再用「头像地址有没有变化」判定成败 —— 重复上传同一张图时地址本来就不会变，
       那样会把成功误判成失败。 */
    const cropAccepted = steps.some((x) => x.step === 'crop' && x.ok);
    if (applied || cropAccepted) {
      return succeed(put.status || storage.status, applied || parseAvatarUrl(lastHtml), 'file', policy.upload_url);
    }

    diag.stage = 'verify';
    diag.forms = summarizeForms(lastHtml);
    const file = dumpAvatarFailure(diag, { login });
    diag.dumped = !!file;
    throw new WebLoginError(
      'AVATAR_NOT_APPLIED',
      '图片已上传，但裁剪确认未通过' + (file ? '（诊断快照：data/' + path.basename(file.jsonFile) + '）' : ''),
      502
    );
  } catch (err) {
    /* 任一步失败都落现场，记录走到哪、请求了谁、返回了什么 */
    if (!diag.dumped) {
      diag.stage = diag.stage || 'unknown';
      diag.message = err.message;
      diag.code = err.code || '';
      diag.settingsHtml = diag.settingsHtml || lastHtml;
      if (!diag.forms && lastHtml) diag.forms = summarizeForms(lastHtml);
      dumpAvatarFailure(diag, { login });
    }
    throw err;
  }
}

/**
 * 一步到位：登录 → 上传。
 * @param {boolean} awaitVerify 登录触发设备/邮箱验证时，是否返回 428 + verifyId 让前端输入验证码
 *                              （false 则直接抛 NEED_VERIFY）
 * @param {object}  payload     需要跨越「等待验证码」阶段保留的数据（图片、账号 id 等）
 */
async function uploadAvatar({ login, password, buffer, mime, filename = 'avatar.png', awaitVerify = false, payload = null } = {}) {
  assertImage({ buffer, mime });

  /* 只用「能不能打开设置页」判断会话是否有效，不在这里做上传 ——
     否则上传失败会被当成会话失效，然后在另一条路径上把同一张图再传一遍。 */
  const probeSession = async (jar, dispatcher) => {
    try {
      const page = await fetchSettingsPage({ jar, dispatcher });
      return page.status === 200 ? page : null;
    } catch {
      return null;
    }
  };

  const runUpload = (jar, dispatcher, settingsHtml) => {
    logger.info('复用已登录的网页会话（未重新登录）', { login });
    return uploadAvatarWithSession({ jar, dispatcher, settingsHtml, buffer, mime, filename, login });
  };

  // 1. 进程内缓存（最快）
  const cached = getCachedSession(login);
  if (cached) {
    const page = await probeSession(cached.jar, cached.dispatcher);
    if (page) return runUpload(cached.jar, cached.dispatcher, page.html);
    logger.info('缓存的网页会话已失效，清理', { login });
    dropCachedSession(login);
  }

  // 2. 持久化 Cookie（重启后仍可用，不需要重新输密码）
  const stored = loadStoredSession(login);
  if (stored) {
    const jar = jarFromHeader(stored.header);
    const dispatcher = await webDispatcher();
    const page = await probeSession(jar, dispatcher);
    if (page) {
      putCachedSession(login, jar, dispatcher);
      saveStoredSession(login, jar);
      return runUpload(jar, dispatcher, page.html);
    }
    logger.info('保存的登录状态已失效', { login, ageMin: Math.round((Date.now() - stored.at) / 60000) });
    if (dispatcher && typeof dispatcher.close === 'function') dispatcher.close().catch(() => {});
  }

  // 3. 没有可用会话，且用户没给密码 → 让他重新输入
  if (!password) {
    if (stored) {
      throw new WebLoginError('GH_SESSION_EXPIRED', '保存的 GitHub 登录状态已失效，请输入密码重新获取。', 401);
    }
    throw new WebLoginError('NEED_PASSWORD', '该账号还没有保存登录状态，请先输入一次 GitHub 密码。', 401);
  }

  // 4. 用密码登录，成功后把 Cookie 存下来
  const sess = await openWebSession({ login, password, purpose: 'avatar', awaitVerify, payload });
  if (sess && sess.needsVerify) return sess;

  putCachedSession(login, sess.jar, sess.dispatcher);
  saveStoredSession(login, sess.jar);
  logger.info('登录成功，已保存登录状态供下次复用', { login });

  return uploadAvatarWithSession({ ...sess, buffer, mime, filename, login });
}

module.exports = {
  uploadAvatar,
  uploadAvatarWithSession,
  fetchSettingsPage,
  assertImage,
  parseAvatarUploadContext,
  parseAvatarForm,
  parseAvatarUrl,
  summarizeForms,
  dumpAvatarFailure,
  avatarSignature,
  webDispatcher,
  MAX_BYTES,
  WebLoginError,
};

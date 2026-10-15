/**
 * 端到端测试：验证码续接全流程（用本地 mock GitHub）
 * 覆盖：密码错误 → 触发验证(302 跳转跟随) → 解析验证页 → 自动发送 → 错误验证码 → 正确验证码 → Token 创建
 *
 * 前置：MySQL 已启动（settings 表可写）；web_proxy 需为 direct
 */
process.env.GITHUB_WEB_ORIGIN = 'http://127.0.0.1:3999';

const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log('  PASS | ' + name);
  } else {
    failed += 1;
    console.log('  FAIL | ' + name + (detail !== undefined ? '  <<< ' + String(detail).slice(0, 180) : ''));
  }
}

const VERIFY_PAGE_HTML = `<html><body>
  <div id="js-flash-container"><div class="flash flash-full flash-warn"><div role="alert" class="js-flash-alert">We sent a verification code to t***@example.com</div></div></div>
  <form action="/sessions/verified-device" method="post">
    <input type="hidden" name="authenticity_token" value="csrf-verify-456">
    <input type="hidden" name="return_to" value="/dashboard">
    <label for="otp">Enter code</label>
    <input type="text" name="otp" autocomplete="one-time-code">
    <button type="submit">Verify</button>
  </form>
  <a href="/sessions/resend?token=abc">Resend code</a>
  <form action="/sessions/resend" method="post">
    <input type="hidden" name="authenticity_token" value="csrf-resend-789">
    <input type="hidden" name="device_id" value="dev1">
    <button type="submit">Resend code</button>
  </form>
</body></html>`;

const TOKEN_PAGE_HTML = `<html><body><form action="/settings/tokens" method="post">
  <input type="hidden" name="authenticity_token" value="csrf-token-789">
  <input type="checkbox" name="oauth_access[scopes][]" value="repo">
  <input type="checkbox" name="oauth_access[scopes][]" value="user">
  <input type="checkbox" name="oauth_access[scopes][]" value="workflow">
</form></body></html>`;

const GITHUB_TOKEN = 'ghp_' + 'A'.repeat(36);
let resendCount = 0;
let resendBody = '';
let verifySubmitted = '';
let sessionBroken = false; // 模拟真实 GitHub：验证待完成时访问未授权的 /settings/tokens/new 会破坏验证会话

/* mock GitHub */
const server = http.createServer((req, res) => {
  const url = req.url;
  const method = (req.method || 'GET').toUpperCase();
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const cookie = req.headers.cookie || '';

    if (url === '/login' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'anon=1; Path=/' });
      return res.end(
        '<html><form action="/session" method="post"><input type="hidden" name="authenticity_token" value="csrf-login-123"><input name="login"><input name="password"></form></html>'
      );
    }

    if (url === '/session' && method === 'POST') {
      sessionBroken = false; // 新的登录尝试 → 验证会话重新建立
      if (/password=GOODPASS/.test(body)) {
        res.writeHead(302, { Location: '/sessions/verified-device' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(
        '<div class="flash flash-full flash-error"><div role="alert" class="js-flash-alert">Incorrect username or password.</div></div>'
      );
    }

    /* 模拟 GitHub 先 302 到带参数的验证页（考验重定向跟随） */
    if (url === '/sessions/verified-device' && method === 'GET') {
      if (sessionBroken) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        return res.end('<html><title>Page not found · GitHub</title></html>');
      }
      if (!/anon=1/.test(cookie)) {
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
      res.writeHead(302, { Location: '/sessions/verified-device?return_to=%2Fdashboard' });
      return res.end();
    }
    if (url.startsWith('/sessions/verified-device?') && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(VERIFY_PAGE_HTML);
    }

    if (url === '/sessions/verified-device' && method === 'POST') {
      verifySubmitted = body;
      if (/otp=123456/.test(body)) {
        res.writeHead(302, { Location: '/', 'Set-Cookie': 'user_session=ghsess123; Path=/' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(
        '<div class="flash flash-full flash-error"><div role="alert" class="js-flash-alert">The code you entered is incorrect. Please try again.</div></div>'
      );
    }

    if (url === '/sessions/resend' && method === 'POST') {
      resendCount += 1;
      resendBody = body;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><body>Code resent.</body></html>');
    }

    if (url === '/settings/tokens/new' && method === 'GET') {
      if (!/user_session=/.test(cookie)) {
        sessionBroken = true; // 关键：破坏验证会话（与真实 GitHub 行为一致）
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(TOKEN_PAGE_HTML);
    }

    if (url === '/settings/tokens' && method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><body>Your new token: <code>' + GITHUB_TOKEN + '</code></body></html>');
    }

    res.writeHead(404);
    return res.end('not found: ' + url);
  });
});

let restoreProxy = null; // 异常退出时也能恢复 web_proxy

(async () => {
  await new Promise((res) => server.listen(3999, res));
  console.log('mock GitHub 已就绪 :3999');

  const settings = require('../server/services/settings.service');
  const login = require('../server/services/github-login.service');
  const origProxy = await settings.get('web_proxy');
  await settings.set('web_proxy', 'direct'); // 测试走直连 mock
  restoreProxy = async () => {
    await settings.set('web_proxy', origProxy);
    console.log('（已恢复 web_proxy = ' + origProxy + '）');
  };

  console.log('== 1. 密码错误 ==');
  let err1 = null;
  try {
    await login.loginAndCreateToken({ login: 'testuser', password: 'WRONGPASS' });
  } catch (e) {
    err1 = e;
  }
  check('密码错误 → BAD_CREDENTIALS', err1 && err1.code === 'BAD_CREDENTIALS', err1 && err1.message);
  check('密码错误 → HTTP 401', err1 && err1.httpStatus === 401);

  console.log('== 2. 正确密码 → 触发验证 ==');
  const start = await login.loginAndCreateToken({ login: 'testuser', password: 'GOODPASS', description: 'ghhub-auto' });
  check('返回 needsVerify', start.needsVerify === true, JSON.stringify(start).slice(0, 150));
  check('verifyId 生成', /^v_[a-f0-9]{24}$/.test(start.verifyId || ''), start.verifyId);
  check('验证类型为 email', start.verifyType === 'email', start.verifyType);
  check('hint 含脱敏邮箱', /t\*\*\*@example\.com/.test(start.hint || ''), start.hint);
  check('hint 为中文提示', /验证码已发送至邮箱/.test(start.hint || ''), start.hint);
  check('有效期 600 秒', start.expiresInSec === 600);
  check('验证会话未被破坏（未先请求未授权 Token 页）', sessionBroken === false, 'sessionBroken=' + sessionBroken);

  const verifyId = start.verifyId;

  console.log('== 3. 错误验证码（可重试）==');
  let err2 = null;
  try {
    await login.submitVerificationCode({ verifyId, code: '000000' });
  } catch (e) {
    err2 = e;
  }
  check('错误验证码 → BAD_CODE', err2 && err2.code === 'BAD_CODE', err2 && err2.message);
  check('错误验证码 → HTTP 400', err2 && err2.httpStatus === 400);
  check('验证码字段名正确提交（otp）', /otp=000000/.test(verifySubmitted), verifySubmitted);
  check('hidden 字段已携带', /authenticity_token=csrf-verify-456/.test(verifySubmitted) && /return_to=%2Fdashboard/.test(verifySubmitted));

  console.log('== 4. 重发验证码 ==');
  const resend = await login.resendVerificationCode({ verifyId });
  check('重发成功', resend && /已重新发送/.test(resend.hint || ''), JSON.stringify(resend));
  check('重发请求已发出（携带 device_id）', resendCount === 1 && /device_id=dev1/.test(resendBody), 'count=' + resendCount + ' body=' + resendBody);

  console.log('== 5. 正确验证码 → 完成 ==');
  const done = await login.submitVerificationCode({ verifyId, code: '123456' });
  check('创建 Token 成功', done && done.token === GITHUB_TOKEN, done && done.token);
  check('scopes 数量', done && done.scopes.length === 3, done && done.scopes);
  check('note 前缀正确', done && /^ghhub-auto-/.test(done.note || ''), done && done.note);

  console.log('== 6. 会话清理 ==');
  let err3 = null;
  try {
    await login.submitVerificationCode({ verifyId, code: '123456' });
  } catch (e) {
    err3 = e;
  }
  check('会话已清理 → VERIFY_EXPIRED', err3 && err3.code === 'VERIFY_EXPIRED', err3 && err3.message);

  console.log('\n== 测试结果: ' + passed + ' 通过 / ' + failed + ' 失败 ==');
  await restoreProxy();
  server.close();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('测试异常:', e.message);
  if (restoreProxy) {
    try {
      await restoreProxy();
    } catch {
      /* 忽略恢复失败 */
    }
  }
  process.exit(2);
});

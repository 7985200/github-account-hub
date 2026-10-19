'use strict';
/**
 * GitHub 账号级错误文案回归（无需数据库）
 * 运行：node scripts/test-account-errors.js
 */
const gh = require('../server/services/github.service');

const SUSPENDED = '该账号因违反服务条款、存在安全风险或异常活动，被平台方主动暂停了访问权限，完整错误请看日志';
let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  PASS ' + name + (extra ? '  ' + extra : ''));
  } else {
    fail += 1;
    console.log('  FAIL ' + name + (extra ? '  ' + extra : ''));
  }
}

const exact = [
  'Sorry. Your account was suspended.',
  'Your account has been suspended.',
  'This account was suspended',
  'Sorry, your account suspended.',
  'Your account is suspended.',
  'Your account is currently suspended.',
  'Your account has been locked.',
];
for (const msg of exact) {
  const got = gh.explainAccountError(msg, 403);
  ok('suspended: ' + JSON.stringify(msg), got === SUSPENDED, got);
}

ok('flagged 命中', /风险/.test(gh.explainAccountError('Your account has been flagged.', 403)));
ok('disabled 命中', /停用/.test(gh.explainAccountError('This account was disabled.', 403)));
ok('子串不误判 subaccount', gh.explainAccountError('The subaccount was suspended.', 403) === '');
ok('非 401/403 不判定', gh.explainAccountError('Sorry. Your account was suspended.', 429) === '');

for (const msg of ['Bad credentials', 'Not Found', 'API rate limit exceeded', '']) {
  ok('普通错误不误判: ' + JSON.stringify(msg), gh.explainAccountError(msg, 403) === '');
}

console.log('\n========== ' + pass + ' 通过 / ' + fail + ' 失败 ==========');
process.exit(fail ? 1 : 0);

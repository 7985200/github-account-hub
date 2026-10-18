'use strict';

/**
 * 全局配置：统一从 .env 读取，集中导出。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');

require('dotenv').config({ path: path.join(ROOT, '.env') });

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '127.0.0.1',
  port: num(process.env.PORT, 24524),

  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || 'data'),
  logDir: path.resolve(ROOT, process.env.LOG_DIR || 'logs'),
  // 密钥默认跟随 DATA_DIR；显式设置 SECRET_KEY_FILE 时以其为准
  keyFile: process.env.SECRET_KEY_FILE
    ? path.resolve(ROOT, process.env.SECRET_KEY_FILE)
    : path.join(path.resolve(ROOT, process.env.DATA_DIR || 'data'), 'secret.key'),

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: num(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'ghhub',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'github_hub',
    connectionLimit: num(process.env.DB_POOL_SIZE, 10),
  },

  github: {
    apiBase: 'https://api.github.com',
    userAgent: 'GitHub-Account-Hub/1.0 (+local)',
    timeout: num(process.env.GITHUB_TIMEOUT, 20000),
  },

  // 网页登录（自动创建 Token 功能）—— github.com 需经代理访问
  // GITHUB_WEB_PROXY: 'auto' 自动探测 | 'direct' 直连 | http://host:port
  webLogin: {
    proxy: process.env.GITHUB_WEB_PROXY || 'auto',
    proxyCandidates: [
      'http://127.0.0.1:7897',
      'http://127.0.0.1:7890',
      'http://127.0.0.1:10809',
      'http://127.0.0.1:10808',
      'http://127.0.0.1:1080',
      'http://127.0.0.1:33210',
      'http://127.0.0.1:8889',
    ],
    proxyCacheMs: num(process.env.GITHUB_WEB_PROXY_CACHE_MS, 300000),
    timeout: num(process.env.GITHUB_WEB_TIMEOUT, 25000),
  },
};

config.ensureDirs = function ensureDirs() {
  for (const dir of [config.dataDir, config.logDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
};

module.exports = config;

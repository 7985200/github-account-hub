'use strict';

/**
 * 代理通道服务
 * 统一管理两类对外通道：
 *   - 网页通道（github.com）：网页登录 / 自动创建 Token 功能使用
 *   - API 通道（api.github.com）：账号验证、批量操作等 REST 调用（可选复用代理）
 *
 * 通道配置存于 settings 表（UI 内可改，即时生效）：
 *   web_proxy     'auto' 自动探测 | 'direct' 直连 | 'http://host:port' 自定义
 *   api_via_proxy '1' / '0'，API 请求是否复用网页通道的代理
 */
const { ProxyAgent, fetch } = require('undici');
const config = require('../config');
const settings = require('./settings.service');
const logger = require('../utils/logger');

// 探测目标（与 github-login 保持一致的 GITHUB_WEB_ORIGIN 覆盖，便于自动化测试）
const WEB_ORIGIN = process.env.GITHUB_WEB_ORIGIN || 'https://github.com';
const API_ORIGIN = 'https://api.github.com';
const UA_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 归一化代理配置值 */
function normalizeProxy(value) {
  const s = String(value === null || value === undefined ? '' : value).trim();
  if (!s || s.toLowerCase() === 'auto' || s.toLowerCase() === 'direct') return s.toLowerCase() || 'auto';
  if (/^(https?|socks5?):\/\//i.test(s)) return s;
  return `http://${s}`;
}

/** 校验代理配置格式是否合法 */
function validateProxyConfig(value) {
  const s = String(value || '').trim();
  if (s === 'auto' || s === 'direct') return true;
  if (/^(https?):\/\/[^\s/]+(:\d+)?$/i.test(normalizeProxy(s))) return true;
  // 允许 host:port 简写
  if (/^[^\s/:]+:\d{2,5}$/.test(s)) return true;
  return false;
}

/**
 * 探测某个通道的连通性
 * @param {string} channel 'direct' 或代理 URL
 * @param {object} opts { targetUrl, timeoutMs, headers }
 */
async function probe(channel, { targetUrl = `${WEB_ORIGIN}/login`, timeoutMs = 6000, headers } = {}) {
  const isDirect = !channel || channel === 'direct';
  const dispatcher = isDirect ? undefined : new ProxyAgent(channel);
  try {
    const res = await fetch(targetUrl, {
      dispatcher,
      headers: { 'User-Agent': UA_BROWSER, Accept: 'text/html,*/*', ...(headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.text().catch(() => '');
    // 能拿到 HTTP 响应（含 4xx）都说明通道可达
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  } finally {
    if (dispatcher && typeof dispatcher.close === 'function') dispatcher.close().catch(() => {});
  }
}

/** 根据配置构造探测候选序列 */
function buildCandidates(cfgRaw) {
  const cfg = normalizeProxy(cfgRaw) || 'auto';
  const candidates = [];
  const push = (v) => {
    const n = normalizeProxy(v);
    if (n && !candidates.includes(n)) candidates.push(n);
  };
  if (cfg === 'direct') {
    push('direct');
  } else if (cfg === 'auto') {
    const hint = normalizeProxy(config.webLogin.proxy);
    if (hint && hint !== 'auto' && hint !== 'direct') push(hint);
    push('direct');
    for (const c of config.webLogin.proxyCandidates) push(c);
  } else {
    push(cfg);
  }
  return candidates;
}

/* 网页通道解析缓存（配置变化时自动失效） */
let webCache = { url: null, cfg: '', at: 0 };

/**
 * 解析网页通道（github.com）
 * @returns {Promise<string>} 'direct' 或可用代理 URL
 */
async function resolveWebChannel({ force = false } = {}) {
  const cfg = normalizeProxy(await settings.get('web_proxy')) || 'auto';
  const now = Date.now();
  if (!force && webCache.url && webCache.cfg === cfg && now - webCache.at < config.webLogin.proxyCacheMs) {
    return webCache.url;
  }

  const candidates = buildCandidates(cfg);
  const tried = [];
  for (const url of candidates) {
    tried.push(url);
    // eslint-disable-next-line no-await-in-loop
    const ok = await probe(url);
    logger.info(`网页通道探测：${url} → ${ok ? '可用' : '不可用'}`);
    if (ok) {
      webCache = { url, cfg, at: Date.now() };
      return url;
    }
  }
  webCache = { url: null, cfg, at: Date.now() };

  const hint =
    cfg === 'auto' || cfg === 'direct'
      ? `无法连接 GitHub 网页（已尝试 ${tried.length} 个通道）。请确认服务器可访问 github.com，或在「菜单 → 代理设置」中配置可用代理。`
      : `配置的网页代理不可用：${cfg}。请到「菜单 → 代理设置」检查地址，或改为自动探测。`;
  const err = new Error(hint);
  err.code = 'PROXY_UNAVAILABLE';
  throw err;
}

/** 通道变更后强制失效缓存（设置保存时调用） */
function invalidateChannelCache() {
  webCache = { url: null, cfg: '', at: 0 };
  if (apiDispatcher) {
    apiDispatcher.close().catch(() => {});
    apiDispatcher = null;
    apiDispatcherCfg = '';
  }
}

/* ---------------- API 通道 ---------------- */

let apiDispatcher = null;
let apiDispatcherCfg = '';

/**
 * 获取 API 请求使用的 dispatcher（未启用代理时返回 undefined = 直连）
 * 由 github.service 在每次请求前调用（内存缓存，开销可忽略）
 */
async function getApiDispatcher() {
  const via = await settings.get('api_via_proxy');
  if (String(via) !== '1') return undefined;
  const channel = await resolveWebChannel();
  if (channel === 'direct') return undefined;
  if (apiDispatcher && apiDispatcherCfg === channel) return apiDispatcher;
  if (apiDispatcher) apiDispatcher.close().catch(() => {});
  apiDispatcher = new ProxyAgent(channel);
  apiDispatcherCfg = channel;
  return apiDispatcher;
}

/**
 * 测试指定配置的连通性（不保存、不改缓存）
 * @returns {{available:boolean, channel:string|null, tried:string[], message:string}}
 */
async function testChannelConfig(cfgRaw) {
  if (!validateProxyConfig(cfgRaw)) {
    return { available: false, channel: null, tried: [], message: '代理地址格式不正确（示例：http://127.0.0.1:7897）' };
  }
  const candidates = buildCandidates(cfgRaw);
  const tried = [];
  for (const url of candidates) {
    tried.push(url);
    // eslint-disable-next-line no-await-in-loop
    const ok = await probe(url);
    if (ok) {
      return {
        available: true,
        channel: url,
        tried,
        message: url === 'direct' ? 'github.com 可直连' : `代理可用（${url}）`,
      };
    }
  }
  return {
    available: false,
    channel: null,
    tried,
    message: `全部通道不可用（已尝试 ${tried.length} 个）`,
  };
}

/** 当前网页通道状态（供 UI 显示） */
async function checkChannel() {
  try {
    const url = await resolveWebChannel();
    return { available: true, channel: url, message: url === 'direct' ? '直连可用' : `代理可用（${url}）` };
  } catch (err) {
    return { available: false, channel: null, message: err.message };
  }
}

/** 当前 API 通道状态（直连 / 走代理 / 不可用） */
async function checkApiChannel() {
  try {
    const via = String(await settings.get('api_via_proxy')) === '1';
    if (!via) {
      const ok = await probe('direct', { targetUrl: API_ORIGIN, timeoutMs: 6000 });
      return { mode: 'direct', available: ok, message: ok ? 'API 直连可用' : 'API 直连不可用（可在代理设置中启用 API 走代理）' };
    }
    const channel = await resolveWebChannel();
    if (channel === 'direct') {
      const ok = await probe('direct', { targetUrl: API_ORIGIN, timeoutMs: 6000 });
      return { mode: 'direct', available: ok, message: ok ? 'API 直连可用' : 'API 直连不可用' };
    }
    const ok = await probe(channel, { targetUrl: API_ORIGIN, timeoutMs: 8000 });
    return {
      mode: 'proxy',
      available: ok,
      message: ok ? `API 经代理可用（${channel}）` : `API 经代理不可用（${channel}）`,
    };
  } catch (err) {
    return { mode: 'unknown', available: false, message: err.message };
  }
}

module.exports = {
  normalizeProxy,
  validateProxyConfig,
  probe,
  resolveWebChannel,
  invalidateChannelCache,
  getApiDispatcher,
  testChannelConfig,
  checkChannel,
  checkApiChannel,
};

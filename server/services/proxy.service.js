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
const net = require('net');
const tls = require('tls');
const { ProxyAgent, Agent, fetch } = require('undici');
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

  /* 支持代理列表常见格式 host:port:user:pass（可带协议前缀）。
     供应商给的凭据常含 - 和数字，密码可能含其它字符，统一做 URL 编码。 */
  const withScheme = s.match(/^(https?|socks5?):\/\/([^\s:/]+):(\d+):([^:\s]+):(\S+)$/i);
  if (withScheme) {
    const [, sch, host, port, user, pass] = withScheme;
    return `${sch}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  const bare = s.match(/^([^\s:/]+):(\d+):([^:\s]+):(\S+)$/);
  if (bare) {
    const [, host, port, user, pass] = bare;
    /* 没写协议时按 HTTP 代理处理（最常见），要 SOCKS5 请显式加 socks5:// 前缀 */
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  if (/^(https?|socks5?):\/\//i.test(s)) return s;
  return `http://${s}`;
}

/** 校验代理配置格式是否合法 */
function validateProxyConfig(value) {
  const s = String(value || '').trim();
  if (s === 'auto' || s === 'direct') return true;
  /* 支持 http / https / socks5，均可带 user:pass@ */
  if (/^(https?|socks5?):\/\/[^\s/@]+(:\d+)?$/i.test(normalizeProxy(s))) return true;
  if (/^(https?|socks5?):\/\/[^\s/]*@[^\s/]+(:\d+)?$/i.test(normalizeProxy(s))) return true;
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
  const dispatcher = isDirect ? undefined : buildDispatcher(channel);
  try {
    const res = await fetch(targetUrl, {
      dispatcher,
      headers: { 'User-Agent': UA_BROWSER, Accept: 'text/html,*/*', ...(headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.text().catch(() => '');
    /* 407 表示代理要认证、401/403 表示被拒 —— 这类都是「不可用」，
       否则用户密码填错时界面会显示「代理可用」却每一个请求都失败。 */
    if ([401, 403, 407].includes(res.status)) return false;
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  } finally {
    if (dispatcher && typeof dispatcher.close === 'function') dispatcher.close().catch(() => {});
  }
}

/** 根据配置构造探测候选序列 */
/**
 * 构造 SOCKS5 的 connect 函数（undici Agent 支持自定义 connect）。
 * 完整实现 RFC1928 握手 + RFC1929 用户名密码认证 + CONNECT 请求。
 */
function socks5Connector(channel) {
  const u = new URL(channel);
  const proxyHost = u.hostname;
  const proxyPort = Number(u.port || 1080);
  const user = decodeURIComponent(u.username || '');
  const pass = decodeURIComponent(u.password || '');

  return function connect(opts, callback) {
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    let settled = false;
    let leftover = Buffer.alloc(0);

    /**
     * 关键：undici 的 TLS 握手写在它自己的 buildConnector 里，我们传了自定义 connect
     * 就等于把整段替换掉了 —— 所以 https 目标必须自己再包一层 TLS，
     * 否则会把明文 HTTP 直接发给 443 端口。
     */
    const deliver = () => {
      socket.removeAllListeners('data');
      socket.pause();
      if (leftover.length) socket.unshift(leftover);
      if (opts.protocol !== 'https:') {
        settled = true;
        callback(null, socket);
        return;
      }
      const tlsSock = tls.connect(
        {
          socket,
          servername: opts.servername || opts.hostname,
          ALPNProtocols: ['http/1.1'],
        },
        () => {
          if (settled) return;
          settled = true;
          callback(null, tlsSock);
        }
      );
      tlsSock.once('error', (e) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        callback(e);
      });
    };

    const done = (err) => {
      if (settled) return;
      if (err) {
        settled = true;
        socket.removeAllListeners('data');
        socket.destroy();
        callback(err);
        return;
      }
      deliver();
    };

    socket.once('error', (err) => done(new Error('SOCKS5 连接失败：' + err.message)));
    socket.setTimeout(10000, () => done(new Error('SOCKS5 握手超时')));

    socket.once('connect', () => {
      /* greeting：声明支持「无认证」和「用户名密码」 */
      const methods = user ? [0x00, 0x02] : [0x00];
      socket.write(Buffer.from([0x05, methods.length].concat(methods)));

      let stage = 'greet';
      let buf = Buffer.alloc(0);

      const sendConnect = () => {
        const host = Buffer.from(opts.hostname, 'utf8');
        const port = Buffer.alloc(2);
        port.writeUInt16BE(opts.port, 0);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]));
        stage = 'connect';
      };

      socket.on('data', function onData(chunk) {
        buf = Buffer.concat([buf, chunk]);

        if (stage === 'greet') {
          if (buf.length < 2) return;
          if (buf[0] !== 0x05) return done(new Error('SOCKS5 版本不匹配'));
          const method = buf[1];
          buf = buf.slice(2);
          if (method === 0x02) {
            const ub = Buffer.from(user, 'utf8');
            const pb = Buffer.from(pass, 'utf8');
            socket.write(Buffer.concat([Buffer.from([0x01, ub.length]), ub, Buffer.from([pb.length]), pb]));
            stage = 'auth';
            return undefined;
          }
          if (method === 0x00) {
            sendConnect();
            return undefined;
          }
          return done(new Error('SOCKS5 不接受该认证方式'));
        }

        if (stage === 'auth') {
          if (buf.length < 2) return undefined;
          if (buf[1] !== 0x00) return done(new Error('SOCKS5 用户名或密码错误'));
          buf = buf.slice(2);
          sendConnect();
          return undefined;
        }

        if (stage === 'connect') {
          if (buf.length < 4) return undefined;
          if (buf[1] !== 0x00) return done(new Error('SOCKS5 连接目标失败，状态码 ' + buf[1]));
          const atyp = buf[3];
          let need = 0;
          if (atyp === 0x01) need = 10;
          else if (atyp === 0x03) {
            /* 域名字段长度在第 5 字节，必须等它到达再算总长 */
            if (buf.length < 5) return undefined;
            need = 4 + 1 + buf[4] + 2;
          } else if (atyp === 0x04) need = 22;
          if (!Number.isFinite(need) || need <= 0) return undefined;
          if (buf.length < need) return undefined;
          leftover = buf.slice(need);
          socket.setTimeout(0);
          return done(null);
        }
        return undefined;
      });
    });
  };
}

/** 按通道类型构造 dispatcher：http(s) 用 ProxyAgent，socks5 用自建 connector */
function buildDispatcher(channel) {
  if (!channel || channel === 'direct' || channel === 'auto') return undefined;
  if (/^socks5?:\/\//i.test(channel)) {
    return new Agent({ connect: socks5Connector(channel) });
  }
  return new ProxyAgent(channel);
}

/** 把账号密码注入代理地址（地址里已内嵌则不覆盖） */
function injectAuth(url, user, pass) {
  if (!user || !url || url === 'direct' || url === 'auto') return url;
  try {
    const u = new URL(url);
    if (u.username || u.password) return url;
    u.username = encodeURIComponent(user);
    u.password = encodeURIComponent(pass || '');
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

/** 日志/报错里隐藏代理凭据 */
function maskProxy(url) {
  if (!url || url === 'direct' || url === 'auto') return url;
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '***';
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

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
let webCache = { url: null, cfg: '', at: 0, failAt: 0, error: null };

/* 探测失败后的冷却时间：避免每个请求都串行重试 8 个通道（最坏 48s） */
const NEGATIVE_TTL_MS = 30000;

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
  /* 刚才探测失败过且还在冷却期内，直接复用那次失败结果，不再重探 */
  if (!force && !webCache.url && webCache.cfg === cfg && webCache.error && now - webCache.failAt < NEGATIVE_TTL_MS) {
    throw webCache.error;
  }

  /* 代理需要认证时，账号密码单独存两个设置项，这里注入到地址里；
     地址本身已带 user:pass@ 时不覆盖。 */
  const authUser = await settings.get('web_proxy_user');
  const authPass = await settings.get('web_proxy_pass');
  const candidates = buildCandidates(cfg).map((u) => injectAuth(u, authUser, authPass));
  const tried = [];
  for (const url of candidates) {
    tried.push(url);
    // eslint-disable-next-line no-await-in-loop
    const ok = await probe(url);
    /* 日志里必须脱敏，否则代理账号密码会永久留在日志文件里 */
    logger.info(`网页通道探测：${maskProxy(url)} → ${ok ? '可用' : '不可用'}`);
    if (ok) {
      webCache = { url, cfg, at: Date.now() };
      return url;
    }
  }
  webCache = { url: null, cfg, at: Date.now(), failAt: 0, error: null };

  const hint =
    cfg === 'auto' || cfg === 'direct'
      ? `无法连接 GitHub 网页（已尝试 ${tried.length} 个通道）。请确认服务器可访问 github.com，或在「菜单 → 代理设置」中配置可用代理。`
      : `配置的网页代理不可用：${maskProxy(cfg)}。请到「菜单 → 代理设置」检查地址，或改为自动探测。`;
  const err = new Error(hint);
  err.code = 'PROXY_UNAVAILABLE';
  /* 记下失败时间与错误对象，供冷却期内直接复用 */
  webCache = { url: null, cfg, at: Date.now(), failAt: Date.now(), error: err };
  throw err;
}

/** 通道变更后强制失效缓存（设置保存时调用） */
function invalidateChannelCache() {
  webCache = { url: null, cfg: '', at: 0, failAt: 0, error: null };
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
  apiDispatcher = buildDispatcher(channel);
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
        channel: url === 'direct' ? url : maskProxy(url),
        tried: tried.map((u) => (u === 'direct' ? u : maskProxy(u))),
        message: url === 'direct' ? 'github.com 可直连' : `代理可用（${maskProxy(url)}）`,
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
    /* 地址可能内嵌代理凭据，回显给前端前必须脱敏 */
    const masked = url === 'direct' ? url : maskProxy(url);
    return { available: true, channel: masked, message: url === 'direct' ? '直连可用' : `代理可用（${masked}）` };
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
  buildDispatcher,
  maskProxy,
  injectAuth,
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

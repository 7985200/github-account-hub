'use strict';

/**
 * 系统设置服务：settings 表的键值读写（内存缓存 + 懒加载）
 *
 * 语义：数据库中的值 > 默认值（.env / 内置）
 * 用途：代理配置等需要「部署后在 UI 里随时改」的运行时设置
 */
const { query } = require('../db/pool');
const config = require('../config');
const logger = require('../utils/logger');

/** 各设置项的默认值（未在数据库中出现时使用） */
function defaults() {
  return {
    // 网页通道（github.com）：'auto' 自动探测 | 'direct' 直连 | http://host:port 自定义代理
    web_proxy: config.webLogin.proxy || 'auto',
    // API 通道（api.github.com）是否复用网页通道的代理：'1' / '0'
    api_via_proxy: '0',
  };
}

const cache = new Map();
let loaded = false;

function isValidKey(key) {
  return Object.prototype.hasOwnProperty.call(defaults(), key);
}

async function load() {
  const rows = await query('SELECT `key`, `value` FROM settings');
  cache.clear();
  for (const row of rows) {
    if (isValidKey(row.key)) cache.set(row.key, row.value === null ? '' : String(row.value));
  }
  loaded = true;
}

/** 读取单个设置（带默认值兜底） */
async function get(key) {
  if (!isValidKey(key)) throw new Error(`未知设置项：${key}`);
  if (!loaded) await load();
  if (cache.has(key)) return cache.get(key);
  return defaults()[key];
}

/** 批量读取 */
async function getAll() {
  if (!loaded) await load();
  const defs = defaults();
  const out = {};
  for (const key of Object.keys(defs)) out[key] = cache.has(key) ? cache.get(key) : defs[key];
  return out;
}

/** 写入设置（upsert）；返回写入后的完整设置 */
async function set(key, value) {
  if (!isValidKey(key)) throw new Error(`未知设置项：${key}`);
  const v = value === null || value === undefined ? '' : String(value).slice(0, 500);
  await query('INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)', [
    key,
    v,
  ]);
  cache.set(key, v);
  loaded = true;
  logger.info(`设置已更新：${key}`, { value: v.slice(0, 120) });
  return getAll();
}

module.exports = { get, getAll, set, load, defaults };

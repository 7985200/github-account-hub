'use strict';

/**
 * 轻量日志：控制台 + 按天滚动文件（logs/app-YYYY-MM-DD.log）
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

let stream = null;
let streamDay = '';

function ensureStream() {
  const day = new Date().toISOString().slice(0, 10);
  if (stream && streamDay === day) return stream;
  if (stream) stream.end();
  fs.mkdirSync(config.logDir, { recursive: true });
  streamDay = day;
  stream = fs.createWriteStream(path.join(config.logDir, `app-${day}.log`), { flags: 'a' });
  return stream;
}

function write(level, message, meta) {
  const parts = [new Date().toISOString(), `[${level.toUpperCase()}]`, message];
  if (meta !== undefined && meta !== null) {
    try {
      parts.push(typeof meta === 'string' ? meta : JSON.stringify(meta));
    } catch {
      parts.push('[unserializable]');
    }
  }
  const line = parts.join(' ');
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  try {
    ensureStream().write(`${line}\n`);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

module.exports = {
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
};

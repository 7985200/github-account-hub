'use strict';

/**
 * 凭据加密工具
 * 算法：AES-256-GCM
 * 密钥：独立密钥文件（默认 data/secret.key，32 字节随机），与数据库分离存放
 * 存储格式：v1:<iv b64>:<authTag b64>:<ciphertext b64>
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');

let cachedKey = null;

function loadKey() {
  if (cachedKey) return cachedKey;
  const file = config.keyFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600 });
  }
  const buf = fs.readFileSync(file);
  if (buf.length !== 32) {
    throw new Error(`加密密钥文件损坏（期望 32 字节）：${file}`);
  }
  cachedKey = buf;
  return cachedKey;
}

function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(blob) {
  if (!blob) return null;
  const parts = String(blob).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    return null;
  }
}

/** 掩码预览：ghp_ab••••••••cdef */
function maskSecret(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 12) return '•'.repeat(10);
  return `${s.slice(0, 6)}${'•'.repeat(Math.min(16, Math.max(6, s.length - 10)))}${s.slice(-4)}`;
}

/** 判断令牌类型 */
function tokenKind(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.startsWith('github_pat_')) return 'fine-grained';
  if (s.startsWith('ghp_')) return 'classic';
  if (s.startsWith('gho_')) return 'oauth';
  if (s.startsWith('ghu_')) return 'user';
  if (s.startsWith('ghs_')) return 'server';
  if (s.startsWith('ghr_')) return 'refresh';
  return 'unknown';
}

module.exports = { encrypt, decrypt, maskSecret, tokenKind };

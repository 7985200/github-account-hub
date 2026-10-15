'use strict';

/**
 * MySQL 连接池（mysql2/promise）
 * - 统一在服务启动时做一次连通性探测
 * - 提供 query / withTransaction 两个基础能力
 */
const mysql = require('mysql2/promise');
const config = require('../config');
const logger = require('../utils/logger');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  queueLimit: 0,
  charset: 'utf8mb4_unicode_ci',
  dateStrings: true,
  timezone: 'local',
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  supportBigNumbers: true,
  bigNumberStrings: false,
});

/** 执行 SQL（预编译参数） */
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** 事务封装：回调内抛错自动回滚 */
async function withTransaction(handler) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await handler(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    conn.release();
  }
}

/** 连通性探测 + 版本信息 */
async function inspect() {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      'SELECT VERSION() AS version, DATABASE() AS db, @@character_set_database AS charset, @@max_connections AS maxConnections'
    );
    const [threads] = await conn.query('SHOW STATUS LIKE "Threads_connected"');
    return {
      version: rows[0].version,
      database: rows[0].db,
      charset: rows[0].charset,
      maxConnections: Number(rows[0].maxConnections),
      threadsConnected: threads.length ? Number(threads[0].Value) : null,
      poolSize: config.db.connectionLimit,
    };
  } finally {
    conn.release();
  }
}

async function close() {
  try {
    await pool.end();
  } catch (err) {
    logger.warn('关闭数据库连接池时出错', { error: err.message });
  }
}

module.exports = { pool, query, withTransaction, inspect, close };

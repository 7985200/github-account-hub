'use strict';

/**
 * 数据库迁移：建库 + 建表
 * 可由 `npm run migrate` 单独执行，也会在服务启动时自动运行（幂等）。
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config');
const logger = require('../utils/logger');

const SCHEMA_FILE = path.join(config.root, 'db', 'schema.sql');

async function ensureDatabase() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
  });
  try {
    try {
      await conn.query(
        `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
    } catch (err) {
      // 应用账号通常没有全局建库权限；库由 scripts/setup-db.js 预先创建，这里仅需已存在
      if (err.code !== 'ER_DBACCESS_DENIED_ERROR' && err.code !== 'ER_ACCESS_DENIED_ERROR') throw err;
      logger.warn('应用账号无建库权限，跳过 CREATE DATABASE（请确保已执行 npm run setup:db）');
    }
    await conn.changeUser({ database: config.db.database });
    const schema = fs.readFileSync(SCHEMA_FILE, 'utf8');
    await conn.query(schema);
  } finally {
    await conn.end();
  }
}

async function tableSummary() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });
  try {
    const [rows] = await conn.query(
      `SELECT TABLE_NAME AS name, TABLE_ROWS AS approxRows, ENGINE AS engine
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [config.db.database]
    );
    return rows;
  } finally {
    await conn.end();
  }
}

async function migrate() {
  await ensureDatabase();
  const tables = await tableSummary();
  logger.info(`数据库就绪：${config.db.database}@${config.db.host}:${config.db.port}`, {
    tables: tables.map((t) => t.name),
  });
  return tables;
}

if (require.main === module) {
  migrate()
    .then((tables) => {
      console.log('迁移完成，当前表：', tables.map((t) => t.name).join(', '));
      process.exit(0);
    })
    .catch((err) => {
      console.error('迁移失败：', err.message);
      process.exit(1);
    });
}

module.exports = { migrate, ensureDatabase, tableSummary };

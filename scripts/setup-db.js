'use strict';

/**
 * 一次性初始化脚本（需要 MySQL root）
 *   node scripts/setup-db.js [root密码]
 *
 * 作用：
 *   1. 创建数据库 github_hub
 *   2. 创建应用账号 ghhub（权限仅限 github_hub.*）
 *   3. 执行建表迁移
 */
const mysql = require('mysql2/promise');
const config = require('../server/config');
const { migrate } = require('../server/db/migrate');

async function main() {
  const rootPassword = process.argv[2];
  if (!rootPassword) {
    console.error('用法：node scripts/setup-db.js <MySQL root 密码>');
    console.error('  示例：node scripts/setup-db.js "your-root-password"');
    process.exit(1);
  }
  const appUser = config.db.user;
  const appPassword = config.db.password;
  const database = config.db.database;

  console.log(`连接 root@${config.db.host}:${config.db.port} …`);
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: 'root',
    password: rootPassword,
    multipleStatements: true,
  });

  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  console.log(`✔ 数据库 ${database} 就绪`);

  for (const host of ['127.0.0.1', 'localhost', '%']) {
    await conn.query(`CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?`, [appUser, host, appPassword]);
    await conn.query(`GRANT ALL PRIVILEGES ON \`${database}\`.* TO ?@?`, [appUser, host]);
  }
  await conn.query('FLUSH PRIVILEGES');
  console.log(`✔ 应用账号 ${appUser} 已授权（仅 ${database}.*）`);

  await conn.end();

  const tables = await migrate();
  console.log(`✔ 建表完成：${tables.map((t) => t.name).join('、')}`);
  console.log('\n初始化完成，可以执行 npm start 启动服务。');
}

main().catch((err) => {
  console.error('初始化失败：', err.message);
  process.exit(1);
});

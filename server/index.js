'use strict';

/**
 * 服务入口
 * 1. 准备运行时目录
 * 2. 自动执行数据库迁移（幂等）
 * 3. 监听 127.0.0.1:24524
 */
const config = require('./config');
const app = require('./app');
const { migrate } = require('./db/migrate');
const db = require('./db/pool');
const logger = require('./utils/logger');

async function bootstrap() {
  config.ensureDirs();

  const started = Date.now();
  await migrate();
  logger.info(`数据库迁移完成（${Date.now() - started}ms）`);

  const info = await db.inspect();
  logger.info(`MySQL 已连接：${info.version} · ${config.db.database} · 连接池 ${info.poolSize}`);

  const server = app.listen(config.port, config.host, () => {
    logger.info(`GitHub 多账号管家已启动 → http://${config.host}:${config.port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`端口 ${config.port} 已被占用，请先释放该端口再启动`);
    } else {
      logger.error('HTTP 服务启动失败', { message: err.message });
    }
    process.exit(1);
  });

  const shutdown = async (signal) => {
    logger.info(`收到 ${signal}，正在关闭服务…`);
    server.close(async () => {
      await db.close();
      logger.info('服务已安全退出');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.error('启动失败', { message: err.message });
  console.error('\n启动失败：', err.message);
  console.error('请确认 MySQL 实例已启动（scripts\\start-mysql.bat），并已执行 npm run setup:db。\n');
  process.exit(1);
});

# ============================================================
#  GitHub 多账号管家 · 生产镜像
#  应用为纯 JS，无原生依赖，无需编译工具链
#  undici 8.x 要求 Node >= 22.19，这里固定到具体 minor，避免旧 22.x 缓存镜像
#  在 require('undici') 时因缺少 zstd API 直接崩溃
# ============================================================
FROM node:22.23-alpine

ENV NODE_ENV=production
WORKDIR /app

# 1) 先安装依赖（package*.json 不变时命中层缓存，构建更快）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit && npm cache clean --force

# 2) 应用代码（前端静态资源由 Express 直接托管，无需构建）
COPY server ./server
COPY public ./public
COPY db ./db

# 3) 数据目录：加密密钥（data/secret.key）与日志通过卷持久化
RUN mkdir -p /app/data /app/logs && chown -R node:node /app/data /app/logs

EXPOSE 24524

# 非 root 运行
USER node

# 健康检查：node 内置 fetch 探测 /api/health（公开接口，无需登录）
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||24524)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]

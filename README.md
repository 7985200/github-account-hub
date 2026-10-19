# GitHub 多账号管家

<p align="center">
  <a href="https://github.com/7985200/github-account-hub"><img alt="GitHub" src="https://img.shields.io/badge/开源地址-7985200%2Fgithub--account--hub-181717?logo=github&labelColor=0a0a0b"></a>
  <img alt="Node" src="https://img.shields.io/badge/Node.js-%E2%89%A522.19-0a0a0b?labelColor=0a0a0b">
  <img alt="MySQL" src="https://img.shields.io/badge/MySQL-8.0-0a0a0b?labelColor=0a0a0b">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-%E6%94%AF%E6%8C%81%E4%B8%80%E9%94%AE%E9%83%A8%E7%BD%B2-0a0a0b?logo=docker&labelColor=0a0a0b">
<img alt="Moe Counter" src="https://count.getloli.com/get/@阿巴阿巴?theme=moebooru">
</p>

本地优先的 GitHub 多账号集中管理面板。**Node.js + Express + MySQL** 全栈（零框架、零构建、零 CDN），黑白极简双主题。

适合需要集中管理多个 GitHub 账号（小号矩阵）的场景：统一查看资料与配额、批量给仓库点 Star、批量复刻仓库、批量关注用户、一键从账号密码自动换取全权限 Token。

## 功能特性

**账号管理**
- 三种添加方式：
  - **Token**：粘贴 Personal Access Token，自动验证并拉取头像 / 资料 / 权限范围 / API 配额
  - **密码换 Token**：输入 GitHub 账号密码，服务端模拟网页登录，自动创建「全权限（51 项）+ 永不过期」Token 并入库；**密码仅用于本次换取，不留存**
  - **账号密码**：仅加密保存凭据（GitHub 官方已停用密码直连认证，此模式用于本地留存）
- 账号卡片：灰度头像、状态徽章（有效 / 未验证 / 异常 / 密码凭据四种形态）、Token 掩码 + 复制 / 查看、权限清单、仓库 / 关注者 / 配额统计
- 仓库列表：拉取全部仓库、搜索过滤、**一键复制带凭据的克隆地址**
- 操作日志：所有动作落库，分页 + 级别筛选

**批量操作**（顶栏 ☰ 菜单）
- 批量 Star：粘贴仓库链接或 `owner/repo` 自动识别，可自选账号 + 全选，串行执行（每账号 400ms 间隔防触发风控），逐账号结果
- 批量关注：输入用户名 / @用户名 / 主页链接，机制同上

**访问控制与运维**
- 登录保护：首次打开创建管理员账号（scrypt 密码哈希 + httpOnly Cookie 会话 + 登录限速）
- 管理员面板：重置用户名、重置密码（改密后其他设备会话全部失效）
- 代理设置：UI 内随时修改（自动探测 / 直连 / 自定义），适配不同网络环境；可开关「API 请求走代理」
- 系统状态：服务 / Node / MySQL 版本、运行时长、连接池

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Node.js ≥ 22.19（undici 8.x 要求）· Express 4 · mysql2（连接池 + 事务）、undici（代理通道） |
| 数据库 | MySQL 8.0（utf8mb4，JSON 字段） |
| 前端 | 原生 HTML / CSS / JavaScript（无框架、无构建步骤） |
| 安全 | AES-256-GCM 凭据加密（密钥独立文件）· scrypt 管理员密码 · httpOnly 会话 Cookie · 登录限速 |

## 快速开始

### 方式一：一键部署脚本（推荐）

自动引导选择 **Docker** 或 **宿主机** 部署，可自定义监听地址（`127.0.0.1` / `0.0.0.0`）与端口，彩色交互：

```bash
git clone https://github.com/7985200/github-account-hub.git
cd github-account-hub
bash install.sh
```

或免 clone 直接运行：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/7985200/github-account-hub/main/install.sh)
```

> - Docker 模式：自动创建数据库与应用账号、建表、构建镜像并启动，全程无需手动操作
> - 宿主机模式：需要本机已有 Node.js ≥ 22.19 与 MySQL 8.0，脚本会引导完成初始化并后台启动
> - 非交互安装（CI 场景）：`INSTALL_MODE=1 INSTALL_PORT=24524 INSTALL_BIND=0.0.0.0 INSTALL_CONFIRM=1 bash install.sh`
> - 重复运行会自动识别已部署的项目并询问操作：**重新部署**（保留数据）/ **更新到最新**（拉取仓库最新代码）/ **部署新实例**（克隆到新目录，独立端口与数据，可与旧实例并存）
> - 非交互模式下可用 `INSTALL_EXISTING=1|2|3` 指定上述操作

### 方式二：Docker Compose（手动）

```bash
git clone https://github.com/7985200/github-account-hub.git && cd github-account-hub
cp .env.example .env        # 编辑 .env：至少修改 DB_PASSWORD
docker compose up -d --build
```

- MySQL 容器首次启动自动创建数据库与应用账号，建表由应用启动时的自动迁移完成，**无需执行 setup-db.js**
- MySQL root 密码默认**不写入 `.env`**：首次初始化由 MySQL 随机生成，只打印在 `docker compose logs mysql` 里一次；应用和备份都只使用权限受限的应用账号（`DB_USER`）
- 数据持久化：`mysql-data` 卷（数据库）+ `app-data` 卷（加密密钥 `data/secret.key`），升级镜像不丢数据
- 端口/绑定地址：`.env` 里的 `PORT` 与 `BIND_IP`（`BIND_IP=127.0.0.1` 时仅本机可访问，配合反代）
- 常用命令：

```bash
docker compose logs -f app        # 查看应用日志
docker compose ps                 # 容器状态
docker compose down               # 停止（数据保留在卷中）
# 备份数据库（用应用账号，无需 root；先加载 .env 里的 DB_* 变量）：
set -a; . ./.env; set +a
docker compose exec -T -e MYSQL_PWD="$DB_PASSWORD" mysql \
  mysqldump -u"$DB_USER" --single-transaction --no-tablespaces "$DB_NAME" > backup.sql
```

### 方式三：宿主机手动部署

**环境要求**：Node.js ≥ 22.19 · MySQL 8.0（本地或远程均可）

```bash
git clone https://github.com/7985200/github-account-hub.git && cd github-account-hub
npm install                       # 安装依赖
cp .env.example .env              # 编辑 .env：至少修改 DB_PASSWORD
node scripts/setup-db.js "你的MySQL-root密码"   # 建库 + 建应用账号 + 建表
npm start                         # 启动，默认 http://127.0.0.1:24524
```

打开站点 → **首次访问会要求创建管理员账号**（与 GitHub 账号无关，是本站自己的登录）。

> 宿主机模式在同一台 MySQL 上部署多个实例时，必须为每个实例指定独立的库名与用户：
> `INSTALL_DB_NAME=github_hub_2 INSTALL_DB_USER=ghhub_2 bash install.sh`
> 否则两个实例会共用同一账号，重装/改密时互相挤下线。`install.sh` 的「部署新实例」菜单会自动处理。

> 宿主机长期运行建议：`pm2 start server/index.js --name github-hub`。
> 从本机直装版迁移到 Docker：导出 `mysqldump` 并导入容器数据库，同时把 `data/secret.key` 复制到 `app-data` 卷，否则已保存的凭据无法解密。

## 配置说明（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `24524` | 监听地址与端口（公网部署时见下文） |
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `3306` | MySQL 地址 |
| `DB_USER` / `DB_PASSWORD` | `ghhub` / — | 应用库账号（仅 `github_hub.*` 权限，由 setup 脚本创建） |
| `DB_NAME` | `github_hub` | 数据库名 |
| `SECRET_KEY_FILE` | `data/secret.key` | 凭据加密密钥文件（**务必备份，丢失则已存凭据无法解密**） |
| `GITHUB_WEB_PROXY` | `auto` | 「密码换 Token」的初始网页通道：`auto` 自动探测 / `direct` 直连 / `http://host:port`；部署后可在菜单「代理设置」里改 |
| `COOKIE_SECURE` | `auto` | 会话 Cookie 的 Secure 策略（`auto` 按请求协议判断） |
| `TRUST_PROXY` | `loopback` | 信任反代 `X-Forwarded-For` 的策略：`loopback` 仅本机反代 / `true` 信任任意反代（Nginx 反代进 Docker 容器时必须）/ `false` / 跳数 |

## 公网部署建议

1. **务必启用 HTTPS**（推荐 Nginx / Caddy 反向代理），并确保转发 `X-Forwarded-Proto` 头；会话 Cookie 会自动带 `Secure`。
2. `HOST` 保持 `127.0.0.1`，由反代转发（不要让 Node 直接监听公网）。
   ```nginx
   location / {
     proxy_pass http://127.0.0.1:24524;
     proxy_set_header Host $host;
     proxy_set_header X-Forwarded-Proto $scheme;
     proxy_set_header X-Real-IP $remote_addr;
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   }
   ```
   宿主机直装 + 本机 Nginx 保持默认 `TRUST_PROXY=loopback` 即可；若反代再转发进 Docker 容器（对端是 Docker 网关而不是 loopback），需在 `.env` 设 `TRUST_PROXY=true`，否则登录失败限速会把所有访客视为同一个 IP，一人输错密码就会锁住所有人。
3. 服务器无法直连 GitHub 时：在「菜单 → 代理设置」填入该服务器的代理（如 `http://127.0.0.1:7890`）；若 `api.github.com` 也不可达，打开「API 请求走代理」开关。
4. 定期备份 `data/` 目录（加密密钥 + 日志）与数据库。

## 安全说明

- GitHub 凭据（Token / 密码）以 **AES-256-GCM** 加密后入库，密钥存放于独立文件 `data/secret.key`（默认权限 0600），与数据库分离；接口永不返回明文密文，仅在「查看/复制」时解密。
- **不在 `.env` 保存 MySQL root 密码**：Docker 首次初始化随机生成，应用与备份只使用仅限本库权限的应用账号；宿主机模式只在初始化时向用户询问 root 密码，不落盘。
- 「密码换 Token」的密码**不落库、不写日志**，仅用于本次网页登录换取 Token。
- 管理员密码使用 **scrypt** 加盐哈希存储；登录会话为 32 字节随机 token（httpOnly + SameSite=Strict Cookie），改密即全端失效。
- 登录失败限速：同一 IP 15 分钟内失败 10 次锁定 15 分钟。
- 全站 API（除登录接口与 `/api/health`）均需登录。
- 本工具用于管理**你本人拥有或已获授权**的账号。批量操作请遵守 GitHub 服务条款，控制频率。

## 常见问题

**Q：添加账号时提示「GitHub 已于 2021-08 停用账号密码认证」？**
A：正常。这是「账号密码」模式的预期行为（凭据仅本地加密保存）。要获得在线能力请使用「Token」或「密码换 Token」。

**Q：`密码换 Token` 失败，提示通道不可用？**
A：去「菜单 → 代理设置」配置能访问 github.com 的代理，点「测试连通性」确认可用后保存。

**Q：账号开了两步验证（2FA）？**
A：`密码换 Token` 不支持 2FA 账号（会明确提示），请在 GitHub 手动创建 Token 后用「Token」方式添加。

**Q：忘记管理员密码？**
A：数据库中删除管理员与会话记录后重启即可重新初始化：
`DELETE FROM admin_users; DELETE FROM admin_sessions;`（账号凭据数据不受影响）

**Q：密钥文件丢了怎么办？**
A：`data/secret.key` 丢失后已保存的 Token/密码无法解密（AES-GCM 设计如此），需重新添加账号。

## 目录结构

```
github-hub/
├── server/               # 后端
│   ├── config/           #   配置聚合（.env → config）
│   ├── db/               #   连接池 + 迁移
│   ├── middleware/       #   认证 / 错误处理 / 访问日志
│   ├── routes/           #   auth / accounts / actions / admin / logs / system
│   ├── services/         #   业务层（账号 / 认证 / 代理 / 设置 / GitHub API / 网页登录）
│   └── utils/            #   加密 / 日志
├── public/               # 前端（login.html + 单页应用）
├── db/schema.sql         # 表结构（幂等）
├── scripts/              # 初始化与启停脚本
├── Dockerfile            # 生产镜像（node:22-alpine，非 root 运行 + 健康检查）
├── docker-compose.yml    # app + MySQL 编排（自动建库建账号，数据卷持久化）
├── install.sh            # 一键部署脚本（Docker / 宿主机可选，彩色交互）
└── .env.example          # 环境变量模板
```

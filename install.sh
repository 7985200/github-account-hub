#!/usr/bin/env bash
# ============================================================
#   GitHub 多账号管家 · 一键部署脚本
#   仓库：https://github.com/7985200/github-account-hub
#
#   用法：bash install.sh
#   支持两种部署方式：
#     1) Docker Compose（推荐，自动建库建表，开箱即用）
#     2) 宿主机直装（需要本机已有 Node.js >= 18 与 MySQL 8.0）
#   可自定义：监听地址（127.0.0.1 / 0.0.0.0）与端口
# ============================================================
set -euo pipefail

REPO_URL="https://github.com/7985200/github-account-hub"
RAW_URL="https://raw.githubusercontent.com/7985200/github-account-hub/main"
APP_TITLE="GitHub 多账号管家"
DEFAULT_PORT="24524"

# ---------------- 彩色输出（非 TTY 自动关闭） ----------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[1;31m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
  C_BLUE=$'\033[1;34m'; C_MAGENTA=$'\033[1;35m'; C_CYAN=$'\033[1;36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_MAGENTA=''; C_CYAN=''
fi

info()  { printf "%s\n" "${C_BLUE}  ▸ ${C_RESET}$*"; }
ok()    { printf "%s\n" "${C_GREEN}  ✓ ${C_RESET}$*"; }
warn()  { printf "%s\n" "${C_YELLOW}  ! ${C_RESET}$*"; }
err()   { printf "%s\n" "${C_RED}  ✗ ${C_RESET}$*"; }
step()  { printf "\n%s\n" "${C_BOLD}${C_MAGENTA}━━ $* ━━${C_RESET}"; }
hr()    { printf "%s\n" "${C_DIM}────────────────────────────────────────────────${C_RESET}"; }

banner() {
  printf "%s" "${C_CYAN}${C_BOLD}"
  cat <<'ART'
   ▄▄▄▄▄▄▄ ▄▄▄▄ ▄▄▄▄▄▄▄ ▄▄▄▄▄▄▄ ▄▄▄▄▄▄ ▄▄▄▄▄▄▄ ▄▄▄▄▄ ▄▄▄
   █  ███  █   █  ███  █  ███  █      █  ███  █      █
   █    █  █   █ ▄ █ ▄ █ █ ▄▄▄ █  ▄▄▄▄█    ▄▄ █▄▄▄▄▄▄█
   █  ▄ █  █   █ ██▄▄█ █ ██▄█▄ █ ██▄▄ █ ▄▄▄█  ▄▄▄▄▄▄
   █▄▄█ █▄▄█   █▄██▄█▄█▄█   █▄█▄█  █▄▄█▄█▄▄▄█▄▄     █▄▄
ART
  printf "%s\n" "${C_RESET}${C_DIM}   $APP_TITLE · 多账号集中管理面板${C_RESET}"
  printf "%s\n" "${C_DIM}   开源地址：$REPO_URL${C_RESET}"
}

# ---------------- 前置检查 ----------------
# 通过环境变量 INSTALL_* 可跳过交互（CI/自动化场景）：
#   INSTALL_MODE=1|2  INSTALL_PORT=24524  INSTALL_BIND=127.0.0.1|0.0.0.0
#   INSTALL_CONFIRM=1  INSTALL_MYSQL_ROOT=<密码（宿主机模式）>
NONINT="${INSTALL_MODE:+1}"

# 交互模式要求：stdin 必须是终端（curl 管道会破坏交互）
if [ ! -t 0 ] && [ -z "$NONINT" ]; then
  err "检测到标准输入不是终端，无法进行交互式安装。"
  info  "请下载脚本后运行，或使用进程替换："
  info  "  bash <(curl -fsSL $RAW_URL/install.sh)"
  info  "非交互安装：INSTALL_MODE=1 INSTALL_PORT=24524 INSTALL_BIND=0.0.0.0 INSTALL_CONFIRM=1 bash install.sh"
  exit 1
fi

banner

# ---------------- 定位项目源码 ----------------
# 三种运行方式都能正确工作：
#   1) clone 后在项目目录内运行： bash install.sh
#   2) 指定路径运行：             bash /path/to/install.sh
#   3) 免 clone 一键运行：        bash <(curl -fsSL .../install.sh)  ← 自动克隆源码
step "准备项目源码"

PROJECT_DIR=""
SELF="${BASH_SOURCE[0]:-}"

# 1) 当前目录已是项目
if [ -f "server/index.js" ] && [ -f "docker-compose.yml" ]; then
  PROJECT_DIR="$PWD"
# 2) 脚本自身所在目录是项目（排除 /dev/fd/* 等进程替换与管道场景）
elif [ -n "$SELF" ] && [ -f "$SELF" ] && [[ "$SELF" != /dev/fd/* ]] && [[ "$SELF" != /dev/stdin ]]; then
  SELF_DIR="$(cd "$(dirname "$SELF")" 2>/dev/null && pwd || true)"
  if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/server/index.js" ]; then
    PROJECT_DIR="$SELF_DIR"
  fi
fi

# 3) 无源码 → 自动克隆仓库（免 clone 一键模式）
if [ -z "$PROJECT_DIR" ]; then
  if ! command -v git >/dev/null 2>&1; then
    err "未检测到项目源码，且系统缺少 git，无法自动获取。"
    info "请手动下载源码后运行：git clone $REPO_URL.git && cd github-account-hub && bash install.sh"
    exit 1
  fi
  TARGET_DIR="github-account-hub"
  if [ -d "$TARGET_DIR" ] && [ -f "$TARGET_DIR/server/index.js" ]; then
    ok "检测到已存在的项目目录：$TARGET_DIR"

    # 已有部署 → 询问操作（非交互模式可用 INSTALL_EXISTING=1|2|3 指定，默认 1）
    ACTION="${INSTALL_EXISTING:-}"
    if [ -z "$ACTION" ] && [ -n "$NONINT" ]; then
      ACTION="1"
    fi
    if [ -z "$ACTION" ]; then
      while true; do
        printf "\n%s\n" "${C_BOLD}检测到该项目已部署过，请选择操作：${C_RESET}"
        printf "%s\n" "  ${C_GREEN}1${C_RESET}) 重新部署      使用现有源码，保留数据（数据库与配置不变）"
        printf "%s\n" "  ${C_GREEN}2${C_RESET}) 更新到最新    拉取仓库最新代码后重新部署"
        printf "%s\n" "  ${C_GREEN}3${C_RESET}) 部署新实例    克隆到新目录（独立端口与数据，可与现有实例并存）"
        read -rp "输入 1/2/3 [默认 1]: " ACTION
        ACTION="${ACTION:-1}"
        case "$ACTION" in 1|2|3) break ;; *) warn "无效输入：$ACTION" ;; esac
      done
    fi

    case "$ACTION" in
      1)
        ok "使用现有源码重新部署（数据保留）"
        ;;
      2)
        info "拉取仓库最新代码…"
        if git -C "$TARGET_DIR" pull --ff-only 2>&1 | tail -3; then
          ok "代码已更新到最新"
        else
          warn "更新失败（网络不通或存在本地改动），将继续使用当前代码部署"
        fi
        ;;
      3)
        BASE_DIR="$TARGET_DIR"
        N=2
        while [ -d "${BASE_DIR}-${N}" ]; do N=$((N + 1)); done
        TARGET_DIR="${BASE_DIR}-${N}"
        info "克隆新实例到 $TARGET_DIR …"
        if ! git clone --depth 1 "$REPO_URL.git" "$TARGET_DIR"; then
          err "克隆失败。若服务器无法访问 github.com，请手动上传源码后运行 bash install.sh"
          exit 1
        fi
        ok "新实例源码就绪"
        DEFAULT_PORT="24525"
        warn "新实例请使用与旧实例不同的端口（默认已改为 $DEFAULT_PORT）"
        ;;
    esac
  else
    info "未检测到项目源码，正在克隆仓库…"
    info "  $REPO_URL.git"
    if ! git clone --depth 1 "$REPO_URL.git" "$TARGET_DIR"; then
      err "克隆失败。若服务器无法访问 github.com，请手动下载源码上传后运行 bash install.sh"
      exit 1
    fi
    ok "源码克隆完成"
  fi
  PROJECT_DIR="$PWD/$TARGET_DIR"
fi

cd "$PROJECT_DIR"
ok "项目目录：$PROJECT_DIR"

# ---------------- 收集部署参数 ----------------
step "部署配置"

if [ -n "$NONINT" ]; then
  MODE="$INSTALL_MODE"
  PORT="${INSTALL_PORT:-$DEFAULT_PORT}"
  BIND_IP="${INSTALL_BIND:-127.0.0.1}"
  ok "非交互模式：MODE=$MODE PORT=$PORT BIND=$BIND_IP"
else
  MODE=""
  while true; do
    printf "%s\n" "${C_BOLD}请选择部署方式：${C_RESET}"
    printf "%s\n" "  ${C_GREEN}1${C_RESET}) Docker Compose （推荐 · 自动创建数据库，需已安装 Docker）"
    printf "%s\n" "  ${C_GREEN}2${C_RESET}) 宿主机直装     （需要本机已有 Node.js >= 18 与 MySQL 8.0）"
    read -rp "输入 1 或 2 [默认 1]: " MODE
    MODE="${MODE:-1}"
    case "$MODE" in
      1|2) break ;;
      *) warn "无效输入：$MODE" ;;
    esac
  done

  # 端口
  PORT=""
  while true; do
    read -rp "服务端口 [默认 $DEFAULT_PORT]: " PORT
    PORT="${PORT:-$DEFAULT_PORT}"
    if [[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]; then
      break
    fi
    warn "端口必须是 1-65535 的数字"
  done

  # 监听地址
  BIND_CHOICE=""
  while true; do
    printf "%s\n" "${C_BOLD}监听地址：${C_RESET}"
    printf "%s\n" "  ${C_GREEN}1${C_RESET}) 127.0.0.1  仅本机可访问（配合 Nginx 反代时选这个）"
    printf "%s\n" "  ${C_GREEN}2${C_RESET}) 0.0.0.0    所有网卡可访问（公网/局域网直接访问）"
    read -rp "输入 1 或 2 [默认 1]: " BIND_CHOICE
    BIND_CHOICE="${BIND_CHOICE:-1}"
    case "$BIND_CHOICE" in
      1) BIND_IP="127.0.0.1"; break ;;
      2) BIND_IP="0.0.0.0";  break ;;
      *) warn "无效输入：$BIND_CHOICE" ;;
    esac
  done
fi

# 端口合法性统一校验
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  err "端口必须是 1-65535 的数字（当前：$PORT）"
  exit 1
fi

# 随机生成数据库密码（除非 .env 里已有）
if [ -f .env ] && grep -q '^DB_PASSWORD=' .env && ! grep -q '^DB_PASSWORD=$' .env; then
  DB_PASSWORD="$(grep '^DB_PASSWORD=' .env | head -1 | cut -d= -f2-)"
  ok "沿用 .env 中已有的数据库密码"
else
  DB_PASSWORD="Ghhub-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-10)-$(date +%s | tail -c 5)"
fi

step "配置确认"
printf "%s\n" "  部署方式   : $([ "$MODE" = 1 ] && echo 'Docker Compose' || echo '宿主机直装')"
printf "%s\n" "  监听地址   : $BIND_IP"
printf "%s\n" "  端口       : $PORT"
printf "%s\n" "  数据库密码 : ${C_DIM}（已生成/复用，见 .env）${C_RESET}"
if [ "${INSTALL_CONFIRM:-}" = "1" ]; then
  ok "非交互模式：自动确认"
else
  read -rp "确认开始安装？[Y/n]: " CONFIRM
  CONFIRM="${CONFIRM:-Y}"
  if [[ ! "$CONFIRM" =~ ^[Yy] ]]; then
    info "已取消安装。"
    exit 0
  fi
fi

# ---------------- 生成 .env ----------------
step "生成环境配置（.env）"
if [ -f .env ]; then
  cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
  ok "已备份原 .env"
fi
cat > .env <<ENV
# ============================================================
#  由 install.sh 生成于 $(date '+%Y-%m-%d %H:%M:%S')
#  仓库：$REPO_URL
# ============================================================
NODE_ENV=production
HOST=$BIND_IP
PORT=$PORT

# ---------- MySQL ----------
DB_HOST=$([ "$MODE" = 1 ] && echo mysql || echo 127.0.0.1)
DB_PORT=3306
DB_USER=ghhub
DB_PASSWORD=$DB_PASSWORD
DB_NAME=github_hub
DB_POOL_SIZE=10
MYSQL_ROOT_PASSWORD=Root-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-10)

# ---------- 存储 / 日志 ----------
DATA_DIR=data
LOG_DIR=logs
SECRET_KEY_FILE=data/secret.key

# ---------- GitHub API ----------
GITHUB_TIMEOUT=20000

# ---------- 网页登录（「密码换 Token」功能）----------
# 服务器无法直连 github.com 时：auto=自动探测 | direct=直连 | http://IP:端口=自定义代理
# 部署后也可在「菜单 → 代理设置」里随时修改
GITHUB_WEB_PROXY=auto
GITHUB_WEB_TIMEOUT=25000

# ---------- 公网部署 ----------
# HTTPS 反代场景保持 auto（按请求协议自动为会话 Cookie 加 Secure）
COOKIE_SECURE=auto

# ---------- Docker 端口绑定 ----------
BIND_IP=$BIND_IP
ENV
ok ".env 已生成（含随机数据库密码）"

# ================= Docker 模式 =================
if [ "$MODE" = 1 ]; then
  step "Docker 部署"

  if ! command -v docker >/dev/null 2>&1; then
    err "未检测到 docker 命令。请先安装 Docker：https://docs.docker.com/engine/install/"
    exit 1
  fi

  COMPOSE_CMD=""
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
  else
    err "未检测到 Docker Compose 插件。请安装：docker-compose-plugin"
    exit 1
  fi
  ok "Docker 环境就绪（$COMPOSE_CMD）"

  info "构建镜像并启动容器（首次构建需要几分钟，取决于网络）…"
  $COMPOSE_CMD up -d --build

  info "等待服务健康检查通过…"
  WAITED=0
  while [ "$WAITED" -lt 180 ]; do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
      break
    fi
    sleep 3
    WAITED=$((WAITED + 3))
  done

  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
    ok "服务已就绪（耗时约 ${WAITED}s）"
  else
    warn "健康检查超时，请查看日志排查：$COMPOSE_CMD logs -f app"
    exit 1
  fi

  STEP_HINT="$COMPOSE_CMD logs -f app"
  STOP_HINT="$COMPOSE_CMD down"
  UPGRADE_HINT="git pull && $COMPOSE_CMD up -d --build"

# ================= 宿主机模式 =================
else
  step "宿主机直装"

  if ! command -v node >/dev/null 2>&1; then
    err "未检测到 node。请安装 Node.js >= 18：https://nodejs.org/"
    exit 1
  fi
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -lt 18 ]; then
    err "Node.js 版本过低（$(node -v)），需要 >= 18"
    exit 1
  fi
  ok "Node.js $(node -v)"

  info "安装依赖（npm ci）…"
  npm ci --omit=dev --no-fund --no-audit
  ok "依赖安装完成"

  info "初始化数据库（需要 MySQL root 密码）…"
  MYSQL_ROOT="${INSTALL_MYSQL_ROOT:-}"
  if [ -z "$MYSQL_ROOT" ]; then
    read -rp "MySQL root 密码: " -s MYSQL_ROOT
    printf "\n"
  fi
  if node scripts/setup-db.js "$MYSQL_ROOT"; then
    ok "数据库初始化完成"
  else
    err "数据库初始化失败，请检查 MySQL 是否运行、root 密码是否正确"
    exit 1
  fi

  info "启动服务（后台运行）…"
  mkdir -p logs data
  if [ -f data/app.pid ] && kill -0 "$(cat data/app.pid)" 2>/dev/null; then
    warn "检测到已有实例（PID $(cat data/app.pid)），先停止…"
    kill "$(cat data/app.pid)" 2>/dev/null || true
    sleep 2
  fi
  HOST="$BIND_IP" PORT="$PORT" nohup node server/index.js >> logs/app.out 2>&1 &
  echo $! > data/app.pid
  sleep 3

  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
    ok "服务已启动（PID $(cat data/app.pid)）"
  else
    err "服务启动失败，请查看日志：logs/app.out"
    exit 1
  fi

  STEP_HINT="tail -f logs/app.out"
  STOP_HINT="kill \$(cat data/app.pid)"
  UPGRADE_HINT="git pull && npm ci --omit=dev && kill \$(cat data/app.pid) && HOST=$BIND_IP PORT=$PORT nohup node server/index.js >> logs/app.out 2>&1 &"
fi

# ---------------- 完成信息 ----------------
hr
printf "%s\n" "${C_GREEN}${C_BOLD}  🎉 安装完成！${C_RESET}"
hr
printf "%s\n" "  ${C_BOLD}访问地址${C_RESET} : http://$([ "$BIND_IP" = "0.0.0.0" ] && echo "<服务器IP>" || echo "$BIND_IP"):$PORT"
printf "%s\n" "  ${C_BOLD}首次使用${C_RESET} : 打开站点 → 创建管理员账号（与 GitHub 账号无关）"
printf "%s\n" "  ${C_BOLD}查看日志${C_RESET} : $STEP_HINT"
printf "%s\n" "  ${C_BOLD}停止服务${C_RESET} : $STOP_HINT"
printf "%s\n" "  ${C_BOLD}升级版本${C_RESET} : $UPGRADE_HINT"
printf "%s\n" "  ${C_BOLD}数据备份${C_RESET} : 密钥文件 data/secret.key + MySQL 数据（请定期备份）"
hr
printf "%s\n" "  ${C_DIM}开源地址：$REPO_URL${C_RESET}"
printf "%s\n" "  ${C_DIM}问题反馈：$REPO_URL/issues${C_RESET}"
hr

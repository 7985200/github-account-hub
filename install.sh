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

# ---------------- 更新前备份 ----------------
# 备份内容：data/ 目录（含加密密钥 secret.key、登录态、调试快照）+ 数据库
# 失败不阻断更新，只提示；非交互模式直接跳过，避免卡住
backup_before_update() {
  local dir="$1"
  local stamp name root ans tmp target
  local dumped=0 skipdata=0 data_captured=0
  local compose="" cid="" appcid="" svc="" rootpw="" dbname="" dbuser="" dbpass="" dbhost="" dbport=""
  local m_user="" m_pass="" data_state=""

  stamp="$(date '+%Y年%m月%d日')"
  name="${stamp}备份.zip"

  if [ -n "$NONINT" ]; then
    warn "非交互模式：跳过交互备份，请在更新前自行备份 $dir/data 与数据库"
    return 0
  fi

  printf "\n%s\n" "${C_BOLD}更新前是否备份数据？${C_RESET}"
  printf "%s\n" "  ${C_DIM}备份内容：data/ 目录（含加密密钥、登录态）+ 数据库${C_RESET}"
  ans=""
  read -rp "是否备份 [Y/n]: " ans || true
  case "$ans" in
    n|N|no|NO) info "已跳过备份"; return 0 ;;
  esac

  read -rp "备份保存目录 [默认 /github-vote]: " root || true
  root="${root:-/github-vote}"
  # shellcheck disable=SC2088  # 下面是 case 模式匹配，不是路径展开，不会也不需要展开 ~
  case "$root" in
    "~")   root="$HOME" ;;
    "~/"*) root="$HOME/${root#\~/}" ;;
  esac
  # 去掉末尾斜杠，避免拼出 //
  while [ "${root%/}" != "$root" ] && [ "$root" != "/" ]; do root="${root%/}"; done
  # 绝对路径判断：POSIX 以 / 开头；同时兼容 Windows 盘符（C:// 或 C:/）
  case "$root" in
    /*|?:[\\/]*) : ;;
    *)  root="$PWD/$root" ;;
  esac

  # 默认 /github-vote 需要 root 权限，失败则回落到用户家目录
  if ! mkdir -p "$root" 2>/dev/null || [ ! -w "$root" ]; then
    if [ "$root" = "/github-vote" ] && mkdir -p "$HOME/github-vote" 2>/dev/null && [ -w "$HOME/github-vote" ]; then
      root="$HOME/github-vote"
      warn "无权创建 /github-vote（需 root），已改用 $root"
    else
      err "无法创建备份目录：$root"
      warn "已跳过备份，继续更新"
      return 1
    fi
  fi

  # 临时目录优先放在备份目标所在分区：/tmp 在多数发行版是 tmpfs（内存盘），
  # 数据库几个 GB 时会写满内存甚至触发 OOM，放同分区则没有这个风险
  tmp=""
  if [ -d "$root" ] && [ -w "$root" ]; then
    mkdir -p "$root/.ghhub-bktmp" 2>/dev/null && \
      tmp="$(mktemp -d "$root/.ghhub-bktmp/bk.XXXXXX" 2>/dev/null || true)"
  fi
  if [ -z "$tmp" ]; then
    tmp="$(mktemp -d 2>/dev/null || echo "/tmp/ghhub-backup-$$")"
    mkdir -p "$tmp" 2>/dev/null || { warn "临时目录创建失败，已跳过备份"; return 1; }
  fi

  # 1) data 目录（加密密钥与登录态都在这里，最关键）
  case "$root/" in
    "$dir/data/"*) warn "备份目录位于 data/ 内部，跳过 data/ 复制以免归档自我嵌套"; skipdata=1 ;;
  esac
  if [ "$skipdata" -eq 0 ] && [ -d "$dir/data" ]; then
    if cp -a "$dir/data" "$tmp/data" 2>/dev/null; then
      ok "已收集 data/ 目录"
    else
      warn "data/ 目录复制失败"
    fi
  elif [ "$skipdata" -eq 0 ]; then
    warn "未找到 $dir/data 目录，跳过"
  fi

  # 1b) .env：里面有 DB_PASSWORD（新版不再写 MySQL root 密码），
  #     不备份的话，恢复数据库后密码对不上照样连不上
  if [ -f "$dir/.env" ] && [ "$skipdata" -eq 0 ]; then
    if cp "$dir/.env" "$tmp/.env" 2>/dev/null; then
      ok "已收集 .env（数据库口令与配置）"
      chmod 600 "$tmp/.env" 2>/dev/null || true
    else
      warn ".env 复制失败"
    fi
  fi

  # 2) 从 .env 读数据库配置
  #    compose 用的是 DB_NAME/DB_USER/DB_PASSWORD，宿主机模式用 DB_*；
  #    MYSQL_DATABASE 只在用户手写 .env 时存在，作为兼容项保留
  #    注意 tr -d '\r'：.env 若在 Windows 上编辑过会带 CRLF，密码末尾的 \r 会让 mysqldump 认证失败
  if [ -f "$dir/.env" ]; then
    rootpw="$( { grep -E '^MYSQL_ROOT_PASSWORD=' "$dir/.env" 2>/dev/null || true; } | head -1 | cut -d= -f2- | tr -d '\r' | sed 's/^"//; s/"$//' )"
    dbname="$( { grep -E '^(DB_NAME|MYSQL_DATABASE)=' "$dir/.env" 2>/dev/null || true; } | head -1 | cut -d= -f2- | tr -d '\r' | sed 's/^"//; s/"$//' )"
    dbuser="$( { grep -E '^DB_USER=' "$dir/.env" 2>/dev/null || true; } | head -1 | cut -d= -f2- | tr -d '\r' | sed 's/^"//; s/"$//' )"
    dbpass="$( { grep -E '^DB_PASSWORD=' "$dir/.env" 2>/dev/null || true; } | head -1 | cut -d= -f2- | tr -d '\r' | sed 's/^"//; s/"$//' )"
    dbhost="$( { grep -E '^DB_HOST=' "$dir/.env" 2>/dev/null || true; } | head -1 | cut -d= -f2- | tr -d '\r' | sed 's/^"//; s/"$//' )"
    dbport="$( { grep -E '^DB_PORT=' "$dir/.env" 2>/dev/null || true; } | head -1 | cut -d= -f2- | tr -d '\r' | sed 's/^"//; s/"$//' )"
  fi
  dbname="${dbname:-github_hub}"

  # 3) Docker 部署：探测 compose 命令（备份发生在 COMPOSE_CMD 赋值之前，这里必须自己探）
  if command -v docker >/dev/null 2>&1; then
    if docker compose version >/dev/null 2>&1; then
      compose="docker compose"
    elif command -v docker-compose >/dev/null 2>&1; then
      compose="docker-compose"
    fi
  fi

  # 服务名不能写死：本项目叫 mysql，其他编排可能叫 db。
  # 先按 compose 文件里 image 含 mysql/mariadb 的服务解析，再用常见名兜底
  if [ -n "$compose" ] && [ -f "$dir/docker-compose.yml" ]; then
    svc="$(awk '
      /^services:[[:space:]]*$/ { inb = 1; next }
      inb && /^[^[:space:]#]/    { inb = 0 }
      inb && /^  [A-Za-z0-9_.-]+:[[:space:]]*$/ {
        n = $1; sub(/:.*/, "", n); cur = n; next
      }
      inb && /image:/ && tolower($0) ~ /(mysql|mariadb)/ { print cur; exit }
    ' "$dir/docker-compose.yml" 2>/dev/null | tr -d ' \r')"
    if [ -z "$svc" ]; then
      for s in db mysql database mariadb; do
        cid="$( cd "$dir" 2>/dev/null || exit 0; $compose ps -q "$s" 2>/dev/null | head -1 || true )"
        if [ -n "$cid" ]; then svc="$s"; break; fi
      done
    fi
    if [ -n "$svc" ] && [ -z "$cid" ]; then
      cid="$( cd "$dir" 2>/dev/null || exit 0; $compose ps -q "$svc" 2>/dev/null | head -1 || true )"
    fi
  fi

  # 2b) Docker 部署：data/ 在 app-data 卷里，宿主机看不到，必须从 app 容器导出
  if [ -n "$compose" ] && [ -f "$dir/docker-compose.yml" ]; then
    appcid="$( cd "$dir" 2>/dev/null || exit 0; $compose ps -q app 2>/dev/null | head -1 || true )"
    if [ -n "$appcid" ]; then
      if docker exec "$appcid" tar -czf - -C /app/data . >"$tmp/app-data.tgz" 2>"$tmp/app-data.err" && [ -s "$tmp/app-data.tgz" ]; then
        data_captured=1
        ok "已收集 app-data 卷（加密密钥与登录态）"
      else
        rm -f "$tmp/app-data.tgz"
        warn "app-data 卷导出失败：$(head -c 160 "$tmp/app-data.err" 2>/dev/null | tr '\n' ' ')"
      fi
    else
      warn "未找到运行中的 app 容器，无法导出 app-data 卷（密钥可能在卷里）"
    fi
  fi

  if [ -n "$cid" ]; then
    # 先用 .env 里的 root 密码。Docker 数据卷一旦初始化，root 密码就固定了；
    # 旧版 install.sh 重跑时可能把 .env 改成新的随机值 → 这里 Access denied 很常见。
    # 失败时回退到应用账号（对本库有全部权限，密码由 DB_PASSWORD 保证正确）。
    if [ -n "$rootpw" ] && docker exec -e MYSQL_PWD="$rootpw" "$cid" \
         mysqldump -uroot --single-transaction --routines --events "$dbname" \
         >"$tmp/database.sql" 2>"$tmp/dump.err" && [ -s "$tmp/database.sql" ]; then
      dumped=1
      ok "已导出数据库（root / 容器 $svc / 库 $dbname / $(du -h "$tmp/database.sql" 2>/dev/null | cut -f1)）"
    else
      warn "容器内 root 导出失败：$(head -c 160 "$tmp/dump.err" 2>/dev/null | tr '\n' ' ')"
      rm -f "$tmp/database.sql"
      if [ -n "$dbpass" ] && docker exec -e MYSQL_PWD="$dbpass" "$cid" \
           mysqldump -u"${dbuser:-ghhub}" --single-transaction --no-tablespaces --default-character-set=utf8mb4 "$dbname" \
           >"$tmp/database.sql" 2>"$tmp/dump.err" && [ -s "$tmp/database.sql" ]; then
        dumped=1
        ok "已改用应用账号导出数据库（容器 $svc / 库 $dbname / $(du -h "$tmp/database.sql" 2>/dev/null | cut -f1)）"
      else
        warn "容器内应用账号导出也失败：$(head -c 160 "$tmp/dump.err" 2>/dev/null | tr '\n' ' ')"
        rm -f "$tmp/database.sql"
      fi
    fi
  fi

  # 4) 宿主机部署：本机有 mysqldump 就优先用它（一致性远好于直接复制正在写入的数据目录）
  #    注意：旧版 .env 可能残留 MYSQL_ROOT_PASSWORD（新版已不再写入），它只属于 Docker 容器；
  #    宿主机真实 root 密码与它无关，不能拿它覆盖应用账号凭据 —— 应用账号对本库有全部权限，足以导出。
  if [ "$dumped" -eq 0 ] && command -v mysqldump >/dev/null 2>&1; then
    m_user="${dbuser:-root}"
    m_pass="$dbpass"
    if [ -n "$m_pass" ]; then
      if MYSQL_PWD="$m_pass" mysqldump \
           -h "${dbhost:-127.0.0.1}" -P "${dbport:-3306}" -u "$m_user" \
           --single-transaction --routines --events "$dbname" \
           >"$tmp/database.sql" 2>"$tmp/dump.err"; then
        if [ -s "$tmp/database.sql" ]; then
          dumped=1
          ok "已导出数据库（本机 mysqldump / 库 $dbname / $(du -h "$tmp/database.sql" 2>/dev/null | cut -f1)）"
        fi
      else
        rm -f "$tmp/database.sql"
      fi
    fi
  fi

  # 5) 最后兜底：复制 MySQL 数据目录（仅免安装版实例存在该路径）
  if [ "$dumped" -eq 0 ] && [ -d "$dir/runtime/mysql/data" ]; then
    if cp -a "$dir/runtime/mysql/data" "$tmp/mysql-data" 2>/dev/null; then
      dumped=1
      warn "MySQL 正在运行时直接复制数据目录，备份可能不一致；建议停库后再备份"
    else
      warn "MySQL 数据目录复制失败"
    fi
  fi

  if [ "$dumped" -eq 0 ]; then
    err "数据库没有备份成功！账号数据都存在数据库里，只有 data/ 无法恢复账号"
    warn "请手动导出后妥善保存：mysqldump -u<用户> -p <库名> > backup.sql"
  fi

  # 6) 元信息，便于日后确认对应哪个版本
  data_state="未包含"
  if [ "$data_captured" -eq 1 ] || [ -d "$dir/data" ]; then data_state="已包含"; fi
  {
    echo "备份时间: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "项目目录: $dir"
    echo "数据库名: $dbname"
    echo "数据库备份: $([ "$dumped" -eq 1 ] && echo 已包含 || echo 未包含（需手动导出）)"
    echo "data 备份: $data_state"
    echo "代码版本: $(cd "$dir" 2>/dev/null && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  } >"$tmp/BACKUP-INFO.txt" 2>/dev/null || true

  # 7) 恢复说明：只给一个 database.sql，多数人不知道该怎么导回去
  cat >"$tmp/RESTORE.txt" 2>/dev/null <<RESTORE
本备份由 install.sh 在更新前自动生成，请连同 BACKUP-INFO.txt 一起保管。

包含内容
  data/         加密密钥 secret.key 与网页登录态（最关键，丢了已保存的 Token 就解不开）
  app-data.tgz  仅 Docker 部署：从 app-data 卷导出的 data/ 打包（等同 data/）
  .env          数据库口令与配置（等同密码文件，注意保管）
  database.sql  数据库导出（账号、日志等数据都在这）
  mysql-data/   仅宿主机免安装版 MySQL 才会有的数据目录副本

恢复步骤（Docker 部署，在项目根目录执行；<解压目录> 换成你解开本压缩包的路径）
  1) 停止服务
       docker compose down
  2) 还原数据目录与配置
       Docker 部署：用 app-data.tgz 还原卷（示例卷名 <项目名>_app-data）：
         docker run --rm -v <项目名>_app-data:/data -v <解压目录>:/backup alpine \
           sh -c 'cd /data && tar -xzf /backup/app-data.tgz'
       宿主机部署：
         rm -rf data && cp -a <解压目录>/data ./data
       cp <解压目录>/.env ./.env
  3) 启动数据库并导入（<库名> 见 BACKUP-INFO.txt，一般是 $dbname）
       docker compose up -d mysql
       docker compose exec -T mysql sh -c 'exec mysql -u"\$MYSQL_USER" -p"\$MYSQL_PASSWORD" "\$MYSQL_DATABASE"' < <解压目录>/database.sql
  4) 重建并启动应用
       docker compose up -d --build

两个必须注意的点
  - data/secret.key 必须和数据库一起还原：Token 是用它加密的，缺了就算数据库完整也解不开
  - .env 里的 DB_PASSWORD 要与数据库里的应用账号密码一致，否则应用连不上库

如果 database.sql 不存在（BACKUP-INFO 里写「未包含」），说明当时导出失败，
需要在旧环境里手动执行：mysqldump -u<用户> -p <库名> > backup.sql
RESTORE

  # 8) 打包为 zip；没有 zip 命令时退化为 tar.gz
  target="$root/$name"
  # 同一天多次更新时加序号，避免静默覆盖上一次的备份
  if [ -e "$target" ]; then
    local n=2
    while [ -e "$root/${stamp}备份-${n}.zip" ]; do n=$((n + 1)); done
    target="$root/${stamp}备份-${n}.zip"
  fi
  local packed=0
  if command -v zip >/dev/null 2>&1; then
    if (cd "$tmp" && zip -qr "$target" .) 2>/dev/null; then
      packed=1
      ok "备份已保存：$target"
    fi
  fi
  # 没有 zip 命令时用 python3 生成标准 zip（大多数 Linux 自带）
  if [ "$packed" -eq 0 ] && command -v python3 >/dev/null 2>&1; then
    if python3 -c "import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2])" "${target%.zip}" "$tmp" >/dev/null 2>&1; then
      packed=1
      ok "备份已保存：$target（python3 打包）"
    fi
  fi
  # 两者都没有才退化为 tar.gz
  if [ "$packed" -eq 0 ]; then
    target="$root/${stamp}备份.tar.gz"
    if tar -czf "$target" -C "$tmp" . 2>/dev/null; then
      warn "系统没有 zip 与 python3，已改用 tar.gz：$target"
    else
      warn "打包失败：$target"
    fi
  fi

  rm -rf "$tmp" 2>/dev/null || true
  rmdir "$root/.ghhub-bktmp" 2>/dev/null || true
  if [ -f "$target" ]; then
    ok "备份大小：$( { du -h "$target" 2>/dev/null || true; } | cut -f1 || true)"
  fi
  if [ "$dumped" -eq 0 ]; then
    warn "⚠ 本次归档不含数据库，不能作为唯一恢复依据；请按上面的提示手动导出后再升级"
  fi
  if [ "$data_captured" -eq 0 ] && [ ! -d "$dir/data" ] && [ -n "$compose" ]; then
    warn "⚠ 本次归档未包含 data/（加密密钥），请单独备份 app-data 卷"
  fi
  return 0
}

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
  SELF_DIR="$( cd "$(dirname "$SELF")" 2>/dev/null || exit 0; pwd )"
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
        # 更新前先询问是否备份（备份的是更新前的状态，失败不阻断更新）
        UPD_DIR="$TARGET_DIR"
        case "$UPD_DIR" in
          /*) : ;;
          *)  UPD_DIR="$PWD/$UPD_DIR" ;;
        esac
        backup_before_update "$UPD_DIR"
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
        # 宿主机模式多实例共用一个 MySQL：必须用独立库名+用户，否则互相挤掉线
        INSTALL_DB_NAME="github_hub_${N}"
        INSTALL_DB_USER="ghhub_${N}"
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

# 监听地址不能包含空白/换行，避免污染 .env
case "$BIND_IP" in
  *[[:space:]]*)
    err "监听地址不能包含空白或换行（当前：$BIND_IP）"
    exit 1
    ;;
esac

# 数据库名/用户：优先 INSTALL_DB_NAME / INSTALL_DB_USER（多实例隔离用），
# 其次沿用 .env 已有值，最后用默认值。宿主机多实例必须各用各的库+用户，
# 否则第二个实例改密码会把第一个实例挤下线。
EXIST_DB_NAME=""
EXIST_DB_USER=""
if [ -f .env ]; then
  EXIST_DB_NAME="$(grep -E '^DB_NAME=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r')"
  EXIST_DB_USER="$(grep -E '^DB_USER=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r')"
fi
if [ -n "${INSTALL_DB_NAME:-}" ]; then
  DB_NAME="$INSTALL_DB_NAME"
else
  DB_NAME="${EXIST_DB_NAME:-github_hub}"
fi
if [ -n "${INSTALL_DB_USER:-}" ]; then
  DB_USER="$INSTALL_DB_USER"
elif [ -n "${INSTALL_DB_NAME:-}" ]; then
  # 只给了库名时，用户默认跟库名走，避免继续共用 ghhub 把旧实例挤下线
  DB_USER="$INSTALL_DB_NAME"
else
  DB_USER="${EXIST_DB_USER:-ghhub}"
fi

if ! [[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]]; then
  err "数据库名只能包含字母、数字和下划线（当前：$DB_NAME）"
  exit 1
fi
if ! [[ "$DB_USER" =~ ^[A-Za-z0-9_]+$ ]]; then
  err "数据库用户名只能包含字母、数字和下划线（当前：$DB_USER）"
  exit 1
fi

# 随机生成数据库密码（除非 .env 里已有）
if [ -f .env ] && grep -q '^DB_PASSWORD=' .env && ! grep -q '^DB_PASSWORD=$' .env; then
  DB_PASSWORD="$(grep '^DB_PASSWORD=' .env | head -1 | cut -d= -f2- | tr -d '\r')"
  ok "沿用 .env 中已有的数据库密码"
else
  DB_PASSWORD="Ghhub-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-10)-$(date +%s | tail -c 5)"
fi

# 数据库密码不能包含换行/CR，避免污染 .env
case "$DB_PASSWORD" in
  *$'\n'*|*$'\r'*)
    err "数据库密码不能包含换行或回车"
    exit 1
    ;;
esac

# 旧版 .env 曾保存 MySQL root 密码。新版本不再把它写进项目 .env：
# 应用运行时只需要 DB_USER/DB_PASSWORD；Docker 的 root 密码在数据卷首次初始化时就固定了，
# 迁移到仅 root 可读的家目录文件，避免升级后彻底丢失 root 维护入口。
LEGACY_ROOT_PW=""
if [ "$MODE" = 1 ] && [ -f .env ]; then
  LEGACY_ROOT_PW="$( { grep -E '^MYSQL_ROOT_PASSWORD=.' .env 2>/dev/null || true; } | head -1 | cut -d= -f2- | tr -d '\r' )"
fi
if [ -n "$LEGACY_ROOT_PW" ]; then
  umask 077
  printf '%s\n' "$LEGACY_ROOT_PW" >"$HOME/.ghhub-mysql-root"
  chmod 600 "$HOME/.ghhub-mysql-root" 2>/dev/null || true
  umask 022
  warn "旧 .env 中的 MySQL root 密码已迁移到 $HOME/.ghhub-mysql-root（不再写入项目 .env）"
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
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_NAME=$DB_NAME
DB_POOL_SIZE=10
# MySQL root 密码默认不落盘：Docker 首次初始化随机生成，可在 docker compose logs mysql 查看一次。
# 如确需固定 root 密码，请按 docker-compose.yml 里的注释修改（不推荐，备份/迁移都不需要它）。

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
chmod 600 .env 2>/dev/null || true
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
  # undici 8.x 要求 Node >= 22.19（低版本 require('undici') 时就会崩溃）
  if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)'; then
    err "Node.js 版本过低（$(node -v)），需要 >= 22.19（依赖 undici 8.x）"
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
  # 宿主机多实例共用一个 MySQL：同名库已被别的实例使用时，再部署会改掉共享用户密码，
  # 把旧实例挤下线。检测到这种情况直接拒绝，要求显式指定独立库名/用户。
  if [ -z "${INSTALL_DB_NAME:-}" ] && [ -z "${EXIST_DB_NAME:-}" ] && command -v mysql >/dev/null 2>&1; then
    DB_USED="$(mysql -h "${DB_HOST:-127.0.0.1}" -P "${DB_PORT:-3306}" -uroot -p"$MYSQL_ROOT" -N -e \
      "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_NAME' AND table_name='accounts'" 2>/dev/null || echo 0)"
    if [ "${DB_USED:-0}" != "0" ]; then
      err "数据库 $DB_NAME 已被其他实例使用，继续部署会改掉共享账号密码并影响旧实例。"
      info "请改用独立库名/用户重新运行，例如："
      info "  INSTALL_DB_NAME=github_hub_2 INSTALL_DB_USER=ghhub_2 bash install.sh"
      exit 1
    fi
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

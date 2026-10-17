-- GitHub 多账号管家 · 数据库结构
-- MySQL 8.0 / utf8mb4

SET NAMES utf8mb4;

-- 账号表：凭据一律以密文存储（AES-256-GCM，密钥独立于数据库）
CREATE TABLE IF NOT EXISTS `accounts` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `mode`             ENUM('token','password') NOT NULL DEFAULT 'token' COMMENT '凭据方式',
  `login`            VARCHAR(120)  NOT NULL DEFAULT ''  COMMENT 'GitHub 登录名',
  `email`            VARCHAR(190)  NOT NULL DEFAULT ''  COMMENT '邮箱',
  `note`             VARCHAR(190)  NOT NULL DEFAULT ''  COMMENT '备注',
  `token_kind`       VARCHAR(32)   NOT NULL DEFAULT ''  COMMENT '令牌类型 classic/fine-grained/oauth/...',
  `token_hint`       VARCHAR(48)   NOT NULL DEFAULT ''  COMMENT '令牌掩码预览',
  `token_enc`        TEXT          NULL                 COMMENT 'Token 密文',
  `password_enc`     TEXT          NULL                 COMMENT '密码密文',
  `scopes`           JSON          NULL                 COMMENT 'OAuth 权限范围快照',
  `profile`          JSON          NULL                 COMMENT 'GitHub 资料快照',
  `rate_limit`       JSON          NULL                 COMMENT 'API 配额快照',
  `status`           ENUM('unverified','active','invalid','password-only','error')
                     NOT NULL DEFAULT 'unverified'      COMMENT '凭据状态',
  `status_message`   VARCHAR(500)  NOT NULL DEFAULT ''  COMMENT '状态说明',
  `last_verified_at` DATETIME      NULL                 COMMENT '最近验证时间',
  `created_at`       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at`       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  KEY `idx_accounts_status`  (`status`),
  KEY `idx_accounts_login`   (`login`),
  KEY `idx_accounts_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='GitHub 账号表';

-- 操作日志表：记录每一次增删改、验证、拉取等动作
CREATE TABLE IF NOT EXISTS `activity_logs` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `account_id` BIGINT UNSIGNED NULL COMMENT '关联账号，账号删除后置空',
  `action`     VARCHAR(48)  NOT NULL COMMENT '动作标识',
  `level`      ENUM('info','warn','error') NOT NULL DEFAULT 'info' COMMENT '级别',
  `detail`     VARCHAR(800) NOT NULL DEFAULT '' COMMENT '明细',
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '发生时间',
  PRIMARY KEY (`id`),
  KEY `idx_logs_created` (`created_at`),
  KEY `idx_logs_account` (`account_id`),
  KEY `idx_logs_action`  (`action`),
  CONSTRAINT `fk_logs_account` FOREIGN KEY (`account_id`)
    REFERENCES `accounts` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='操作日志表';

-- 管理员账号表：登录本站的管理员（与 GitHub 账号无关）
-- 密码以 scrypt 加盐哈希存储，不可逆
CREATE TABLE IF NOT EXISTS `admin_users` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `username`      VARCHAR(64)  NOT NULL COMMENT '登录用户名',
  `password_hash` VARCHAR(255) NOT NULL COMMENT 'scrypt 哈希（scrypt:salthex:hashhex）',
  `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `last_login_at` DATETIME     NULL COMMENT '最近登录时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_admin_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='管理员账号表';

-- 管理员会话表：登录态（httpOnly Cookie 携带，服务端可撤销）
CREATE TABLE IF NOT EXISTS `admin_sessions` (
  `token`        CHAR(64)     NOT NULL COMMENT '会话令牌（32字节随机 hex）',
  `admin_id`     BIGINT UNSIGNED NOT NULL COMMENT '所属管理员',
  `user_agent`   VARCHAR(255) NOT NULL DEFAULT '' COMMENT '登录时 UA 摘要',
  `created_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `expires_at`   DATETIME     NOT NULL COMMENT '过期时间',
  `last_seen_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '最近活跃时间',
  PRIMARY KEY (`token`),
  KEY `idx_sessions_admin`   (`admin_id`),
  KEY `idx_sessions_expires` (`expires_at`),
  CONSTRAINT `fk_sessions_admin` FOREIGN KEY (`admin_id`)
    REFERENCES `admin_users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='管理员会话表';

-- 系统设置表：键值对（代理配置等运行时设置，UI 内可改）
CREATE TABLE IF NOT EXISTS `settings` (
  `key`        VARCHAR(64) NOT NULL COMMENT '设置项',
  `value`      TEXT        NULL COMMENT '设置值',
  `updated_at` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统设置表';

'use strict';

/**
 * 调试快照文件轮转。
 *
 * 排查问题时会把 GitHub 页面/响应落盘到 data/，这些文件含 CSRF token、
 * 邮箱等敏感内容，且会随每次失败持续增长。这里按前缀只保留最近若干份。
 */
const fs = require('fs');
const path = require('path');

/**
 * 删除目录下同前缀的旧文件，只保留最新 keep 份。
 * @param {string} dir     目录
 * @param {string} prefix  文件名前缀
 * @param {number} keep    保留份数
 * @returns {number} 删除的文件数
 */
function pruneDebugFiles(dir, prefix, keep = 10) {
  let removed = 0;
  try {
    const entries = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => {
        const full = path.join(dir, name);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          mtime = 0;
        }
        return { name, full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const item of entries.slice(keep)) {
      try {
        fs.unlinkSync(item.full);
        removed += 1;
      } catch {
        /* 单个文件删不掉不影响其它 */
      }
    }
  } catch {
    /* 目录不存在或不可读：直接跳过 */
  }
  return removed;
}

module.exports = { pruneDebugFiles };

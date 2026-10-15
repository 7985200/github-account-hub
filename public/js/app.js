/* ============================================================
   GitHub 多账号管家 · 前端逻辑（原生 JS，无依赖）
   ============================================================ */
(function () {
  'use strict';

  /* ----------------------------- 常量 ----------------------------- */
  var THEME_KEY = 'ghhub-theme';
  var REVEAL_MS = 10000;

  var STATUS_META = {
    active: { label: '有效', cls: 'badge-active' },
    unverified: { label: '未验证', cls: 'badge-unverified' },
    invalid: { label: '无效', cls: 'badge-invalid' },
    'password-only': { label: '仅密码凭据', cls: 'badge-password-only' },
    error: { label: '异常', cls: 'badge-error' }
  };

  var TOKEN_KIND_LABEL = {
    classic: '经典令牌',
    'fine-grained': '细粒度令牌',
    oauth: 'OAuth 令牌',
    user: '用户令牌',
    server: '服务端令牌',
    refresh: '刷新令牌',
    unknown: '令牌'
  };

  var SUN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path></svg>';
  var MOON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';

  /* ----------------------------- 工具 ----------------------------- */
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  /** HTML 转义（所有动态插入内容必须经过） */
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 仅允许 http(s) 链接 */
  function safeUrl(value) {
    var s = String(value || '');
    return /^https?:\/\//i.test(s) ? s : '';
  }

  function fmtNum(value) {
    var n = Number(value);
    if (value === null || value === undefined || value === '' || isNaN(n)) return '—';
    return n.toLocaleString('en-US');
  }

  /** ISO 时间 → 本地「YYYY-MM-DD HH:mm」 */
  function fmtDateTime(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    var pad = function (n) {
      return (n < 10 ? '0' : '') + n;
    };
    return (
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    );
  }

  /* ----------------------------- API 封装 ----------------------------- */
  function api(path, options) {
    var opts = options || {};
    var init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(
      function (res) {
        return res
          .json()
          .catch(function () {
            return null;
          })
          .then(function (data) {
            /* 会话失效：统一跳转登录页（login.html 不引本文件，不受影响）
               仅认证类错误码触发跳转；业务 401（如验证码错误）不跳转 */
            if (res.status === 401) {
              var authCode = data && data.code;
              if (!authCode || authCode === 'UNAUTHORIZED' || authCode === 'SESSION_EXPIRED') {
                location.replace('/login.html');
              }
            }
            if (!res.ok || !data || data.ok !== true) {
              var msg = (data && data.error) || '请求失败（HTTP ' + res.status + '）';
              var err = new Error(msg);
              err.status = res.status;
              err.code = (data && data.code) || '';
              err.data = data || null;
              throw err;
            }
            return data;
          });
      },
      function () {
        throw new Error('无法连接服务端，请确认服务已启动');
      }
    );
  }

  /* ----------------------------- Toast ----------------------------- */
  function toast(message, type, duration) {
    var wrap = $('#toastWrap');
    if (!wrap) return;
    var el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    var icon = type === 'success' ? '✓' : type === 'error' ? '!' : 'i';
    var iconEl = document.createElement('span');
    iconEl.className = 'toast-icon';
    iconEl.textContent = icon;
    var msgEl = document.createElement('span');
    msgEl.className = 'toast-msg';
    msgEl.textContent = message;
    el.appendChild(iconEl);
    el.appendChild(msgEl);
    wrap.appendChild(el);
    while (wrap.children.length > 4) wrap.removeChild(wrap.firstElementChild);
    setTimeout(function () {
      el.classList.add('leaving');
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 220);
    }, duration || 3200);
  }

  /* ----------------------------- 剪贴板 ----------------------------- */
  function copyText(text) {
    var value = String(text === null || text === undefined ? '' : text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value).then(
        function () {
          return true;
        },
        function () {
          return legacyCopy(value);
        }
      );
    }
    return Promise.resolve(legacyCopy(value));
  }

  function legacyCopy(value) {
    try {
      var ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (err) {
      return false;
    }
  }

  /* ----------------------------- 按钮忙碌态 ----------------------------- */
  function setBusy(btn, busy, busyText) {
    if (!btn) return;
    if (busy) {
      if (btn.dataset.origHtml === undefined) btn.dataset.origHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>' + (busyText ? '<span>' + esc(busyText) + '</span>' : '');
    } else {
      btn.disabled = false;
      if (btn.dataset.origHtml !== undefined) {
        btn.innerHTML = btn.dataset.origHtml;
        delete btn.dataset.origHtml;
      }
    }
  }

  /* ----------------------------- 模态框 ----------------------------- */
  function openModal(root) {
    root.hidden = false;
    document.body.style.overflow = 'hidden';
    /* 优先聚焦表单输入；无输入则不聚焦，避免误触危险按钮 */
    var focusable = root.querySelector('input:not([type="hidden"]), textarea, select');
    if (focusable) setTimeout(function () { focusable.focus(); }, 80);
  }

  function closeModal(root) {
    if (!root) return;
    root.hidden = true;
    if (!$('.modal-root:not([hidden])')) document.body.style.overflow = '';
  }

  function showFormError(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }

  function hideFormError(el) {
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
  }

  /* ----------------------------- 状态存储 ----------------------------- */
  var state = {
    admin: null,
    view: 'accounts',
    q: '',
    status: '',
    sort: 'recent',
    accounts: [],
    editingId: null,
    pendingDeleteId: null,
    reposAccountId: null,
    repos: [],
    logPage: 1,
    logPages: 1,
    logLevel: '',
    verifyingAll: false,
    bsAccounts: [],
    bsSelected: {},
    bsRepo: null,
    bsRepoSeq: 0,
    bsRunning: false,
    bkAccounts: [],
    bkSelected: {},
    bkRepo: null,
    bkRepoSeq: 0,
    bkRunning: false,
    bfAccounts: [],
    bfSelected: {},
    bfUser: null,
    bfUserSeq: 0,
    bfRunning: false,
    detailAccountId: null,
    atProxySeq: 0
  };

  var revealTimers = new Map();
  var accountsReqSeq = 0;

  /* ----------------------------- 主题 ----------------------------- */
  function applyTheme(theme) {
    var t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch (err) { /* 忽略存储异常 */ }
    var btn = $('#themeToggle');
    if (btn) {
      btn.innerHTML = t === 'dark' ? SUN_SVG : MOON_SVG;
      btn.title = t === 'dark' ? '切换到浅色主题' : '切换到深色主题';
    }
  }

  /* ----------------------------- 视图切换 ----------------------------- */
  function switchView(view) {
    state.view = view;
    $$('.view-tab').forEach(function (tab) {
      var active = tab.dataset.view === view;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    $('#viewAccounts').hidden = view !== 'accounts';
    $('#viewLogs').hidden = view !== 'logs';
    if (view === 'logs') loadLogs();
  }

  /* ----------------------------- 统计条 ----------------------------- */
  function renderStatsSkeleton() {
    var grid = $('#statsGrid');
    grid.innerHTML = Array.from({ length: 4 })
      .map(function () {
        return (
          '<div class="stat-card">' +
          '<span class="skeleton sk-line" style="width:52px"></span>' +
          '<span class="skeleton" style="width:92px;height:28px;border-radius:9px;margin:7px 0"></span>' +
          '<span class="skeleton sk-line" style="width:120px"></span>' +
          '</div>'
        );
      })
      .join('');
  }

  function renderStats(accounts, logs) {
    var a = accounts || {};
    var cards = [
      { label: '账号总数', value: fmtNum(a.total), sub: '异常 ' + fmtNum(a.abnormal) + ' · 仅密码 ' + fmtNum(a.passwordOnly) },
      { label: '有效账号', value: fmtNum(a.active), sub: '未验证 ' + fmtNum(a.unverified) + ' · 授权 ' + fmtNum(a.grantedScopes) + ' 项' },
      { label: '公开仓库合计', value: fmtNum(a.publicRepos), sub: '来自各账号资料快照' },
      { label: '关注者合计', value: fmtNum(a.followers), sub: 'GitHub Followers' }
    ];
    if (logs && logs.total !== undefined) cards[0].sub += ' · 日志 ' + fmtNum(logs.total) + ' 条';
    $('#statsGrid').innerHTML = cards
      .map(function (c) {
        return (
          '<div class="stat-card">' +
          '<span class="stat-label">' + esc(c.label) + '</span>' +
          '<span class="stat-value">' + esc(c.value) + '</span>' +
          '<span class="stat-sub">' + esc(c.sub) + '</span>' +
          '</div>'
        );
      })
      .join('');
  }

  function loadStats() {
    return api('/api/stats')
      .then(function (data) {
        renderStats(data.accounts, data.logs);
      })
      .catch(function () {
        renderStats(null, null);
      });
  }

  /* ----------------------------- 账号卡片 ----------------------------- */
  function credRowHtml(kind, masked, field) {
    return (
      '<div class="cred-row">' +
      '<span class="cred-kind">' + esc(kind) + '</span>' +
      '<span class="cred-value" data-masked="' + esc(masked) + '">' + esc(masked) + '</span>' +
      '<span class="cred-actions">' +
      '<button type="button" class="mini-btn" data-action="copy-cred" data-field="' + esc(field) + '">复制</button>' +
      '<button type="button" class="mini-btn" data-action="reveal" data-field="' + esc(field) + '">显示</button>' +
      '</span>' +
      '</div>'
    );
  }

  function chipsHtml(account) {
    var scopes = Array.isArray(account.scopes) ? account.scopes : [];
    if (scopes.length) {
      var shown = scopes.slice(0, 8).map(function (s) {
        return '<span class="chip">' + esc(s) + '</span>';
      });
      if (scopes.length > 8) {
        shown.push('<span class="chip chip-more">+' + (scopes.length - 8) + '</span>');
      }
      return '<div class="chips">' + shown.join('') + '</div>';
    }
    if (account.hasToken && account.tokenKind === 'fine-grained') {
      return '<div class="chips"><span class="chip">细粒度令牌</span></div>';
    }
    if (account.hasToken) {
      return '<div class="chips"><span class="chip chip-more">未返回 scopes</span></div>';
    }
    return '<div class="chips"><span class="chip chip-more">无 Token 权限信息</span></div>';
  }

  function renderAccountCard(account, withVerified) {
    var id = account.id;
    var st = STATUS_META[account.status] || { label: account.status || '未知', cls: 'badge-unverified' };
    var profile = account.profile || {};
    var login = account.login || '（未命名）';
    var modeLabel = account.mode === 'password' ? '密码' : 'Token';
    var avatarUrl = safeUrl(profile.avatarUrl);
    var letter = login.trim().charAt(0).toUpperCase() || '?';
    var name = profile.name || account.email || '未获取资料';

    var avatarHtml = avatarUrl
      ? '<div class="avatar"><img src="' + esc(avatarUrl) + '" alt="" loading="lazy" data-fallback="' + esc(letter) + '"></div>'
      : '<div class="avatar"><span class="avatar-fallback">' + esc(letter) + '</span></div>';

    var htmlUrl = safeUrl(profile.htmlUrl) || (account.login ? 'https://github.com/' + encodeURIComponent(account.login) : '');
    var loginHtml = htmlUrl
      ? '<a class="card-login" href="' + esc(htmlUrl) + '" target="_blank" rel="noopener noreferrer" title="打开 GitHub 主页"><span>' + esc(login) + '</span>' +
        '<svg class="external" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path></svg></a>'
      : '<span class="card-login"><span>' + esc(login) + '</span></span>';

    var credHtml;
    if (account.hasToken) {
      credHtml = credRowHtml(TOKEN_KIND_LABEL[account.tokenKind] || 'Token', account.tokenHint || '••••••••', 'token');
    } else if (account.hasPassword) {
      credHtml = credRowHtml('密码', '••••••••••••', 'password');
    } else {
      credHtml = '<div class="cred-row"><span class="cred-kind">凭据</span><span class="cred-value">无可用凭据</span></div>';
    }

    var rl = account.rateLimit || null;
    var quota = rl && rl.limit ? fmtNum(rl.remaining) + '/' + fmtNum(rl.limit) : '—';

    return (
      '<article class="account-card" data-id="' + esc(id) + '">' +
      '<div class="card-head">' +
      avatarHtml +
      '<div class="card-identity">' +
      loginHtml +
      '<div class="card-name"><span class="name-text">' + esc(name) + '</span><span class="chip">' + esc(modeLabel) + '</span></div>' +
      '</div>' +
      '<span class="badge ' + st.cls + '"><span class="dot"></span>' + esc(st.label) + '</span>' +
      '</div>' +
      (account.statusMessage ? '<p class="status-msg">' + esc(account.statusMessage) + '</p>' : '') +
      (withVerified ? '<p class="card-verified">上次验证：' + esc(fmtDateTime(account.lastVerifiedAt)) + '</p>' : '') +
      credHtml +
      chipsHtml(account) +
      (account.note ? '<p class="card-note">' + esc(account.note) + '</p>' : '') +
      '<div class="mini-stats">' +
      '<div class="mini-stat"><span class="v">' + esc(account.profile ? fmtNum(profile.publicRepos) : '—') + '</span><span class="k">仓库</span></div>' +
      '<div class="mini-stat"><span class="v">' + esc(account.profile ? fmtNum(profile.followers) : '—') + '</span><span class="k">关注者</span></div>' +
      '<div class="mini-stat"><span class="v" title="API 配额剩余/上限">' + esc(quota) + '</span><span class="k">配额</span></div>' +
      '</div>' +
      '<div class="card-actions">' +
      '<button type="button" class="btn btn-ghost" data-action="verify">验证</button>' +
      '<button type="button" class="btn btn-ghost" data-action="repos">仓库</button>' +
      '<button type="button" class="btn btn-ghost" data-action="edit">编辑</button>' +
      '<button type="button" class="btn btn-ghost btn-ghost-danger" data-action="delete">删除</button>' +
      '</div>' +
      '</article>'
    );
  }

  function updateCount() {
    var n = state.accounts.length;
    var filtered = !!(state.q || state.status);
    $('#accountCount').textContent = filtered ? '筛选出 ' + n + ' 个账号' : '共 ' + n + ' 个账号';
  }

  function renderAccounts() {
    var grid = $('#accountGrid');
    $('#accountsError').hidden = true;
    if (!state.accounts.length) {
      grid.innerHTML = '';
      grid.hidden = true;
      var filtered = !!(state.q || state.status);
      $('#emptyTitle').textContent = filtered ? '没有匹配的账号' : '还没有账号，点右上角添加';
      $('#emptySub').textContent = filtered
        ? '试试调整搜索关键词或状态筛选。'
        : '支持 Personal Access Token 与账号密码两种凭据，均加密保存在本机数据库。';
      $('#accountsEmpty').hidden = false;
      updateCount();
      return;
    }
    $('#accountsEmpty').hidden = true;
    grid.hidden = false;
    grid.innerHTML = state.accounts.map(renderAccountCard).join('');
    updateCount();
  }

  function renderAccountSkeletons() {
    var grid = $('#accountGrid');
    $('#accountsEmpty').hidden = true;
    $('#accountsError').hidden = true;
    grid.hidden = false;
    grid.innerHTML = Array.from({ length: 6 })
      .map(function () {
        return (
          '<div class="skeleton-card" aria-hidden="true">' +
          '<div style="display:flex;gap:13px;align-items:center">' +
          '<span class="skeleton sk-avatar"></span>' +
          '<span style="flex:1;display:flex;flex-direction:column;gap:8px">' +
          '<span class="skeleton sk-line" style="width:46%"></span>' +
          '<span class="skeleton sk-line" style="width:68%"></span>' +
          '</span>' +
          '</div>' +
          '<span class="skeleton sk-line" style="width:100%"></span>' +
          '<span class="skeleton" style="height:40px"></span>' +
          '<span class="skeleton" style="height:64px"></span>' +
          '<span class="skeleton" style="height:34px"></span>' +
          '</div>'
        );
      })
      .join('');
  }

  function showAccountsError(msg, skeletonShown) {
    if (!skeletonShown) return;
    var grid = $('#accountGrid');
    grid.innerHTML = '';
    grid.hidden = true;
    $('#accountsEmpty').hidden = true;
    $('#accountsError').hidden = false;
    $('#errorText').textContent = msg;
    updateCount();
  }

  function loadAccounts() {
    var seq = ++accountsReqSeq;
    var firstLoad = state.accounts.length === 0;
    if (firstLoad) renderAccountSkeletons();
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.status) params.set('status', state.status);
    params.set('sort', state.sort || 'recent');
    return api('/api/accounts?' + params.toString())
      .then(function (data) {
        if (seq !== accountsReqSeq) return;
        state.accounts = Array.isArray(data.accounts) ? data.accounts : [];
        revealTimers.forEach(function (t) { clearTimeout(t); });
        revealTimers.clear();
        renderAccounts();
      })
      .catch(function (err) {
        if (seq !== accountsReqSeq) return;
        showAccountsError(err.message, firstLoad);
        if (!firstLoad) toast(err.message, 'error');
      });
  }

  function findAccount(id) {
    var target = Number(id);
    for (var i = 0; i < state.accounts.length; i++) {
      if (Number(state.accounts[i].id) === target) return state.accounts[i];
    }
    return null;
  }

  function updateAccountInPlace(account) {
    var id = Number(account.id);
    var timer = revealTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      revealTimers.delete(id);
    }
    var idx = -1;
    for (var i = 0; i < state.accounts.length; i++) {
      if (Number(state.accounts[i].id) === id) { idx = i; break; }
    }
    if (idx >= 0) {
      state.accounts[idx] = account;
      var node = $('#accountGrid').querySelector('.account-card[data-id="' + id + '"]');
      if (node) {
        node.outerHTML = renderAccountCard(account);
        refreshAccountDetail();
        return;
      }
    }
    renderAccounts();
    refreshAccountDetail();
  }

  function afterMutation() {
    loadAccounts();
    loadStats();
    if (state.view === 'logs') loadLogs();
  }

  /* ----------------------------- 凭据：复制 / 显示 ----------------------------- */
  function maskCredential(card, btn) {
    var valueEl = card.querySelector('.cred-value');
    if (!valueEl) return;
    valueEl.textContent = valueEl.dataset.masked || '••••••••';
    valueEl.classList.remove('revealed');
    delete card.dataset.revealed;
    if (btn && btn.isConnected) btn.textContent = '显示';
    var id = Number(card.dataset.id);
    var timer = revealTimers.get(id);
    if (timer) clearTimeout(timer);
    revealTimers.delete(id);
  }

  function handleReveal(card, btn) {
    var field = btn.dataset.field;
    var id = Number(card.dataset.id);
    var valueEl = card.querySelector('.cred-value');
    if (!valueEl) return;
    if (card.dataset.revealed === '1') {
      maskCredential(card, btn);
      return;
    }
    btn.disabled = true;
    api('/api/accounts/' + id + '/secret?field=' + encodeURIComponent(field))
      .then(function (data) {
        valueEl.textContent = data.value || '（空）';
        valueEl.classList.add('revealed');
        card.dataset.revealed = '1';
        btn.textContent = '隐藏';
        var prev = revealTimers.get(id);
        if (prev) clearTimeout(prev);
        revealTimers.set(id, setTimeout(function () {
          maskCredential(card, btn);
        }, REVEAL_MS));
      })
      .catch(function (err) {
        toast(err.message, 'error');
      })
      .then(function () {
        btn.disabled = false;
      });
  }

  function handleCopyCred(card, btn) {
    var field = btn.dataset.field;
    var id = Number(card.dataset.id);
    setBusy(btn, true);
    api('/api/accounts/' + id + '/secret?field=' + encodeURIComponent(field))
      .then(function (data) {
        return copyText(data.value || '').then(function (ok) {
          if (ok) {
            toast(field === 'password' ? '密码已复制到剪贴板' : 'Token 已复制到剪贴板', 'success');
          } else {
            toast('复制失败，请使用「显示」后手动复制', 'error');
          }
        });
      })
      .catch(function (err) {
        toast(err.message, 'error');
      })
      .then(function () {
        setBusy(btn, false);
      });
  }

  /* ----------------------------- 验证 ----------------------------- */
  function handleVerify(card, btn) {
    var id = Number(card.dataset.id);
    setBusy(btn, true, '验证中');
    api('/api/accounts/' + id + '/verify', { method: 'POST' })
      .then(function (data) {
        var account = data.account;
        updateAccountInPlace(account);
        var st = STATUS_META[account.status] || { label: account.status };
        toast('验证完成：' + st.label, account.status === 'active' ? 'success' : 'info', 4200);
        loadStats();
      })
      .catch(function (err) {
        toast(err.message, 'error');
        setBusy(btn, false);
      });
  }

  /* ----------------------------- 仓库 ----------------------------- */
  function repoRowHtml(repo) {
    var name = repo.fullName || repo.name || '';
    var url = safeUrl(repo.htmlUrl);
    return (
      '<div class="repo-row" data-repo="' + esc(name) + '">' +
      '<div class="repo-row-top">' +
      (url
        ? '<a class="repo-name" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(name) + '</a>'
        : '<span class="repo-name">' + esc(name) + '</span>') +
      '<div class="repo-tags">' +
      '<span class="repo-tag' + (repo.private ? ' repo-tag-private' : '') + '">' + (repo.private ? '私有' : '公开') + '</span>' +
      (repo.language ? '<span class="repo-tag">' + esc(repo.language) + '</span>' : '') +
      (repo.fork ? '<span class="repo-tag">Fork</span>' : '') +
      (repo.archived ? '<span class="repo-tag">已归档</span>' : '') +
      '</div>' +
      (url
        ? '<div class="repo-actions"><a class="btn btn-ghost btn-sm" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">打开</a>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-action="copy-remote">复制克隆地址</button></div>'
        : '<div class="repo-actions"><button type="button" class="btn btn-ghost btn-sm" data-action="copy-remote">复制克隆地址</button></div>') +
      '</div>' +
      (repo.description ? '<p class="repo-desc">' + esc(repo.description) + '</p>' : '') +
      '<div class="repo-meta">' +
      '<span class="star">★ ' + esc(fmtNum(repo.stars)) + '</span>' +
      '<span>Forks ' + esc(fmtNum(repo.forks)) + '</span>' +
      '<span>更新 ' + esc(repo.updatedAt || '—') + '</span>' +
      '</div>' +
      '<div class="repo-remote" hidden></div>' +
      '</div>'
    );
  }

  function renderRepos() {
    var listEl = $('#reposList');
    var q = ($('#repoFilter').value || '').trim().toLowerCase();
    var all = state.repos || [];
    var filtered = all.filter(function (r) {
      if (!q) return true;
      return [r.fullName, r.language, r.description].some(function (v) {
        return String(v || '').toLowerCase().indexOf(q) !== -1;
      });
    });
    $('#reposCount').textContent = filtered.length + ' / ' + all.length + ' 个仓库';
    if (!filtered.length) {
      listEl.innerHTML = '<div class="repo-empty">' + (all.length ? '没有匹配的仓库' : '该账号暂无仓库') + '</div>';
      return;
    }
    listEl.innerHTML = filtered.map(repoRowHtml).join('');
  }

  function openRepos(account) {
    state.reposAccountId = Number(account.id);
    state.repos = [];
    $('#reposLogin').textContent = account.login || '（未命名）';
    $('#repoFilter').value = '';
    $('#reposCount').textContent = '';
    hideFormError($('#reposError'));
    $('#reposList').innerHTML = '<div class="repo-loading"><span class="spinner spinner-lg"></span></div>';
    openModal($('#reposModal'));
    api('/api/accounts/' + account.id + '/repos?page=1&perPage=100')
      .then(function (data) {
        state.repos = Array.isArray(data.repos) ? data.repos : [];
        renderRepos();
      })
      .catch(function (err) {
        $('#reposList').innerHTML = '';
        showFormError($('#reposError'), err.message);
      });
  }

  function handleCopyRemote(btn) {
    var row = btn.closest('.repo-row');
    if (!row) return;
    var repo = btn.dataset.repo || row.dataset.repo;
    var box = row.querySelector('.repo-remote');
    setBusy(btn, true);
    api('/api/accounts/' + state.reposAccountId + '/remote?repo=' + encodeURIComponent(repo))
      .then(function (data) {
        return copyText(data.authed).then(function (ok) {
          if (box) {
            box.hidden = false;
            box.innerHTML =
              '<div class="remote-line"><span class="remote-label">掩码</span><span class="remote-value">' + esc(data.masked) + '</span></div>' +
              '<div class="remote-line"><span class="remote-label">SSH</span><span class="remote-value">' + esc(data.ssh) + '</span></div>' +
              '<div class="remote-line"><span class="remote-label">PLAIN</span><span class="remote-value">' + esc(data.plain) + '</span></div>';
          }
          toast(ok ? '已复制带凭据克隆地址' : '已生成地址，但复制失败，请手动复制', ok ? 'success' : 'error');
        });
      })
      .catch(function (err) {
        if (box) {
          box.hidden = false;
          box.innerHTML = '<div class="remote-line"><span class="remote-label">错误</span><span class="remote-value">' + esc(err.message) + '</span></div>';
        }
        toast(err.message, 'error');
      })
      .then(function () {
        setBusy(btn, false);
      });
  }

  /* ----------------------------- 添加账号 ----------------------------- */
  function switchAddTab(tab) {
    /* 切换 Tab 时退出验证码视图（清理倒计时与会话状态） */
    clearAtResendTimer();
    atVerifyState.verifyId = '';
    atVerifyState.left = 0;
    $('#atFormView').hidden = false;
    $('#atVerifyView').hidden = true;
    $$('#addModal .modal-tab').forEach(function (t) {
      var active = t.dataset.tab === tab;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
    });
    $$('#addModal .tab-pane').forEach(function (p) {
      p.hidden = p.dataset.pane !== tab;
    });
    /* 提交按钮随 Tab 切换：「密码换 Token」使用独立按钮与流程 */
    var isAuto = tab === 'auto-token';
    $('#addSubmit').hidden = isAuto;
    $('#atSubmit').hidden = !isAuto;
    if (isAuto) {
      updateAtSubmitState();
      checkProxyStatus(++state.atProxySeq);
    }
    hideFormError($('#addError'));
  }

  function resetAddForm() {
    $('#addForm').reset();
    /* 退出验证码视图并清理定时器 */
    clearAtResendTimer();
    atVerifyState.verifyId = '';
    atVerifyState.left = 0;
    $('#atFormView').hidden = false;
    $('#atVerifyView').hidden = true;
    switchAddTab('token');
    hideFormError($('#addError'));
  }

  function handleAddSubmit(event) {
    event.preventDefault();
    var errEl = $('#addError');
    var submitBtn = $('#addSubmit');
    var activeTab = $('#addModal .modal-tab.is-active').dataset.tab;
    hideFormError(errEl);

    if (activeTab === 'auto-token') return submitAutoToken();

    var body;
    if (activeTab === 'token') {
      var token = $('#addToken').value.trim();
      if (!token) return showFormError(errEl, '请填写 Personal Access Token');
      body = { mode: 'token', token: token, note: $('#addNote').value.trim(), email: $('#addEmail').value.trim() };
    } else {
      var login = $('#addLogin').value.trim();
      var password = $('#addPassword').value;
      if (!login) return showFormError(errEl, '请填写 GitHub 登录名或邮箱');
      if (!password) return showFormError(errEl, '请填写密码');
      body = {
        mode: 'password',
        login: login,
        password: password,
        note: $('#addNotePwd').value.trim(),
        email: $('#addEmailPwd').value.trim()
      };
    }

    setBusy(submitBtn, true, '提交并验证中…');
    api('/api/accounts', { method: 'POST', body: body })
      .then(function (data) {
        var account = data.account || {};
        var st = STATUS_META[account.status] || { label: account.status || '已保存' };
        toast('账号 ' + (account.login || '') + ' 已添加（' + st.label + '）', 'success', 4200);
        closeModal($('#addModal'));
        resetAddForm();
        afterMutation();
      })
      .catch(function (err) {
        showFormError(errEl, err.message);
      })
      .then(function () {
        setBusy(submitBtn, false);
      });
  }

  /* ----------------------------- 密码换 Token ----------------------------- */
  var AT_SLOW_MS = 15000;

  /* 后端 message 缺失（api() 兜底格式）时，按状态码给出具体处理建议 */
  var AT_ERROR_FALLBACK = {
    401: '账号或密码错误，请检查登录名与密码后重试。',
    428: '该账号启用了两步验证（2FA），无法通过密码换取 Token，请改用「Token 添加」方式。',
    403: 'GitHub 要求人工验证，请先在浏览器中登录一次该账号，再回来重试。',
    503: '本地代理不可用，请检查代理软件是否正常运行，并确认可访问 github.com。'
  };

  /** 必填项校验：登录名与密码都填写后才允许提交（提交中由 setBusy 接管） */
  function updateAtSubmitState() {
    var btn = $('#atSubmit');
    if (!btn || btn.dataset.origHtml !== undefined) return;
    btn.disabled = !($('#atLogin').value.trim() && $('#atPassword').value);
  }

  /** 进入 Tab 时探测 github.com 访问通道；仅作提示，不阻塞提交 */
  function checkProxyStatus(seq) {
    var box = $('#atProxyStatus');
    if (!box) return;
    box.hidden = false;
    box.className = 'at-proxy';
    box.innerHTML = '<span class="spinner"></span><span>正在检测访问通道…</span>';
    api('/api/proxy-check')
      .then(function (data) {
        if (seq !== state.atProxySeq) return;
        if (data.available) {
          box.className = 'at-proxy at-proxy-ok';
          box.textContent = '✓ 访问通道检测通过 · ' + (data.message || '可用');
        } else {
          box.className = 'at-proxy at-proxy-warn';
          box.textContent = '访问通道不可用：' + (data.message || '无法连接 GitHub 网页');
        }
      })
      .catch(function (err) {
        if (seq !== state.atProxySeq) return;
        box.className = 'at-proxy at-proxy-warn';
        box.textContent = '访问通道检测失败：' + err.message;
      });
  }

  /** 失败提示：后端 error 优先直接展示；message 为空或仅为通用兜底时按状态码给建议 */
  function autoTokenErrorMessage(err) {
    var msg = String((err && err.message) || '');
    if (msg && msg.indexOf('请求失败（HTTP ') !== 0) return msg;
    return AT_ERROR_FALLBACK[err && err.status] || msg || '创建 Token 失败，请稍后重试';
  }

  function submitAutoToken() {
    var errEl = $('#addError');
    var submitBtn = $('#atSubmit');
    var login = $('#atLogin').value.trim();
    var password = $('#atPassword').value;
    if (!login) return showFormError(errEl, '请填写 GitHub 登录名或邮箱');
    if (!password) return showFormError(errEl, '请填写密码');

    setBusy(submitBtn, true, '正在登录 GitHub…');
    /* 全流程通常 3-10 秒；超过 15 秒仍未返回时提示仍在处理，避免用户以为卡死 */
    var slowTimer = setTimeout(function () {
      if (submitBtn.dataset.origHtml === undefined) return;
      submitBtn.innerHTML = '<span class="spinner"></span><span>仍在处理中，请稍候…</span>';
    }, AT_SLOW_MS);

    api('/api/accounts/auto-token', {
      method: 'POST',
      body: {
        login: login,
        password: password,
        note: $('#atNote').value.trim(),
        email: $('#atEmail').value.trim()
      }
    })
      .then(function (data) {
        var meta = data.meta || {};
        toast(
          '已通过网页登录创建全权限 Token（' + fmtNum(meta.scopes || 51) + ' 项权限 · 永不过期）',
          'success',
          5200
        );
        closeModal($('#addModal'));
        resetAddForm();
        afterMutation();
      })
      .catch(function (err) {
        /* GitHub 要求额外验证（邮箱验证码 / 两步验证）→ 切换到验证码输入视图 */
        if (err && err.code === 'NEED_VERIFY' && err.data && err.data.needsVerify) {
          showAtVerifyView(err.data);
          return;
        }
        showFormError(errEl, autoTokenErrorMessage(err));
      })
      .then(function () {
        clearTimeout(slowTimer);
        setBusy(submitBtn, false);
        updateAtSubmitState();
      });
  }

  /* ----------------------------- 密码换 Token：验证码续接 ----------------------------- */
  var atVerifyState = { verifyId: '', timer: null, left: 0 };

  function clearAtResendTimer() {
    if (atVerifyState.timer) {
      clearInterval(atVerifyState.timer);
      atVerifyState.timer = null;
    }
  }

  function updateAtResendBtn() {
    var btn = $('#atVerifyResend');
    if (!btn) return;
    if (atVerifyState.left > 0) {
      btn.disabled = true;
      btn.textContent = '重新发送（' + atVerifyState.left + 's）';
    } else {
      btn.disabled = false;
      btn.textContent = '重新发送验证码';
    }
  }

  function startAtResendCountdown(seconds) {
    clearAtResendTimer();
    atVerifyState.left = seconds;
    updateAtResendBtn();
    if (seconds <= 0) return;
    atVerifyState.timer = setInterval(function () {
      atVerifyState.left -= 1;
      if (atVerifyState.left <= 0) {
        atVerifyState.left = 0;
        clearAtResendTimer();
      }
      updateAtResendBtn();
    }, 1000);
  }

  function updateAtVerifySubmit() {
    var code = ($('#atVerifyCode').value || '').replace(/\D/g, '');
    $('#atVerifySubmit').disabled = code.length !== 6;
  }

  /** 切换到验证码视图（后端返回 needsVerify 时） */
  function showAtVerifyView(data) {
    atVerifyState.verifyId = (data && data.verifyId) || '';
    $('#atFormView').hidden = true;
    $('#atVerifyView').hidden = false;
    $('#addSubmit').hidden = true;
    $('#atSubmit').hidden = true;
    $('#atVerifyHint').textContent = (data && data.hint) || '验证码已发送，请查收后输入';
    var errEl = $('#atVerifyError');
    errEl.hidden = true;
    errEl.textContent = '';
    $('#atVerifySubmit').hidden = false;
    $('#atVerifyResend').hidden = false;
    $('#atVerifyCode').value = '';
    updateAtVerifySubmit();
    startAtResendCountdown(0);
    setTimeout(function () {
      var input = $('#atVerifyCode');
      if (input) input.focus();
    }, 80);
  }

  /** 返回账号密码输入视图 */
  function hideAtVerifyView() {
    $('#atFormView').hidden = false;
    $('#atVerifyView').hidden = true;
    var errEl = $('#atVerifyError');
    errEl.hidden = true;
    errEl.textContent = '';
    $('#atVerifyCode').value = '';
    clearAtResendTimer();
    atVerifyState.left = 0;
    atVerifyState.verifyId = '';
    $('#atVerifySubmit').hidden = false;
    $('#atVerifyResend').hidden = false;
    /* 恢复底部按钮：当前处于「密码换 Token」Tab */
    $('#addSubmit').hidden = true;
    $('#atSubmit').hidden = false;
    updateAtSubmitState();
  }

  function submitAtVerifyCode() {
    var errEl = $('#atVerifyError');
    var btn = $('#atVerifySubmit');
    var code = ($('#atVerifyCode').value || '').replace(/\D/g, '');
    if (code.length !== 6) return showFormError(errEl, '请输入 6 位验证码');
    if (!atVerifyState.verifyId) return showFormError(errEl, '验证会话已失效，请返回重新开始');
    hideFormError(errEl);
    setBusy(btn, true, '正在验证…');

    api('/api/accounts/auto-token/verify', {
      method: 'POST',
      body: {
        verifyId: atVerifyState.verifyId,
        code: code,
        note: $('#atNote').value.trim(),
        email: $('#atEmail').value.trim()
      }
    })
      .then(function (data) {
        var meta = data.meta || {};
        toast(
          '已通过网页登录创建全权限 Token（' + fmtNum(meta.scopes || 51) + ' 项权限 · 永不过期）',
          'success',
          5200
        );
        clearAtResendTimer();
        atVerifyState.verifyId = '';
        closeModal($('#addModal'));
        resetAddForm();
        afterMutation();
      })
      .catch(function (err) {
        if (err && err.code === 'VERIFY_EXPIRED') {
          showFormError(errEl, err.message || '验证会话已过期，请返回重新开始');
          $('#atVerifySubmit').hidden = true;
          $('#atVerifyResend').hidden = true;
          return;
        }
        showFormError(errEl, (err && err.message) || '验证失败，请重试');
        $('#atVerifyCode').value = '';
        updateAtVerifySubmit();
        var input = $('#atVerifyCode');
        if (input) input.focus();
      })
      .then(function () {
        setBusy(btn, false);
      });
  }

  function resendAtVerifyCode() {
    var btn = $('#atVerifyResend');
    var errEl = $('#atVerifyError');
    if (btn.disabled || atVerifyState.left > 0) return;
    if (!atVerifyState.verifyId) return showFormError(errEl, '验证会话已失效，请返回重新开始');
    hideFormError(errEl);
    btn.disabled = true;
    btn.textContent = '正在发送…';

    api('/api/accounts/auto-token/resend', {
      method: 'POST',
      body: { verifyId: atVerifyState.verifyId }
    })
      .then(function (data) {
        toast((data && data.hint) || '验证码已重新发送', 'success');
        startAtResendCountdown(60);
        var input = $('#atVerifyCode');
        if (input) input.focus();
      })
      .catch(function (err) {
        showFormError(errEl, (err && err.message) || '重发失败，请稍后重试');
        atVerifyState.left = 0;
        clearAtResendTimer();
        updateAtResendBtn();
      });
  }

  /* ----------------------------- 编辑账号 ----------------------------- */
  function openEdit(account) {
    state.editingId = Number(account.id);
    $('#editAccountLabel').textContent = account.login || '（未命名）';
    $('#editNote').value = account.note || '';
    $('#editEmail').value = account.email || '';
    $('#editLogin').value = account.login || '';
    $('#editToken').value = '';
    hideFormError($('#editError'));
    openModal($('#editModal'));
  }

  function handleEditSubmit(event) {
    event.preventDefault();
    var errEl = $('#editError');
    var submitBtn = $('#editSubmit');
    var account = findAccount(state.editingId);
    hideFormError(errEl);
    if (!account) {
      closeModal($('#editModal'));
      return;
    }

    var patch = {};
    var note = $('#editNote').value.trim();
    var email = $('#editEmail').value.trim();
    var login = $('#editLogin').value.trim();
    var token = $('#editToken').value.trim();

    if (note !== (account.note || '')) patch.note = note;
    if (email !== (account.email || '')) patch.email = email;
    if (login && login !== (account.login || '')) patch.login = login;
    if (token) patch.token = token;

    if (!Object.keys(patch).length) {
      toast('没有需要修改的内容', 'info');
      closeModal($('#editModal'));
      return;
    }

    var hasNewToken = !!patch.token;
    setBusy(submitBtn, true, hasNewToken ? '保存并重新验证中…' : '保存中…');
    api('/api/accounts/' + account.id, { method: 'PATCH', body: patch })
      .then(function (data) {
        updateAccountInPlace(data.account);
        toast(hasNewToken ? '已保存，Token 已重新验证' : '已保存', 'success');
        closeModal($('#editModal'));
        state.editingId = null;
        loadStats();
      })
      .catch(function (err) {
        showFormError(errEl, err.message);
      })
      .then(function () {
        setBusy(submitBtn, false);
      });
  }

  /* ----------------------------- 删除账号 ----------------------------- */
  function openDelete(account) {
    state.pendingDeleteId = Number(account.id);
    $('#deleteLogin').textContent = account.login || '（未命名）';
    hideFormError($('#deleteError'));
    openModal($('#deleteModal'));
  }

  function handleDeleteConfirm() {
    var id = state.pendingDeleteId;
    if (!id) return;
    var btn = $('#deleteConfirm');
    var errEl = $('#deleteError');
    hideFormError(errEl);
    setBusy(btn, true, '删除中…');
    api('/api/accounts/' + id, { method: 'DELETE' })
      .then(function (data) {
        var login = (data.removed && data.removed.login) || '';
        toast('已删除账号 ' + login, 'success');
        closeModal($('#deleteModal'));
        state.pendingDeleteId = null;
        /* 详情模态正在展示被删账号：立即关闭，避免残留已删除数据 */
        if (state.detailAccountId === id) {
          state.detailAccountId = null;
          closeModal($('#accountDetailModal'));
        }
        afterMutation();
      })
      .catch(function (err) {
        showFormError(errEl, err.message);
      })
      .then(function () {
        setBusy(btn, false);
      });
  }

  /* ----------------------------- 操作日志 ----------------------------- */
  function renderLogRows(items) {
    var tbody = $('#logBody');
    if (!items || !items.length) {
      tbody.innerHTML = '<tr class="table-empty"><td colspan="5">暂无日志记录</td></tr>';
      return;
    }
    tbody.innerHTML = items
      .map(function (it) {
        var level = ['info', 'warn', 'error'].indexOf(it.level) !== -1 ? it.level : 'info';
        return (
          '<tr>' +
          '<td class="log-time">' + esc(it.createdAt) + '</td>' +
          '<td class="log-account">' + (it.accountLogin ? esc(it.accountLogin) : '<span class="faint">—</span>') + '</td>' +
          '<td class="log-action">' + esc(it.action) + '</td>' +
          '<td><span class="badge-level badge-level-' + level + '">' + level + '</span></td>' +
          '<td class="log-detail">' + esc(it.detail) + '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function loadLogs() {
    var tbody = $('#logBody');
    tbody.innerHTML = '<tr class="table-empty"><td colspan="5"><span class="spinner spinner-lg"></span></td></tr>';
    var params = new URLSearchParams();
    params.set('page', String(state.logPage || 1));
    params.set('pageSize', '20');
    if (state.logLevel) params.set('level', state.logLevel);
    return api('/api/logs?' + params.toString())
      .then(function (data) {
        /* 越界保护：数据量收缩导致当前页超出总页数时回到末页 */
        if (data.pages && data.page > data.pages) {
          state.logPage = data.pages;
          return loadLogs();
        }
        state.logPage = data.page || 1;
        state.logPages = data.pages || 1;
        renderLogRows(data.items);
        $('#logPageInfo').textContent = '第 ' + state.logPage + ' / ' + state.logPages + ' 页 · 共 ' + fmtNum(data.total) + ' 条';
        $('#logPrev').disabled = state.logPage <= 1;
        $('#logNext').disabled = state.logPage >= state.logPages;
      })
      .catch(function (err) {
        state.logPage = 1;
        state.logPages = 1;
        tbody.innerHTML = '<tr class="table-empty"><td colspan="5">加载失败：' + esc(err.message) + '</td></tr>';
        $('#logPageInfo').textContent = '第 0 / 0 页';
        $('#logPrev').disabled = true;
        $('#logNext').disabled = true;
        toast(err.message, 'error');
      });
  }

  /* ----------------------------- 顶栏下拉菜单 ----------------------------- */
  /** 菜单弹出定位：视口内自适应 —— 优先右对齐按钮；左侧空间不足（窄屏换行）改为左对齐；仍溢出则贴视口边缘 */
  function positionMenuPopover() {
    var pop = $('#menuPopover');
    var wrap = pop && pop.parentElement;
    if (!pop || !wrap || pop.hidden) return;
    var wrapRect = wrap.getBoundingClientRect();
    var vw = window.innerWidth;
    var margin = 12;
    var popW = Math.min(pop.offsetWidth || 224, vw - margin * 2);
    var leftEdge = wrapRect.right - popW; // 优先右对齐到按钮
    if (leftEdge < margin) leftEdge = wrapRect.left; // 左侧空间不足 → 左对齐
    if (leftEdge + popW > vw - margin) leftEdge = vw - margin - popW; // 右侧仍溢出 → 贴右
    if (leftEdge < margin) leftEdge = margin; // 极端保底
    pop.style.right = 'auto';
    pop.style.left = leftEdge - wrapRect.left + 'px';
  }

  function openMenu() {
    $('#menuPopover').hidden = false;
    $('#menuBtn').setAttribute('aria-expanded', 'true');
    positionMenuPopover();
  }

  function closeMenu() {
    var pop = $('#menuPopover');
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    $('#menuBtn').setAttribute('aria-expanded', 'false');
  }

  function toggleMenu() {
    if ($('#menuPopover').hidden) openMenu();
    else closeMenu();
  }

  function handleMenuAction(action) {
    if (action === 'batch-star') return openBatchStar();
    if (action === 'batch-fork') return openBatchFork();
    if (action === 'batch-follow') return openBatchFollow();
    if (action === 'verify-all') return verifyAllAccounts();
    if (action === 'logs') return switchView('logs');
    if (action === 'health') return openHealth();
    if (action === 'admin') return openAdmin();
    if (action === 'proxy') return openProxy();
    if (action === 'logout') return openLogout();
  }

  /* ----------------------------- 验证全部账号 ----------------------------- */
  function verifyAllAccounts() {
    if (state.verifyingAll) {
      toast('正在验证中，请稍候', 'info');
      return;
    }
    state.verifyingAll = true;
    api('/api/accounts?sort=recent')
      .then(function (data) {
        var targets = (data.accounts || []).filter(function (a) {
          return a.hasToken;
        });
        if (!targets.length) {
          state.verifyingAll = false;
          toast('没有可验证的账号（需先在账号上配置 Token）', 'info');
          return;
        }
        var total = targets.length;
        var done = 0;
        var stats = { active: 0, abnormal: 0, unchanged: 0, failed: 0 };

        var runNext = function () {
          if (done >= total) {
            state.verifyingAll = false;
            var parts = [stats.active + ' 有效', stats.abnormal + ' 异常', stats.unchanged + ' 未变'];
            if (stats.failed) parts.push(stats.failed + ' 请求失败');
            toast('已验证 ' + total + ' 个账号：' + parts.join('、'), 'success', 6000);
            afterMutation();
            return;
          }
          var acc = targets[done];
          var pos = done + 1;
          toast('验证中 ' + pos + '/' + total + ' · ' + (acc.login || '账号 ' + acc.id), 'info', 1800);
          /* 串行执行：上一个完成后间隔约 300ms 再验证下一个 */
          api('/api/accounts/' + acc.id + '/verify', { method: 'POST' })
            .then(function (data) {
              var st = (data.account && data.account.status) || '';
              if (st === 'active') stats.active++;
              else if (st === 'invalid' || st === 'error') stats.abnormal++;
              else stats.unchanged++;
            })
            .catch(function () {
              stats.failed++;
            })
            .then(function () {
              done++;
              setTimeout(runNext, 300);
            });
        };

        runNext();
      })
      .catch(function (err) {
        state.verifyingAll = false;
        toast(err.message, 'error');
      });
  }

  /* ----------------------------- 系统状态 ----------------------------- */
  function fmtUptime(sec) {
    var s = Number(sec);
    if (sec === null || sec === undefined || isNaN(s) || s < 0) return '—';
    s = Math.floor(s);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + ' 小时 ' + m + ' 分';
    if (m > 0) return m + ' 分';
    return s + ' 秒';
  }

  function openHealth() {
    var body = $('#healthBody');
    body.innerHTML = '<div class="health-loading"><span class="spinner spinner-lg"></span></div>';
    openModal($('#healthModal'));
    api('/api/health')
      .then(function (data) {
        renderHealth(data.service || {}, data.database || {});
      })
      .catch(function (err) {
        body.innerHTML = '<div class="form-error">加载失败：' + esc(err.message) + '</div>';
      });
  }

  function renderHealth(svc, db) {
    var svcLabel = [svc.name, svc.version ? 'v' + svc.version : ''].filter(Boolean).join(' · ') || '—';
    var poolSize = db.poolSize === null || db.poolSize === undefined ? '—' : String(db.poolSize);
    var threads = db.threadsConnected === null || db.threadsConnected === undefined ? '—' : String(db.threadsConnected);
    var rows = [
      ['服务名称 / 版本', svcLabel],
      ['Node 版本', svc.node || '—'],
      ['运行时长', fmtUptime(svc.uptimeSec)],
      ['MySQL 版本', db.version || '—'],
      ['连接池大小', poolSize],
      ['当前连接数', threads]
    ];
    $('#healthBody').innerHTML = rows
      .map(function (r) {
        return (
          '<div class="health-kv"><span class="health-key">' + esc(r[0]) + '</span>' +
          '<span class="health-val">' + esc(r[1]) + '</span></div>'
        );
      })
      .join('');
  }

  /* ----------------------------- 管理员账户 ----------------------------- */
  function openAdmin() {
    var admin = state.admin || {};
    $('#admUsername').textContent = admin.username || '—';
    $('#admLastLogin').textContent = '上次登录：' + fmtDateTime(admin.lastLoginAt);
    $('#admNewUsername').value = '';
    $('#admUsernamePwd').value = '';
    $('#admNewPassword').value = '';
    $('#admNewPassword2').value = '';
    $('#admPasswordPwd').value = '';
    hideFormError($('#admUsernameError'));
    hideFormError($('#admPasswordError'));
    openModal($('#adminModal'));
    /* 每次打开刷新资料，保证「上次登录」等信息最新；失败不打断操作 */
    api('/api/admin/profile')
      .then(function (data) {
        if (!data.admin) return;
        state.admin = data.admin;
        $('#admUsername').textContent = data.admin.username || '—';
        $('#admLastLogin').textContent = '上次登录：' + fmtDateTime(data.admin.lastLoginAt);
      })
      .catch(function () { /* 保持既有展示 */ });
  }

  function handleAdminUsernameSubmit() {
    var errEl = $('#admUsernameError');
    var btn = $('#admUsernameSubmit');
    hideFormError(errEl);
    var username = $('#admNewUsername').value.trim();
    var currentPassword = $('#admUsernamePwd').value;
    if (!username) return showFormError(errEl, '请填写新用户名');
    if (!currentPassword) return showFormError(errEl, '请填写当前密码');

    setBusy(btn, true, '更新中…');
    api('/api/admin/profile', { method: 'PATCH', body: { currentPassword: currentPassword, username: username } })
      .then(function (data) {
        var name = data.username || username;
        if (state.admin) state.admin.username = name;
        $('#admUsername').textContent = name;
        $('#admNewUsername').value = '';
        $('#admUsernamePwd').value = '';
        toast('用户名已更新为 ' + name, 'success');
      })
      .catch(function (err) {
        showFormError(errEl, err.message);
      })
      .then(function () {
        setBusy(btn, false);
      });
  }

  function handleAdminPasswordSubmit() {
    var errEl = $('#admPasswordError');
    var btn = $('#admPasswordSubmit');
    hideFormError(errEl);
    var newPassword = $('#admNewPassword').value;
    var confirmPassword = $('#admNewPassword2').value;
    var currentPassword = $('#admPasswordPwd').value;
    if (!newPassword) return showFormError(errEl, '请填写新密码');
    if (newPassword.length < 8) return showFormError(errEl, '密码至少 8 位');
    if (newPassword !== confirmPassword) return showFormError(errEl, '两次输入的密码不一致');
    if (!currentPassword) return showFormError(errEl, '请填写当前密码');

    setBusy(btn, true, '重置中…');
    api('/api/admin/password', {
      method: 'PATCH',
      body: { currentPassword: currentPassword, newPassword: newPassword }
    })
      .then(function (data) {
        toast((data && data.message) || '密码已重置，其他设备的登录已失效', 'success', 4500);
        $('#admNewPassword').value = '';
        $('#admNewPassword2').value = '';
        $('#admPasswordPwd').value = '';
      })
      .catch(function (err) {
        showFormError(errEl, err.message);
      })
      .then(function () {
        setBusy(btn, false);
      });
  }

  /* ----------------------------- 代理设置 ----------------------------- */
  /** 当前表单值：auto / direct / 自定义地址（自定义为空时返回 ''） */
  function currentProxyValue() {
    var checked = $('#proxyModal .px-radio:checked');
    var mode = checked ? checked.value : 'auto';
    if (mode === 'custom') return $('#pxCustomInput').value.trim();
    return mode;
  }

  function setProxyMode(mode) {
    $$('#proxyModal .px-radio').forEach(function (radio) {
      radio.checked = radio.value === mode;
    });
    var isCustom = mode === 'custom';
    $('#pxCustomInput').disabled = !isCustom;
    $('#pxCustomField').classList.toggle('is-disabled', !isCustom);
  }

  function renderProxyCurrent(data) {
    var web = (data && data.webProxy) || 'auto';
    var via = !!(data && data.apiViaProxy);
    $('#pxWebCurrent').textContent = '当前生效：网页通道 ' + web + ' · API 走代理 ' + (via ? '开启' : '关闭');
  }

  function openProxy() {
    hideFormError($('#pxError'));
    var result = $('#pxTestResult');
    result.hidden = true;
    result.className = 'px-result';
    result.textContent = '';
    setProxyMode('auto');
    $('#pxCustomInput').value = '';
    $('#pxApiVia').checked = false;
    $('#pxWebCurrent').textContent = '';
    openModal($('#proxyModal'));
    api('/api/admin/proxy')
      .then(function (data) {
        var webProxy = data.webProxy || 'auto';
        var mode = webProxy === 'auto' || webProxy === 'direct' ? webProxy : 'custom';
        setProxyMode(mode);
        if (mode === 'custom') $('#pxCustomInput').value = webProxy;
        $('#pxApiVia').checked = !!data.apiViaProxy;
        renderProxyCurrent(data);
      })
      .catch(function (err) {
        showFormError($('#pxError'), '加载代理配置失败：' + err.message);
      });
  }

  function testProxy() {
    var errEl = $('#pxError');
    hideFormError(errEl);
    var value = currentProxyValue();
    if (!value) {
      showFormError(errEl, '请填写自定义代理地址');
      return;
    }
    var box = $('#pxTestResult');
    box.hidden = false;
    box.className = 'px-result is-loading';
    box.innerHTML = '<span class="spinner"></span><span>正在探测…（可能需要十几秒）</span>';

    var btn = $('#pxTestBtn');
    setBusy(btn, true, '探测中…');
    /* auto 模式逐个探测通道可能耗时较久，超 15 秒更新文案避免用户以为卡死 */
    var slowTimer = setTimeout(function () {
      if (box.className.indexOf('is-loading') === -1) return;
      box.innerHTML = '<span class="spinner"></span><span>仍在探测中，请稍候…</span>';
    }, 15000);

    api('/api/admin/proxy/test', { method: 'POST', body: { webProxy: value } })
      .then(function (data) {
        var web = data.web || {};
        if (web.available) {
          box.className = 'px-result is-ok';
          box.textContent = '✓ ' + (web.message || '代理可用');
        } else {
          box.className = 'px-result is-warn';
          box.textContent = web.message || '代理不可用';
        }
      })
      .catch(function (err) {
        box.className = 'px-result is-warn';
        box.textContent = '探测失败：' + err.message;
      })
      .then(function () {
        clearTimeout(slowTimer);
        setBusy(btn, false);
      });
  }

  function saveProxy() {
    var errEl = $('#pxError');
    hideFormError(errEl);
    var value = currentProxyValue();
    if (!value) {
      showFormError(errEl, '请填写自定义代理地址');
      return;
    }
    var btn = $('#pxSaveBtn');
    setBusy(btn, true, '保存中…');
    api('/api/admin/proxy', {
      method: 'PUT',
      body: { webProxy: value, apiViaProxy: $('#pxApiVia').checked }
    })
      .then(function (data) {
        renderProxyCurrent(data);
        toast('代理设置已保存，即时生效', 'success');
        closeModal($('#proxyModal'));
      })
      .catch(function (err) {
        showFormError(errEl, err.message);
      })
      .then(function () {
        setBusy(btn, false);
      });
  }

  /* ----------------------------- 退出登录 ----------------------------- */
  function openLogout() {
    var admin = state.admin || {};
    $('#logoutUser').textContent = admin.username || '';
    hideFormError($('#logoutError'));
    openModal($('#logoutModal'));
  }

  function handleLogoutConfirm() {
    var btn = $('#logoutConfirm');
    var errEl = $('#logoutError');
    hideFormError(errEl);
    setBusy(btn, true, '正在退出…');
    api('/api/auth/logout', { method: 'POST' })
      .then(function () {
        location.replace('/login.html');
      })
      .catch(function (err) {
        showFormError(errEl, err.message);
        setBusy(btn, false);
      });
  }

/* ----------------------------- 批量 Star ----------------------------- */
var bsRepoTimer = null;

/* 结果状态展示元数据：实心反白 / 空心描边 / 灰横杠 / 虚线（状态字符串与后端逐字对应） */
var STAR_STATUS_META = {
  starred: { mark: 'bs-mark-done', msg: 'Star 成功', strong: true },
  unstarred: { mark: 'bs-mark-done', msg: '已取消 Star', strong: true },
  already: { mark: 'bs-mark-already', msg: '之前已 Star' },
  skipped: { mark: 'bs-mark-skipped', msg: '已跳过（无 Token）' },
  failed: { mark: 'bs-mark-failed' }
};

  function setBatchRepoCard(kind, html) {
    var box = $('#bsRepoCard');
    box.className = 'bs-repo-card' + (kind ? ' is-' + kind : '');
    box.innerHTML = html;
  }

  function resetBatchRepoCard() {
    setBatchRepoCard('empty', '先填写目标仓库');
  }

  function openBatchStar() {
    clearTimeout(bsRepoTimer);
    state.bsRepo = null;
    state.bsRepoSeq++;
    state.bsRunning = false;
    $('#bsRepoInput').value = '';
    resetBatchRepoCard();
    $('#bsResults').innerHTML = '';
    $('#bsRunHint').hidden = true;
    var btn = $('#bsRunBtn');
    btn.disabled = true;
    btn.textContent = '开始执行（已选 0 个账号）';
    $('#bsSelectedCount').textContent = '已选 0 / 0 个可用账号';
    openModal($('#batchStarModal'));
    loadBatchAccounts();
  }

  function loadBatchAccounts() {
    var listEl = $('#bsAccountList');
    listEl.innerHTML = '<div class="bs-list-loading"><span class="spinner spinner-lg"></span></div>';
    api('/api/accounts?sort=recent')
      .then(function (data) {
        state.bsAccounts = Array.isArray(data.accounts) ? data.accounts : [];
        state.bsSelected = {};
        state.bsAccounts.forEach(function (a) {
          if (a.hasToken) state.bsSelected[a.id] = true; /* 可用账号默认全选 */
        });
        renderBatchAccounts();
        updateBatchControls();
      })
      .catch(function (err) {
        state.bsAccounts = [];
        state.bsSelected = {};
        listEl.innerHTML = '<div class="bs-list-error">加载账号失败：' + esc(err.message) + '</div>';
        updateBatchControls();
      });
  }

  function renderBatchAccounts() {
    var listEl = $('#bsAccountList');
    if (!state.bsAccounts.length) {
      listEl.innerHTML = '<div class="bs-list-error">还没有账号，请先到账号总览添加。</div>';
      return;
    }
    listEl.innerHTML = state.bsAccounts
      .map(function (a) {
        return batchAccountRowHtml(a, state.bsSelected);
      })
      .join('');
  }

  function batchAvatarHtml(account) {
    var login = account.login || '';
    var letter = login.trim().charAt(0).toUpperCase() || '?';
    var profile = account.profile || {};
    var avatarUrl = safeUrl(profile.avatarUrl);
    return avatarUrl
      ? '<span class="bs-avatar"><img src="' + esc(avatarUrl) + '" alt="" loading="lazy" data-fallback="' + esc(letter) + '"></span>'
      : '<span class="bs-avatar"><span class="bs-avatar-letter">' + esc(letter) + '</span></span>';
  }

  function batchAccountRowHtml(account, selectedMap) {
    var canUse = !!account.hasToken;
    var st = STATUS_META[account.status] || { label: account.status || '未知', cls: 'badge-unverified' };
    var login = account.login || '（未命名）';
    var tokenText = account.hasToken
      ? account.tokenHint || '••••••••'
      : account.hasPassword
        ? '仅密码凭据'
        : '无凭据';
    var flagHtml = '';
    if (!canUse) {
      flagHtml = '<span class="bs-flag">无 Token，不可选</span>';
    } else if (account.status === 'invalid' || account.status === 'error') {
      flagHtml = '<span class="bs-flag bs-flag-dashed">上次验证失败</span>';
    }
    return (
      '<label class="bs-acc-row' + (canUse ? '' : ' is-disabled') + '" data-id="' + esc(account.id) + '">' +
      '<input type="checkbox" class="bs-checkbox" data-id="' + esc(account.id) + '"' +
      (canUse ? '' : ' disabled') +
      (canUse && selectedMap && selectedMap[account.id] ? ' checked' : '') +
      '>' +
      batchAvatarHtml(account) +
      '<span class="bs-acc-main">' +
      '<span class="bs-acc-login">' + esc(login) + '</span>' +
      '<span class="bs-acc-token mono">' + esc(tokenText) + '</span>' +
      '</span>' +
      flagHtml +
      '<span class="badge ' + st.cls + '"><span class="dot"></span>' + esc(st.label) + '</span>' +
      '</label>'
    );
  }

  function updateBatchControls() {
    var usable = 0;
    var selected = 0;
    state.bsAccounts.forEach(function (a) {
      if (!a.hasToken) return;
      usable++;
      if (state.bsSelected[a.id]) selected++;
    });
    $('#bsSelectedCount').textContent = '已选 ' + selected + ' / ' + usable + ' 个可用账号';
    if (state.bsRunning) return; /* 执行中由 setBusy 接管按钮状态 */
    var btn = $('#bsRunBtn');
    btn.disabled = !(state.bsRepo && selected > 0);
    btn.textContent = '开始执行（已选 ' + selected + ' 个账号）';
  }

  function setAllBatchSelected(sel) {
    state.bsAccounts.forEach(function (a) {
      if (!a.hasToken) return;
      if (sel) state.bsSelected[a.id] = true;
      else delete state.bsSelected[a.id];
    });
    $$('#bsAccountList .bs-checkbox:not(:disabled)').forEach(function (cb) {
      cb.checked = sel;
    });
    updateBatchControls();
  }

  function queryBatchRepo(raw, seq) {
    setBatchRepoCard('', '<div class="bs-repo-loading"><span class="spinner"></span><span>正在查询仓库…</span></div>');
    api('/api/actions/repo-info?repo=' + encodeURIComponent(raw))
      .then(function (data) {
        if (seq !== state.bsRepoSeq) return;
        state.bsRepo = data.repo || null;
        renderBatchRepoCard();
        updateBatchControls();
      })
      .catch(function (err) {
        if (seq !== state.bsRepoSeq) return;
        state.bsRepo = null;
        setBatchRepoCard('error', esc(err.message || '仓库不存在或无权访问：' + raw));
        updateBatchControls();
      });
  }

  /** 目标仓库信息卡内容（批量 Star / 批量复刻共用） */
  function batchRepoCardHtml(repo) {
    var url = safeUrl(repo.htmlUrl);
    var name = repo.fullName || repo.name || '';
    var externalSvg =
      '<svg class="external" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path></svg>';
    var nameHtml = url
      ? '<a class="bs-repo-name" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(name) + '</a>' + externalSvg
      : '<span class="bs-repo-name">' + esc(name) + '</span>';
    return (
      '<div class="bs-repo-top">' +
        nameHtml +
        '<span class="repo-tag' + (repo.private ? ' repo-tag-private' : '') + '">' + (repo.private ? '私有' : '公开') + '</span>' +
        (repo.language ? '<span class="repo-tag">' + esc(repo.language) + '</span>' : '') +
        '</div>' +
        (repo.description
          ? '<p class="bs-repo-desc" title="' + esc(repo.description) + '">' + esc(repo.description) + '</p>'
          : '') +
        '<div class="bs-repo-meta">' +
        '<span class="star">★ ' + esc(fmtNum(repo.stars)) + '</span>' +
        '<span>Forks ' + esc(fmtNum(repo.forks)) + '</span>' +
        '<span>Issues ' + esc(fmtNum(repo.openIssues)) + '</span>' +
        '</div>' +
        (repo.queriedBy
          ? '<p class="bs-repo-by">由账号 <span class="mono">' + esc(repo.queriedBy) + '</span> 查询</p>'
          : '')
    );
  }

  function renderBatchRepoCard() {
    var repo = state.bsRepo;
    if (!repo) {
      resetBatchRepoCard();
      return;
    }
    setBatchRepoCard('', batchRepoCardHtml(repo));
  }

  function findBatchAccount(id, list) {
    var arr = list || state.bsAccounts;
    var target = Number(id);
    for (var i = 0; i < arr.length; i++) {
      if (Number(arr[i].id) === target) return arr[i];
    }
    return null;
  }

  function runBatchStar() {
    if (state.bsRunning) return;
    var repo = (state.bsRepo && state.bsRepo.fullName) || $('#bsRepoInput').value.trim();
    var ids = [];
    state.bsAccounts.forEach(function (a) {
      if (a.hasToken && state.bsSelected[a.id]) ids.push(a.id);
    });
    if (!repo || !ids.length) return;

    state.bsRunning = true;
    var btn = $('#bsRunBtn');
    setBusy(btn, true, '正在执行…');
    $('#bsRunHint').hidden = false;
    $('#bsResults').innerHTML = '';

    /* 后端串行执行、每账号间隔约 400ms，多账号时请求可能持续数秒到数十秒 */
    api('/api/actions/star', { method: 'POST', body: { accountIds: ids, repo: repo, action: 'star' } })
      .then(function (data) {
        renderBatchResults(data.results || [], data.summary || {});
        var s = data.summary || {};
        toast(
          '执行完成：成功 ' + (s.success || 0) + ' · 已存在 ' + (s.already || 0) +
            ' · 跳过 ' + (s.skipped || 0) + ' · 失败 ' + (s.failed || 0),
          'success',
          5000
        );
        afterMutation();
      })
      .catch(function (err) {
        $('#bsResults').innerHTML = '<div class="bs-result-error">执行失败：' + esc(err.message) + '</div>';
        toast(err.message, 'error');
      })
      .then(function () {
        state.bsRunning = false;
        setBusy(btn, false);
        updateBatchControls();
        $('#bsRunHint').hidden = true;
      });
  }

  function batchResultRowHtml(r, statusMeta, accountList) {
    var meta = statusMeta || STAR_STATUS_META;
    var status = r.status || 'failed';
    var m = meta[status] || meta.failed;
    var login = r.login || '账号 #' + r.accountId;
    var msg = status === 'failed' ? '失败：' + (r.message || '未知错误') : m.msg;
    var account = findBatchAccount(r.accountId, accountList);
    var avatarHtml = account
      ? batchAvatarHtml(account)
      : '<span class="bs-avatar"><span class="bs-avatar-letter">' +
        esc(login.trim().charAt(0).toUpperCase() || '?') +
        '</span></span>';
    /* 复刻结果附带产物仓库全名，以小字展示在登录名下方 */
    var forkHtml = r.forkFullName
      ? '<span class="bs-result-fork mono" title="' + esc(r.forkFullName) + '">→ ' + esc(r.forkFullName) + '</span>'
      : '';
    return (
      '<div class="bs-result-row">' +
      avatarHtml +
      '<span class="bs-result-main">' +
      '<span class="bs-result-login">' + esc(login) + '</span>' +
      forkHtml +
      '</span>' +
      '<span class="bs-result-right">' +
      '<span class="bs-mark ' + m.mark + '"></span>' +
      '<span class="bs-result-msg' + (m.strong ? ' is-strong' : '') + '" title="' + esc(msg) + '">' + esc(msg) + '</span>' +
      '</span>' +
      '</div>'
    );
  }

  function batchSummaryHtml(summary) {
    var s = summary || {};
    return (
      '<div class="bs-summary">成功 ' + esc(fmtNum(s.success || 0)) +
      ' · 已存在 ' + esc(fmtNum(s.already || 0)) +
      ' · 跳过 ' + esc(fmtNum(s.skipped || 0)) +
      ' · 失败 ' + esc(fmtNum(s.failed || 0)) + '</div>'
    );
  }

  function renderBatchResults(results, summary) {
    var rowsHtml = results
      .map(function (r) {
        return batchResultRowHtml(r);
      })
      .join('');
    $('#bsResults').innerHTML = rowsHtml + batchSummaryHtml(summary);
  }

  /* ----------------------------- 批量关注 ----------------------------- */
  var bfUserTimer = null;

  /* 结果状态展示元数据：实心反白 / 空心描边 / 灰横杠 / 虚线（状态字符串与后端逐字对应） */
  var FOLLOW_STATUS_META = {
    followed: { mark: 'bs-mark-done', msg: '关注成功', strong: true },
    unfollowed: { mark: 'bs-mark-done', msg: '已取消关注', strong: true },
    already: { mark: 'bs-mark-already', msg: '之前已关注' },
    skipped: { mark: 'bs-mark-skipped', msg: '已跳过（无 Token）' },
    failed: { mark: 'bs-mark-failed' }
  };

  function setFollowUserCard(kind, html) {
    var box = $('#bfUserCard');
    box.className = 'bs-repo-card' + (kind ? ' is-' + kind : '');
    box.innerHTML = html;
  }

  function resetFollowUserCard() {
    setFollowUserCard('empty', '先填写目标用户');
  }

  function openBatchFollow() {
    clearTimeout(bfUserTimer);
    state.bfUser = null;
    state.bfUserSeq++;
    state.bfRunning = false;
    $('#bfUserInput').value = '';
    resetFollowUserCard();
    $('#bfResults').innerHTML = '';
    $('#bfRunHint').hidden = true;
    var btn = $('#bfRunBtn');
    btn.disabled = true;
    btn.textContent = '开始关注（已选 0 个账号）';
    $('#bfSelectedCount').textContent = '已选 0 / 0 个可用账号';
    openModal($('#batchFollowModal'));
    loadFollowAccounts();
  }

  function loadFollowAccounts() {
    var listEl = $('#bfAccountList');
    listEl.innerHTML = '<div class="bs-list-loading"><span class="spinner spinner-lg"></span></div>';
    api('/api/accounts?sort=recent')
      .then(function (data) {
        state.bfAccounts = Array.isArray(data.accounts) ? data.accounts : [];
        state.bfSelected = {};
        state.bfAccounts.forEach(function (a) {
          if (a.hasToken) state.bfSelected[a.id] = true; /* 可用账号默认全选 */
        });
        renderFollowAccounts();
        updateFollowControls();
      })
      .catch(function (err) {
        state.bfAccounts = [];
        state.bfSelected = {};
        listEl.innerHTML = '<div class="bs-list-error">加载账号失败：' + esc(err.message) + '</div>';
        updateFollowControls();
      });
  }

  function renderFollowAccounts() {
    var listEl = $('#bfAccountList');
    if (!state.bfAccounts.length) {
      listEl.innerHTML = '<div class="bs-list-error">还没有账号，请先到账号总览添加。</div>';
      return;
    }
    listEl.innerHTML = state.bfAccounts
      .map(function (a) {
        return batchAccountRowHtml(a, state.bfSelected);
      })
      .join('');
  }

  function updateFollowControls() {
    var usable = 0;
    var selected = 0;
    state.bfAccounts.forEach(function (a) {
      if (!a.hasToken) return;
      usable++;
      if (state.bfSelected[a.id]) selected++;
    });
    $('#bfSelectedCount').textContent = '已选 ' + selected + ' / ' + usable + ' 个可用账号';
    if (state.bfRunning) return; /* 执行中由 setBusy 接管按钮状态 */
    var btn = $('#bfRunBtn');
    btn.disabled = !(state.bfUser && selected > 0);
    btn.textContent = '开始关注（已选 ' + selected + ' 个账号）';
  }

  function setAllFollowSelected(sel) {
    state.bfAccounts.forEach(function (a) {
      if (!a.hasToken) return;
      if (sel) state.bfSelected[a.id] = true;
      else delete state.bfSelected[a.id];
    });
    $$('#bfAccountList .bs-checkbox:not(:disabled)').forEach(function (cb) {
      cb.checked = sel;
    });
    updateFollowControls();
  }

  function queryBatchUser(raw, seq) {
    setFollowUserCard('', '<div class="bs-repo-loading"><span class="spinner"></span><span>正在查询用户…</span></div>');
    api('/api/actions/user-info?username=' + encodeURIComponent(raw))
      .then(function (data) {
        if (seq !== state.bfUserSeq) return;
        state.bfUser = data.user || null;
        renderFollowUserCard();
        updateFollowControls();
      })
      .catch(function (err) {
        if (seq !== state.bfUserSeq) return;
        state.bfUser = null;
        setFollowUserCard('error', esc(err.message || '用户不存在：' + raw));
        updateFollowControls();
      });
  }

  function renderFollowUserCard() {
    var user = state.bfUser;
    if (!user) {
      resetFollowUserCard();
      return;
    }
    var login = user.login || '';
    var letter = login.trim().charAt(0).toUpperCase() || '?';
    var avatarUrl = safeUrl(user.avatarUrl);
    var url = safeUrl(user.htmlUrl) || (login ? 'https://github.com/' + encodeURIComponent(login) : '');
    var externalSvg =
      '<svg class="external" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path></svg>';
    var avatarHtml = avatarUrl
      ? '<span class="bs-avatar"><img src="' + esc(avatarUrl) + '" alt="" loading="lazy" data-fallback="' + esc(letter) + '"></span>'
      : '<span class="bs-avatar"><span class="bs-avatar-letter">' + esc(letter) + '</span></span>';
    var loginHtml = url
      ? '<a class="bf-user-link" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" title="打开 GitHub 主页"><span>@' + esc(login) + '</span>' +
        externalSvg +
        '</a>'
      : '<span class="bf-user-link"><span>@' + esc(login) + '</span></span>';

    setFollowUserCard(
      '',
      '<div class="bf-user-top">' +
        avatarHtml +
        '<span class="bf-user-id">' +
        '<span class="bf-user-name">' + esc(user.name || login || '（未命名）') + '</span>' +
        loginHtml +
        '</span>' +
        '</div>' +
        (user.bio ? '<p class="bs-repo-desc" title="' + esc(user.bio) + '">' + esc(user.bio) + '</p>' : '') +
        '<div class="mini-stats bf-user-stats">' +
        '<div class="mini-stat"><span class="v">' + esc(fmtNum(user.publicRepos)) + '</span><span class="k">仓库</span></div>' +
        '<div class="mini-stat"><span class="v">' + esc(fmtNum(user.followers)) + '</span><span class="k">关注者</span></div>' +
        '<div class="mini-stat"><span class="v">' + esc(fmtNum(user.following)) + '</span><span class="k">正在关注</span></div>' +
        '</div>' +
        (user.queriedBy
          ? '<p class="bs-repo-by">由账号 <span class="mono">' + esc(user.queriedBy) + '</span> 查询</p>'
          : '')
    );
  }

  function runBatchFollow() {
    if (state.bfRunning) return;
    var username = (state.bfUser && state.bfUser.login) || '';
    var ids = [];
    state.bfAccounts.forEach(function (a) {
      if (a.hasToken && state.bfSelected[a.id]) ids.push(a.id);
    });
    if (!username || !ids.length) return;

    state.bfRunning = true;
    var btn = $('#bfRunBtn');
    setBusy(btn, true, '正在关注…');
    $('#bfRunHint').hidden = false;
    $('#bfResults').innerHTML = '';

    /* 后端串行执行、每账号间隔约 400ms，多账号时请求可能持续数十秒 */
    api('/api/actions/follow', { method: 'POST', body: { accountIds: ids, username: username, action: 'follow' } })
      .then(function (data) {
        renderFollowResults(data.results || [], data.summary || {});
        var s = data.summary || {};
        toast(
          '执行完成：成功 ' + (s.success || 0) + ' · 已存在 ' + (s.already || 0) +
            ' · 跳过 ' + (s.skipped || 0) + ' · 失败 ' + (s.failed || 0),
          'success',
          5000
        );
        afterMutation();
      })
      .catch(function (err) {
        $('#bfResults').innerHTML = '<div class="bs-result-error">执行失败：' + esc(err.message) + '</div>';
        toast(err.message, 'error');
      })
      .then(function () {
        state.bfRunning = false;
        setBusy(btn, false);
        updateFollowControls();
        $('#bfRunHint').hidden = true;
      });
  }

  function renderFollowResults(results, summary) {
    var rowsHtml = results
      .map(function (r) {
        return batchResultRowHtml(r, FOLLOW_STATUS_META, state.bfAccounts);
      })
      .join('');
    $('#bfResults').innerHTML = rowsHtml + batchSummaryHtml(summary);
  }

  /* ----------------------------- 批量复刻（Fork） ----------------------------- */
  var bkRepoTimer = null;

  /* 结果状态展示元数据：实心反白 / 空心描边 / 灰横杠 / 虚线（状态字符串与后端逐字对应） */
  var FORK_STATUS_META = {
    forked: { mark: 'bs-mark-done', msg: '复刻成功', strong: true },
    already: { mark: 'bs-mark-already', msg: '之前已复刻' },
    skipped: { mark: 'bs-mark-skipped', msg: '已跳过（无 Token）' },
    failed: { mark: 'bs-mark-failed' }
  };

  function setForkRepoCard(kind, html) {
    var box = $('#bkRepoCard');
    box.className = 'bs-repo-card' + (kind ? ' is-' + kind : '');
    box.innerHTML = html;
  }

  function resetForkRepoCard() {
    setForkRepoCard('empty', '先填写目标仓库');
  }

  function openBatchFork() {
    clearTimeout(bkRepoTimer);
    state.bkRepo = null;
    state.bkRepoSeq++;
    state.bkRunning = false;
    $('#bkRepoInput').value = '';
    resetForkRepoCard();
    $('#bkResults').innerHTML = '';
    $('#bkRunHint').hidden = true;
    var btn = $('#bkRunBtn');
    btn.disabled = true;
    btn.textContent = '开始复刻（已选 0 个账号）';
    $('#bkSelectedCount').textContent = '已选 0 / 0 个可用账号';
    openModal($('#batchForkModal'));
    loadForkAccounts();
  }

  function loadForkAccounts() {
    var listEl = $('#bkAccountList');
    listEl.innerHTML = '<div class="bs-list-loading"><span class="spinner spinner-lg"></span></div>';
    api('/api/accounts?sort=recent')
      .then(function (data) {
        state.bkAccounts = Array.isArray(data.accounts) ? data.accounts : [];
        state.bkSelected = {};
        state.bkAccounts.forEach(function (a) {
          if (a.hasToken) state.bkSelected[a.id] = true; /* 可用账号默认全选 */
        });
        renderForkAccounts();
        updateForkControls();
      })
      .catch(function (err) {
        state.bkAccounts = [];
        state.bkSelected = {};
        listEl.innerHTML = '<div class="bs-list-error">加载账号失败：' + esc(err.message) + '</div>';
        updateForkControls();
      });
  }

  function renderForkAccounts() {
    var listEl = $('#bkAccountList');
    if (!state.bkAccounts.length) {
      listEl.innerHTML = '<div class="bs-list-error">还没有账号，请先到账号总览添加。</div>';
      return;
    }
    listEl.innerHTML = state.bkAccounts
      .map(function (a) {
        return batchAccountRowHtml(a, state.bkSelected);
      })
      .join('');
  }

  function updateForkControls() {
    var usable = 0;
    var selected = 0;
    state.bkAccounts.forEach(function (a) {
      if (!a.hasToken) return;
      usable++;
      if (state.bkSelected[a.id]) selected++;
    });
    $('#bkSelectedCount').textContent = '已选 ' + selected + ' / ' + usable + ' 个可用账号';
    if (state.bkRunning) return; /* 执行中由 setBusy 接管按钮状态 */
    var btn = $('#bkRunBtn');
    btn.disabled = !(state.bkRepo && selected > 0);
    btn.textContent = '开始复刻（已选 ' + selected + ' 个账号）';
  }

  function setAllForkSelected(sel) {
    state.bkAccounts.forEach(function (a) {
      if (!a.hasToken) return;
      if (sel) state.bkSelected[a.id] = true;
      else delete state.bkSelected[a.id];
    });
    $$('#bkAccountList .bs-checkbox:not(:disabled)').forEach(function (cb) {
      cb.checked = sel;
    });
    updateForkControls();
  }

  function queryForkRepo(raw, seq) {
    setForkRepoCard('', '<div class="bs-repo-loading"><span class="spinner"></span><span>正在查询仓库…</span></div>');
    api('/api/actions/repo-info?repo=' + encodeURIComponent(raw))
      .then(function (data) {
        if (seq !== state.bkRepoSeq) return;
        state.bkRepo = data.repo || null;
        renderForkRepoCard();
        updateForkControls();
      })
      .catch(function (err) {
        if (seq !== state.bkRepoSeq) return;
        state.bkRepo = null;
        setForkRepoCard('error', esc(err.message || '仓库不存在或无权访问：' + raw));
        updateForkControls();
      });
  }

  function renderForkRepoCard() {
    var repo = state.bkRepo;
    if (!repo) {
      resetForkRepoCard();
      return;
    }
    setForkRepoCard('', batchRepoCardHtml(repo));
  }

  function runBatchFork() {
    if (state.bkRunning) return;
    var repo = (state.bkRepo && state.bkRepo.fullName) || $('#bkRepoInput').value.trim();
    var ids = [];
    state.bkAccounts.forEach(function (a) {
      if (a.hasToken && state.bkSelected[a.id]) ids.push(a.id);
    });
    if (!repo || !ids.length) return;

    state.bkRunning = true;
    var btn = $('#bkRunBtn');
    setBusy(btn, true, '正在复刻…');
    $('#bkRunHint').hidden = false;
    $('#bkResults').innerHTML = '';

    /* 后端串行执行、每账号间隔约 800ms，多账号时请求可能持续十几秒 */
    api('/api/actions/fork', { method: 'POST', body: { accountIds: ids, repo: repo } })
      .then(function (data) {
        renderBatchForkResults(data.results || [], data.summary || {});
        var s = data.summary || {};
        toast(
          '执行完成：成功 ' + (s.success || 0) + ' · 已存在 ' + (s.already || 0) +
            ' · 跳过 ' + (s.skipped || 0) + ' · 失败 ' + (s.failed || 0),
          'success',
          5000
        );
        afterMutation();
      })
      .catch(function (err) {
        $('#bkResults').innerHTML = '<div class="bs-result-error">执行失败：' + esc(err.message) + '</div>';
        toast(err.message, 'error');
      })
      .then(function () {
        state.bkRunning = false;
        setBusy(btn, false);
        updateForkControls();
        $('#bkRunHint').hidden = true;
      });
  }

  function renderBatchForkResults(results, summary) {
    var rowsHtml = results
      .map(function (r) {
        return batchResultRowHtml(r, FORK_STATUS_META, state.bkAccounts);
      })
      .join('');
    $('#bkResults').innerHTML = rowsHtml + batchSummaryHtml(summary);
  }

  /* ----------------------------- 账号详情（窄屏紧凑卡片点击打开） ----------------------------- */
  var COMPACT_QUERY = '(max-width: 720px)';

  /** 是否处于窄屏紧凑模式（断点与 CSS 保持一致） */
  function isCompactView() {
    return window.matchMedia ? window.matchMedia(COMPACT_QUERY).matches : window.innerWidth <= 720;
  }

  /** 详情模态使用完整卡片渲染（附带上次验证时间）；账号已不存在时返回 false */
  function renderAccountDetail() {
    var account = findAccount(state.detailAccountId);
    if (!account) return false;
    $('#accountDetailBody').innerHTML = renderAccountCard(account, true);
    return true;
  }

  /** 详情模态打开时同步最新账号数据；账号已被删除则关闭模态 */
  function refreshAccountDetail() {
    var modal = $('#accountDetailModal');
    if (!modal || modal.hidden) return;
    if (!renderAccountDetail()) {
      state.detailAccountId = null;
      closeModal(modal);
    }
  }

  function openAccountDetail(account) {
    state.detailAccountId = Number(account.id);
    $('#accountDetailLogin').textContent = account.login || '（未命名）';
    renderAccountDetail();
    openModal($('#accountDetailModal'));
  }

  /* ----------------------------- 卡片操作委托 ----------------------------- */
  /** 卡片操作（事件委托）：账号总览卡片与窄屏详情模态内的 验证/仓库/编辑/删除/复制/显示 共用 */
  function handleAccountCardAction(event) {
    var btn = event.target.closest('[data-action]');
    if (!btn) return;
    var card = btn.closest('.account-card');
    if (!card) return;
    var id = Number(card.dataset.id);
    var action = btn.dataset.action;
    if (action === 'verify') return handleVerify(card, btn);
    if (action === 'edit') {
      var acc = findAccount(id);
      if (acc) openEdit(acc);
      return;
    }
    if (action === 'delete') {
      var acc2 = findAccount(id);
      if (acc2) openDelete(acc2);
      return;
    }
    if (action === 'repos') {
      var acc3 = findAccount(id);
      if (acc3) openRepos(acc3);
      return;
    }
    if (action === 'reveal') return handleReveal(card, btn);
    if (action === 'copy-cred') return handleCopyCred(card, btn);
  }

  /* ----------------------------- 头像加载失败回退 ----------------------------- */
  /** 头像加载失败 → 首字母回退（对 .avatar 与 .bs-avatar 两种头像均生效） */
  function bindAvatarFallback(root) {
    if (!root) return;
    root.addEventListener(
      'error',
      function (event) {
        var img = event.target;
        if (!img || img.tagName !== 'IMG') return;
        var letter = img.dataset.fallback || '?';
        if (img.closest('.avatar')) {
          img.parentNode.innerHTML = '<span class="avatar-fallback">' + esc(letter) + '</span>';
        } else if (img.closest('.bs-avatar')) {
          img.parentNode.innerHTML = '<span class="bs-avatar-letter">' + esc(letter) + '</span>';
        }
      },
      true
    );
  }

  /* ----------------------------- 事件绑定 ----------------------------- */
  function bindEvents() {
    /* 主题 */
    $('#themeToggle').addEventListener('click', function () {
      var current = document.documentElement.getAttribute('data-theme');
      applyTheme(current === 'dark' ? 'light' : 'dark');
    });

    /* 视图切换 */
    $$('.view-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        switchView(tab.dataset.view);
      });
    });

    /* 搜索（300ms 防抖） */
    var searchTimer = null;
    $('#searchInput').addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.q = $('#searchInput').value.trim();
        if (state.view !== 'accounts') switchView('accounts');
        loadAccounts();
      }, 300);
    });

    /* 状态筛选 / 排序 */
    $('#statusFilter').addEventListener('change', function () {
      state.status = $('#statusFilter').value;
      loadAccounts();
    });
    $('#sortSelect').addEventListener('change', function () {
      state.sort = $('#sortSelect').value;
      loadAccounts();
    });

    /* 刷新 */
    $('#refreshBtn').addEventListener('click', function () {
      loadAccounts();
      loadStats();
    });
    $('#accountsRetry').addEventListener('click', function () {
      renderAccountSkeletons();
      loadAccounts();
      loadStats();
    });

    /* 添加账号 */
    $('#addAccountBtn').addEventListener('click', function () {
      resetAddForm();
      openModal($('#addModal'));
    });
    $$('#addModal .modal-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        switchAddTab(tab.dataset.tab);
      });
    });
    $('#addForm').addEventListener('submit', handleAddSubmit);
    $('#atLogin').addEventListener('input', updateAtSubmitState);
    $('#atPassword').addEventListener('input', updateAtSubmitState);

    /* 密码换 Token：验证码续接视图交互 */
    $('#atVerifyCode').addEventListener('input', function () {
      var v = this.value.replace(/\D/g, '').slice(0, 6);
      if (this.value !== v) this.value = v;
      updateAtVerifySubmit();
    });
    $('#atVerifyCode').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!$('#atVerifySubmit').disabled) submitAtVerifyCode();
      }
    });
    $('#atVerifySubmit').addEventListener('click', submitAtVerifyCode);
    $('#atVerifyResend').addEventListener('click', resendAtVerifyCode);
    $('#atVerifyBack').addEventListener('click', hideAtVerifyView);

    /* 卡片操作（事件委托）：覆盖账号网格与窄屏详情模态内的卡片 */
    document.addEventListener('click', handleAccountCardAction);

    /* 窄屏紧凑模式：点击卡片本体（非操作按钮）打开账号详情模态 */
    $('#accountGrid').addEventListener('click', function (event) {
      if (!isCompactView()) return;
      if (event.target.closest('[data-action]')) return;
      var card = event.target.closest('.account-card');
      if (!card) return;
      if (event.target.closest('a')) event.preventDefault(); /* 紧凑卡片整体可点：登录名不再跳外链 */
      var account = findAccount(card.dataset.id);
      if (account) openAccountDetail(account);
    });

    /* 头像加载失败 → 首字母回退 */
    bindAvatarFallback($('#accountGrid'));
    bindAvatarFallback($('#accountDetailModal'));

    /* 编辑 / 删除 / 仓库模态 */
    $('#editForm').addEventListener('submit', handleEditSubmit);
    $('#deleteConfirm').addEventListener('click', handleDeleteConfirm);
    $('#repoFilter').addEventListener('input', renderRepos);
    $('#reposList').addEventListener('click', function (event) {
      var btn = event.target.closest('[data-action="copy-remote"]');
      if (btn) handleCopyRemote(btn);
    });

    /* 日志 */
    $('#logLevel').addEventListener('change', function () {
      state.logLevel = $('#logLevel').value;
      state.logPage = 1;
      loadLogs();
    });
    $('#logsRefreshBtn').addEventListener('click', loadLogs);
    $('#logPrev').addEventListener('click', function () {
      if (state.logPage > 1) {
        state.logPage -= 1;
        loadLogs();
      }
    });
    $('#logNext').addEventListener('click', function () {
      if (state.logPage < state.logPages) {
        state.logPage += 1;
        loadLogs();
      }
    });

    /* 右上角菜单 */
    $('#menuBtn').addEventListener('click', toggleMenu);
    $('#menuPopover').addEventListener('click', function (event) {
      var item = event.target.closest('.menu-item');
      if (!item) return;
      closeMenu();
      handleMenuAction(item.dataset.menu);
    });
    document.addEventListener('click', function (event) {
      if (!event.target.closest('.menu-wrap')) closeMenu();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeMenu();
    });
    /* 窗口尺寸变化时重算菜单位置（菜单打开状态下） */
    window.addEventListener('resize', positionMenuPopover);

    /* 批量 Star：仓库输入（500ms 防抖） */
    $('#bsRepoInput').addEventListener('input', function () {
      clearTimeout(bsRepoTimer);
      state.bsRepo = null;
      var seq = ++state.bsRepoSeq;
      updateBatchControls();
      var raw = $('#bsRepoInput').value.trim();
      if (!raw) {
        resetBatchRepoCard();
        return;
      }
      bsRepoTimer = setTimeout(function () {
        queryBatchRepo(raw, seq);
      }, 500);
    });
    $('#bsSelectAll').addEventListener('click', function () {
      setAllBatchSelected(true);
    });
    $('#bsSelectNone').addEventListener('click', function () {
      setAllBatchSelected(false);
    });
    $('#bsAccountList').addEventListener('change', function (event) {
      var cb = event.target.closest('.bs-checkbox');
      if (!cb || cb.disabled) return;
      var id = Number(cb.dataset.id);
      if (cb.checked) state.bsSelected[id] = true;
      else delete state.bsSelected[id];
      updateBatchControls();
    });
    $('#bsRunBtn').addEventListener('click', runBatchStar);

    /* 批量 Star 模态内头像加载失败 → 首字母回退 */
    bindAvatarFallback($('#batchStarModal'));

    /* 批量关注：用户输入（500ms 防抖） */
    $('#bfUserInput').addEventListener('input', function () {
      clearTimeout(bfUserTimer);
      state.bfUser = null;
      var seq = ++state.bfUserSeq;
      updateFollowControls();
      var raw = $('#bfUserInput').value.trim();
      if (!raw) {
        resetFollowUserCard();
        return;
      }
      bfUserTimer = setTimeout(function () {
        queryBatchUser(raw, seq);
      }, 500);
    });
    $('#bfSelectAll').addEventListener('click', function () {
      setAllFollowSelected(true);
    });
    $('#bfSelectNone').addEventListener('click', function () {
      setAllFollowSelected(false);
    });
    $('#bfAccountList').addEventListener('change', function (event) {
      var cb = event.target.closest('.bs-checkbox');
      if (!cb || cb.disabled) return;
      var id = Number(cb.dataset.id);
      if (cb.checked) state.bfSelected[id] = true;
      else delete state.bfSelected[id];
      updateFollowControls();
    });
    $('#bfRunBtn').addEventListener('click', runBatchFollow);

    /* 批量关注模态内头像加载失败 → 首字母回退 */
    bindAvatarFallback($('#batchFollowModal'));

    /* 批量复刻：仓库输入（500ms 防抖） */
    $('#bkRepoInput').addEventListener('input', function () {
      clearTimeout(bkRepoTimer);
      state.bkRepo = null;
      var seq = ++state.bkRepoSeq;
      updateForkControls();
      var raw = $('#bkRepoInput').value.trim();
      if (!raw) {
        resetForkRepoCard();
        return;
      }
      bkRepoTimer = setTimeout(function () {
        queryForkRepo(raw, seq);
      }, 500);
    });
    $('#bkSelectAll').addEventListener('click', function () {
      setAllForkSelected(true);
    });
    $('#bkSelectNone').addEventListener('click', function () {
      setAllForkSelected(false);
    });
    $('#bkAccountList').addEventListener('change', function (event) {
      var cb = event.target.closest('.bs-checkbox');
      if (!cb || cb.disabled) return;
      var id = Number(cb.dataset.id);
      if (cb.checked) state.bkSelected[id] = true;
      else delete state.bkSelected[id];
      updateForkControls();
    });
    $('#bkRunBtn').addEventListener('click', runBatchFork);

    /* 批量复刻模态内头像加载失败 → 首字母回退 */
    bindAvatarFallback($('#batchForkModal'));

    /* 五期：管理员账户 / 代理设置 / 退出登录 */
    $('#admUsernameSubmit').addEventListener('click', handleAdminUsernameSubmit);
    $('#admPasswordSubmit').addEventListener('click', handleAdminPasswordSubmit);
    $$('#proxyModal .px-radio').forEach(function (radio) {
      radio.addEventListener('change', function () {
        setProxyMode(radio.value);
        if (radio.value === 'custom') $('#pxCustomInput').focus();
      });
    });
    $('#pxTestBtn').addEventListener('click', testProxy);
    $('#pxSaveBtn').addEventListener('click', saveProxy);
    $('#logoutConfirm').addEventListener('click', handleLogoutConfirm);

    /* 模态关闭：overlay / 关闭按钮 / Esc */
    document.addEventListener('click', function (event) {
      var closer = event.target.closest('[data-close]');
      if (closer) {
        var root = closer.closest('.modal-root');
        if (root) closeModal(root);
      }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        var open = $$('.modal-root:not([hidden])');
        if (open.length) closeModal(open[open.length - 1]);
      }
    });
  }

  /* ----------------------------- 启动 ----------------------------- */
  /** 首屏数据（统计 + 账号）加载结束后移除启动遮罩 */
  function startDataLoading() {
    Promise.all([loadStats(), loadAccounts()]).then(finishBoot);
  }

  function finishBoot() {
    var boot = $('#appBoot');
    if (!boot) return;
    boot.classList.add('is-done');
    setTimeout(function () {
      boot.hidden = true;
    }, 260);
  }

  function init() {
    applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
    bindEvents();
    renderStatsSkeleton();
    renderAccountSkeletons();

    /* 第一步：校验会话。401 由 api() 统一跳转登录页；网络错误提示后照常尝试 */
    api('/api/auth/me')
      .then(function (data) {
        state.admin = data.admin || null;
        startDataLoading();
      })
      .catch(function (err) {
        if (err && !err.status) {
          toast(err.message, 'error');
          startDataLoading();
          return;
        }
        location.replace('/login.html');
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

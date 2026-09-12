// ==================== 配置 ====================
  const CONFIG = {
    owner: 'YOUR_GITHUB_USERNAME',
    repo: 'YOUR_REPO_NAME',
    admin: 'YOUR_GITHUB_USERNAME',
    clientID: 'YOUR_GITHUB_CLIENT_ID',
    // OAuth 回调地址：必须与 GitHub OAuth App 后台的 Authorization callback URL 完全一致。
    // 固定写死（带末尾斜杠），不依赖当前 URL，避免移动端因 location.pathname 为 /index.html、
    // 或访问了预览部署子域名/hash/query 差异，导致 redirect_uri 精确匹配失败。
    redirectURI: 'https://YOUR_DOMAIN/',
    branch: 'main',
  };
  const GH_API = 'https://api.github.com';

  // ==================== 降低动态偏好 ====================
  // 系统开启「减少动态效果」时：Canvas 运动冻结（仍绘制静态画面）、鼠标粒子不生成、
  // 彩蛋不触发。与 style.css 末尾的 prefers-reduced-motion 媒体查询配套。
  var REDUCED_MOTION = false;
  try {
    REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { REDUCED_MOTION = false; }

  // ==================== Markdown 渲染配置 ====================
  // 想法流帖子和评论内容用 marked 渲染（GitHub 风格 Markdown）。
  // 注意：这些内容来自 GitHub Issues/Comments，**任何 GitHub 登录用户都能写入**，属不可信输入。
  // 所以 marked 的输出不能直接插入 innerHTML —— 必须先经 DOMPurify 净化（见 renderMd）。
  if (window.marked) {
    marked.setOptions({
      gfm: true,         // GitHub 风格 Markdown（表格、删除线、任务列表等）
      breaks: true,      // 单行换行转 <br>（与原 nl2br 行为一致）
      headerIds: false,  // 不生成 header id（避免锚点冲突）
      mangle: false,     // 不混淆邮箱链接
    });
  }
  function renderMd(text) {
    if (!text) return '';
    var html;
    if (window.marked) {
      try { html = marked.parse(text); } catch (e) { return nl2br(text); }
    } else {
      return nl2br(text);  // marked 加载失败时回退到纯换行（内部已转义，安全）
    }
    // XSS 净化：剥除 <script>、on* 事件、javascript: 链接等危险内容后再插入页面
    if (window.DOMPurify) {
      try { return DOMPurify.sanitize(html); } catch (e) { return nl2br(text); }
    }
    // DOMPurify 未加载时宁可退化为纯文本，也不渲染未净化的 HTML
    return nl2br(text);
  }

  // ==================== Toast 浮动提示 ====================
  // 替代阻塞式 alert：右下角滑入，3 秒后自动滑出。
  // type: 'info'（默认）| 'error' | 'warning' | 'success'
  var toastContainer = document.getElementById('toastContainer');
  function showToast(msg, type) {
    if (!toastContainer) return;
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' toast-' + type : '');
    el.textContent = msg;
    toastContainer.appendChild(el);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { el.classList.add('show'); });
    });
    setTimeout(function () {
      el.classList.remove('show');
      el.classList.add('hide');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 350);
    }, 3000);
  }

  // ==================== 状态 ====================
  // 本地存储安全访问：Safari 无痕 / iOS 隐私模式下读写 localStorage 会直接抛
  // SecurityError。下面两处读取在脚本顶层同步执行，一旦抛出会导致整个 app.js
  // 中断 → 全站白屏（海洋 / 想法流 / 相册 / 评论全废）。写入侧原本已有 try-catch，
  // 这里补上遗漏的读取侧，并把其余裸调用统一收口，避免同类崩溃复发。
  function safeStorageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeStorageSet(key, val) {
    try { localStorage.setItem(key, val); return true; } catch (e) { return false; }
  }
  function safeStorageRemove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* 存储不可用时静默降级 */ }
  }
  let accessToken = safeStorageGet('GT_ACCESS_TOKEN') || null;
  let currentUser = null;
  let thoughts = [];
  let photos = [];
  let allComments = [];  // 漂流瓶内容池：所有已加载的评论
  const likedIssues = new Set((function () {
    try { return JSON.parse(safeStorageGet('GT_LIKED_ISSUES') || '[]') || []; }
    catch (e) { return []; }
  })());

  // 在脚本同步阶段捕获 OAuth code。Gitalk 的构造函数会用 history.replaceState
  // 清掉 URL 上的 ?code=xxx，若不提前捕获，init() 在异步等待后就读不到了。
  const oauthCode = new URLSearchParams(location.search).get('code');

  // ==================== 工具函数 ====================
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function nl2br(s) { return escapeHtml(s).replace(/\n/g, '<br>'); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function formatIssueTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' · ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // 全局兜底：未被局部 try/catch 捕获的 Promise 异常统一记日志，避免静默失败
  window.addEventListener('unhandledrejection', function (ev) {
    console.error('[几何岛屿] 未处理的异步错误：', ev && ev.reason);
  });

  // ==================== 页面切换（hash 路由） ====================
  const pages = document.querySelectorAll('.page');
  const links = document.querySelectorAll('.nav-links a');
  const VALID_PAGES = ['home', 'album'];
  const PAGE_TITLES = { home: '几何岛屿 · 我的想法流', album: '相册 · 几何岛屿' };
  function showPage(name) {
    // 无效 hash 回退到首页，避免所有 .page 都丢失 active 导致空白页
    if (VALID_PAGES.indexOf(name) === -1) name = 'home';
    pages.forEach(p => p.classList.toggle('active', p.id === name));
    links.forEach(a => a.classList.toggle('active', a.dataset.page === name));
    document.title = PAGE_TITLES[name] || PAGE_TITLES.home;  // 标签页标题随路由更新
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  links.forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      history.pushState(null, '', a.getAttribute('href'));
      showPage(a.dataset.page);
    });
  });
  window.addEventListener('hashchange', () => {
    showPage(location.hash.replace('#', ''));
  });
  showPage(location.hash.replace('#', ''));

  // ==================== DOM 引用 ====================
  const thoughtsList = document.getElementById('thoughtsList');
  const thoughtsEmpty = document.getElementById('thoughtsEmpty');
  const thoughtsSearch = document.getElementById('thoughtsSearch');
  const albumGrid = document.getElementById('albumGrid');
  const albumEmpty = document.getElementById('albumEmpty');
  const albumCount = document.getElementById('albumCount');
  const btnNewPost = document.getElementById('btnNewPost');
  const btnUploadPhoto = document.getElementById('btnUploadPhoto');
  const btnLogin = document.getElementById('btnLogin');
  const btnLogout = document.getElementById('btnLogout');
  const userChip = document.getElementById('userChip');
  const loginTip = document.getElementById('loginTip');
  const postModal = document.getElementById('postModal');
  const postInput = document.getElementById('postInput');
  const btnClosePost = document.getElementById('closePostModal');
  const btnCancelPost = document.getElementById('cancelPost');
  const btnPublishPost = document.getElementById('publishPost');
  const photoInput = document.getElementById('photoInput');

  // ==================== GitHub API 封装 ====================
  // 判断是否触发 GitHub 限流：429，或匿名额度耗尽时的 403（X-RateLimit-Remaining=0）
  function isRateLimited(res) {
    if (res.status === 429) return true;
    if (res.status === 403 && res.headers.get('X-RateLimit-Remaining') === '0') return true;
    return false;
  }
  // 真正发起请求：遇限流读 Retry-After 自动等待并重试一次
  async function ghFetch(path, opts) {
    opts = opts || {};
    const buildHeaders = function () {
      const headers = Object.assign({}, opts.headers || {});
      if (accessToken) headers['Authorization'] = 'token ' + accessToken;
      headers['Accept'] = 'application/vnd.github.v3+json';
      return headers;
    };
    let res = await fetch(GH_API + path, Object.assign({}, opts, { headers: buildHeaders() }));
    if (isRateLimited(res)) {
      const ra = parseInt(res.headers.get('Retry-After') || '', 10);
      const waitMs = (!isNaN(ra) && ra > 0) ? Math.min(ra * 1000, 5000) : 1500;
      await new Promise(function (r) { setTimeout(r, waitMs); });  // 退避后重试一次
      res = await fetch(GH_API + path, Object.assign({}, opts, { headers: buildHeaders() }));
      if (isRateLimited(res) && typeof showToast === 'function') {
        showToast('GitHub 请求过于频繁，请稍后再试', 'warning');
      }
    }
    return res;
  }
  async function ghRequest(path, opts) {
    const res = await ghFetch(path, opts);
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) {
      const err = new Error((data && data.message) || ('GitHub API ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }
  // 从 Link 头解析 rel="next"，并把绝对 URL 还原为 GH_API 相对路径
  function nextPagePath(linkHeader) {
    if (!linkHeader) return null;
    const m = linkHeader.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (!m) return null;
    const url = m[1];
    return url.indexOf(GH_API) === 0 ? url.slice(GH_API.length) : url;
  }
  // 列表接口自动翻页：跟随 rel="next" 拉完全部页并合并（上限 10 页防异常死循环）
  async function ghRequestAll(path, opts) {
    let all = [];
    let nextPath = path;
    let guard = 0;
    while (nextPath && guard < 10) {
      guard++;
      const res = await ghFetch(nextPath, opts);
      let page = null;
      try { page = await res.json(); } catch (e) { page = []; }
      if (!res.ok) {
        const err = new Error((page && page.message) || ('GitHub API ' + res.status));
        err.status = res.status;
        throw err;
      }
      if (Array.isArray(page)) all = all.concat(page);
      nextPath = nextPagePath(res.headers.get('Link'));
    }
    return all;
  }

  // ==================== 登录 / 用户 ====================
  function isLoggedIn() { return !!accessToken; }
  function isAdmin() {
    return currentUser && currentUser.login.toLowerCase() === CONFIG.admin.toLowerCase();
  }

  async function fetchUser() {
    if (!accessToken) { currentUser = null; return null; }
    try {
      currentUser = await ghRequest('/user');
    } catch (e) {
      currentUser = null;
      if (e.status === 401) {
        accessToken = null;
        safeStorageRemove('GT_ACCESS_TOKEN');
      }
    }
    return currentUser;
  }

  function login() {
    // redirect_uri 固定写死（与 GitHub OAuth App 后台精确一致），不读 location 动态拼接，
    // 从根源上避免移动端因访问路径/子域名/hash/query 差异导致的 redirect_uri 不匹配。
    const url = 'https://github.com/login/oauth/authorize'
      + '?client_id=' + encodeURIComponent(CONFIG.clientID)
      + '&redirect_uri=' + encodeURIComponent(CONFIG.redirectURI)
      + '&scope=public_repo';
    // 记住用户原本在哪个页面，授权回来后跳回去
    const intended = location.hash || '#home';
    sessionStorage.setItem('intendedHash', intended);
    location.href = url;
  }

  function logout() {
    safeStorageRemove('GT_ACCESS_TOKEN');
    safeStorageRemove('GT_LIKED_ISSUES');
    location.reload();
  }

  function updateNav() {
    const logged = isLoggedIn();
    const admin = isAdmin();
    btnLogin.hidden = logged;
    btnLogout.hidden = !logged;
    loginTip.hidden = logged;
    userChip.hidden = !logged;
    btnNewPost.hidden = !admin;
    btnUploadPhoto.hidden = !admin;
    if (logged && currentUser) {
      userChip.innerHTML =
        '<img src="' + escapeHtml(currentUser.avatar_url || '') + '" alt="" decoding="async">' +
        '<span>' + escapeHtml(currentUser.login || '') + '</span>';
    } else {
      userChip.innerHTML = '';
    }
  }

  btnLogin.addEventListener('click', login);
  btnLogout.addEventListener('click', logout);

  // ==================== 接管 Gitalk 评论区登录入口 ====================
  // Gitalk 内部的登录链接用 window.location.href（含 #hash）构造 redirect_uri，
  // 会与 OAuth App 白名单精确匹配失败。这里在“捕获阶段”拦截其登录元素的点击，
  // 统一改走右上角的 login()（固定 redirect_uri），并保留草稿评论。
  document.addEventListener('click', function (e) {
    const t = e.target;
    if (!t || !t.closest) return;
    const loginEl = t.closest('.gt-btn-login, .gt-avatar-github, .gt-action-login');
    if (!loginEl) return;
    e.preventDefault();
    e.stopPropagation();
    // 保存草稿评论（Gitalk 登录前会存 GT_COMMENT，登录后自动恢复输入框内容）
    const ta = document.querySelector('.gt-header-textarea');
    if (ta && ta.value) {
      try { window.localStorage.setItem('GT_COMMENT', encodeURIComponent(ta.value)); } catch (err) {}
    }
    login();
  }, true);

  // ==================== 渲染：想法流 ====================
  // 「显示更多」分页：一次渲染 10 篇，点按钮再多渲染 10 篇；
  // 搜索时不分页（直接展示全部匹配），方便一眼看完结果。
  var THOUGHTS_PAGE_SIZE = 10;
  var thoughtsShown = THOUGHTS_PAGE_SIZE;

  function renderThoughts() {
    const isEmpty = thoughts.length === 0;
    thoughtsList.classList.toggle('is-empty', isEmpty);
    thoughtsEmpty.style.display = isEmpty ? 'block' : 'none';
    thoughtsList.querySelectorAll('.thought').forEach(el => el.remove());
    var moreBtn = document.getElementById('thoughtsMoreBtn');
    if (moreBtn) moreBtn.remove();
    var noMatch = document.getElementById('thoughtsNoMatch');
    if (noMatch) noMatch.remove();

    // 搜索过滤：标题 + 正文模糊匹配
    var kw = (thoughtsSearch.value || '').trim().toLowerCase();
    var filtered = kw
      ? thoughts.filter(function (t) {
          return t.title.toLowerCase().indexOf(kw) > -1 ||
                 (t.text || '').toLowerCase().indexOf(kw) > -1;
        })
      : thoughts;

    if (kw && filtered.length === 0) {
      var hint = document.createElement('div');
      hint.id = 'thoughtsNoMatch';
      hint.className = 'load-hint';
      hint.textContent = '没有匹配的帖子';
      thoughtsList.insertBefore(hint, thoughtsEmpty);
    }

    var visible = kw ? filtered : filtered.slice(0, thoughtsShown);
    visible.forEach(function (t) {
      const art = document.createElement('article');
      art.className = 'thought';
      const liked = likedIssues.has(t.number);
      art.innerHTML =
        '<span class="thought-date">' + escapeHtml(t.date) + '</span>' +
        '<div class="md">' + renderMd(t.text) + '</div>' +
        '<div class="post-actions">' +
          '<button class="post-action-btn like-btn' + (liked ? ' liked' : '') + '" data-n="' + t.number + '" title="点赞">' +
            '<span>👍</span><span class="like-count">' + t.likeCount + '</span>' +
          '</button>' +
          '<button class="post-action-btn comment-btn" data-n="' + t.number + '" title="评论">' +
            '<span>💬</span><span class="comment-count">' + t.comments + '</span>' +
          '</button>' +
          (isAdmin() ? '<button class="post-action-btn edit-btn" data-n="' + t.number + '" title="编辑帖子">✏️</button>' : '') +
          (isAdmin() ? '<button class="post-action-btn delete-btn" data-n="' + t.number + '" title="删除帖子">🗑</button>' : '') +
        '</div>' +
        '<div class="post-comments" hidden></div>';
      thoughtsList.insertBefore(art, thoughtsEmpty);

      art.querySelector('.like-btn').addEventListener('click', function () { toggleLike(t.number); });
      art.querySelector('.comment-btn').addEventListener('click', function () {
        toggleComments(t.number, art.querySelector('.comment-btn'), art.querySelector('.post-comments'));
      });
      const delPostBtn = art.querySelector('.delete-btn');
      if (delPostBtn) delPostBtn.addEventListener('click', function () { deletePost(t.number, art); });
      const editPostBtn = art.querySelector('.edit-btn');
      if (editPostBtn) editPostBtn.addEventListener('click', function () { openEditPostModal(t); });
    });

    // 还有剩余且不在搜索态时，尾部挂「显示更多」按钮
    if (!kw && filtered.length > thoughtsShown) {
      var more = document.createElement('button');
      more.id = 'thoughtsMoreBtn';
      more.className = 'btn-ghost thoughts-more-btn';
      more.textContent = '显示更多（还有 ' + (filtered.length - thoughtsShown) + ' 篇）';
      more.addEventListener('click', function () {
        thoughtsShown += THOUGHTS_PAGE_SIZE;
        renderThoughts();
      });
      thoughtsList.insertBefore(more, thoughtsEmpty);
    }
  }

  // 搜索框实时过滤（带简单防抖）
  var searchTimer = null;
  thoughtsSearch.addEventListener('input', function () {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(renderThoughts, 150);
  });

  // ==================== 渲染：相册 ====================
  function renderAlbum() {
    const isEmpty = photos.length === 0;
    albumEmpty.style.display = isEmpty ? 'block' : 'none';
    albumCount.textContent = isEmpty ? '还没有照片' : '共 ' + photos.length + ' 张照片';
    albumGrid.querySelectorAll('.photo').forEach(el => el.remove());

    photos.forEach(function (p, idx) {
      const div = document.createElement('div');
      div.className = 'photo';
      // 网格用 ~400px 缩略图，灯箱才加载原图（省流量、加快首屏）。
      // 缩略图路径与原图同名加 thumb_ 前缀；旧照片没有缩略图，onerror 回退原图。
      var thumbSrc = p.path
        ? 'https://cdn.jsdelivr.net/gh/' + CONFIG.owner + '/' + CONFIG.repo + '@' + CONFIG.branch + '/' + p.path.replace('photos/', 'photos/thumb_')
        : '';
      div.innerHTML =
        '<img src="' + escapeHtml(thumbSrc || p.src) + '" data-full="' + escapeHtml(p.src) + '" alt="相册照片：' + escapeHtml(p.title) + '，拍摄于 ' + escapeHtml(p.date) + '" loading="lazy" decoding="async" class="lightbox-target">' +
        '<div class="photo-caption">' + escapeHtml(p.title) + '<small>' + escapeHtml(p.date) + '</small></div>' +
        (isAdmin() ? '<button class="photo-delete-btn" data-n="' + p.number + '" data-path="' + escapeHtml(p.path || '') + '" title="删除照片">✕</button>' : '');
      albumGrid.insertBefore(div, albumEmpty);
      var img = div.querySelector('img.lightbox-target');
      img.addEventListener('error', function () {
        if (thumbSrc && img.src.indexOf('thumb_') > -1) img.src = p.src;   // 缩略图不存在（旧照片）→ 回退原图
      });
      img.addEventListener('click', function () { openLightbox(p.src, idx); });
      const delPhotoBtn = div.querySelector('.photo-delete-btn');
      if (delPhotoBtn) delPhotoBtn.addEventListener('click', function (e) { e.stopPropagation(); deletePhoto(p.number, p.path, div); });
    });
  }

  // ==================== 内容缓存（TTL 10 分钟） ====================
  // 想法流 / 相册 / 漂流瓶评论池带时间戳存入 localStorage：
  // ① 缓存新鲜期内，首屏先即时渲染缓存内容，后台仍会刷新一次保持数据最新；
  // ② 加载失败且无内容时，回退展示过期缓存（标注"可能不是最新"）；
  // ③ 评论池随缓存复用，缓存新鲜期内不再发起每帖一条的预取请求（缓解 N+1）。
  var CACHE_TTL = 10 * 60 * 1000;
  var CACHE_KEY = 'GT_CONTENT_CACHE';
  function readContentCache(ignoreTtl) {
    var raw = safeStorageGet(CACHE_KEY);
    if (!raw) return null;
    try {
      var data = JSON.parse(raw);
      if (!data || !data.savedAt) return null;
      if (!ignoreTtl && Date.now() - data.savedAt > CACHE_TTL) return null;
      return data;
    } catch (e) { return null; }
  }
  function writeContentCache() {
    try {
      safeStorageSet(CACHE_KEY, JSON.stringify({
        savedAt: Date.now(),
        thoughts: thoughts,
        photos: photos,
        allComments: allComments.slice(0, 500)   // 评论池封顶，防长评论把存储额度撑爆
      }));
    } catch (e) { /* 存储不可用 / 超限时静默跳过，不影响正常流程 */ }
  }

  // 在空状态容器里追加「重试」按钮：加载失败时给用户一个不刷页的出路
  function showLoadRetry(container, fn) {
    var old = document.getElementById('loadRetryBtn');
    if (old) old.remove();
    var btn = document.createElement('button');
    btn.id = 'loadRetryBtn';
    btn.className = 'btn-ghost empty-retry-btn';
    btn.textContent = '重试';
    btn.addEventListener('click', function () { btn.disabled = true; fn(); });
    container.appendChild(btn);
  }
  function clearLoadRetry() {
    var old = document.getElementById('loadRetryBtn');
    if (old) old.remove();
  }

  // ==================== 数据加载 ====================
  async function loadThoughts() {
    clearLoadRetry();
    thoughtsEmpty.classList.add('loading');
    thoughtsEmpty.querySelector('p').textContent = '加载中…';
    try {
      const issues = await ghRequestAll('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/issues?labels=post&state=open&per_page=100&t=' + Date.now());  // 自动翻页，突破单页 100 条上限
      thoughts = issues.map(function (issue) {
        return {
          number: issue.number,
          title: issue.title,
          text: issue.body || '',
          date: formatIssueTime(issue.created_at),
          likeCount: (issue.reactions && issue.reactions['+1']) || 0,
          comments: issue.comments || 0,
        };
      });
      thoughtsEmpty.querySelector('p').textContent = '这里还空着，点击右上角「＋ 新建帖子」写下第一条想法吧。';
      writeContentCache();
    } catch (e) {
      console.error('加载帖子失败', e);
      if (!thoughts.length) {
        // 无任何内容：先试过期缓存兜底，再考虑显示重试按钮
        var stale = readContentCache(true);
        if (stale && (stale.thoughts || []).length) {
          thoughts = stale.thoughts;
          thoughtsEmpty.querySelector('p').textContent = '网络异常，正在显示上次的内容（可能不是最新）。';
          // 故意不 writeContentCache：保持原 savedAt，不给过期数据"续命"
        }
      }
      if (!thoughts.length) {
        thoughtsEmpty.querySelector('p').textContent = '加载失败，请刷新页面重试。';
        showLoadRetry(thoughtsEmpty, loadThoughts);
      } else {
        showToast('帖子刷新失败，正在显示缓存内容', 'warning');
      }
    }
    thoughtsEmpty.classList.remove('loading');
    renderThoughts();
  }

  async function loadPhotos() {
    clearLoadRetry();
    albumEmpty.classList.add('loading');
    try {
      // 显式指定 sort=created&direction=desc（最新在前），不依赖 API 默认返回顺序。
      const issues = await ghRequestAll('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/issues?labels=photo&state=open&per_page=100&sort=created&direction=desc&t=' + Date.now());  // 自动翻页，突破单页 100 条上限
      photos = issues.map(function (issue) {
        var src = (issue.body || '').trim();
        var path = '';
        if (src && src.indexOf('cdn.jsdelivr.net') > -1) {
          var m = src.match(/cdn\.jsdelivr\.net\/gh\/([^/]+\/[^/]+)@(.+?)\/(.+)/);
          if (m && m[1] === CONFIG.owner + '/' + CONFIG.repo) path = m[3];
        }
        return { number: issue.number, title: issue.title || '照片', src: src, path: path, date: formatIssueTime(issue.created_at), createdAt: issue.created_at };
      }).filter(function (p) { return p.src; });
      // 双保险：在前端再按创建时间降序排一次，确保最新上传的照片始终在最前面。
      photos.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
      writeContentCache();
    } catch (e) {
      console.error('加载照片失败', e);
      if (!photos.length) {
        var stale = readContentCache(true);
        if (stale && (stale.photos || []).length) {
          photos = stale.photos;
          albumCount.textContent = '网络异常，正在显示上次的 ' + photos.length + ' 张照片（可能不是最新）';
        }
      }
      if (!photos.length) {
        showLoadRetry(albumEmpty, loadPhotos);
      } else {
        showToast('相册刷新失败，正在显示缓存内容', 'warning');
      }
    }
    albumEmpty.classList.remove('loading');
    renderAlbum();
  }

  // ==================== 漂流瓶评论池 ====================
  // 合并评论进内容池（按 id 去重）。三处调用：预加载 / 展开评论区 / 发送评论成功后。
  function addCommentsToPool(comments) {
    (comments || []).forEach(function (c) {
      if (c && c.body && !allComments.some(function (ec) { return ec.id === c.id; })) {
        allComments.push({ id: c.id, body: c.body });
      }
    });
  }

  // 首屏自动把每个帖子的评论合并进 allComments，
  // 悬停漂流瓶无需用户手动点开评论区即可抽到真实评论。
  async function loadAllComments() {
    if (!thoughts.length) return;
    var BATCH = 3;  // 每批最多 3 个并发请求，避免帖子多时一次性打大量 GitHub API 触发速率限制
    try {
      for (var bi = 0; bi < thoughts.length; bi += BATCH) {
        var batch = thoughts.slice(bi, bi + BATCH);
        await Promise.all(batch.map(async function (t) {
          try {
            const comments = await ghRequest(
              '/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/issues/' + t.number + '/comments?per_page=100'
            );
            addCommentsToPool(comments);
          } catch (e) { /* 单个帖子失败不影响其余 */ }
        }));
      }
      writeContentCache();   // 评论池更新后同步进缓存
    } catch (e) {
      console.error('预加载漂流瓶评论失败', e);
    }
  }

  // ==================== 图片放大 ====================
  var lightbox = document.getElementById('lightbox');
  var lightboxImg = document.getElementById('lightboxImg');
  var lightboxPrev = document.getElementById('lightboxPrev');
  var lightboxNext = document.getElementById('lightboxNext');
  var currentPhotoIndex = -1;
  document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', function (e) { if (e.target === lightbox) closeLightbox(); });
  lightboxPrev.addEventListener('click', function (e) { e.stopPropagation(); prevPhoto(); });
  lightboxNext.addEventListener('click', function (e) { e.stopPropagation(); nextPhoto(); });
  document.addEventListener('keydown', function (e) {
    if (!lightbox.classList.contains('show')) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') prevPhoto();
    else if (e.key === 'ArrowRight') nextPhoto();
  });
  function updateLightboxNav() {
    lightboxPrev.disabled = currentPhotoIndex <= 0;
    lightboxNext.disabled = currentPhotoIndex >= photos.length - 1;
  }
  // 统一设置大图：加载失败时显示占位提示（内联样式，不改 style.css）
  function setLightboxSrc(src, alt) {
    var oldHint = document.getElementById('lightboxFail');
    if (oldHint) oldHint.remove();
    lightboxImg.style.opacity = '';
    lightboxImg.alt = alt || '';
    lightboxImg.onload = function () {
      lightboxImg.style.opacity = '';
      var hint = document.getElementById('lightboxFail');
      if (hint) hint.remove();
    };
    lightboxImg.onerror = function () {
      lightboxImg.onerror = null;
      lightboxImg.style.opacity = '0';
      if (!document.getElementById('lightboxFail')) {
        var d = document.createElement('div');
        d.id = 'lightboxFail';
        d.textContent = '图片加载失败';
        d.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:rgba(255,255,255,.85);font-size:15px;letter-spacing:.15em;pointer-events:none;';
        lightbox.appendChild(d);
      }
    };
    lightboxImg.src = src;
  }
  function showPhoto(idx) {
    if (idx < 0 || idx >= photos.length) return;
    currentPhotoIndex = idx;
    setLightboxSrc(photos[idx].src, photos[idx].title || '');
    updateLightboxNav();
  }
  function prevPhoto() { showPhoto(currentPhotoIndex - 1); }
  function nextPhoto() { showPhoto(currentPhotoIndex + 1); }
  function openLightbox(src, idx) {
    if (typeof idx === 'number' && idx >= 0 && idx < photos.length) {
      showPhoto(idx);
    } else {
      setLightboxSrc(src, '');
      currentPhotoIndex = -1;
      lightboxPrev.disabled = true;
      lightboxNext.disabled = true;
    }
    lightbox.classList.add('show');
    document.body.style.overflow = 'hidden';
  }
  function closeLightbox() {
    lightbox.classList.remove('show');
    document.body.style.overflow = '';
    setTimeout(function () {
      lightboxImg.src = '';
      lightboxImg.onload = null;
      lightboxImg.onerror = null;
      var hint = document.getElementById('lightboxFail');
      if (hint) hint.remove();
    }, 250);
  }

  // ==================== 回到顶部按钮 ====================
  var backToTop = document.getElementById('backToTop');
  var bttTimer = null;
  function updateBackToTop() {
    if (window.scrollY > window.innerHeight * 0.5) {
      backToTop.style.display = '';
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { backToTop.classList.add('show'); });
      });
    } else {
      backToTop.classList.remove('show');
      if (bttTimer) clearTimeout(bttTimer);
      bttTimer = setTimeout(function () {
        if (!backToTop.classList.contains('show')) backToTop.style.display = 'none';
      }, 350);
    }
  }
  window.addEventListener('scroll', updateBackToTop, { passive: true });
  backToTop.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  function refreshAdminUI() {
    var admin = isAdmin();
    document.querySelectorAll('.photo-delete-btn').forEach(function (b) { b.classList.toggle('admin-on', admin); });
    document.querySelectorAll('.comment-delete-btn').forEach(function (b) { b.classList.toggle('admin-on', admin); });
    document.querySelectorAll('.post-action-btn.delete-btn').forEach(function (b) { b.style.display = admin ? 'inline-flex' : 'none'; });
    document.querySelectorAll('.post-action-btn.edit-btn').forEach(function (b) { b.style.display = admin ? 'inline-flex' : 'none'; });
  }

  // ==================== 删除功能 ====================
  async function deletePost(number, artEl) {
    if (!confirm('确定要删除这篇帖子吗？删除后无法恢复。')) return;
    try {
      await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/issues/' + number, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
      if (artEl) artEl.remove();
      thoughts = thoughts.filter(function (t) { return t.number !== number; });
    } catch (e) {
      console.error('删除帖子失败', e);
      showToast('删除失败：' + (e.message || '未知错误'), 'error');
    }
  }
  async function deletePhoto(number, path, photoEl) {
    if (!confirm('确定要删除这张照片吗？删除后无法恢复。')) return;
    try {
      if (path) {
        var fileInfo = await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/contents/' + path);
        await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/contents/' + path, { method: 'DELETE', body: JSON.stringify({ message: '删除照片 ' + path, sha: fileInfo.sha, branch: CONFIG.branch }) });
        // 顺带清理缩略图（旧照片可能没有，404 时静默跳过）
        try {
          var thumbInfo = await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/contents/' + path.replace('photos/', 'photos/thumb_'));
          await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/contents/' + path.replace('photos/', 'photos/thumb_'), { method: 'DELETE', body: JSON.stringify({ message: '删除缩略图 thumb_' + path.slice(7), sha: thumbInfo.sha, branch: CONFIG.branch }) });
        } catch (e2) { /* 无缩略图，跳过 */ }
      }
      await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/issues/' + number, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
      if (photoEl) photoEl.remove();
      photos = photos.filter(function (p) { return p.number !== number; });
      var isEmpty = photos.length === 0;
      albumEmpty.style.display = isEmpty ? 'block' : 'none';
      albumCount.textContent = isEmpty ? '还没有照片' : '共 ' + photos.length + ' 张照片';
    } catch (e) {
      console.error('删除照片失败', e);
      showToast('删除失败：' + (e.message || '未知错误'), 'error');
    }
  }
  async function deleteComment(commentId, number, container) {
    if (!confirm('确定要删除这条评论吗？')) return;
    try {
      await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/issues/comments/' + commentId, { method: 'DELETE' });
      var comments = await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/issues/' + number + '/comments?per_page=100');
      renderComments(container, comments || []);
      refreshAdminUI();
    } catch (e) {
      console.error('删除评论失败', e);
      showToast('删除失败：' + (e.message || '未知错误'), 'error');
    }
  }

  // ==================== 点赞 ====================
  async function toggleLike(number) {
    if (!accessToken) { login(); return; }
    if (!currentUser) await fetchUser();
    if (!currentUser) { login(); return; }
    const btn = thoughtsList.querySelector('.like-btn[data-n="' + number + '"]');
    try {
      const reactions = await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/issues/' + number + '/reactions?per_page=100');
      const mine = (reactions || []).find(function (r) {
        return r.user && r.user.login.toLowerCase() === currentUser.login.toLowerCase() && r.content === '+1';
      });
      var added;
      if (mine) {
        await fetch(GH_API + '/reactions/' + mine.id, {
          method: 'DELETE',
          headers: { 'Authorization': 'token ' + accessToken, 'Accept': 'application/vnd.github.v3+json' },
        });
        likedIssues.delete(number);
        added = false;
      } else {
        await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/issues/' + number + '/reactions', {
          method: 'POST',
          body: JSON.stringify({ content: '+1' }),
        });
        likedIssues.add(number);
        added = true;
      }
      safeStorageSet('GT_LIKED_ISSUES', JSON.stringify(Array.from(likedIssues)));
      // 计数直接由刚拉到的 reactions 列表推算（过滤 +1 再 ±1），省掉重查 issue 的一次往返
      const count = Math.max(0,
        (reactions || []).filter(function (r) { return r && r.content === '+1'; }).length + (added ? 1 : -1));
      if (btn) {
        btn.classList.toggle('liked', likedIssues.has(number));
        btn.querySelector('.like-count').textContent = count;
      }
    } catch (e) {
      console.error('点赞失败', e);
      showToast('点赞失败：' + (e.message || '未知错误'), 'error');
    }
  }

  // ==================== 评论区 ====================
  async function toggleComments(number, btn, container) {
    if (!container.hidden) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    container.dataset.n = number;
    container.innerHTML = '<div class="load-hint">加载评论中…</div>';
    try {
      const comments = await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/issues/' + number + '/comments?per_page=100');
      renderComments(container, comments || []);
      addCommentsToPool(comments);
    } catch (e) {
      container.innerHTML = '<div class="load-hint">评论加载失败</div>';
    }
  }

  function commentInputHtml() {
    if (accessToken) {
      return '<div class="comment-input-wrap">' +
        '<textarea placeholder="写下你的评论…" rows="1"></textarea>' +
        '<button class="btn-primary btn-send-comment">发送</button>' +
      '</div>';
    }
    return '<div class="comment-login-hint">登录后才能评论。<a class="comment-login-link">点此登录 GitHub</a></div>';
  }

  function renderComments(container, comments) {
    var sortType = container.dataset.sort || 'time-asc';
    var page = parseInt(container.dataset.page || '1', 10);
    const pageSize = 10;
    function getSortVal(c) {
      if (sortType === 'time-desc') return new Date(c.created_at).getTime();
      if (sortType === 'reactions') return ((c.reactions && c.reactions['+1']) || 0);
      return new Date(c.created_at).getTime(); // time-asc
    }
    var sorted = comments.slice().sort(function (a, b) {
      var ka = getSortVal(a), kb = getSortVal(b);
      return sortType === 'time-asc' ? ka - kb : kb - ka;
    });
    // 计算分页
    var totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
    if (page > totalPages) page = totalPages;
    if (page < 1) page = 1;
    container.dataset.page = String(page);
    var start = (page - 1) * pageSize;
    var pageComments = sorted.slice(start, start + pageSize);

    var sortBarHtml = '<div class="comment-sort-bar"><label>排序：</label><select class="comment-sort-select">' +
      '<option value="time-asc"' + (sortType === 'time-asc' ? ' selected' : '') + '>从旧到新</option>' +
      '<option value="time-desc"' + (sortType === 'time-desc' ? ' selected' : '') + '>从新到旧</option>' +
      '<option value="reactions"' + (sortType === 'reactions' ? ' selected' : '') + '>按点赞数</option>' +
    '</select></div>';
    var html = sortBarHtml;
    if (!comments.length) {
      html += '<div class="comment-empty">还没有评论，来说点什么吧。</div>';
    } else {
      html += pageComments.map(function (c) {
        var u = c.user || {};
        var delBtn = isAdmin() ? '<button class="comment-delete-btn admin-on" data-id="' + c.id + '" data-n="' + container.dataset.n + '" title="删除评论">🗑 删除</button>' : '';
        return '<div class="comment-item">' +
          '<img src="' + escapeHtml(u.avatar_url || '') + '" alt="" decoding="async">' +
          '<div class="c-body">' +
            '<div class="c-author"><a href="' + escapeHtml(u.html_url || '#') + '" target="_blank" rel="noopener">' + escapeHtml(u.login || '匿名') + '</a>' +
            '<span class="c-time">' + escapeHtml(formatIssueTime(c.created_at)) + '</span>' + delBtn + '</div>' +
            '<div class="c-text">' + renderMd(c.body || '') + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
      // 评论总数超过一页（>10 条）时才显示翻页控件
      if (sorted.length > pageSize) {
        html += '<div class="comment-pagination">' +
          '<button class="comment-page-btn comment-page-prev"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>' +
          '<span class="comment-page-info">第 ' + page + ' / ' + totalPages + ' 页</span>' +
          '<button class="comment-page-btn comment-page-next"' + (page >= totalPages ? ' disabled' : '') + '>下一页</button>' +
        '</div>';
      }
    }
    container.innerHTML = html + commentInputHtml();
    container.querySelector('.comment-sort-select').addEventListener('change', function () {
      container.dataset.sort = this.value;
      container.dataset.page = '1'; // 切换排序时回到第一页
      renderComments(container, comments);
      refreshAdminUI();
    });
    var prevBtn = container.querySelector('.comment-page-prev');
    var nextBtn = container.querySelector('.comment-page-next');
    if (prevBtn) prevBtn.addEventListener('click', function () {
      container.dataset.page = String(page - 1);
      renderComments(container, comments);
      refreshAdminUI();
    });
    if (nextBtn) nextBtn.addEventListener('click', function () {
      container.dataset.page = String(page + 1);
      renderComments(container, comments);
      refreshAdminUI();
    });
    container.querySelectorAll('.comment-delete-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        deleteComment(parseInt(btn.dataset.id, 10), parseInt(btn.dataset.n, 10), container);
      });
    });
    const loginLink = container.querySelector('.comment-login-link');
    if (loginLink) loginLink.addEventListener('click', login);
    const textarea = container.querySelector('textarea');
    const sendBtn = container.querySelector('.btn-send-comment');
    if (textarea && sendBtn) {
      const number = parseInt(container.dataset.n, 10);
      const doSend = function () { sendComment(container, number, textarea.value); };
      sendBtn.addEventListener('click', doSend);
      textarea.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          doSend();
        }
      });
    }
  }

  async function sendComment(container, number, text) {
    const body = (text || '').trim();
    if (!body) { container.querySelector('textarea').focus(); return; }
    try {
      await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/issues/' + number + '/comments', {
        method: 'POST',
        body: JSON.stringify({ body: body }),
      });
      const comments = await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/issues/' + number + '/comments?per_page=100');
      renderComments(container, comments || []);
      addCommentsToPool(comments);
      const btn = thoughtsList.querySelector('.comment-btn[data-n="' + number + '"]');
      if (btn) btn.querySelector('.comment-count').textContent = (comments || []).length;
    } catch (e) {
      console.error('评论失败', e);
      showToast('评论失败：' + (e.message || '未知错误'), 'error');
    }
  }

  // ==================== 新建 / 编辑帖子 ====================
  var editingPostNumber = null;
  function openPostModal() {
    editingPostNumber = null;
    postModal.classList.add('show');
    postInput.value = '';
    btnPublishPost.textContent = '发布';
    setTimeout(function () { postInput.focus(); }, 50);
  }
  function openEditPostModal(t) {
    editingPostNumber = t.number;
    postModal.classList.add('show');
    postInput.value = t.text;
    btnPublishPost.textContent = '保存修改';
    setTimeout(function () { postInput.focus(); }, 50);
  }
  function closePostModal() {
    postModal.classList.remove('show');
    postInput.value = '';
    editingPostNumber = null;
    btnPublishPost.textContent = '发布';
  }
  btnNewPost.addEventListener('click', openPostModal);
  btnClosePost.addEventListener('click', closePostModal);
  btnCancelPost.addEventListener('click', closePostModal);
  postModal.addEventListener('click', function (e) { if (e.target === postModal) closePostModal(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && postModal.classList.contains('show')) closePostModal();
  });
  postInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      btnPublishPost.click();
    }
  });

  btnPublishPost.addEventListener('click', async function () {
    const text = postInput.value.trim();
    if (!text) { postInput.focus(); return; }
    if (!isAdmin()) { showToast('只有管理员（' + CONFIG.admin + '）可以发布帖子', 'warning'); return; }
    btnPublishPost.disabled = true;
    btnPublishPost.textContent = editingPostNumber ? '保存中…' : '发布中…';
    try {
      const title = text.length > 30 ? text.slice(0, 30) + '…' : text;
      if (editingPostNumber) {
        // 编辑已有帖子：PATCH 更新 issue body/title
        await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/issues/' + editingPostNumber, {
          method: 'PATCH',
          body: JSON.stringify({ title: title, body: text }),
        });
        showToast('帖子已更新', 'success');
      } else {
        await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/issues', {
          method: 'POST',
          body: JSON.stringify({ title: title, body: text, labels: ['post'] }),
        });
      }
      closePostModal();
      await loadThoughts();
    } catch (e) {
      console.error('发布/编辑失败', e);
      showToast((editingPostNumber ? '编辑失败：' : '发布失败：') + (e.message || '未知错误'), 'error');
    } finally {
      btnPublishPost.disabled = false;
      btnPublishPost.textContent = '发布';
    }
  });

  // ==================== 上传照片 ====================
  btnUploadPhoto.addEventListener('click', function () { photoInput.click(); });

  function compressImage(file, maxSize, quality) {
    maxSize = maxSize || 1600;
    quality = quality || 0.78;
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function (e) {
        const img = new Image();
        img.onload = function () {
          let w = img.width, h = img.height;
          if (w >= h && w > maxSize) { h = Math.round(h * maxSize / w); w = maxSize; }
          else if (h > w && h > maxSize) { w = Math.round(w * maxSize / h); h = maxSize; }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  photoInput.addEventListener('change', async function () {
    const files = Array.from(photoInput.files).filter(function (f) { return f.type.indexOf('image/') === 0; });
    photoInput.value = '';
    if (!files.length) return;
    if (!isAdmin()) { showToast('只有管理员（' + CONFIG.admin + '）可以上传照片', 'warning'); return; }

    // 超大图片预警：超过 10MB 的原图压缩时可能卡顿，提示用户确认
    var MAX_FILE_SIZE = 10 * 1024 * 1024;
    var bigFiles = files.filter(function (f) { return f.size > MAX_FILE_SIZE; });
    if (bigFiles.length) {
      var names = bigFiles.map(function (f) { return f.name + ' (' + (f.size / 1024 / 1024).toFixed(1) + 'MB)'; }).join('、');
      if (!confirm('以下图片较大（超过 10MB），压缩处理可能需要几秒：\n' + names + '\n\n是否继续上传？')) return;
    }

    for (const file of files) {
      try {
        const dataUrl = await compressImage(file);
        const base64 = dataUrl.split(',')[1];
        const ts = new Date();
        const filename = ts.getFullYear() + pad(ts.getMonth() + 1) + pad(ts.getDate()) + '_'
          + pad(ts.getHours()) + pad(ts.getMinutes()) + pad(ts.getSeconds()) + '.jpg';
        const path = 'photos/' + filename;
        await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/contents/' + path, {
          method: 'PUT',
          body: JSON.stringify({
            message: '上传照片 ' + filename,
            content: base64,
            branch: CONFIG.branch,
          }),
        });
        const imageUrl = 'https://cdn.jsdelivr.net/gh/' + CONFIG.owner + '/' + CONFIG.repo + '@' + CONFIG.branch + '/' + path;
        // 同步生成并上传 ~400px 缩略图（相册网格展示用，灯箱仍用原图）。
        // 失败不阻断主流程：网格 onerror 会回退原图，只是那一张稍微费流量。
        try {
          const thumbDataUrl = await compressImage(file, 400, 0.7);
          await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/contents/photos/thumb_' + filename, {
            method: 'PUT',
            body: JSON.stringify({
              message: '上传缩略图 thumb_' + filename,
              content: thumbDataUrl.split(',')[1],
              branch: CONFIG.branch,
            }),
          });
        } catch (thumbErr) {
          console.warn('缩略图上传失败（不影响原图）', thumbErr);
        }
        const title = file.name.replace(/\.[^.]+$/, '') || '照片';
        await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo + '/issues', {
          method: 'POST',
          body: JSON.stringify({ title: title, body: imageUrl, labels: ['photo'] }),
        });
      } catch (e) {
        console.error('上传照片失败', e);
        showToast('上传照片失败：' + (e.message || '未知错误'), 'error');
      }
    }
    await loadPhotos();
  });

  // ==================== 初始化 ====================
  async function init() {
    try {
      const repo = await ghRequest('/repos/' + CONFIG.owner + '/' + CONFIG.repo);
      CONFIG.branch = (repo && repo.default_branch) || 'main';
    } catch (e) { /* 保持 main */ }

    // OAuth 回调：由 Gitalk 负责用 code 换 token，这里轮询等待 token 写入 localStorage
    const hasCode = !!oauthCode;
    if (hasCode) {
      for (let i = 0; i < 75 && !safeStorageGet('GT_ACCESS_TOKEN'); i++) {
        await new Promise(function (r) { setTimeout(r, 200); });
      }
      // GitHub 跳回时不会保留 hash（fragment 不发送到服务器），这里恢复用户原本所在的页面
      const intended = sessionStorage.getItem('intendedHash') || '#home';
      sessionStorage.removeItem('intendedHash');
      const targetHash = intended.startsWith('#') ? intended.slice(1) : intended;
      const targetPage = (targetHash === 'album' || targetHash === 'home') ? targetHash : 'home';
      // replaceState 同时清掉 ?code=xxx 和设置 hash
      history.replaceState(null, '', location.pathname + '#' + targetPage);
      // 手动触发 hashchange，让 showPage 切到目标页（replaceState 不会触发 hashchange）
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }

    accessToken = safeStorageGet('GT_ACCESS_TOKEN') || null;
    await fetchUser();
    updateNav();
    refreshAdminUI();
    // 缓存命中：先即时渲染，再让下面的加载函数走网络刷新（用户无感知地换新数据）
    var cached = readContentCache();
    if (cached) {
      thoughts = cached.thoughts || [];
      photos = cached.photos || [];
      allComments = cached.allComments || [];
      renderThoughts();
      renderAlbum();
    }
    await Promise.all([loadThoughts(), loadPhotos()]);
    // 评论池预取（每帖一条请求）：缓存已带回评论池时跳过，省掉这批 N+1 请求
    if (!allComments.length) loadAllComments();
    refreshAdminUI();
  }

  init();

  // ==================== 主题系统（昼夜 × 四季） ====================
  var SEASON_COLORS = {
    spring: {
      bg: [[240,249,240],[227,242,227],[200,230,200]],
      tileLow: [180,220,180], tileHigh: [242,252,242],
      solid: [60,140,80], dash: [60,140,80],
      water: [100,180,120], grid: [60,140,80]
    },
    summer: {
      bg: [[244,249,255],[234,243,252],[207,228,247]],
      tileLow: [191,220,243], tileHigh: [255,255,255],
      solid: [70,120,175], dash: [70,120,175],
      water: [115,170,225], grid: [36,85,140]
    },
    autumn: {
      bg: [[255,248,240],[253,238,221],[245,213,176]],
      tileLow: [235,205,165], tileHigh: [255,242,222],
      solid: [180,100,30], dash: [180,100,30],
      water: [220,150,70], grid: [160,90,25]
    },
    winter: {
      bg: [[248,244,252],[237,228,247],[213,197,232]],
      tileLow: [200,185,225], tileHigh: [242,234,250],
      solid: [110,80,160], dash: [110,80,160],
      water: [155,126,201], grid: [90,60,140]
    }
  };
  var NIGHT_COLORS = {
    bg: [[10,14,26],[13,21,37],[20,30,53]],
    tileLow: [18,28,52], tileHigh: [32,46,74],
    solid: [170,200,240], dash: [170,200,240],
    water: [130,180,240], grid: [80,120,180]
  };

  // 当前插值后的显示颜色（canvas 每帧向目标色靠近）
  var themeDisplay = {
    bg0: [244,249,255], bg1: [234,243,252], bg2: [207,228,247],
    tileLow: [191,220,243], tileHigh: [255,255,255],
    solid: [70,120,175], dash: [70,120,175],
    water: [115,170,225], grid: [36,85,140],
    glow: 0
  };

  var themeMode = 'day';
  var themeSeason = (function () {
    var h = new Date().getHours();
    if (h >= 3 && h < 9) return 'spring';
    if (h >= 9 && h < 15) return 'summer';
    if (h >= 15 && h < 21) return 'autumn';
    return 'winter';
  })();

  function getTargetColors() {
    return themeMode === 'night' ? NIGHT_COLORS : SEASON_COLORS[themeSeason];
  }

  function applyThemeClasses() {
    document.body.classList.remove('season-spring','season-summer','season-autumn','season-winter');
    document.body.classList.toggle('night', themeMode === 'night');
    if (themeMode === 'day') document.body.classList.add('season-' + themeSeason);
  }

  function updateThemePanel() {
    var panel = document.getElementById('themePanel');
    if (!panel) return;
    panel.querySelectorAll('.theme-btn').forEach(function (btn) {
      btn.classList.remove('active');
      btn.disabled = false;
    });
    var modeBtn = panel.querySelector('[data-mode="' + themeMode + '"]');
    if (modeBtn) modeBtn.classList.add('active');
    if (themeMode === 'night') {
      panel.querySelectorAll('[data-season]').forEach(function (b) { b.disabled = true; });
    } else {
      var sb = panel.querySelector('[data-season="' + themeSeason + '"]');
      if (sb) sb.classList.add('active');
    }
  }

  function setThemeMode(mode) {
    themeMode = mode;
    applyThemeClasses();
    updateThemePanel();
  }
  function setThemeSeason(s) {
    themeSeason = s;
    themeMode = 'day';
    // 四季切换秒切：临时禁用 @property 变量过渡，双层 rAF 确保浏览器先渲染新色再恢复
    document.body.classList.add('no-theme-transition');
    applyThemeClasses();
    updateThemePanel();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        document.body.classList.remove('no-theme-transition');
      });
    });
  }

  // 初始化 body 类名
  applyThemeClasses();

  // 绑定侧边栏按钮
  document.querySelectorAll('.theme-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.dataset.mode) setThemeMode(btn.dataset.mode);
      else if (btn.dataset.season) setThemeSeason(btn.dataset.season);
    });
  });
  updateThemePanel();

  // 移动端没有 hover：平时面板只露出 14px 边条，点边条即可展开/收起（桌面 hover 行为不变）。
  // 点在主题按钮上时不切换展开态——那是选主题，不是开合面板；选中后面板保持展开，方便连续试色。
  var themePanelEl = document.getElementById('themePanel');
  if (themePanelEl) {
    themePanelEl.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('.theme-btn')) return;
      themePanelEl.classList.toggle('open');
    });
  }

  // ==================== 首页海洋背景（等距俯视海面） ====================
  // 仅在首页（#home 激活）时绘制并显示；鼠标在海面停留 1.5s 浮出随机几何体，移开 1s 内沉回。
  (function initOcean() {
    var home = document.getElementById('home');
    if (!home) return;

    var canvas = document.createElement('canvas');
    canvas.className = 'ocean-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    // 同步迁移：把岛屿 SVG 重新 append 到 body 末尾，确保它排在 canvas 之后入栈。
    // 同 z-index:-1 时按 DOM 顺序靠后 → 视觉上岛屿浮在海面之上，并且整个背景层（海+岛）
    // 都让位给 z-index:auto 的静态内容（想法流/评论区），滚动时不会再压在卡片上。
    var _islandDomForLayer = document.getElementById('island-bg');
    if (_islandDomForLayer && _islandDomForLayer.parentNode === document.body) {
      document.body.appendChild(_islandDomForLayer);
    }
    var ctx = canvas.getContext('2d');

    var W = 0, H = 0, DPR = 1, cols = 0, rows = 0;
    var pts = null;   // 预分配的格点缓冲（resize 时重建，frame 中只更新值不创建对象）
    var TILE_W = 46;   // 菱形水平半宽
    var TILE_H = 26;   // 菱形垂直半高

    // ---- 漂流几何体（drifter）----
    // 注意：数量是动态的（见 initDrifters），不存在常量；早期版本曾有 DRIFTER_COUNT=10，
    // 仅定义无引用，已删除。
    var DRIFT_SPEED_MIN = 14;   // px/s，缓慢漂流
    var DRIFT_SPEED_MAX = 22;
    var DRIFT_SCALE_MIN = 0.62; // 比悬停几何体(A=28)略小
    var DRIFT_SCALE_MAX = 0.74;
    var DRIFT_TILT_MIN = Math.PI / 6;   // 30°
    var DRIFT_TILT_MAX = Math.PI / 4;   // 45°
    var SINK_DURATION = 0.7;   // 下沉/上浮动画时长(s)
    var WAVE_SWAY_AMP = 5 * Math.PI / 180;  // 随波摇摆幅度 ±5°
    var WAVE_SWAY_FREQ = 1.4;                 // 摇摆频率
    var SPLASH_MAX = 60;      // 水花粒子池上限
    var RIPPLE_MAX = 16;      // 涟漪池上限
    var SPLASH_COUNT = 7;     // 每次破水喷出的水珠数
    var SPLASH_SPEED_MIN = 26, SPLASH_SPEED_MAX = 74;  // 水珠初速(px/s)
    var SPLASH_LIFE = 0.55;   // 水花寿命(s)
    var RIPPLE_SPEED = 46;    // 涟漪扩散速度(px/s)
    var RIPPLE_LIFE = 0.9;    // 涟漪寿命(s)
    var DRIFT_MIN_DISTANCE = 50;  // 漂流几何体之间最小间距(px)
    var BOTTLE_HOVER_TIME = 0.8;    // 悬停几何体多久后提起(s)
    var BOTTLE_RISE_TIME = 0.6;     // 提起动画时长(s)
    var BOTTLE_SINK_TIME = 0.4;     // 放下动画时长(s)
    var BOTTLE_LIFT_HEIGHT = 35;    // 提起高度(px)
    var BOTTLE_LEAVE_GRACE = 0.3;   // 鼠标离开防抖时间(s)
    var BOTTLE_HOVER_DIST = 40;     // 鼠标悬停碰撞距离(px)
    var TRANSITION_HALF = 3;   // 水上/水下柔和过渡带半高(px)
    var drifters = [];
    var stars = [];
    var meteor = null;       // 夜间流星（低频点缀，同时最多一颗）
    var nextMeteorAt = 0;    // 下一颗流星的出现时刻（白天持续顺延，入夜稳定后 8~20s 首颗）
    var splashPool = [];   // 水花粒子池
    var ripplePool = [];   // 涟漪环池

    function initStars() {
      stars = [];
      for (var i = 0; i < 140; i++) {
        stars.push({
          x: Math.random() * W,
          y: Math.random() * H * 0.75,
          r: Math.random() * 1.3 + 0.3,
          phase: Math.random() * Math.PI * 2,
          speed: Math.random() * 2 + 0.8
        });
      }
    }

    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.round(W * DPR);
      canvas.height = Math.round(H * DPR);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      cols = Math.ceil(W / (TILE_W * 2)) + 4;
      rows = Math.ceil(H / (TILE_H * 2)) + 5;
      // 预分配格点缓冲：每帧只更新 x/y/h 属性，不创建新对象，减少 GC 压力
      pts = [];
      for (var pi = 0; pi <= rows; pi++) {
        pts[pi] = [];
        for (var pj = 0; pj <= cols; pj++) {
          pts[pi][pj] = { x: 0, y: 0, h: 0 };
        }
      }
      initStars();
      cacheIslandAnchor();   // 岛屿菱形碰撞盒锚点（窗口缩放时重算）
    }

    // 波浪高度：正弦叠加，幅度约 10~16px，缓慢呼吸
    function wave(i, j, t) {
      return Math.sin(i * 0.5 + t * 1.15) * 7
           + Math.sin(j * 0.42 - t * 0.9 + 1.7) * 6;
    }

    // 格点 (i,j) 的等距投影（不含波浪）
    function iso(i, j) {
      return { x: (j - i) * TILE_W, y: (j + i) * TILE_H };
    }

    // 根据屏幕坐标连续采样波浪高度（非格点对齐，用于漂流几何体跟随波浪）
    function sampleWave(sx, sy, t) {
      var cx = W / 2 - ((cols - rows) / 2) * TILE_W;
      var ji = (sx - cx) / TILE_W;   // j - i
      var jpi = sy / TILE_H;          // j + i (cy=0)
      var j = (ji + jpi) / 2;
      var i = (jpi - ji) / 2;
      return wave(i, j, t);
    }

    // ---- 破水特效：水花粒子 + 涟漪 ----
    // 水花：破水瞬间喷出若干小水珠，受重力、按寿命淡出（对象池，避免 GC 抖动）
    function spawnSplash(x, y) {
      for (var n = 0; n < SPLASH_COUNT; n++) {
        if (splashPool.length >= SPLASH_MAX) break;
        var ang = Math.PI + Math.random() * Math.PI;  // 朝上扇形
        var sp = SPLASH_SPEED_MIN + Math.random() * (SPLASH_SPEED_MAX - SPLASH_SPEED_MIN);
        splashPool.push({
          x: x + (Math.random() - 0.5) * 6,
          y: y + (Math.random() - 0.5) * 4,
          vx: Math.cos(ang) * sp * (0.4 + Math.random() * 0.6),
          vy: -Math.sin(ang) * sp * (0.7 + Math.random() * 0.5),
          r: 1.2 + Math.random() * 1.8,
          age: 0,
          life: SPLASH_LIFE * (0.7 + Math.random() * 0.5)
        });
      }
    }

    // 涟漪：参数化扩散压扁椭圆（ry≈rx*0.4 模拟水面透视）
    function spawnRipple(x, y) {
      if (ripplePool.length >= RIPPLE_MAX) ripplePool.shift();
      ripplePool.push({ x: x, y: y, r: 3, age: 0, life: RIPPLE_LIFE });
    }

    function updateEffects(dt) {
      // 水花
      for (var i = splashPool.length - 1; i >= 0; i--) {
        var p = splashPool[i];
        p.age += dt;
        if (p.age >= p.life) { splashPool.splice(i, 1); continue; }
        p.vy += 420 * dt;   // 重力
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      // 涟漪
      for (var j = ripplePool.length - 1; j >= 0; j--) {
        var rp = ripplePool[j];
        rp.age += dt;
        if (rp.age >= rp.life) { ripplePool.splice(j, 1); continue; }
        rp.r += RIPPLE_SPEED * dt;
      }
    }

    function drawEffects() {
      var wc = themeDisplay.water;
      // 水花
      for (var i = 0; i < splashPool.length; i++) {
        var p = splashPool[i];
        var a = Math.max(0, 1 - p.age / p.life);
        ctx.fillStyle = 'rgba(' + (wc[0]|0) + ',' + (wc[1]|0) + ',' + (wc[2]|0) + ',' + (a * 0.85).toFixed(2) + ')';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      // 涟漪
      for (var j = 0; j < ripplePool.length; j++) {
        var rp = ripplePool[j];
        var prog = rp.age / rp.life;
        var a = (1 - prog) * 0.5;
        ctx.strokeStyle = 'rgba(' + (wc[0]|0) + ',' + (wc[1]|0) + ',' + (wc[2]|0) + ',' + a.toFixed(2) + ')';
        ctx.lineWidth = 1.4 * (1 - prog) + 0.3;
        ctx.beginPath();
        ctx.ellipse(rp.x, rp.y, rp.r, rp.r * 0.4, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // ---- 鼠标悬停几何体 ----
    var TYPES = ['cube', 'pyramid', 'cylinder'];
    var shape = null;
    var hoverTimer = null;
    var mouse = { x: 0, y: 0 };

    function spawn(x, y) {
      if (shape) return;
      shape = {
        type: TYPES[(Math.random() * TYPES.length) | 0],
        x: x, y: y, t: 0, phase: 'rising'
      };
    }
    function sink() {
      if (shape && shape.phase !== 'sinking') { shape.phase = 'sinking'; shape.t = 0; }
    }

    // 鼠标事件监听在 window 上（而不是 canvas）——因为 canvas 的 z-index:-1 位于最底层，
    // 被 body 内容与导航栏覆盖，永远收不到 mousemove/mouseleave 事件，导致几何体无法浮出。
    var entered = false;
    var lastTouchEnd = 0;   // 触摸结束后短暂屏蔽浏览器合成的事件，避免松手后误浮出瓶子
    // 鼠标与触摸共用：px / py 为视口坐标（函数体内统一用 mouse.x / mouse.y）
    function handlePointer(px, py) {
      if (!home.classList.contains('active')) return;   // 仅首页
      if (!entered) {
        entered = true;
      }
      mouse.x = px;
      mouse.y = py;

      // 情况B：检测鼠标是否悬停在某个漂流几何体上（仅海洋范围内生效）
      var hitDrifter = null;
      if (inOceanRect(mouse.x, mouse.y)) {
        for (var di = 0; di < drifters.length; di++) {
          var dd = drifters[di];
          if (dd.phase !== 'drifting') continue;  // 浸没状态不参与
          if (dd.bottleState === 'sinking') continue;
          var ddx = mouse.x - dd.x;
          var ddy = mouse.y - dd.baseY;
          if (ddx * ddx + ddy * ddy < BOTTLE_HOVER_DIST * BOTTLE_HOVER_DIST) {
            hitDrifter = dd;
            break;
          }
        }
      }

      if (hitDrifter) {
        // 悬停在几何体上：标记 hovered，清除情况A计时器
        hitDrifter.hovered = true;
        hitDrifter.leaveTimer = 0;
        clearTimeout(hoverTimer);
        if (shape && shape.phase !== 'sinking') sink();
      } else {
        // 不在几何体上：所有几何体标记为未悬停（防抖在 updateDrifters 中处理）
        for (var di2 = 0; di2 < drifters.length; di2++) {
          drifters[di2].hovered = false;
        }
        // 情况A：空白区域悬停浮出纯几何体
        if (shape && shape.phase !== 'sinking') {
          var sdx = mouse.x - shape.x, sdy = mouse.y - shape.y;
          if (sdx * sdx + sdy * sdy > 50 * 50) sink();
        }
        var inOcean = inOceanRect(mouse.x, mouse.y);
        clearTimeout(hoverTimer);
        if (inOcean) {
          hoverTimer = setTimeout(function () {
            spawn(mouse.x, mouse.y);
          }, 800);
        } else {
          sink();
        }
      }
    }
    window.addEventListener('mousemove', function (e) {
      if (Date.now() - lastTouchEnd < 500) return;      // 忽略触摸后浏览器补发的事件
      handlePointer(e.clientX, e.clientY);
    });

    // ---- 移动端触摸支持 ----
    // 桌面是「悬停 0.8s」，手机没有悬停，改用「长按 0.8s」：
    // 手指落下即开始计时；移动超过 12px 判定为滚动并取消；抬起/中断即收起。
    var TOUCH_MOVE_CANCEL = 12;
    var touchOrigin = null;
    function cancelTouchBottle() {
      touchOrigin = null;
      clearTimeout(hoverTimer);
      sink();
      for (var ti = 0; ti < drifters.length; ti++) drifters[ti].hovered = false;
    }
    window.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;               // 多指手势不参与
      var t = e.touches[0];
      touchOrigin = { x: t.clientX, y: t.clientY };
      handlePointer(t.clientX, t.clientY);              // 触发一次即启动 0.8s 计时
    }, { passive: true });
    window.addEventListener('touchmove', function (e) {
      if (!touchOrigin || e.touches.length !== 1) return;
      var t = e.touches[0];
      var dx = t.clientX - touchOrigin.x, dy = t.clientY - touchOrigin.y;
      if (dx * dx + dy * dy > TOUCH_MOVE_CANCEL * TOUCH_MOVE_CANCEL) cancelTouchBottle();
    }, { passive: true });
    window.addEventListener('touchend', function () {
      lastTouchEnd = Date.now();
      cancelTouchBottle();
    }, { passive: true });
    window.addEventListener('touchcancel', function () {
      lastTouchEnd = Date.now();
      cancelTouchBottle();
    }, { passive: true });

    window.addEventListener('mouseout', function (e) {
      if (!e.relatedTarget) {          // 鼠标离开窗口
        entered = false;
        clearTimeout(hoverTimer);
        sink();
        for (var i = 0; i < drifters.length; i++) drifters[i].hovered = false;
      }
    });

    // 绘制等距线稿几何体（正方体 / 三棱锥 / 圆柱体）
    // 纪念碑谷线稿风格：不填充，只描边；可见线实线 + 不可见线虚线
    // 等距投影约定：X-Y 平面水平、Z 轴垂直
    //   → 立方体顶面菱形宽高比 2:1（半宽 a、半高 a/2）
    //   → 菱形一个边的等距投影 = √(a² + (a/2)²) = a√5/2 ≈ 1.118a
    //   → 立方体棱长（垂直）= 1.118a，让顶/底菱形对齐
    function drawShape(s, px, py, scale, alpha, colorMode) {
      var A = 28 * scale;            // 顶面菱形半宽
      var Hh = A * 0.5;              // 顶面菱形半高
      var side = A * 1.118;          // 立方体棱长（垂直）
      ctx.save();
      ctx.globalAlpha = alpha;
      var isUnder = colorMode === 'underwater';
      ctx.lineWidth = isUnder ? 2.4 : 1.8;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      // 颜色跟随主题；夜间几何体发光
      var sc = themeDisplay.solid, dc = themeDisplay.dash;
      var glow = themeDisplay.glow;
      var SOLID, DASH;
      if (isUnder) {
        SOLID = 'rgba(' + (sc[0]*0.4|0) + ',' + (sc[1]*0.4|0) + ',' + (sc[2]*0.4|0) + ',0.85)';
        DASH  = 'rgba(' + (dc[0]*0.4|0) + ',' + (dc[1]*0.4|0) + ',' + (dc[2]*0.4|0) + ',0.5)';
      } else {
        SOLID = 'rgba(' + (sc[0]|0) + ',' + (sc[1]|0) + ',' + (sc[2]|0) + ',0.6)';
        DASH  = 'rgba(' + (dc[0]|0) + ',' + (dc[1]|0) + ',' + (dc[2]|0) + ',0.35)';
      }
      if (glow > 0.3 && !isUnder) {
        ctx.shadowColor = 'rgba(' + (sc[0]|0) + ',' + (sc[1]|0) + ',' + (sc[2]|0) + ',' + (glow * 0.5).toFixed(2) + ')';
        ctx.shadowBlur = 10 * glow;
      }

      // 画一条线（实或虚）
      function line(p1, p2, color, dashed) {
        ctx.strokeStyle = color;
        ctx.setLineDash(dashed ? [4, 3] : []);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
      // 画一串首尾相接线段
      function poly(points, color, dashed, closed) {
        ctx.strokeStyle = color;
        ctx.setLineDash(dashed ? [4, 3] : []);
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (var i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        if (closed) ctx.closePath();
        ctx.stroke();
      }

      if (s.type === 'cube') {
        // 8 顶点
        var tT = { x: px,        y: py - Hh };
        var tR = { x: px + A,    y: py };
        var tB = { x: px,        y: py + Hh };
        var tL = { x: px - A,    y: py };
        var bT = { x: tT.x,      y: tT.y + side };
        var bR = { x: tR.x,      y: tR.y + side };
        var bB = { x: tB.x,      y: tB.y + side };
        var bL = { x: tL.x,      y: tL.y + side };

        // ---- 不可见部分（虚线、淡色）---- 先画以免压住实线
        // 底面菱形：上半两条（bT→bR 背面右、bT→bL 背面左）被顶面+左右侧面遮住 → 虚线
        //           下半两条（bR→bB 正面右、bB→bL 正面左）从前面可见 → 实线
        line(bT, bR, DASH, true);
        line(bT, bL, DASH, true);
        // 后棱 tT→bT 背向
        line(tT, bT, DASH, true);

        // ---- 可见部分（实线）----
        // 顶面菱形（蓝色）
        poly([tT, tR, tB, tL], SOLID, false, true);
        // 底面下半两条（正面）
        line(bR, bB, SOLID, false);
        line(bB, bL, SOLID, false);
        // 3 条前面可见垂直棱
        line(tL, bL, SOLID, false);
        line(tR, bR, SOLID, false);
        line(tB, bB, SOLID, false);

      } else if (s.type === 'pyramid') {
        var baseHW = A * 0.5;
        var baseHH = A * 0.25;
        var height = side;
        var ba = { x: px,          y: py - baseHH }; // 后
        var bb = { x: px + baseHW, y: py };          // 右
        var bc = { x: px,          y: py + baseHH }; // 前
        var bd = { x: px - baseHW, y: py };          // 左
        var Tp = { x: px, y: py - height };

        // ---- 不可见 ----
        // 底面菱形被三个侧面盖住：虚线
        poly([ba, bb, bc, bd], DASH, true, true);
        // 顶点 Tp→后顶点 ba 的侧棱被前面挡住（实际上 Tp→ba 是后侧棱，视线被两侧面遮挡）
        line(Tp, ba, DASH, true);

        // ---- 可见 ----
        // 3 条可见侧棱（亮色）
        line(Tp, bb, SOLID, false);
        line(Tp, bc, SOLID, false);
        line(Tp, bd, SOLID, false);
        // 3 条底面边中可见部分（前、右前、左前的连线）：实线叠加到虚线上增强
        // 整圈底面已经是虚线，关键 3 条可见边重新画实线覆盖
        line(bb, bc, SOLID, false);
        line(bc, bd, SOLID, false);
        line(bd, ba, DASH, true); // ba-bd 实际上被前棱遮挡 - 但后侧边，不可见
        // 实际上 ba→bb 是后侧边，被 Tp-侧棱遮；bb→bc 右前可见；bc→bd 左前可见；bd→ba 左后不可见
        // 修正：画 bb→bc 和 bc→bd 两条实线；ba→bb 和 bd→ba 保持虚线
        // （上面已经画了虚线整圈，所以只需覆盖可见的）

      } else {
        // 圆柱体：等距投影下顶/底为水平椭圆（X:Y = 2:1）
        var rx = A;
        var ry = A * 0.5;
        var cylH = side;
        var topY = py - side * 0.5;
        var botY = topY + cylH;

        // 底椭圆：前半（面向观察者，在 Canvas 上位于下方、靠近观察者）蓝色实线，
        // 后半（背向观察者，位于上方、远离观察者）虚线。
        // Canvas 角度体系：0=右、π/2=下、π=左、3π/2=上
        //   面向观察者的半弧 = 经过 π/2 那一半（从 0 到 π，顺时针） → 屏幕下方凸出
        //   背向观察者的半弧 = 经过 3π/2 那一半（从 π 到 2π，顺时针） → 屏幕上方凸出
        ctx.strokeStyle = DASH;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        // 虚线：背向半弧（从 π 顺时针绕到 2π，经过 3π/2 = 屏幕上侧）
        ctx.ellipse(px, botY, rx, ry, 0, Math.PI, 2 * Math.PI, false);
        ctx.stroke();

        ctx.strokeStyle = SOLID;
        ctx.setLineDash([]);
        ctx.beginPath();
        // 实线：面向半弧（从 0 顺时针绕到 π，经过 π/2 = 屏幕下侧）
        ctx.ellipse(px, botY, rx, ry, 0, 0, Math.PI, false);
        ctx.stroke();

        // 顶椭圆（蓝色实线整圈，俯视可见）
        ctx.strokeStyle = SOLID;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.ellipse(px, topY, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();

        // 两条可见的左/右母线（连接顶椭圆左右端点到底椭圆左右端点）
        line({ x: px - rx, y: topY }, { x: px - rx, y: botY }, SOLID, false);
        line({ x: px + rx, y: topY }, { x: px + rx, y: botY }, SOLID, false);
      }



      ctx.restore();
    }

    // ==================== 漂流几何体系统 ====================
    function randRange(a, b) { return a + Math.random() * (b - a); }

    // 根据基准y计算海洋的左右边界（等距菱形区域），halfWidth为几何体半宽
    // 海洋是矩形 [0,rows]×[0,cols] 的等距投影，边界分上/下两段：
    //   右边界拐点 y = cols*TILE_H，左边界拐点 y = rows*TILE_H（cols≠rows 时顶点 cx 不居中）
    function oceanBounds(baseY, halfWidth) {
      var cx = W / 2 - ((cols - rows) / 2) * TILE_W;
      var hw = halfWidth || 0;
      var left, right;
      // 右边界：上段 x = cx + y*TILE_W/TILE_H；下段（j=cols 边）x = cx + (2*cols - y/TILE_H)*TILE_W
      if (baseY <= cols * TILE_H) {
        right = cx + baseY * TILE_W / TILE_H;
      } else {
        right = cx + (2 * cols - baseY / TILE_H) * TILE_W;
      }
      // 左边界：上段 x = cx - y*TILE_W/TILE_H；下段（i=rows 边）x = cx + (y/TILE_H - 2*rows)*TILE_W
      if (baseY <= rows * TILE_H) {
        left = cx - baseY * TILE_W / TILE_H;
      } else {
        left = cx + (baseY / TILE_H - 2 * rows) * TILE_W;
      }
      return {
        left: Math.max(0, left + hw),
        right: Math.min(W, right - hw)
      };
    }

    // 判断某屏幕坐标是否落在海洋菱形范围内（用 sampleWave 相同的逆换算，与渲染完全对齐）
    function inOceanRect(sx, sy) {
      var cx = W / 2 - ((cols - rows) / 2) * TILE_W;
      var ji = (sx - cx) / TILE_W;   // j - i
      var jpi = sy / TILE_H;          // j + i
      var j = (ji + jpi) / 2;
      var i = (jpi - ji) / 2;
      return i >= -0.5 && i <= rows + 0.5 && j >= -0.5 && j <= cols + 0.5;
    }

    // ---- 岛屿避让：等距 2.5D 非对称 4 顶点菱形碰撞盒（与海洋瓦片同透视）----
    // 锚点：SVG 内部基座中心 (160, 156) 通过 #island-bg 的 getBoundingClientRect
    //       + viewBox 0 0 320 260 比例映射到 canvas 屏幕 (ox, oy)，再反算网格 (i0, j0)。
    // 碰撞：drifter (x, baseY) → 用凸 4 顶点 polygon 包含判定（非对称时 L1 距离不适用）。
    //       左/下顶点额外外扩以贴岛屿左下。锚点只在 resize() 缓存一次，零运行时 DOM 读取。
    var ISLAND_R = 5;        // 菱形半径（外缘贴合岛屿基座菱形），半宽 = R*TILE_W、半高 = R*TILE_H
    var ISLAND_EPS = 0.2;    // 旧名保留（debug 用），判定容差单独用 ISLAND_L1_EPS
    var ISLAND_L1_EPS = 0.04;// 屏幕 L1 菱形判定容差（无量纲，0.04 ≈ 4% 离外缘）
    var ISLAND_EXT_LEFT   = 30;  // 左顶点额外左扩（屏幕像素，基准宽度下）
    var ISLAND_EXT_BOTTOM = 18;  // 下顶点额外下扩（屏幕像素，基准宽度下）
    var HITBOX_PAD = 30;         // 判定边界在显示菱形外 30px（碰撞盒 ≠ 显示盒）
    // ⚠ 上面四个尺寸是按「桌面端 #island-bg width:360px」调出来的固定像素值，
    // 与 SVG 实际渲染尺寸无关。窄屏 CSS 会缩小岛屿，若碰撞盒仍用固定像素就会与
    // 视觉岛屿错位（岛缩小了、判定区还那么大）。故引入缩放比：
    //   islandScale = 岛屿实际渲染宽度 / 基准宽度 360
    // 桌面端恒为 1 → 所有数值与调参时完全一致，零回归风险。
    var ISLAND_BASE_W = 360;
    var islandScale = 1;
    var islandEl = document.getElementById('island-bg');   // 岛屿 SVG（body 直系、fixed 定位）
    var islandHasBox = false;  // 锚点是否就绪
    var islandOx = 0, islandOy = 0;     // 锚点对应 canvas 屏幕坐标
    var islandI0 = 0, islandJ0 = 0;     // 锚点对应 (i,j) 网格坐标
    function cacheIslandAnchor() {
      if (!islandEl) { islandHasBox = false; return; }
      var r = islandEl.getBoundingClientRect();
      if (!r.width || !r.height) { islandHasBox = false; return; }
      // viewBox 0 0 320 260 → SVG 内部 (160,156) 映射到屏幕：
      //  scaleX = r.width / 320, scaleY = r.height / 260
      var scaleX = r.width / 320;
      var scaleY = r.height / 260;
      // 碰撞盒同比缩放（桌面端 r.width === 360 → islandScale === 1，行为完全不变）
      islandScale = Math.max(0.05, r.width / ISLAND_BASE_W);
      islandOx = r.left + 160 * scaleX;
      islandOy = r.top + 156 * scaleY;
      // 屏幕 → 网格（与 sampleWave 同逆变换）
      var cx = W / 2 - ((cols - rows) / 2) * TILE_W;
      var ji = (islandOx - cx) / TILE_W;
      var jpi = islandOy / TILE_H;
      islandJ0 = (ji + jpi) / 2;
      islandI0 = (jpi - ji) / 2;
      islandHasBox = true;
    }
    // 屏幕 → 网格（与 sampleWave 同体系）
    function screenToGrid(sx, sy) {
      var cx = W / 2 - ((cols - rows) / 2) * TILE_W;
      var ji = (sx - cx) / TILE_W;
      var jpi = sy / TILE_H;
      return { i: (jpi - ji) / 2, j: (ji + jpi) / 2 };
    }
    // 网格 → 屏幕绝对坐标（iso 相对值 + cx）
    function gridToScreen(i, j) {
      var cx = W / 2 - ((cols - rows) / 2) * TILE_W;
      var p = iso(i, j);
      return { x: cx + p.x, y: p.y };
    }
    // 凸 4 顶点 polygon 包含判定（顺时针绕外缘，4 条边 cross 同号 ⇔ 点在内部）
    function pointInQuad(px, py, va, vb, vc, vd) {
      function cross2D(ax, ay, bx, by, cx, cy) {
        return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      }
      var c1 = cross2D(px, py, va.x, va.y, vb.x, vb.y);
      var c2 = cross2D(px, py, vb.x, vb.y, vc.x, vc.y);
      var c3 = cross2D(px, py, vc.x, vc.y, vd.x, vd.y);
      var c4 = cross2D(px, py, vd.x, vd.y, va.x, va.y);
      var hasNeg = (c1 < 0) || (c2 < 0) || (c3 < 0) || (c4 < 0);
      var hasPos = (c1 > 0) || (c2 > 0) || (c3 > 0) || (c4 > 0);
      return !(hasNeg && hasPos);
    }

    // 判断 (x, y) 是否落在岛屿"碰撞盒"（= 显示菱形外扩 HITBOX_PAD）内。
    // 用于 drifter 初始化/重生时排除落在岛屿区域的"坏点"，避免视觉上"刚出生就
    // 卡在红菱形里再被滑行逻辑挤出去"的瑕疵。
    function isInIslandHitbox(x, y) {
      if (!islandHasBox) return false;
      var halfW = ISLAND_R * TILE_W * islandScale;
      var halfH = ISLAND_R * TILE_H * islandScale;
      var halfWLeft   = halfW + ISLAND_EXT_LEFT * islandScale;
      var halfHTop    = halfH;
      var halfHBottom = halfH + ISLAND_EXT_BOTTOM * islandScale;
      var padS = HITBOX_PAD * islandScale;
      var vTopH    = { x: islandOx,                y: islandOy - halfHTop   - padS };
      var vRightH  = { x: islandOx + halfW         + padS, y: islandOy };
      var vBottomH = { x: islandOx,                y: islandOy + halfHBottom + padS };
      var vLeftH   = { x: islandOx - halfWLeft   - padS, y: islandOy };
      return pointInQuad(x, y, vTopH, vRightH, vBottomH, vLeftH);
    }

    // 求一个"安全的出生点"：(baseY, x) 在海洋内且不落在岛屿 hitbox 内。
    // 用于 makeDrifter / respawnDrifter，避免几何体出生在红菱形里再被滑行逻辑挤出的视觉瑕疵。
    function pickSafeSpawn() {
      var baseY, scale, b, x;
      for (var tries = 0; tries < 16; tries++) {
        baseY = randRange(H * 0.32, H * 0.85);
        scale = randRange(DRIFT_SCALE_MIN, DRIFT_SCALE_MAX);
        b = oceanBounds(baseY, 28 * scale);
        if (b.right <= b.left) continue;  // 极窄 screen 兜底
        // 岛屿锚点未就绪（首屏抢跑 / 异常路径）：放过 island 检查
        if (!islandHasBox) {
          x = randRange(b.left, b.right);
          return { baseY: baseY, scale: scale, x: x, b: b };
        }
        // hitbox 的横向 X 区间 + 上下 Y 区间（与 isInIslandHitbox 同源）
        var halfW      = ISLAND_R * TILE_W * islandScale;
        var halfH      = ISLAND_R * TILE_H * islandScale;
        var halfWLeft  = halfW + ISLAND_EXT_LEFT * islandScale;
        var halfHBott  = halfH + ISLAND_EXT_BOTTOM * islandScale;
        var padS       = HITBOX_PAD * islandScale;
        var hboxLeftX  = islandOx - halfWLeft - padS;
        var hboxRightX = islandOx + halfW + padS;
        var hboxTopY   = islandOy - halfH - padS;
        var hboxBotY   = islandOy + halfHBott + padS;
        // 当前 baseY 已经在 hitbox 高度外 → x 任意
        if (baseY < hboxTopY || baseY > hboxBotY) {
          x = randRange(b.left, b.right);
          return { baseY: baseY, scale: scale, x: x, b: b };
        }
        // baseY 在 hitbox 高度内 → 在海洋横向 lane [b.left, b.right] 中挖掉 hitbox 横向投影 [hboxLeftX, hboxRightX]
        var leftSegLen = Math.max(0, Math.min(b.right, hboxLeftX) - b.left);
        var rightSegStart = Math.max(b.left, hboxRightX);
        var rightSegLen = Math.max(0, b.right - rightSegStart);
        var totalLen = leftSegLen + rightSegLen;
        if (totalLen < 6) continue;  // 整条 lane 几乎被占满 → 重抽 baseY
        var r = Math.random() * totalLen;
        if (r < leftSegLen) {
          x = b.left + r;
        } else {
          x = rightSegStart + (r - leftSegLen);
        }
        // 二次校验：菱形判定最终兜底
        if (!isInIslandHitbox(x, baseY)) {
          return { baseY: baseY, scale: scale, x: x, b: b };
        }
      }
      // 极端兜底：16 次都失败时返回一个海洋最左点（不会真的发生，hitbox 远小于海洋）
      return { baseY: baseY, scale: scale, x: b.left, b: b };
    }

    function makeDrifter() {
      var s = pickSafeSpawn();
      return {
        type: TYPES[(Math.random() * TYPES.length) | 0],
        x: s.x,
        baseY: s.baseY,
        tilt: randRange(DRIFT_TILT_MIN, DRIFT_TILT_MAX),
        scale: s.scale,
        vx: randRange(DRIFT_SPEED_MIN, DRIFT_SPEED_MAX),
        vy: 0,               // 垂直速度（仅沿墙滑行时用，平时恒为 0）
        slideState: 'none',  // 'none' | 'sliding'（岛屿沿墙滑行）
        originalVx: 0,       // 进入滑行前的水平速度
        phase: 'drifting',   // drifting | sinking | rising（浸没状态机）
        stateT: 0,
        phaseOffset: Math.random() * Math.PI * 2,  // 随波摇摆相位
        leftBound: s.b.left,
        rightBound: s.b.right,
        // 漂流瓶状态
        bottleState: 'idle',  // idle | hovering | rising | floating | sinking
        bottleT: 0,
        bottleLift: 0,
        bottleText: '',
        leaveTimer: 0,
        hovered: false
      };
    }

    function initDrifters() {
      drifters = [];
      // 动态数量：小屏最少 6 个，大屏最多 14 个，约每 180px 屏幕宽 1 个
      var count = Math.max(6, Math.min(14, Math.round(W / 180)));
      for (var i = 0; i < count; i++) {
        drifters.push(makeDrifter());
      }
    }

    function easeInOut(t) {
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }

    // 漂流瓶：缓动函数
    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
    function easeInCubic(t) { return t * t * t; }

    // 沉没后重生：重新随机属性，从海洋左边界的水下开始上浮
    function respawnDrifter(d) {
      // 先取一个"安全出生点"——和 makeDrifter 共用过滤逻辑，避免重生在岛屿 hitbox 内
      var s = pickSafeSpawn();
      d.baseY = s.baseY;
      d.scale = s.scale;
      d.leftBound = s.b.left;
      d.rightBound = s.b.right;
      d.x = s.b.left;          // 重生强制从海洋左边界开始（破水动画从水下升起来）
      d.tilt = randRange(DRIFT_TILT_MIN, DRIFT_TILT_MAX);
      d.vx = randRange(DRIFT_SPEED_MIN, DRIFT_SPEED_MAX);
      d.type = TYPES[(Math.random() * TYPES.length) | 0];
      d.phaseOffset = Math.random() * Math.PI * 2;
      d.stateT = 0;
      d.phase = 'rising';   // 从海洋左边界水下开始上浮
    }

    // 漂流瓶：从评论池随机抽取一条文本。
    // 气泡只显示摘要（上限 120 字）：评论可能很长，全塞进气泡会竖着糊满大半屏幕。
    var BOTTLE_TEXT_MAX = 120;
    function pickBottleText() {
      var fallback = '💬 还没有评论，来说点什么吧！';
      if (!allComments || allComments.length === 0) return fallback;
      var c = allComments[(Math.random() * allComments.length) | 0];
      var body = (c && c.body) ? c.body.trim() : '';
      if (!body) return fallback;
      if (body.length > BOTTLE_TEXT_MAX) return body.slice(0, BOTTLE_TEXT_MAX) + '…';
      return body;
    }

    function updateDrifters(dt, t) {
      for (var i = 0; i < drifters.length; i++) {
        var d = drifters[i];

        // ---- 漂流瓶状态机 ----
        var isLifted = d.bottleState === 'rising' || d.bottleState === 'floating' || d.bottleState === 'sinking';

        if (d.bottleState === 'idle') {
          if (d.hovered) {
            d.bottleState = 'hovering';
            d.bottleT = 0;
            d.leaveTimer = 0;
          }
        } else if (d.bottleState === 'hovering') {
          if (d.hovered) {
            d.leaveTimer = 0;
            d.bottleT += dt;
            if (d.bottleT >= BOTTLE_HOVER_TIME) {
              d.bottleState = 'rising';
              d.bottleT = 0;
              d.bottleText = pickBottleText();
              // 破水（被提起、离开水面）
              spawnSplash(d.x, d.baseY - sampleWave(d.x, d.baseY, t));
              spawnRipple(d.x, d.baseY - sampleWave(d.x, d.baseY, t));
            }
          } else {
            d.leaveTimer += dt;
            if (d.leaveTimer >= BOTTLE_LEAVE_GRACE) {
              d.bottleState = 'idle';
              d.bottleT = 0;
            }
          }
        } else if (d.bottleState === 'rising') {
          d.bottleT += dt;
          var bp = Math.min(1, d.bottleT / BOTTLE_RISE_TIME);
          d.bottleLift = easeOutCubic(bp);
          if (bp >= 1) {
            d.bottleState = 'floating';
            d.bottleLift = 1;
          }
        } else if (d.bottleState === 'floating') {
          d.bottleLift = 1;
          if (!d.hovered) {
            d.leaveTimer += dt;
            if (d.leaveTimer >= BOTTLE_LEAVE_GRACE) {
              d.bottleState = 'sinking';
              d.bottleT = 0;
            }
          } else {
            d.leaveTimer = 0;
          }
        } else if (d.bottleState === 'sinking') {
          d.bottleT += dt;
          var bp2 = Math.min(1, d.bottleT / BOTTLE_SINK_TIME);
          d.bottleLift = 1 - easeInCubic(bp2);
          if (bp2 >= 1) {
            d.bottleState = 'idle';
            d.bottleLift = 0;
            d.bottleText = '';
            // 破水（放回、落回水中）
            spawnSplash(d.x, d.baseY - sampleWave(d.x, d.baseY, t));
            spawnRipple(d.x, d.baseY - sampleWave(d.x, d.baseY, t));
          }
        }

        // ---- 漂流移动 + 岛屿菱形贴边滑行（被提起时不漂流）----
        if (d.phase === 'drifting' && !isLifted) {
          // 屏幕系非对称 4 顶点菱形碰撞盒（左/下顶点额外外扩）
          var halfW = ISLAND_R * TILE_W * islandScale;              // 230
          var halfH = ISLAND_R * TILE_H * islandScale;              // 130
          var halfWLeft   = halfW + ISLAND_EXT_LEFT * islandScale;   // 260
          var halfWRight  = halfW;                                   // 230
          var halfHTop    = halfH;                                   // 130
          var halfHBottom = halfH + ISLAND_EXT_BOTTOM * islandScale; // 148
          // 显示用 4 顶点（顺时针：上→右→下→左）—— 与调试渲染红菱形完全一致
          var vTop    = { x: islandOx,         y: islandOy - halfHTop };
          var vRight  = { x: islandOx + halfWRight, y: islandOy };
          var vBottom = { x: islandOx,         y: islandOy + halfHBottom };
          var vLeft   = { x: islandOx - halfWLeft,  y: islandOy };

          // 判定用碰撞盒 = 显示菱形 + HITBOX_PAD（更大 polygon），让 drifter 在红菱形外
          // 就触发规避，drifter 视觉上"贴着红菱形外缘"绕行而非"进入红菱形后再绕"
          // HITBOX_PAD 已提到模块顶层（避免和其它位置重复定义）
          var padS = HITBOX_PAD * islandScale;
          var vTopH    = { x: islandOx,                y: islandOy - halfHTop   - padS };
          var vRightH  = { x: islandOx + halfWRight  + padS, y: islandOy };
          var vBottomH = { x: islandOx,                y: islandOy + halfHBottom + padS };
          var vLeftH   = { x: islandOx - halfWLeft   - padS, y: islandOy };

          // 凸多边形包含判定（扩大 polygon）—— drifter 进入"红菱形外 30px"环带就触发
          var insideIsland = islandHasBox && pointInQuad(d.x, d.baseY, vTopH, vRightH, vBottomH, vLeftH);

          if (d.slideState === 'sliding') {
            // ---- 沿"显示红菱形"外缘严格切线滑行 ----
            // 切线 = 速度 v=(spd,0) 在触边外法线 n 上的反射投影
            //   t = v - (v·n/|n|²) n
            //   t_x = spd · ny² / |n|²   （永远 > 0，drifter 不倒车）
            //   t_y = -spd · nx · ny / |n|² （由象限决定上下）
            // 触边判定基于显示红菱形（非扩大 collision box），切线沿"显示红菱形
            // 外缘"走，drifter 视觉上紧贴红菱形外绕行。
            var sdx = d.x - islandOx;
            var sdy = d.baseY - islandOy;
            // 4 条边的外法线（指多边形外）—— 对应 vTop→vRight→vBottom→vLeft 顺时针顶点顺序
            // CW 旋转边矢量 (a,b) → (b,-a) = 外法线
            //   上左边 (vLeft→vTop) 边矢量 (+w_l, -h_t) → 外法线 (-h_t, -w_l)
            //   上右边 (vTop→vRight) 边矢量 (+w_r, +h_t) → 外法线 (+h_t, -w_r)
            //   下右边 (vRight→vBottom) 边矢量 (-w_r, +h_b) → 外法线 (+h_b, +w_r)
            //   下左边 (vBottom→vLeft) 边矢量 (-w_l, -h_b) → 外法线 (-h_b, -w_l)
            // 历史 bug：上左曾写 ny=+w_l（应为 -w_l），导致上左象限切线方向反，drifter 触岛后向南走入红菱形。
            var nx, ny;
            if (sdy < 0) {
              if (sdx < 0) {
                // 上左边：触 vLeft→vTop，外法线 = (-h_t, -w_l)
                nx = -halfHTop;
                ny = -halfWLeft;
              } else {
                // 上右边：触 vTop→vRight，外法线 = (+h_t, -w_r)
                nx = halfHTop;
                ny = -halfWRight;
              }
            } else {
              if (sdx < 0) {
                // 下左边：触 vBottom→vLeft，外法线 = (-h_b, +w_l) → 向左下
                // 历史 bug：曾写 ny=-w_l（方向反），导致 drifter 触下左时向北回到红菱形内
                nx = -halfHBottom;
                ny = halfWLeft;
              } else {
                // 下右边：触 vRight→vBottom，外法线 = (+h_b, +w_r)
                nx = halfHBottom;
                ny = halfWRight;
              }
            }
            var nrm2 = nx * nx + ny * ny;
            var nrm = Math.sqrt(nrm2);
            var spd = Math.abs(d.originalVx);
            // ---- 滑动方向 = 70% 外法线 + 30% 切线（顺时针绕外缘）----
            // 切线方向 = 外法线 CCW 旋转 90° = (-ny, +nx)  → 顺时针沿外缘走（vLeft→vTop→vRight→vBottom→vLeft 顺序）
            // 外法线方向 = (nx, ny) / |n|
            // 强外推（70% 外法线）保证 drifter 在 ~1s 内脱离扩大 polygon，不再卡在内部绕。
            // 切线分量让视觉上"绕岛而过"而不是直接弹开。
            var NORM_RATIO = 0.7;
            var TANG_RATIO = 0.3;
            var nxn = nx / nrm;
            var nyn = ny / nrm;
            var tnx = -ny / nrm;     // 切线 x 分量（CCW 90° 旋转外法线）
            var tny =  nx / nrm;     // 切线 y 分量
            var tx = spd * (TANG_RATIO * tnx + NORM_RATIO * nxn);
            var ty = spd * (TANG_RATIO * tny + NORM_RATIO * nyn);
            d.x += tx * dt;
            d.baseY += ty * dt;
            // 退出条件：脱离碰撞盒（扩大 polygon），切回 'none' 恢复水平右漂
            // 用"扩大 polygon"做退出判定 → drifter 一旦离开"红菱形外 30px"即恢复
            var eInside = islandHasBox && pointInQuad(d.x, d.baseY, vTopH, vRightH, vBottomH, vLeftH);
            if (!islandHasBox || !eInside) {
              d.vy = 0;
              d.slideState = 'none';
              // vx 保持 originalVx（基准速度），恢复水平右漂，baseY 不回弹
            }
          } else {
            // ---- 常态：纯水平向右漂移 ----
            if (islandHasBox && insideIsland) {
              // 真正进入"红菱形外 30px"环带：切换为外缘切线滑行，drifter 沿红菱形外缘绕
              d.slideState = 'sliding';
              d.originalVx = d.vx;   // 基准速度
              d.vy = 0;
              // 本帧不推进，交给下一帧滑行分支处理（避免半帧穿透）
            } else {
              d.x = d.x + d.vx * dt;
            }
          }

          // 到达海洋右边界、或已漂出海面菱形外时立即沉入（兜底覆盖滑行改 baseY 等异常路径）
          // 历史 bug：曾用缓存的 d.rightBound 做判定，但 drifter 在 sliding 状态会改 baseY，
          // 脱离 hitbox 后 baseY 不回弹，导致 d.rightBound 与真实海面边界脱节，
          // 视觉上"漂出网格外一段路"才触发沉没。改为实时 oceanBounds(d.baseY, ...) 求解。
          var liveHalfW = 28 * d.scale;
          var liveB = oceanBounds(d.baseY, liveHalfW);
          if (d.x > liveB.right || d.x < liveB.left || !inOceanRect(d.x, d.baseY)) {
            d.phase = 'sinking';
            d.stateT = 0;
            // 破水（没入）：在水面处喷水花 + 涟漪
            spawnSplash(d.x, d.baseY - sampleWave(d.x, d.baseY, t));
            spawnRipple(d.x, d.baseY - sampleWave(d.x, d.baseY, t));
          } else {
            // 碰撞检测：与其他几何体距离小于阈值时沿连线方向推开
            for (var j = i + 1; j < drifters.length; j++) {
              var d2 = drifters[j];
              if (d2.phase === 'sinking') continue;
              var ddx = d2.x - d.x;
              var ddy = d2.baseY - d.baseY;
              var dist2 = ddx * ddx + ddy * ddy;
              if (dist2 < DRIFT_MIN_DISTANCE * DRIFT_MIN_DISTANCE && dist2 > 0.01) {
                var dist = Math.sqrt(dist2);
                var push = DRIFT_MIN_DISTANCE - dist;
                var nx = ddx / dist;
                var ny = ddy / dist;
                // 被提起的几何体不被移动
                var d2Lifted = d2.bottleState === 'rising' || d2.bottleState === 'floating';
                if (d2.phase === 'drifting' && !d2Lifted) {
                  // 双方各沿连线方向移一半（x 与 baseY 同时修正）
                  d.x -= nx * push * 0.5;
                  d.baseY -= ny * push * 0.5;
                  d2.x += nx * push * 0.5;
                  d2.baseY += ny * push * 0.5;
                } else {
                  // 对方不可移动：己方全距移开
                  d.x -= nx * push;
                  d.baseY -= ny * push;
                }
                // baseY 改变后实时重算海面左右边界并夹紧 x，防止推出海洋菱形
                var pushB = oceanBounds(d.baseY, liveHalfW);
                if (d.x < pushB.left) d.x = pushB.left;
                if (d.x > pushB.right) d.x = pushB.right;
              }
            }
          }
        } else if (d.phase === 'sinking') {
          d.stateT += dt / SINK_DURATION;
          d.x += d.vx * dt * 0.25;  // 下沉时继续极缓慢右移
          if (d.stateT >= 1) {
            respawnDrifter(d);
          }
        } else if (d.phase === 'rising') {
          d.stateT += dt / SINK_DURATION;
          d.x += d.vx * dt * 0.5;   // 上浮时开始缓慢右移
          if (d.stateT >= 1) {
            d.stateT = 1;
            d.phase = 'drifting';
            // 破水（露出）：在水面处喷水花 + 涟漪
            spawnSplash(d.x, d.baseY - sampleWave(d.x, d.baseY, t));
            spawnRipple(d.x, d.baseY - sampleWave(d.x, d.baseY, t));
          }
        }
      }
    }

    // 水面线计算：预计算边索引（固定不变），纯函数提到外部避免每帧创建闭包
    var CUBE_EDGES = [
      [0,1],[1,2],[2,3],[3,0],
      [4,5],[5,6],[6,7],[7,4],
      [0,4],[1,5],[2,6],[3,7]
    ];
    var PYRAMID_EDGES = [
      [0,1],[1,2],[2,3],[3,0],
      [4,0],[4,1],[4,2],[4,3]
    ];
    // 边与 y + x*tanT=0 平面求交，返回 [hx, hy] 或 null
    function edgeHitRaw(x1, y1, x2, y2, tanT) {
      var f1 = y1 + x1 * tanT;
      var f2 = y2 + x2 * tanT;
      if (f1 * f2 > 0) return null;
      var d = f1 - f2;
      if (Math.abs(d) < 1e-9) return null;
      var tt = f1 / d;
      return [x1 + tt * (x2 - x1), y1 + tt * (y2 - y1)];
    }

    function drawDrifter(d, t) {
      var waveH = sampleWave(d.x, d.baseY, t);
      var waterY = d.baseY - waveH;

      var sway = Math.sin(t * WAVE_SWAY_FREQ + d.phaseOffset) * WAVE_SWAY_AMP;
      var effectiveTilt = d.tilt + sway;

      var sinkY = 0, alphaMul = 1;
      if (d.phase === 'sinking') {
        var e = easeInOut(d.stateT);
        sinkY = e * 55;
        alphaMul = 1 - e * 0.75;
      } else if (d.phase === 'rising') {
        var e2 = easeInOut(1 - d.stateT);
        sinkY = e2 * 55;
        alphaMul = 0.25 + (1 - e2) * 0.75;
      }

      var centerY = waterY + sinkY;
      // 漂流瓶提起偏移
      var liftOffset = d.bottleLift * BOTTLE_LIFT_HEIGHT;
      centerY -= liftOffset;
      var isBottleLifted = d.bottleState === 'rising' || d.bottleState === 'floating' || d.bottleState === 'sinking';
      var isBottleHover = d.bottleState === 'hovering';
      var A = 28 * d.scale;
      var side = A * 1.118;
      var rx = d.x;

      // 立方体倾斜后顶面一侧会进水，需上移几何体让顶面完整露出
      var floatOffset = 0;
      if (d.type === 'cube') {
        floatOffset = Math.max(0, A * Math.tan(effectiveTilt) - side / 2 + 0.06 * A);
      }

      // drawShape 的 py（顶面/底面基准点）
      var topPy;
      if (d.type === 'pyramid') {
        topPy = centerY + side / 2;
      } else {
        topPy = centerY - side / 2 - floatOffset;
      }

      // --- 绘制几何体 ---
      ctx.save();
      if (isBottleLifted) {
        // 被提起：完整绘制（补全水下部分），不裁剪，不画水面线
        ctx.translate(rx, centerY);
        ctx.rotate(effectiveTilt);
        ctx.translate(-rx, -centerY);
        if (d.bottleLift > 0.05) {
          var sc = themeDisplay.solid;
          var glowA = 0.35 * d.bottleLift + themeDisplay.glow * 0.4;
          ctx.shadowColor = 'rgba(' + (sc[0]|0) + ',' + (sc[1]|0) + ',' + (sc[2]|0) + ',' + glowA + ')';
          ctx.shadowBlur = 14 * d.bottleLift;
        }
        drawShape(d, rx, topPy, d.scale, alphaMul, 'default');
      } else {
        // 正常 / 悬停高光：仅绘制水上部分
        if (isBottleHover) {
          var sc2 = themeDisplay.solid;
          ctx.shadowColor = 'rgba(' + (sc2[0]|0) + ',' + (sc2[1]|0) + ',' + (sc2[2]|0) + ',' + (0.35 + themeDisplay.glow * 0.4) + ')';
          ctx.shadowBlur = 10;
        }
        ctx.beginPath();
        ctx.rect(-20, -20, W + 40, waterY + 20);
        ctx.clip();
        ctx.translate(rx, centerY);
        ctx.rotate(effectiveTilt);
        ctx.translate(-rx, -centerY);
        drawShape(d, rx, topPy, d.scale, 0.8 * alphaMul, 'default');
      }
      ctx.restore();

      // --- 水面线：几何体轮廓与水面交点之间的水平线段（被提起时不画）---
      if (!isBottleLifted && alphaMul > 0.15) {
        var cosT = Math.cos(effectiveTilt);
        var sinT = Math.sin(effectiveTilt);
        var tanT = Math.tan(effectiveTilt);

        var waterXs = [];

        if (d.type === 'cylinder') {
          // 右母线与水面交点
          waterXs.push(rx + A / Math.max(0.01, cosT));
          // 底椭圆前半弧与水面交点
          waterXs.push(rx - A / Math.sqrt(1 + 3 * sinT * sinT));
        } else {
          // 立方体 / 四棱锥：枚举边与水面的交点（顶点直接数值计算，不创建对象数组）
          var Hh = A * 0.5;
          var fo = floatOffset;
          var topY = -side / 2 - fo;
          var botY = side / 2 - fo;
          var verts;
          var edges;
          if (d.type === 'cube') {
            // 8 顶点：前4上、后4下，x,y 为局部坐标
            verts = [
              [0, topY - Hh], [A, topY],
              [0, topY + Hh], [-A, topY],
              [0, botY - Hh], [A, botY],
              [0, botY + Hh], [-A, botY]
            ];
            edges = CUBE_EDGES;
          } else {
            var bHW = A * 0.5, bHH = A * 0.25;
            verts = [
              [0, side/2 - bHH], [bHW, side/2],
              [0, side/2 + bHH], [-bHW, side/2],
              [0, -side/2]
            ];
            edges = PYRAMID_EDGES;
          }
          for (var ei = 0; ei < edges.length; ei++) {
            var e0 = edges[ei][0], e1 = edges[ei][1];
            var v0 = verts[e0], v1 = verts[e1];
            var hit = edgeHitRaw(v0[0], v0[1], v1[0], v1[1], tanT);
            if (hit) waterXs.push(rx + hit[0] * cosT - hit[1] * sinT);
          }
        }

        if (waterXs.length >= 2) {
          var minX = Math.min.apply(null, waterXs);
          var maxX = Math.max.apply(null, waterXs);
          ctx.save();
          ctx.globalAlpha = 0.85 * alphaMul;
          var wc = themeDisplay.water;
          ctx.strokeStyle = 'rgba(' + (wc[0]|0) + ',' + (wc[1]|0) + ',' + (wc[2]|0) + ',0.92)';
          ctx.lineWidth = 2.0;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(minX - 2, centerY);
          ctx.lineTo(maxX + 2, centerY);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    var RISE = 0.6, SINK_T = 1.0;
    var last = performance.now();

    function frame(now) {
      requestAnimationFrame(frame);
      var active = home.classList.contains('active');
      canvas.style.display = active ? '' : 'none';
      if (!active) { last = now; bottleBubble.style.display = 'none'; return; }
      // 标签页切到后台：跳过绘制省电，重置时间基准避免回来时 dt 跳变
      if (document.hidden) { last = now; return; }

      var rawDt = Math.min((now - last) / 1000, 0.05);
      last = now;
      var t = now / 1000;
      // reduced-motion：运动积分冻结（dt=0，drifter/波浪静止），但颜色直接到位
      var dt = REDUCED_MOTION ? 0 : rawDt;

      if (W !== window.innerWidth || H !== window.innerHeight) resize();

      // ---- 主题颜色插值（1s 过渡）----
      var tc = getTargetColors();
      var lerpF = REDUCED_MOTION ? 1 : (1 - Math.pow(0.001, rawDt));  // ~1s 平滑过渡，与 DOM 主题过渡时长一致
      function lerpArr(a, b) {
        for (var k = 0; k < a.length; k++) a[k] += (b[k] - a[k]) * lerpF;
      }
      lerpArr(themeDisplay.bg0, tc.bg[0]);
      lerpArr(themeDisplay.bg1, tc.bg[1]);
      lerpArr(themeDisplay.bg2, tc.bg[2]);
      lerpArr(themeDisplay.tileLow, tc.tileLow);
      lerpArr(themeDisplay.tileHigh, tc.tileHigh);
      lerpArr(themeDisplay.solid, tc.solid);
      lerpArr(themeDisplay.dash, tc.dash);
      lerpArr(themeDisplay.water, tc.water);
      lerpArr(themeDisplay.grid, tc.grid);
      var targetGlow = themeMode === 'night' ? 1 : 0;
      themeDisplay.glow += (targetGlow - themeDisplay.glow) * lerpF;

      function rgbStr(c, a) {
        return 'rgba(' + (c[0]|0) + ',' + (c[1]|0) + ',' + (c[2]|0) + ',' + a + ')';
      }

      // 背景渐变
      var bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, rgbStr(themeDisplay.bg0, 1));
      bg.addColorStop(0.55, rgbStr(themeDisplay.bg1, 1));
      bg.addColorStop(1, rgbStr(themeDisplay.bg2, 1));
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      // 夜间星星
      if (themeDisplay.glow > 0.02) {
        for (var si = 0; si < stars.length; si++) {
          var st = stars[si];
          var tw = 0.35 + 0.65 * Math.sin(t * st.speed + st.phase);
          ctx.globalAlpha = tw * themeDisplay.glow * 0.85;
          ctx.fillStyle = '#d8e4f8';
          ctx.beginPath();
          ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      var cx = W / 2 - ((cols - rows) / 2) * TILE_W;
      var cy = 0;

      // 填充格点（复用预分配对象，仅更新属性）
      for (var i = 0; i <= rows; i++) {
        for (var j = 0; j <= cols; j++) {
          var p = iso(i, j);
          var h = wave(i, j, t);
          var pt = pts[i][j];
          pt.x = cx + p.x;
          pt.y = cy + p.y - h;
          pt.h = h;
        }
      }

      for (var i2 = 0; i2 < rows; i2++) {
        for (var j2 = 0; j2 < cols; j2++) {
          var nw = pts[i2][j2], ne = pts[i2][j2 + 1], se = pts[i2 + 1][j2 + 1], sw = pts[i2 + 1][j2];
          var avg = (nw.h + ne.h + se.h + sw.h) / 4;
          var norm = Math.max(0, Math.min(1, (avg + 13) / 26));
          var tl = themeDisplay.tileLow, th = themeDisplay.tileHigh;
          var r = tl[0] + (th[0] - tl[0]) * norm;
          var g = tl[1] + (th[1] - tl[1]) * norm;
          var b = tl[2] + (th[2] - tl[2]) * norm;
          ctx.fillStyle = 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + (0.28 + norm * 0.22).toFixed(2) + ')';
          ctx.beginPath();
          ctx.moveTo(nw.x, nw.y); ctx.lineTo(ne.x, ne.y);
          ctx.lineTo(se.x, se.y); ctx.lineTo(sw.x, sw.y);
          ctx.closePath(); ctx.fill();
          var gc = themeDisplay.grid;
          ctx.strokeStyle = 'rgba(' + (gc[0]|0) + ',' + (gc[1]|0) + ',' + (gc[2]|0) + ',0.07)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // ---- 夜间流星（低频点缀：入夜后每 20~40s 一颗，向右下划向海面方向）----
      if (themeDisplay.glow > 0.9 && !REDUCED_MOTION) {
        if (!meteor && t > nextMeteorAt) {
          var mAng = 0.35 + Math.random() * 0.5;   // 俯角约 20°~49°
          meteor = {
            x: W * (0.1 + Math.random() * 0.55),
            y: H * (0.04 + Math.random() * 0.18),
            dx: Math.cos(mAng), dy: Math.sin(mAng),
            spd: 320 + Math.random() * 200,        // px/s
            len: 90 + Math.random() * 60,          // 尾迹长度
            t: 0,
            life: 0.9 + Math.random() * 0.4
          };
        }
        if (meteor) {
          meteor.t += dt;
          meteor.x += meteor.dx * meteor.spd * dt;
          meteor.y += meteor.dy * meteor.spd * dt;
          var mp = meteor.t / meteor.life;
          if (mp >= 1 || meteor.x - meteor.len > W || meteor.y - meteor.len > H) {
            meteor = null;
            nextMeteorAt = t + 20 + Math.random() * 20;
          } else if (dt > 0) {
            // 首尾各 20% 寿命渐隐；宽淡尾 + 白亮芯 + 头部光点三层
            var ma = Math.min(1, Math.min(mp, 1 - mp) / 0.2) * 0.85;
            var tx = meteor.x - meteor.dx * meteor.len;
            var ty = meteor.y - meteor.dy * meteor.len;
            ctx.save();
            ctx.lineCap = 'round';
            var mg = ctx.createLinearGradient(meteor.x, meteor.y, tx, ty);
            mg.addColorStop(0, 'rgba(216,228,248,' + ma.toFixed(3) + ')');
            mg.addColorStop(1, 'rgba(216,228,248,0)');
            ctx.strokeStyle = mg;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(meteor.x, meteor.y);
            ctx.lineTo(tx, ty);
            ctx.stroke();
            ctx.globalAlpha = ma;
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(meteor.x, meteor.y);
            ctx.lineTo(tx, ty);
            ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.95)';
            ctx.beginPath();
            ctx.arc(meteor.x, meteor.y, 1.6, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }
      } else {
        // 白天 / 昼夜过渡期：清掉残留并持续顺延计时（入夜稳定后 8~20s 出现第一颗）
        meteor = null;
        nextMeteorAt = t + 8 + Math.random() * 12;
      }

      // ---- 漂流几何体 ----
      updateDrifters(dt, t);
      for (var di = 0; di < drifters.length; di++) {
        drawDrifter(drifters[di], t);
      }
      updateBottleBubble(t);

      // ---- 【调试】岛屿碰撞盒可视化（默认隐藏；浏览器控制台 `window.__debugHitbox = true` 临时打开）----
      if (window.__debugHitbox && islandHasBox) {
        // 屏幕真 4 顶点菱形（上/右/下/左）—— 必须是 4 顶点 polygon，不是曼哈顿菱形
        // 非对称：左/下顶点额外外扩以贴岛屿左下
        var halfW = ISLAND_R * TILE_W * islandScale;
        var halfH = ISLAND_R * TILE_H * islandScale;
        var halfWLeft   = halfW + ISLAND_EXT_LEFT * islandScale;    // 260
        var halfHBottom = halfH + ISLAND_EXT_BOTTOM * islandScale;  // 148
        var vTop    = { x: islandOx,            y: islandOy - halfH };
        var vRight  = { x: islandOx + halfW,    y: islandOy };
        var vBottom = { x: islandOx,            y: islandOy + halfHBottom };
        var vLeft   = { x: islandOx - halfWLeft, y: islandOy };
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(vTop.x, vTop.y);
        ctx.lineTo(vRight.x, vRight.y);
        ctx.lineTo(vBottom.x, vBottom.y);
        ctx.lineTo(vLeft.x, vLeft.y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 0, 0, 0.18)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 60, 60, 0.95)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
        // 锚点：黄色十字
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 220, 0, 0.95)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(islandOx - 8, islandOy); ctx.lineTo(islandOx + 8, islandOy);
        ctx.moveTo(islandOx, islandOy - 8); ctx.lineTo(islandOx, islandOy + 8);
        ctx.stroke();
        ctx.restore();
      }

      // ---- 破水特效：水花 + 涟漪 ----
      updateEffects(dt);
      drawEffects();

      if (shape) {
        if (shape.phase === 'rising') {
          shape.t += dt / RISE;
          if (shape.t >= 1) { shape.t = 1; shape.phase = 'floating'; }
        } else if (shape.phase === 'sinking') {
          shape.t += dt / SINK_T;
          if (shape.t >= 1) { shape = null; }
        }
        if (shape) {
          var prog;
          if (shape.phase === 'rising') prog = shape.t;
          else if (shape.phase === 'sinking') prog = 1 - shape.t;
          else prog = 1;
          var ease = prog < 0.5 ? 2 * prog * prog : 1 - Math.pow(-2 * prog + 2, 2) / 2;
          var scale = 0.55 + ease * 0.45;
          var alpha = 0.2 + ease * 0.65;
          var bob = shape.phase === 'floating' ? Math.sin(now / 650) * 3 : 0;
          var yOff = (1 - ease) * 44;
          drawShape(shape, shape.x, shape.y + yOff - bob, scale, alpha);
        }
      }
    }

    resize();
    initDrifters();

    // 漂流瓶内容气泡
    var bottleBubble = document.createElement('div');
    bottleBubble.id = 'bottleBubble';
    bottleBubble.style.display = 'none';
    document.body.appendChild(bottleBubble);

    function updateBottleBubble(t) {
      var activeD = null;
      for (var i = 0; i < drifters.length; i++) {
        if (drifters[i].bottleState === 'floating') { activeD = drifters[i]; break; }
      }
      if (!activeD) {
        if (bottleBubble.style.display !== 'none') bottleBubble.style.display = 'none';
        return;
      }
      var waveH = sampleWave(activeD.x, activeD.baseY, t);
      var topY = activeD.baseY - waveH - activeD.bottleLift * BOTTLE_LIFT_HEIGHT;
      var A = 28 * activeD.scale;
      var side = A * 1.118;
      // 气泡底部对准几何体顶部上方 10px
      var bubbleBottomY = topY - side / 2 - 10;

      bottleBubble.textContent = activeD.bottleText;
      bottleBubble.style.display = 'block';
      var bw = bottleBubble.offsetWidth || 200;
      var bh = bottleBubble.offsetHeight || 40;
      var bx = activeD.x;
      if (bx - bw / 2 < 8) bx = bw / 2 + 8;
      if (bx + bw / 2 > W - 8) bx = W - bw / 2 - 8;
      // 默认气泡在几何体上方；顶部空间不够时放下方
      var by;
      if (bubbleBottomY - bh < 8) {
        by = topY + side / 2 + 10 + bh;  // 放下方时 top = 几何体底部 + 间距 + 气泡高度
        bottleBubble.style.transform = 'translate(-50%, 0)';
      } else {
        by = bubbleBottomY;
        bottleBubble.style.transform = 'translate(-50%, -100%)';
      }
      bottleBubble.style.left = bx + 'px';
      bottleBubble.style.top = by + 'px';
    }

    window.addEventListener('resize', resize);
    resize();   // 首次执行：缓存 islands SVG 锚点 (DOM 时机安全)
    requestAnimationFrame(frame);
  })();

  // ==================== 鼠标轨迹粒子系统（MouseTrail） ====================
  // 独立模块：自带 overlay canvas + 独立 requestAnimationFrame，
  // 不读不写主 canvas，不介入 drifter / 岛屿 / 碰撞 / 海浪 / 水花 / 涟漪任何逻辑；
  // 仅每帧读取顶层 themeMode / themeSeason 做主题联动（不改动主题系统本身）。
  (function initMouseTrail() {
    var MAX_PARTICLES = 60;   // 粒子池上限
    var IDLE_MS = 100;        // 鼠标静止判定：超过该时间无 mousemove 则停止生成
    var TRAIL_MAX = 7;        // 夜间星尘拖尾最大采样点数。四季不用拖尾；夜的寿命/速度只取中值，
                              // 尾巴本就不长，7 点足够且省 30% 绘制量（上一版是 10 点）

    function rand(a, b) { return a + Math.random() * (b - a); }

    // 五主题配置。
    //   rate = 生成速率「个/秒」（时间累加器消费，帧率无关）
    //   life = 生命周期「帧」（内部 /60 转秒存储，保证 60Hz / 120Hz 观感一致）
    //   gravity = 下落加速度 px/s²，drag = 每 1/60 秒的速度阻尼系数
    //   sway = 左右摇摆幅度 px/s，brown = 布朗运动扰动强度 px/s²
    // 2026-09-02 密度增强：五个主题统一「行程减半 + 数量 2.5 倍」。
    //   行程靠「降初速 ~45% + 阻尼 .98x → .95x」压缩，摇摆/布朗同比下调，
    //   否则它们会把粒子重新推开；寿命只缩 10~15%（缩太狠淡入淡出会吃掉大半生命）。
    //   稳态存活 = rate 中值 × life 中值 ≈ 21~29 个，远低于 MAX_PARTICLES=60。
    var TRAIL_CONFIG = {
      // 春 · 桃花瓣：贝塞尔水滴形花瓣（顶部中央凹口、基部泛白渐变），1/8 概率生成五瓣小桃花
      spring: {
        rate: [20, 28], life: [45, 62], size: [2.4, 4.4],
        color: '#f8c8d8',
        vx: [-16, 16], vy: [-14, 7], gravity: 14, drag: 0.955,
        rotSpeed: [-3.4, 3.4], sway: 6, swayFreq: [1.2, 2.2],
        brown: 0, trail: false, twinkle: 0
      },
      // 夏 · 蒲公英种子：顶部放射冠毛 + 细梗 + 纺锤形种子，冠毛朝上随风微倾。
      // 2026-09-12 行为重做：不再原地布朗晃动，改为「乘风飞远再消散」——
      //   wind 是不衰减的持续风移（生成时随机方向/强度），life 加长让它飞得够远；
      //   rate 相应下调，稳态存活数仍控制在 ~30 个（上限 60 的一半）。
      summer: {
        rate: [12, 18], life: [100, 140], size: [2.6, 4.2],
        color: '#ffffff', color2: '#f0f4f8',
        speed: [5, 13], gravity: 3, drag: 0.985,
        wind: [35, 85],
        rotSpeed: [-1.6, 1.6], sway: 0, swayFreq: [1, 1],
        brown: 60, trail: false, twinkle: 0
      },
      // 秋 · 银杏叶：金黄扇形叶面（放射脉络 + 顶部浅裂 + 细叶柄），下落时翻飞摇摆
      autumn: {
        rate: [20, 28], life: [54, 70], size: [3.0, 5.0],
        color: '#e8b83a',
        vx: [-11, 11], vy: [5, 17], gravity: 21, drag: 0.960,
        rotSpeed: [-2.6, 2.6], sway: 40, swayFreq: [2.2, 3.6],
        brown: 0, trail: false, twinkle: 0
      },
      // 冬 · 雪花：六臂枝晶（每片的分叉位置/数量随机生成并缓存），缓慢下落 + 微弱旋转
      winter: {
        rate: [18, 26], life: [70, 88], size: [2.2, 4.0],
        color: '#dbe8fa',
        vx: [-7, 7], vy: [3, 9], gravity: 8, drag: 0.968,
        rotSpeed: [-1.2, 1.2], sway: 5, swayFreq: [0.8, 1.6],
        brown: 0, trail: false, twinkle: 0
      },
      // 夜 · 星尘：暖白~淡蓝光点 + 四芒星光针 + 渐变拖尾，四周缓慢飘散、消散慢、带闪烁
      // 2026-09-02 二次调整：夜不参与四季那套「行程减半 + 数量 2.5 倍」。
      //   理由：夜的诉求不是显眼而是宁静，密度增强后 27 个大光点挤在 3.5px 内糊成亮斑，
      //   把星尘感做没了。此处只回退「大小 + 数量」，运动参数取上一版与增强版的中值，
      //   保留一点贴身感（speed [3,10] / drag 0.985 / brown 30），避免散得太开。
      //   稳态存活 ≈ 7 × 1.4s ≈ 10 个。
      night: {
        rate: [6, 8], life: [72, 96], size: [1.6, 3.0],
        color: '#fffbe6',
        speed: [3, 10], gravity: 0, drag: 0.985,
        rotSpeed: [0, 0], sway: 0, swayFreq: [1, 1],
        brown: 30, trail: true, twinkle: 0.55
      }
    };

    // ---- overlay canvas ----
    var overlay = document.createElement('canvas');
    overlay.className = 'mouse-trail-canvas';
    overlay.setAttribute('aria-hidden', 'true');
    // 插到 body 最前面：与 #bottleBubble 同为 z-index:50，同层按 DOM 顺序后者在上，
    // 保证漂流瓶文字气泡始终压在粒子之上。
    document.body.insertBefore(overlay, document.body.firstChild);
    var octx = overlay.getContext('2d');
    var OW = 0, OH = 0, ODPR = 1;

    function resizeOverlay() {
      ODPR = Math.min(window.devicePixelRatio || 1, 2);
      OW = window.innerWidth;
      OH = window.innerHeight;
      overlay.width = Math.round(OW * ODPR);
      overlay.height = Math.round(OH * ODPR);
      overlay.style.width = OW + 'px';
      overlay.style.height = OH + 'px';
      octx.setTransform(ODPR, 0, 0, ODPR, 0, 0);   // 之后一律用 CSS 像素坐标绘制
    }
    resizeOverlay();
    window.addEventListener('resize', resizeOverlay);

    // ---- 状态 ----
    var particles = [];
    var curType = null;      // 上一帧的主题，变化即清空粒子池
    var curRate = 10;        // 当前生成速率（每次生成后按配置区间重新采样）
    var emitAcc = 0;         // 「个/秒」时间累加器
    var wasEmpty = false;    // 上一帧是否无粒子（用于跳过无意义的 clearRect）
    var mouse = { x: 0, y: 0, moving: false, has: false, lastMove: 0 };
    var trailEnabled = true;  // 彩蛋模式时设为 false，停止生成季节拖尾粒子

    window.addEventListener('mousemove', function (e) {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.moving = true;
      mouse.has = true;
      mouse.lastMove = performance.now();
    }, { passive: true });
    // 鼠标移出文档 → 停止生成
    document.addEventListener('mouseleave', function () { mouse.moving = false; });

    function sampleRate(cfg) { return rand(cfg.rate[0], cfg.rate[1]); }

    function evictIfFull() {
      if (particles.length < MAX_PARTICLES) return;
      var worst = 0, worstLife = Infinity;
      for (var i = 0; i < particles.length; i++) {
        if (particles[i].life < worstLife) { worstLife = particles[i].life; worst = i; }
      }
      particles.splice(worst, 1);   // 超上限时优先移除生命值最低的
    }

    function spawnParticle(cfg, type, x, y) {
      var p = {
        type: type,
        x: x, y: y,
        vx: 0, vy: 0,
        size: rand(cfg.size[0], cfg.size[1]),
        rotation: Math.random() * Math.PI * 2,
        rotSpeed: rand(cfg.rotSpeed[0], cfg.rotSpeed[1]),
        swayPhase: Math.random() * Math.PI * 2,
        swayFreq: rand(cfg.swayFreq[0], cfg.swayFreq[1]),
        twinklePhase: Math.random() * Math.PI * 2,
        trail: cfg.trail ? [{ x: x, y: y }] : null,
        maxLife: rand(cfg.life[0], cfg.life[1]) / 60,   // 帧 → 秒
        life: 0,
        alpha: 0
      };
      p.life = p.maxLife;
      if (cfg.speed) {
        // 全向散开（蒲公英 / 星尘）
        var ang = Math.random() * Math.PI * 2;
        var sp = rand(cfg.speed[0], cfg.speed[1]);
        p.vx = Math.cos(ang) * sp;
        p.vy = Math.sin(ang) * sp;
      } else {
        // 定向飘散（花瓣 / 落叶 / 冰晶）
        p.vx = rand(cfg.vx[0], cfg.vx[1]);
        p.vy = rand(cfg.vy[0], cfg.vy[1]);
      }
      // ---- 形态参数：按类型在生成时随机定死并缓存（绘制层用，不引入每帧随机）----
      if (type === 'spring') {
        p.floret = Math.random() < 0.125;          // 1/8 概率生成五瓣小桃花
      } else if (type === 'summer') {
        p.bristles = [];                            // 冠毛：8~12 条，角度在朝上扇面内、长短随机
        var nB = 8 + (Math.random() * 5 | 0);
        for (var ib = 0; ib < nB; ib++) {
          p.bristles.push({
            a: -Math.PI / 2 + (Math.random() - 0.5) * 2.4,
            len: 0.75 + Math.random() * 0.5
          });
        }
        // 乘风飞远：持续风移（左右随机方向、略带向上的升风），不参与阻尼衰减
        p.windX = (Math.random() < 0.5 ? -1 : 1) * rand(cfg.wind[0], cfg.wind[1]);
        p.windY = rand(-24, 6);
      } else if (type === 'autumn') {
        p.baseRot = p.rotation;                     // 翻飞的基准角
        p.veins = [];                               // 叶脉：3~5 条，均布在扇面内、避开顶部裂口
        var nV = 3 + (Math.random() * 3 | 0);
        for (var iv = 0; iv < nV; iv++) {
          p.veins.push(-Math.PI / 2 + (nV > 1 ? (iv / (nV - 1) - 0.5) * 2.2 : 0));
        }
      } else if (type === 'winter') {
        p.arms = [];                                // 雪枝：每臂 2~3 对分叉，位置/长度随机
        var nA = 2 + (Math.random() * 2 | 0);
        for (var ia = 0; ia < nA; ia++) {
          p.arms.push({
            at: 0.38 + ia * 0.22 + Math.random() * 0.08,
            len: 0.28 + Math.random() * 0.18
          });
        }
      } else if (type === 'night') {
        p.colorT = Math.random();                   // 色温：0 暖白 → 1 淡蓝
        p.spike = 0.8 + Math.random() * 0.5;        // 四芒星长度系数（星等感）
      }
      return p;
    }

    function updateParticles(dt) {
      // 彩蛋模式：停止生成并清空已有粒子
      if (!trailEnabled) {
        if (particles.length) { particles.length = 0; octx.clearRect(0, 0, OW, OH); wasEmpty = true; }
        return;
      }
      // ---- 主题联动：夜间优先（夜间模式下季节按钮 disabled）。
      // 软过渡（2026-09-12）：切主题不再清空粒子池——老粒子带着出生时的形态参数
      // 自然飘完消散，新粒子直接用新主题形态，切换时不再"唰地全部消失"。
      var type = (themeMode === 'night') ? 'night' : themeSeason;
      if (type !== curType) {
        curType = type;
        curRate = sampleRate(TRAIL_CONFIG[type]);
        emitAcc = 0;
      }
      var cfg = TRAIL_CONFIG[type];

      // 鼠标静止则不再生成
      if (mouse.moving && performance.now() - mouse.lastMove > IDLE_MS) mouse.moving = false;

      // reduced-motion：不生成拖尾粒子（已有粒子会自然消亡并清空）
      if (REDUCED_MOTION) { emitAcc = 0; }
      else if (mouse.moving && mouse.has) {
        emitAcc += curRate * dt;
        while (emitAcc >= 1) {   // 按「个/秒」累加，帧率无关
          emitAcc -= 1;
          evictIfFull();
          particles.push(spawnParticle(cfg, type, mouse.x, mouse.y));
          curRate = sampleRate(cfg);
        }
      } else {
        emitAcc = 0;
      }

      for (var i = particles.length - 1; i >= 0; i--) {
        var p = particles[i];
        // 每个粒子用自己的形态参数（主题软过渡期新旧形态短暂共存）
        var pc = TRAIL_CONFIG[p.type] || cfg;
        var dragF = Math.pow(pc.drag, dt * 60);   // 阻尼帧率无关化
        p.life -= dt;
        if (p.life <= 0) { particles.splice(i, 1); continue; }

        p.vy += pc.gravity * dt;
        if (pc.brown) {   // 布朗运动：随机扰动，营造絮状飘荡
          p.vx += (Math.random() * 2 - 1) * pc.brown * dt;
          p.vy += (Math.random() * 2 - 1) * pc.brown * dt * 0.6;
        }
        p.vx *= dragF;
        p.vy *= dragF;
        // 蒲公英的持续风移：独立于速度/阻尼体系，保证种子一直飞而不衰减到原地晃
        if (p.windX) { p.x += p.windX * dt; p.y += (p.windY || 0) * dt; }

        p.swayPhase += p.swayFreq * dt;
        p.x += (p.vx + Math.sin(p.swayPhase) * pc.sway) * dt;
        p.y += p.vy * dt;
        if (p.baseRot !== undefined) {
          // 秋叶翻飞：旋转角随摇摆相位来回摆动（周期性换向），而不是匀速自转——
          // 这是落叶区别于雪花的标志性动态
          p.rotation = p.baseRot + Math.sin(p.swayPhase * 0.8) * 1.2;
        } else {
          p.rotation += p.rotSpeed * dt;
        }

        if (p.trail) {
          p.trail.push({ x: p.x, y: p.y });
          if (p.trail.length > TRAIL_MAX) p.trail.shift();
        }

        // 透明度：出生淡入 + 消亡淡出
        var k = p.life / p.maxLife;
        p.alpha = Math.max(0, Math.min(1, (1 - k) / 0.2, k / 0.35));
        if (pc.twinkle) {   // 星尘闪烁
          var tw = 0.5 + 0.5 * Math.sin(p.twinklePhase + p.life * 9);
          p.alpha *= (1 - pc.twinkle * 0.5) + pc.twinkle * 0.5 * tw;
        }
      }
    }

    // ---- 各主题粒子绘制（均不调用 spawnSplash / spawnRipple 等现有特效） ----

    // 单片桃花瓣路径：水滴形、尖端朝下，顶部中央一个小凹口（桃花瓣的标志特征）。
    // 供单片花瓣与五瓣小桃花复用；坐标为局部空间，随 CTM 旋转/缩放。
    function petalPath(s) {
      octx.beginPath();
      octx.moveTo(0, s * 1.3);
      octx.bezierCurveTo(-s * 1.15, s * 0.85, -s * 1.2, -s * 0.55, -s * 0.3, -s * 1.35);
      octx.lineTo(0, -s * 1.02);            // 顶端中央凹口底
      octx.lineTo(s * 0.3, -s * 1.35);
      octx.bezierCurveTo(s * 1.2, -s * 0.55, s * 1.15, s * 0.85, 0, s * 1.3);
      octx.closePath();
    }

    function drawPetal(p, cfg) {          // 春：单片桃花瓣（基部泛白 → 边缘粉的渐变）
      var s = p.size;
      octx.translate(p.x, p.y);
      octx.rotate(p.rotation);
      var grad = octx.createLinearGradient(0, s * 1.3, 0, -s * 1.35);
      grad.addColorStop(0, '#fdeef4');
      grad.addColorStop(1, cfg.color);
      octx.fillStyle = grad;
      petalPath(s);
      octx.fill();
    }

    function drawFloret(p, cfg) {         // 春：五瓣小桃花（1/8 概率点缀）
      var s = p.size * 0.55;
      octx.translate(p.x, p.y);
      octx.rotate(p.rotation);
      var grad = octx.createLinearGradient(0, s * 1.3, 0, -s * 1.35);
      grad.addColorStop(0, '#fdeef4');
      grad.addColorStop(1, cfg.color);
      octx.fillStyle = grad;
      for (var i = 0; i < 5; i++) {
        octx.rotate(Math.PI * 2 / 5);
        petalPath(s);
        octx.fill();
      }
      // 花蕊：中心一撮黄色小点
      octx.fillStyle = '#f5d76e';
      for (var j = 0; j < 5; j++) {
        var ang = j * Math.PI * 2 / 5 + 0.3;
        octx.beginPath();
        octx.arc(Math.cos(ang) * s * 0.5, Math.sin(ang) * s * 0.5, s * 0.18, 0, Math.PI * 2);
        octx.fill();
      }
    }

    function drawDandelion(p, cfg) {      // 夏：蒲公英种子（放射冠毛 + 细梗 + 纺锤种子）
      var s = p.size;
      octx.translate(p.x, p.y);
      // 朝向：冠毛始终朝上，随风移方向整体倾斜（含持续风移，像被风推着走）
      var tilt = Math.max(-0.45, Math.min(0.45, -((p.vx || 0) + (p.windX || 0) * 0.6) * 0.03));
      octx.rotate(tilt);
      // 顶部放射冠毛：细弧线向上扇形散开（角度/长短在生成时缓存）
      var R = s * 2.3;
      octx.strokeStyle = cfg.color2;
      octx.lineWidth = 0.7;
      octx.beginPath();
      for (var i = 0; i < p.bristles.length; i++) {
        var b = p.bristles[i];
        var len = R * b.len;
        var ex = Math.cos(b.a) * len, ey = Math.sin(b.a) * len;
        var cx = Math.cos(b.a) * len * 0.5, cy = Math.sin(b.a) * len * 0.5 - len * 0.12;
        octx.moveTo(0, 0);
        octx.quadraticCurveTo(cx, cy, ex, ey);
      }
      octx.stroke();
      // 细梗
      octx.lineWidth = 0.8;
      octx.beginPath();
      octx.moveTo(0, 0);
      octx.lineTo(0, s * 1.5);
      octx.stroke();
      // 种子：细长纺锤形挂在梗底
      octx.fillStyle = cfg.color;
      octx.beginPath();
      octx.ellipse(0, s * 1.5 + s * 0.55, s * 0.3, s * 0.65, 0, 0, Math.PI * 2);
      octx.fill();
    }

    function drawGinkgo(p, cfg) {         // 秋：银杏叶（扇形叶面 + 放射脉络 + 顶部浅裂）
      var s = p.size;
      octx.translate(p.x, p.y);
      octx.rotate(p.rotation);   // 翻飞角由 updateParticles 驱动（随摇摆相位来回换向）
      var r = s * 1.5;
      var A0 = -Math.PI / 2 - 1.75, A1 = -Math.PI / 2 + 1.75;   // 约 200° 扇面
      var NOTCH = 0.13;                                          // 顶部中央浅裂半宽
      // 叶柄：自叶基向下微弯
      octx.strokeStyle = '#c9962f';
      octx.lineWidth = 1;
      octx.beginPath();
      octx.moveTo(0, 0);
      octx.quadraticCurveTo(s * 0.18, s * 0.9, s * 0.06, s * 1.8);
      octx.stroke();
      // 叶面：基部深金 → 边缘亮黄
      var grad = octx.createLinearGradient(0, 0, 0, -r);
      grad.addColorStop(0, '#d9a41e');
      grad.addColorStop(1, '#f4c542');
      octx.fillStyle = grad;
      octx.beginPath();
      octx.moveTo(0, 0);
      octx.arc(0, 0, r, A0, -Math.PI / 2 - NOTCH);   // 左半外缘
      octx.lineTo(0, -r * 0.72);                      // 裂口凹向叶基
      octx.arc(0, 0, r, -Math.PI / 2 + NOTCH, A1);    // 右半外缘（自动连线成裂口右缘）
      octx.closePath();
      octx.fill();
      // 放射脉络：从叶基伸向扇缘（角度在生成时缓存）
      octx.strokeStyle = 'rgba(150,100,15,0.4)';
      octx.lineWidth = 0.6;
      octx.beginPath();
      for (var i = 0; i < p.veins.length; i++) {
        octx.moveTo(0, 0);
        octx.lineTo(Math.cos(p.veins[i]) * r * 0.88, Math.sin(p.veins[i]) * r * 0.88);
      }
      octx.stroke();
    }

    function drawIce(p, cfg) {            // 冬：六臂枝晶雪花（分叉形态每片随机）
      var s = p.size * 2.0;   // 主臂长——雪花需要比原六边形更大的半径才看得清分叉
      octx.translate(p.x, p.y);
      octx.rotate(p.rotation);
      octx.strokeStyle = cfg.color;
      octx.lineWidth = 1.1;
      octx.lineCap = 'round';
      for (var i = 0; i < 6; i++) {
        octx.rotate(Math.PI / 3);
        // 主臂
        octx.beginPath();
        octx.moveTo(0, 0);
        octx.lineTo(0, -s);
        octx.stroke();
        // 一对 60° 分叉（朝臂尖方向），位置/长度生成时缓存
        for (var j = 0; j < p.arms.length; j++) {
          var br = p.arms[j];
          var by = -s * br.at;
          var bl = s * br.len;
          octx.beginPath();
          octx.moveTo(0, by); octx.lineTo(bl * 0.5, by - bl * 0.866);
          octx.moveTo(0, by); octx.lineTo(-bl * 0.5, by - bl * 0.866);
          octx.stroke();
        }
      }
    }

    function drawStardust(p, cfg) {       // 夜：四芒星 + 渐变拖尾（色温随机、闪烁呼吸）
      var tr = p.trail;
      if (tr && tr.length > 1) {
        octx.lineCap = 'round';
        octx.strokeStyle = cfg.color;
        for (var i = 1; i < tr.length; i++) {
          var f = i / (tr.length - 1);    // 0 = 最旧, 1 = 最新
          octx.globalAlpha = p.alpha * f * 0.55;
          octx.lineWidth = Math.max(0.4, p.size * 0.5 * f);
          octx.beginPath();
          octx.moveTo(tr[i - 1].x, tr[i - 1].y);
          octx.lineTo(tr[i].x, tr[i].y);
          octx.stroke();
        }
      }
      var tw = 0.5 + 0.5 * Math.sin(p.twinklePhase + p.life * 9);
      // 色温插值：0 暖白 → 1 淡蓝（每颗星生成时定死，形成"星等"差异）
      var cr = Math.round(255 - p.colorT * 25);
      var cg = Math.round(251 - p.colorT * 10);
      var cb = Math.round(230 + p.colorT * 25);
      // 四芒星光针：长度随闪烁相位呼吸
      var spike = p.size * 2.6 * p.spike * (0.5 + 0.5 * tw);
      octx.globalAlpha = p.alpha * 0.7;
      octx.strokeStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',1)';
      octx.lineWidth = 0.8;
      octx.beginPath();
      octx.moveTo(p.x - spike, p.y); octx.lineTo(p.x + spike, p.y);
      octx.moveTo(p.x, p.y - spike); octx.lineTo(p.x, p.y + spike);
      octx.stroke();
      // 核心光点
      octx.globalAlpha = p.alpha;
      octx.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',1)';
      octx.beginPath();
      octx.arc(p.x, p.y, p.size * 0.62, 0, Math.PI * 2);
      octx.fill();
    }

    function drawParticles() {
      if (!particles.length) {
        if (!wasEmpty) { octx.clearRect(0, 0, OW, OH); wasEmpty = true; }
        return;
      }
      wasEmpty = false;
      octx.clearRect(0, 0, OW, OH);
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        octx.save();
        octx.globalAlpha = p.alpha;
        if (p.type === 'spring') { (p.floret ? drawFloret : drawPetal)(p, TRAIL_CONFIG.spring); }
        else if (p.type === 'summer') drawDandelion(p, TRAIL_CONFIG.summer);
        else if (p.type === 'autumn') drawGinkgo(p, TRAIL_CONFIG.autumn);
        else if (p.type === 'winter') drawIce(p, TRAIL_CONFIG.winter);
        else if (p.type === 'night') drawStardust(p, TRAIL_CONFIG.night);
        octx.restore();
      }
    }

    // 独立 RAF：不受主 frame() 里 `if (!active) return` 限制，非首页也继续跑
    var lastTrail = performance.now();
    function trailFrame(now) {
      requestAnimationFrame(trailFrame);
      // 标签页后台：不更新不绘制，重置时间基准避免回来时粒子一次性跳一大步
      if (document.hidden) { lastTrail = now; return; }
      var dt = Math.min((now - lastTrail) / 1000, 0.05);
      lastTrail = now;
      updateParticles(dt);
      drawParticles();
    }
    requestAnimationFrame(trailFrame);

    // 暴露彩蛋切换接口
    window.__setTrailEnabled = function (enabled) { trailEnabled = enabled; };
  })();

  // ==================== 隐藏彩蛋：蔚蓝档案风点击粒子（BASpark 移植） ====================
  // 双击首页背景岛屿切换：关闭季节拖尾，改为点击时扩散圆环+火花粒子效果。
  // 只移植 mousedown 点击效果，不移植 mousemove 拖尾。刷新后自动恢复默认。
  (function initBASparkEgg() {
    var SPARK_COLOR = '45,175,255';
    var RING_START = [250, 252, 252];
    var RING_END = [185, 228, 255];
    // BASpark 设置：点击动画速度 0.60x（用户要求更慢→0.42）、缩放 2.2x（用户要求更大）
    // 关键：尺寸只乘 SCALE，速度通过每帧增量乘 SPEED，两者独立
    var SPEED = 0.32;          // 点击动画速度倍率（越小越慢）
    var SCALE = 1.8;           // 缩放比例
    var FILL_RATE = 26;        // 填充圆扩散基准速度（实际半径再乘 SCALE）
    var FILL_MAX = 16;         // 填充圆基准寿命
    var RING_MAX = 23;         // 圆环基准寿命
    var RING_LEN = 1.1 * Math.PI;  // 每段圆弧长度
    var SPARKS_PER_CLICK = 4;

    var canvas = document.createElement('canvas');
    canvas.className = 'spark-egg-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:50;';
    document.body.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    var cw = 0, ch = 0, dpr = 1;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cw = window.innerWidth;
      ch = window.innerHeight;
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      canvas.style.width = cw + 'px';
      canvas.style.height = ch + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    // 对象池
    var waves = [], sparks = [];
    var wavePool = [], sparkPool = [];
    var running = false;
    var enabled = false;

    function createClick(x, y) {
      // 波浪环（填充圆 + 2段弧形圆环）
      var w = wavePool.pop() || {};
      w.x = x; w.y = y; w.r = 0; w.life = 0;
      if (!w.ring) w.ring = {};
      w.ring.ang = Math.random() * Math.PI * 2;
      w.ring.rs = [0, 0.03, 0.06][Math.floor(Math.random() * 3)];
      if (!w.ring.segs) w.ring.segs = [{}, {}];
      w.ring.segs[0].off = 0;
      w.ring.segs[0].len = RING_LEN;
      w.ring.segs[0].rate = [0, 1, 1.5, 2][Math.floor(Math.random() * 4)];
      w.ring.segs[1].off = (Math.random() * 3 - 1.5) * Math.PI;
      w.ring.segs[1].len = RING_LEN;
      w.ring.segs[1].rate = [0, 1, 1.5, 2][Math.floor(Math.random() * 4)];
      waves.push(w);

      // 火花粒子
      var speedAdjust = SCALE / 1.5;   // BASpark 源码：速度随缩放比例调整
      for (var i = 0; i < SPARKS_PER_CLICK; i++) {
        var s = sparkPool.pop() || {};
        var a = Math.random() * Math.PI * 2;
        var speed = (4.8 + Math.random() * 2) * speedAdjust;
        s.x = x; s.y = y;
        s.vx = Math.cos(a) * speed;
        s.vy = Math.sin(a) * speed;
        s.rot = Math.random() * Math.PI * 2;
        s.rs = (Math.random() - 0.5) * 0.28;
        s.size = (4 + Math.random() * 3) * SCALE;
        s.alpha = 1;
        s.drag = 0.9;
        sparks.push(s);
      }
      if (!running) { running = true; requestAnimationFrame(tick); }
    }

    function tick() {
      ctx.clearRect(0, 0, cw, ch);
      var hasWork = waves.length > 0 || sparks.length > 0;

      // ---- 更新+绘制波浪环 ----
      for (var i = waves.length - 1; i >= 0; i--) {
        var w = waves[i];
        w.life += SPEED;   // 寿命按速度倍率增长（减速→动画更久）
        var waveProg = Math.min(w.life / FILL_MAX, 1);
        var ringProg = Math.min(w.life / RING_MAX, 1);

        // 填充圆（ease-out 扩散），半径乘 SCALE
        var ease = 1 - Math.pow(1 - waveProg, 3);
        w.r = FILL_RATE * SCALE * ease;
        var fillAlpha = Math.max(0, 1 - waveProg);
        if (fillAlpha > 0) {
          ctx.beginPath();
          ctx.arc(w.x, w.y, w.r, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(' + SPARK_COLOR + ',' + fillAlpha * 0.5 + ')';
          ctx.fill();
        }

        // 弧形圆环
        var r = w.ring;
        r.ang -= r.rs * SPEED;
        for (var si = 0; si < 2; si++) {
          var seg = r.segs[si];
          var base = r.ang + seg.off;
          var start, end, len;
          if (ringProg <= 0.1) {
            len = seg.len * (ringProg / 0.1);
            end = base + seg.len;
            start = end - len;
          } else if (ringProg > 0.4) {
            len = seg.len * (1 - (ringProg - 0.4) / 0.6);
            start = base;
            end = start + len;
          } else {
            len = seg.len;
            start = base;
            end = start + len;
          }
          var lwMul = Math.min(-0.8 * (ringProg - 0.8) + 1, 1);
          var rt = Math.min(1.2 * ringProg, 1);
          var rr = Math.round(RING_START[0] * (1 - rt) + RING_END[0] * rt);
          var rg = Math.round(RING_START[1] * (1 - rt) + RING_END[1] * rt);
          var rb = Math.round(RING_START[2] * (1 - rt) + RING_END[2] * rt);
          var ringAlpha = Math.min(1.1 - 0.3 * ringProg, 1);
          var radius = w.r + seg.rate * SCALE;   // 圆环半径随缩放比例
          var segNum = 10;
          for (var k = 0; k < segNum; k++) {
            var a0 = start + (end - start) * (k / segNum);
            var a1 = start + (end - start) * ((k + 1) / segNum);
            if (Math.abs(a1 - a0) < 0.01) continue;
            var wT = Math.min(2 - Math.abs(4 * (k / segNum - 0.5)), 1);
            var lw = (0.4 * (1 - wT) + 3.3 * wT) * lwMul;
            ctx.beginPath();
            ctx.arc(w.x, w.y, radius, a0, a1);
            ctx.lineWidth = lw;
            ctx.strokeStyle = 'rgba(' + rr + ',' + rg + ',' + rb + ',' + ringAlpha + ')';
            ctx.stroke();
          }
        }

        if (ringProg >= 1 && waveProg >= 1) {
          wavePool.push(w);
          waves.splice(i, 1);
        }
      }

      // ---- 更新+绘制火花（位移/阻尼/旋转/衰减均乘 SPEED） ----
      var dragF = Math.pow(0.9, SPEED);
      for (var j = sparks.length - 1; j >= 0; j--) {
        var s = sparks[j];
        s.x += s.vx * SPEED;
        s.y += s.vy * SPEED;
        s.vx *= dragF;
        s.vy *= dragF;
        s.rot += s.rs * SPEED;
        s.alpha -= 0.032 * SPEED;
        if (s.alpha <= 0) {
          sparkPool.push(s);
          sparks.splice(j, 1);
          continue;
        }
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(s.rot);
        ctx.beginPath();
        ctx.moveTo(0, -s.size);
        ctx.lineTo(s.size * 0.6, s.size * 0.6);
        ctx.lineTo(-s.size * 0.6, s.size * 0.6);
        ctx.fillStyle = 'rgba(255,255,255,' + s.alpha + ')';
        ctx.fill();
        ctx.restore();
      }

      if (hasWork) {
        requestAnimationFrame(tick);
      } else {
        running = false;
        ctx.clearRect(0, 0, cw, ch);
      }
    }

    // mousedown 触发点击效果（仅彩蛋模式启用）
    window.addEventListener('mousedown', function (e) {
      if (!enabled) return;
      // 点在按钮/输入框/链接等交互元素上时不冒粒子，避免干扰正常操作
      if (e.target && e.target.closest && e.target.closest('button, input, textarea, select, a, [contenteditable]')) return;
      createClick(e.clientX, e.clientY);
    });

    // 暴露开关
    window.__setEggEnabled = function (on) {
      enabled = on;
      if (!on) {
        waves.length = 0;
        sparks.length = 0;
        ctx.clearRect(0, 0, cw, ch);
      }
    };

    // 双击岛屿切换彩蛋（无任何视觉提示）。
    // 岛屿 z-index:-1 + pointer-events:none，收不到事件，改为全局 dblclick + 矩形命中检测。
    // 限定：仅「夜」主题可触发；白天双击岛屿无反应。
    window.addEventListener('dblclick', function (e) {
      var island = document.getElementById('island-bg');
      if (!island || island.style.display === 'none') return;
      // reduced-motion 下不开启彩蛋；彩蛋已开启时双击仍允许关闭
      if (REDUCED_MOTION && !enabled) return;
      // 非夜间主题不能开启彩蛋；彩蛋已开启时双击则允许关闭
      var isNight = document.body.classList.contains('night');
      if (!isNight && !enabled) return;
      var r = island.getBoundingClientRect();
      // 扩大一点命中区域，降低发现门槛但不会误触
      var pad = 20;
      if (e.clientX >= r.left - pad && e.clientX <= r.right + pad &&
          e.clientY >= r.top - pad && e.clientY <= r.bottom + pad) {
        var eggOn = !enabled;
        window.__setEggEnabled(eggOn);
        window.__setTrailEnabled(!eggOn);
      }
    });

    // 从夜间切回白天时，若彩蛋正开着则自动关闭、恢复季节拖尾
    new MutationObserver(function () {
      if (enabled && !document.body.classList.contains('night')) {
        window.__setEggEnabled(false);
        window.__setTrailEnabled(true);
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  })();

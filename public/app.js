'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let allArticles = [];
let activeSource = 'all';
let showUnreadOnly = true;
let activeId = null;

// ── Read state (localStorage) ─────────────────────────────────────────────────
const READ_KEY = 'aiblogs_read';
function getReadSet() {
  try { return new Set(JSON.parse(localStorage.getItem(READ_KEY) || '[]')); }
  catch { return new Set(); }
}
function markRead(ids) {
  const s = getReadSet();
  ids.forEach(id => s.add(String(id)));
  localStorage.setItem(READ_KEY, JSON.stringify([...s]));
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const el = id => document.getElementById(id);
const articleList      = el('article-list');
const unreadBadge      = el('unread-badge');
const feedCount        = el('feed-count');
const lastRefreshEl    = el('last-refresh');
const reader           = el('reader');
const readerEmpty      = el('reader-empty');
const readerToolbar    = el('reader-toolbar');
const readerMeta       = el('reader-meta');
const readerTitle      = el('reader-title');
const readerSub        = el('reader-sub');
const readerBody       = el('reader-body');
const readerOrig       = el('reader-orig');
const readerBack       = el('reader-back');
const btnRefresh       = el('btn-refresh');
const btnMarkAll       = el('btn-mark-all');
const btnUnreadToggle  = el('btn-unread-toggle');
const toast            = el('toast');

// ── API helpers ───────────────────────────────────────────────────────────────
async function apiFetch(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Load & render ─────────────────────────────────────────────────────────────
async function loadArticles() {
  allArticles = await apiFetch('GET', '/api/articles');
  const readSet = getReadSet();
  allArticles.forEach(a => { a.isRead = readSet.has(a.id); });
  renderList();
  refreshStatus();
}

function displayedArticles() {
  return allArticles.filter(a => {
    if (activeSource !== 'all' && a.source !== activeSource) return false;
    if (showUnreadOnly && a.isRead) return false;
    return true;
  });
}

function renderList() {
  const list = displayedArticles();
  if (!list.length) {
    articleList.innerHTML = `<div class="empty">${showUnreadOnly ? 'All caught up! No unread articles.' : 'No articles.'}</div>`;
    feedCount.textContent = '';
    return;
  }
  feedCount.textContent = `${list.length} article${list.length !== 1 ? 's' : ''}`;
  articleList.innerHTML = list.map(cardHTML).join('');
  articleList.querySelectorAll('.card').forEach(c =>
    c.addEventListener('click', () => openArticle(c.dataset.id))
  );
}

function cardHTML(a) {
  const active = a.id === activeId ? ' active' : '';
  const read   = a.isRead ? ' is-read' : '';
  return `<div class="card src-${esc(a.source)}${active}${read}" data-id="${esc(a.id)}">
    <div class="card-title">${esc(a.title)}</div>
    <div class="card-meta">
      <span class="chip src-${esc(a.source)}">${esc(a.sourceName)}</span>
      <span class="card-age">${timeAgo(a.date)}</span>
      ${!a.isRead ? '<span class="dot"></span>' : ''}
    </div>
    ${a.excerpt ? `<div class="card-excerpt">${esc(a.excerpt)}</div>` : ''}
  </div>`;
}

async function refreshStatus() {
  const s = await apiFetch('GET', '/api/status');
  const readSet = getReadSet();

  if (s.lastRefresh) {
    lastRefreshEl.textContent = `Updated ${timeAgo(s.lastRefresh)}`;
  }

  const sourceUnread = {};
  let totalUnread = 0;
  for (const a of allArticles) {
    if (!readSet.has(a.id)) {
      totalUnread++;
      sourceUnread[a.source] = (sourceUnread[a.source] || 0) + 1;
    }
  }

  unreadBadge.textContent = totalUnread;
  unreadBadge.classList.toggle('hidden', totalUnread === 0);

  document.querySelectorAll('#source-tabs .tab').forEach(tab => {
    const src = tab.dataset.source;
    const base = tab.dataset.base || tab.textContent.replace(/\s*\(\d+\)$/, '');
    tab.dataset.base = base;
    if (src === 'all') {
      tab.textContent = totalUnread ? `${base} (${totalUnread})` : base;
    } else {
      const n = sourceUnread[src] || 0;
      tab.textContent = n ? `${base} (${n})` : base;
    }
  });
}

// ── Article reader ────────────────────────────────────────────────────────────
async function openArticle(id) {
  const article = allArticles.find(a => a.id === id);
  if (!article) return;

  activeId = id;
  setReaderOpen(true);

  readerTitle.textContent = article.title;
  readerSub.innerHTML = `<span class="chip src-${esc(article.source)}">${esc(article.sourceName)}</span><span>${timeAgo(article.date)}</span>`;
  readerOrig.href = article.url;
  readerBody.className = 'loading';
  readerBody.textContent = 'Loading…';

  // Highlight card
  articleList.querySelectorAll('.card').forEach(c =>
    c.classList.toggle('active', c.dataset.id === id)
  );

  // Mark as read
  if (!article.isRead) {
    article.isRead = true;
    markRead([id]);
    renderList();
    refreshStatus();
  }

  // Fetch content
  try {
    const data = await apiFetch('GET', `/api/article?url=${encodeURIComponent(article.url)}`);
    readerBody.className = '';
    if (data.content) {
      // Client-side safety: strip any remaining event handlers
      const tmp = document.createElement('div');
      tmp.innerHTML = data.content;
      tmp.querySelectorAll('[onclick],[onload],[onerror],[onmouseover]').forEach(e => {
        ['onclick','onload','onerror','onmouseover'].forEach(a => e.removeAttribute(a));
      });
      readerBody.innerHTML = tmp.innerHTML;
    } else {
      readerBody.innerHTML = fallbackHTML(article);
    }
    if (data.byline) {
      readerSub.innerHTML += `<span class="byline">${esc(data.byline)}</span>`;
    }
  } catch {
    readerBody.className = '';
    readerBody.innerHTML = fallbackHTML(article);
  }
}

function fallbackHTML(article) {
  return `<div class="fallback">
    <p>${esc(article.excerpt || 'Content unavailable.')}</p>
    <a href="${esc(article.url)}" target="_blank" rel="noopener noreferrer">Read on ${esc(article.sourceName)} ↗</a>
  </div>`;
}

function setReaderOpen(open) {
  reader.classList.toggle('closed', !open);
}

readerBack.addEventListener('click', () => {
  activeId = null;
  setReaderOpen(false);
  articleList.querySelectorAll('.card').forEach(c => c.classList.remove('active'));
});

// ── Controls ──────────────────────────────────────────────────────────────────
document.querySelectorAll('#source-tabs .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#source-tabs .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeSource = tab.dataset.source;
    activeId = null;
    setReaderOpen(false);
    loadArticles();
  });
});

btnUnreadToggle.addEventListener('click', () => {
  showUnreadOnly = !showUnreadOnly;
  btnUnreadToggle.classList.toggle('active', showUnreadOnly);
  btnUnreadToggle.textContent = showUnreadOnly ? 'Unread' : 'All';
  loadArticles();
});

btnRefresh.addEventListener('click', async () => {
  btnRefresh.disabled = true;
  btnRefresh.classList.add('spinning');
  try {
    const r = await apiFetch('POST', '/api/refresh');
    showToast(`${r.newCount} new article${r.newCount !== 1 ? 's' : ''}`);
    await loadArticles();
  } catch {
    showToast('Refresh failed');
  } finally {
    btnRefresh.disabled = false;
    btnRefresh.classList.remove('spinning');
  }
});

btnMarkAll.addEventListener('click', () => {
  const unread = allArticles.filter(a => !a.isRead && (activeSource === 'all' || a.source === activeSource));
  if (!unread.length) return;
  unread.forEach(a => { a.isRead = true; });
  markRead(unread.map(a => a.id));
  showToast(`Marked ${unread.length} as read`);
  renderList();
  refreshStatus();
});

// ── Utils ──────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 2)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)   return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

// ── About modal ───────────────────────────────────────────────────────────────
const aboutModal = el('about-modal');
el('btn-about').addEventListener('click', () => aboutModal.classList.remove('hidden'));
el('about-close').addEventListener('click', () => aboutModal.classList.add('hidden'));
aboutModal.addEventListener('click', e => { if (e.target === aboutModal) aboutModal.classList.add('hidden'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') aboutModal.classList.add('hidden'); });

// ── Init ──────────────────────────────────────────────────────────────────────
setReaderOpen(false);
loadArticles();
setInterval(loadArticles, 5 * 60 * 1000); // poll every 5 min for new data

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

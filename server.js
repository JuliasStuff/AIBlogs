'use strict';

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const RSSParser = require('rss-parser');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

const PORT = parseInt(process.env.PORT) || 3001;
const REFRESH_MINUTES = Math.max(15, parseInt(process.env.REFRESH_MINUTES) || 60);
const DATA = path.join(__dirname, 'data');

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);

function readData(file, def) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
  catch { return def; }
}
function writeData(file, data) {
  fs.writeFileSync(path.join(DATA, file), JSON.stringify(data, null, 2));
}

const rssParser = new RSSParser();
const HTTP_OPTS = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5'
  },
  timeout: 20000,
  maxRedirects: 5
};

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseDate(text) {
  if (!text) return null;
  const d = new Date(text.trim().replace(/\s+/g, ' '));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchRSS(url, source, sourceName) {
  const feed = await rssParser.parseURL(url);
  return feed.items.slice(0, 30).map(item => ({
    id: item.link || item.guid,
    title: (item.title || '').trim(),
    url: item.link || item.guid,
    date: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
    excerpt: (item.contentSnippet || item.summary || '').replace(/<[^>]+>/g, '').trim().slice(0, 300),
    source,
    sourceName
  })).filter(a => a.title && a.url);
}

async function fetchMIT() {
  return fetchRSS(
    'https://news.mit.edu/topic/mitartificial-intelligence2-rss.xml',
    'mit', 'MIT News'
  );
}

async function fetchMarkTechPost() {
  try {
    return await fetchRSS('https://www.marktechpost.com/feed/', 'marktechpost', 'MarkTechPost');
  } catch (e) {
    console.log(`MarkTechPost RSS failed (${e.message}), trying HTML…`);
  }
  const res = await axios.get('https://www.marktechpost.com/', HTTP_OPTS);
  const $ = cheerio.load(res.data);
  const articles = [];
  const seen = new Set();
  $('h2 a[href*="marktechpost.com/20"], h3 a[href*="marktechpost.com/20"]').each((_, el) => {
    if (articles.length >= 25) return false;
    const $a = $(el);
    const title = $a.text().trim();
    const url = $a.attr('href');
    if (!title || !url || seen.has(url)) return;
    seen.add(url);
    const $p = $a.closest('article, .post, .entry');
    const date = parseDate($p.find('time, [class*="date"]').first().text()) || new Date().toISOString();
    const excerpt = $p.find('p').first().text().trim().slice(0, 250);
    articles.push({ id: url, title, url, date, excerpt, source: 'marktechpost', sourceName: 'MarkTechPost' });
  });
  return articles;
}

async function fetchTowardsAI() {
  try {
    return await fetchRSS('https://towardsai.com/feed/', 'towardsai', 'Towards AI');
  } catch (e) {
    console.log(`TowardsAI RSS failed (${e.message}), trying HTML…`);
  }
  const res = await axios.get('https://towardsai.com/p', HTTP_OPTS);
  const $ = cheerio.load(res.data);
  const articles = [];
  const seen = new Set();
  $('h2 a, h3 a, h4 a, h5 a').each((_, el) => {
    if (articles.length >= 25) return false;
    const $a = $(el);
    const title = $a.text().trim();
    const url = $a.attr('href');
    if (!title || !url || seen.has(url)) return;
    if (!url.startsWith('http') || url.includes('#') || !url.includes('towardsai.com')) return;
    seen.add(url);
    const $p = $a.closest('article, .post, .entry');
    const date = parseDate($p.find('time, [class*="date"]').first().text()) || new Date().toISOString();
    const excerpt = $p.find('p').first().text().trim().slice(0, 250);
    articles.push({ id: url, title, url, date, excerpt, source: 'towardsai', sourceName: 'Towards AI' });
  });
  return articles;
}

async function fetchTopBots() {
  try {
    return await fetchRSS('https://www.topbots.com/feed/', 'topbots', 'TopBots');
  } catch (e) {
    console.log(`TopBots RSS failed (${e.message}), trying HTML…`);
  }
  const res = await axios.get('https://www.topbots.com/', HTTP_OPTS);
  const $ = cheerio.load(res.data);
  const articles = [];
  const seen = new Set();
  $('h2 a[href*="topbots.com"], h3 a[href*="topbots.com"]').each((_, el) => {
    if (articles.length >= 20) return false;
    const $a = $(el);
    const title = $a.text().trim();
    const url = $a.attr('href');
    if (!title || !url || seen.has(url)) return;
    if (url.includes('/category/') || url.includes('/tag/')) return;
    seen.add(url);
    const $p = $a.closest('article, .post, .entry');
    const date = parseDate($p.find('time, [class*="date"]').first().text()) || new Date().toISOString();
    const excerpt = $p.find('p').first().text().trim().slice(0, 250);
    articles.push({ id: url, title, url, date, excerpt, source: 'topbots', sourceName: 'TopBots' });
  });
  return articles;
}

// ── Refresh ───────────────────────────────────────────────────────────────────

async function refreshAll() {
  const ts = new Date().toISOString();
  console.log(`[${ts}] Refreshing articles…`);

  const existing = readData('articles.json', []);
  const existingIds = new Set(existing.map(a => a.id));

  const results = await Promise.allSettled([fetchMIT(), fetchMarkTechPost(), fetchTowardsAI(), fetchTopBots()]);

  const fresh = [];
  const sourceCounts = { mit: 0, marktechpost: 0, towardsai: 0, topbots: 0 };
  const sources = ['mit', 'marktechpost', 'towardsai', 'topbots'];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled') {
      fresh.push(...results[i].value);
      sourceCounts[sources[i]] = results[i].value.length;
    } else {
      console.error(`${sources[i]} fetch error:`, results[i].reason?.message);
    }
  }

  // Deduplicate fresh list
  const seenFresh = new Set();
  const deduped = fresh.filter(a => { if (seenFresh.has(a.id)) return false; seenFresh.add(a.id); return true; });

  const newArticles = deduped.filter(a => !existingIds.has(a.id));
  const merged = [...newArticles, ...existing].slice(0, 600);

  writeData('articles.json', merged);

  writeData('status.json', {
    lastRefresh: ts,
    newCount: newArticles.length,
    total: merged.length,
    fetchedPerSource: sourceCounts
  });

  console.log(`[${new Date().toISOString()}] Done: ${newArticles.length} new, ${merged.length} total`);
  return { newCount: newArticles.length, total: merged.length };
}

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/articles', (req, res) => {
  res.json(readData('articles.json', []));
});

app.post('/api/refresh', async (req, res) => {
  try { res.json(await refreshAll()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/status', (req, res) => {
  const status = readData('status.json', {});
  res.json(status);
});

// Article reader proxy – fetches page, extracts content with Readability
const ALLOWED_HOSTS = new Set([
  'news.mit.edu',
  'www.marktechpost.com', 'marktechpost.com',
  'towardsai.com', 'www.towardsai.com', 'pub.towardsai.net',
  'www.topbots.com', 'topbots.com'
]);

app.get('/api/article', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:') return res.status(400).json({ error: 'https only' });
    if (!ALLOWED_HOSTS.has(parsedUrl.hostname)) return res.status(403).json({ error: 'Domain not permitted' });
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const response = await axios.get(url, { ...HTTP_OPTS, maxContentLength: 5 * 1024 * 1024 });
    const dom = new JSDOM(response.data, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article) return res.status(422).json({ error: 'Content extraction failed' });

    // Server-side sanitization
    const $ = cheerio.load(article.content);
    $('script, iframe, object, embed, form, style').remove();
    $('*').each((_, el) => {
      const attrs = el.attribs || {};
      for (const k of Object.keys(attrs)) {
        if (k.startsWith('on') || k === 'srcdoc') delete attrs[k];
      }
    });
    $('a[href]').attr('target', '_blank').attr('rel', 'noopener noreferrer');
    $('img').attr('loading', 'lazy');

    res.json({
      title: article.title,
      byline: article.byline || null,
      excerpt: article.excerpt || null,
      siteName: article.siteName || null,
      content: $('body').html() || $.html()
    });
  } catch (err) {
    console.error('Article fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch article' });
  }
});

// SVG icon
app.get('/icons/icon.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#1e3a5f"/>
    <stop offset="100%" stop-color="#0d1b2e"/>
  </linearGradient></defs>
  <rect width="192" height="192" rx="32" fill="url(#g)"/>
  <text x="96" y="130" text-anchor="middle" font-size="96" font-family="system-ui">🧠</text>
</svg>`);
});

// ── Cron ──────────────────────────────────────────────────────────────────────

function makeCron(minutes) {
  if (minutes >= 60) return `0 */${Math.floor(minutes / 60)} * * *`;
  return `*/${minutes} * * * *`;
}
cron.schedule(makeCron(REFRESH_MINUTES), refreshAll);

// Initial fetch if no data yet
if (!fs.existsSync(path.join(DATA, 'articles.json'))) {
  refreshAll().catch(err => console.error('Initial refresh failed:', err.message));
} else {
  console.log(`Loaded existing data. Auto-refresh every ${REFRESH_MINUTES} min.`);
}

app.listen(PORT, () => console.log(`AI Blogs → http://localhost:${PORT}`));

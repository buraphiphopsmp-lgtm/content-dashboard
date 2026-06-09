const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

// ---- Google Sheet config ----
const SHEET_ID = '1PORT556ite9ATGh91lYc3KdGAMz6h4fVoL_0vM6u0g4';
const GID_SUMMARY = '307838850';   // แท็บสรุปรายเดือน (Month, Platform, Profile/Pillar ...)
const GID_POSTS   = '277724235';   // แท็บรายโพสต์ (Pillar, Date, Message, Network ...)
const CACHE_MS = 10 * 60 * 1000;   // cache 10 นาที
const csvUrl = (gid) => `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${gid}`;

let CACHE = { ts: 0, data: null };

// ---- helpers ----
function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const num = (v) => { const n = parseFloat(String(v || '').replace(/,/g, '').trim()); return isNaN(n) ? 0 : n; };
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const MONTHS = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
function toISO(d) {
  const m = clean(d).match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (!m) return clean(d);
  return `${m[3]}-${MONTHS[m[2].slice(0,3)]||'01'}-${m[1].padStart(2,'0')}`;
}
const NET = { FACEBOOK:'Facebook', INSTAGRAM:'Instagram', TIKTOK:'TikTok', TWITTER:'X', X:'X', YOUTUBE:'YouTube' };
const normNet = (n) => NET[clean(n).toUpperCase()] || clean(n);

async function fetchCsv(gid) {
  const res = await fetch(csvUrl(gid));
  const text = await res.text();
  if (text.trim().startsWith('<') || text.includes('<!DOCTYPE'))
    throw new Error('sheet not public or gid wrong (got HTML)');
  return parseCSV(text);
}
function header(rows) {
  const head = rows[0].map(h => h.trim());
  return {
    exact: (name) => head.findIndex(h => h === name),
    incl:  (kw)   => head.findIndex(h => h.toLowerCase().includes(kw.toLowerCase())),
    body: rows.slice(1).filter(r => r.some(c => String(c).trim() !== '')),
  };
}
function buildSummary(rows) {
  const h = header(rows);
  const c = { platform: h.exact('Platform'), pillar: h.exact('Profile'),
    reactions: h.incl('Reactions'), impressions: h.exact('Impressions/views of posts'),
    posts: h.incl('Number of posts') };
  return h.body.map(r => ({
    platform: clean(r[c.platform]), pillar: clean(r[c.pillar]),
    reactions: Math.round(num(r[c.reactions])), impressions: Math.round(num(r[c.impressions])),
    posts: Math.round(num(r[c.posts])),
  })).filter(x => x.platform);
}
function buildPosts(rows) {
  const h = header(rows);
  const c = { pillar: h.exact('Pillar'), date: h.exact('Date'), message: h.exact('Message'),
    profile: h.exact('Profile'), network: h.exact('Network'),
    reactions: h.incl('Reactions'), impressions: h.exact('Impressions/views of posts'),
    link: h.exact('Link') };
  return h.body.map(r => {
    let msg = clean(r[c.message])
      .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
    if (msg.length > 90) msg = msg.slice(0, 90) + '...';
    return {
      date: toISO(r[c.date]), network: normNet(r[c.network]), pillar: clean(r[c.pillar]),
      profile: clean(r[c.profile]), engagement: Math.round(num(r[c.reactions])),
      impressions: Math.round(num(r[c.impressions])), message: msg,
      link: clean(r[c.link]).replace(/\\/g, ''),
    };
  }).filter(x => x.network);
}

async function getData() {
  if (CACHE.data && Date.now() - CACHE.ts < CACHE_MS) return CACHE.data;
  const [sumRows, postRows] = await Promise.all([fetchCsv(GID_SUMMARY), fetchCsv(GID_POSTS)]);
  const summary = buildSummary(sumRows);
  const posts = buildPosts(postRows);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`;
  const data = { meta: { source: 'Raw data Pillar SMP', month: 'May 2026', generatedAt: stamp,
    rows: summary.length, postsAnalyzed: posts.length }, summary, posts };
  CACHE = { ts: Date.now(), data };
  return data;
}

// ---- routes ----
app.get('/content-data.json', async (req, res) => {
  res.set('Cache-Control', 'no-cache');
  try {
    res.json(await getData());
  } catch (e) {
    if (CACHE.data) return res.json(CACHE.data);            // serve stale on error
    res.status(502).json({ error: String(e.message || e), meta: {}, summary: [], posts: [] });
  }
});

app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});
app.use(express.static(PUBLIC));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'content-dashboard.html')));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.listen(PORT, '0.0.0.0', () => console.log('Content Performance Dashboard (live sheet) on port ' + PORT));

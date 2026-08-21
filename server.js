const express = require('express');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

// ---- Google Sheet config ----
const SHEET_ID = '1PORT556ite9ATGh91lYc3KdGAMz6h4fVoL_0vM6u0g4';
const GID_SUMMARY = '307838850';   // แท็บสรุปรายเดือน (Month, Platform, Profile/Pillar ...)
const GID_POSTS   = '277724235';   // แท็บรายโพสต์ (Pillar, Date, Message, Network ...)
const GID_TUTOR   = '46843437';    // แท็บ "Raw data by Tutor Platform" (Follower, Follower Growth, Tutor, Network ...)
const GID_TCONTENT = '1543994548'; // แท็บ "Raw data Top content (incl. Tutor Platform)" (post-level by tutor)
const GID_COLLAB   = '1620780602'; // แท็บ "Raw Data Tutor Overview (IG Collab Post)" (สรุป IG collab รายเดือน)
const GID_COLLABPOSTS = '1522627842'; // แท็บ "Raw data Post with Tutor Account (IG Collab)" (post-level)

const CACHE_MS = 10 * 60 * 1000;   // ถือ cache 10 นาที (stale-while-revalidate)
const FETCH_TIMEOUT_MS = 90 * 1000;

// ดึงเฉพาะคอลัมน์ที่ใช้จริงจากแท็บใหญ่ เพื่อลดขนาดที่โหลด (แท็บเล็กดึงทั้งหมด)
// ถ้าคอลัมน์ในชีตถูกสลับ/แทรก จะ fallback ไปดึงทั้งแท็บอัตโนมัติ (ดู fetchRows)
const SELECT_POSTS    = 'A,B,C,D,E,F,G,J';         // Pillar,Date,Message,Profile,Network,Reactions,Impressions,Link
const SELECT_TCONTENT = 'B,C,D,E,F,G,H,I,P';       // Date,Profile,Tutor,Message,Network,Reactions,Impressions,Reach,Link

const csvUrl = (gid, select) =>
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv` +
  (select ? '&tq=' + encodeURIComponent('select ' + select) : '') +
  `&gid=${gid}`;

// ---- helpers ----
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
const trimMsg = (s, max) => {
  let m = clean(s)
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
  return m.length > max ? m.slice(0, max) + '...' : m;
};

// ---- streaming CSV parser ----
// รับข้อมูลเป็นก้อน ๆ แล้ว callback ทีละแถว จึงไม่ต้องเก็บทั้งไฟล์/ทั้งตารางไว้ในหน่วยความจำ
function createCsvParser(onRow) {
  let field = '', row = [], inQuotes = false, pendingQuote = false;
  return {
    push(text) {
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (pendingQuote) {              // ตัวก่อนหน้าเป็น " ขณะอยู่ใน quotes
          pendingQuote = false;
          if (c === '"') { field += '"'; continue; }   // "" = escaped quote
          inQuotes = false;                            // ปิด quotes แล้วประมวลผล c ต่อแบบปกติ
        }
        if (inQuotes) {
          if (c === '"') pendingQuote = true;
          else field += c;
        } else {
          if (c === '"') inQuotes = true;
          else if (c === ',') { row.push(field); field = ''; }
          else if (c === '\n') { row.push(field); onRow(row); row = []; field = ''; }
          else if (c === '\r') { /* skip */ }
          else field += c;
        }
      }
    },
    end() {
      pendingQuote = false; inQuotes = false;
      if (field.length || row.length) { row.push(field); onRow(row); row = []; field = ''; }
    },
  };
}

// ดึง CSV แบบ stream -> map เป็น object ทีละแถว (คืนเฉพาะผลลัพธ์ที่ต้องใช้)
// mapRow(cols) -> object | null ;  cols = ตัวช่วยหา index จาก header
async function fetchRows(gid, select, makeMapper, required) {
  const attempt = async (sel) => {
    const res = await fetch(csvUrl(gid, sel), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} on gid ${gid}`);
    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/html')) throw new Error(`gid ${gid}: got HTML (sheet not public or gid wrong)`);

    const out = [];
    let head = null, mapper = null, checked = false;
    const parser = createCsvParser((row) => {
      if (!head) {
        head = row.map(h => clean(h).replace(/^﻿/, ''));
        mapper = makeMapper({
          exact: (name) => head.indexOf(name),
          incl:  (kw)   => head.findIndex(h => h.toLowerCase().includes(kw.toLowerCase())),
        });
        return;
      }
      if (!checked) {
        checked = true;
        // ถ้าคอลัมน์ที่จำเป็นหายไป แปลว่า select ผิดตำแหน่ง -> โยนให้ไป fallback
        for (const name of (required || [])) {
          if (!head.some(h => h === name || h.toLowerCase().includes(name.toLowerCase())))
            throw new Error(`gid ${gid}: missing column "${name}"`);
        }
      }
      let empty = true;
      for (let i = 0; i < row.length; i++) if (row[i] && row[i].trim() !== '') { empty = false; break; }
      if (empty) return;
      const o = mapper(row);
      if (o) out.push(o);
    });

    const decoder = new TextDecoder('utf-8');
    const reader = res.body.getReader();
    // อ่านทีละก้อน — ระหว่างรอ chunk ถัดไป event loop ว่างให้ /healthz ตอบได้ตลอด
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
    } catch (e) {
      reader.cancel().catch(() => {});    // อย่าทิ้ง stream ค้างไว้
      throw e;
    }
    parser.push(decoder.decode());
    parser.end();
    return out;
  };

  try {
    return await attempt(select);
  } catch (e) {
    if (!select) throw e;
    console.warn(`gid ${gid}: select failed (${e.message}) — retrying full tab`);
    return await attempt(null);   // ปลอดภัยไว้ก่อน: ดึงทั้งแท็บแล้วหาคอลัมน์จากชื่อ
  }
}

// ---- dataset builders (map ทีละแถว ไม่เก็บ matrix) ----
const buildSummaryRow = (h) => {
  const c = { month: h.exact('Month-Year'), platform: h.exact('Platform'), pillar: h.exact('Profile'),
    reactions: h.incl('Reactions'), impressions: h.exact('Impressions/views of posts'),
    posts: h.incl('Number of posts') };
  return (r) => {
    const platform = clean(r[c.platform]);
    if (!platform) return null;
    return { month: clean(r[c.month]), platform, pillar: clean(r[c.pillar]),
      reactions: Math.round(num(r[c.reactions])), impressions: Math.round(num(r[c.impressions])),
      posts: Math.round(num(r[c.posts])) };
  };
};
const buildPostRow = (h) => {
  const c = { pillar: h.exact('Pillar'), date: h.exact('Date'), message: h.exact('Message'),
    profile: h.exact('Profile'), network: h.exact('Network'), reactions: h.incl('Reactions'),
    impressions: h.exact('Impressions/views of posts'), link: h.exact('Link') };
  return (r) => {
    const network = normNet(r[c.network]);
    if (!network) return null;
    return { date: toISO(r[c.date]), network, pillar: clean(r[c.pillar]), profile: clean(r[c.profile]),
      engagement: Math.round(num(r[c.reactions])), impressions: Math.round(num(r[c.impressions])),
      message: trimMsg(r[c.message], 90), link: clean(r[c.link]).replace(/\\/g, '') };
  };
};
const buildTutorRow = (h) => {
  const c = { month: h.exact('Month-Year'), tutor: h.exact('Tutor'), profile: h.exact('Profile'),
    network: h.exact('Network'), follower: h.exact('Follower'), growth: h.incl('Follower Growth'),
    posts: h.incl('Number of posts'), eng: h.incl('Reactions'), rate: h.incl('interaction rate') };
  return (r) => {
    const tutor = clean(r[c.tutor]);
    if (!tutor) return null;
    return { month: clean(r[c.month]), tutor, profile: clean(r[c.profile]), network: normNet(r[c.network]),
      follower: Math.round(num(r[c.follower])), followerGrowth: Math.round(num(r[c.growth])),
      posts: Math.round(num(r[c.posts])), engagement: Math.round(num(r[c.eng])), rate: num(r[c.rate]) };
  };
};
const buildTutorPostRow = (h) => {
  const c = { date: h.exact('Date'), tutor: h.exact('Tutor'), network: h.exact('Network'),
    profile: h.exact('Profile'), message: h.exact('Message'), eng: h.incl('Reactions'),
    impressions: h.exact('Impressions/views of posts'), reach: h.incl('Reach per post'), link: h.exact('Link') };
  return (r) => {
    const tutor = clean(r[c.tutor]), network = normNet(r[c.network]);
    if (!tutor || !network) return null;
    return { date: toISO(r[c.date]), tutor, network, profile: clean(r[c.profile]),
      engagement: Math.round(num(r[c.eng])), impressions: Math.round(num(r[c.impressions])),
      reachPerPost: Math.round(num(r[c.reach])), message: trimMsg(r[c.message], 80),
      link: clean(r[c.link]).replace(/\\/g, '') };
  };
};
const buildCollabRow = (h) => {
  const c = { month: h.exact('Month-Year'), tutor: h.exact('Tutor'), network: h.exact('Network'),
    posts: h.incl('Number of posts'), eng: h.incl('Reactions'), impressions: h.exact('Impressions/views of posts'),
    reach: h.incl('Reach per post'), watch: h.incl('watch time') };
  return (r) => {
    const tutor = clean(r[c.tutor]);
    if (!tutor) return null;
    return { month: clean(r[c.month]), tutor, network: normNet(r[c.network]),
      posts: Math.round(num(r[c.posts])), engagement: Math.round(num(r[c.eng])),
      impressions: Math.round(num(r[c.impressions])), reachPerPost: Math.round(num(r[c.reach])),
      watch: Math.round(num(r[c.watch]) * 100) / 100 };
  };
};
const buildCollabPostRow = (h) => {
  const c = { date: h.exact('Date'), tutor: h.exact('Tutor'), collab: h.exact('Collaboration'),
    network: h.exact('Network'), profile: h.exact('Profile'), message: h.exact('Message'),
    eng: h.incl('Reactions'), impressions: h.exact('Impressions/views of posts'),
    reach: h.incl('Reach per post'), rate: h.incl('Engage Rate'), link: h.exact('Link') };
  return (r) => {
    const tutor = clean(r[c.tutor]), collaboration = clean(r[c.collab]);
    if (!tutor && !collaboration) return null;
    return { date: toISO(r[c.date]), tutor, collaboration, network: normNet(r[c.network]),
      profile: clean(r[c.profile]), engagement: Math.round(num(r[c.eng])),
      impressions: Math.round(num(r[c.impressions])), reachPerPost: Math.round(num(r[c.reach])),
      rate: num(r[c.rate]), message: trimMsg(r[c.message], 80), link: clean(r[c.link]).replace(/\\/g, '') };
  };
};

// ---- meta ----
const MONTH_ORDER = Object.keys(MONTHS);
function latestMonth(summary) {
  let best = null, bestKey = -1;
  for (const r of summary) {
    const m = /^([A-Za-z]{3})[a-z]*\s+(\d{4})$/.exec(r.month || '');
    if (!m) continue;
    const key = (+m[2]) * 12 + MONTH_ORDER.indexOf(m[1]);
    if (key > bestKey) { bestKey = key; best = r.month; }
  }
  return best;
}
function stamp() {
  const now = new Date(), pad = (n) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ` +
         `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`;
}

// ---- แยก cache ตามชุดข้อมูล: หน้าไหนขอ ถึงจะดึงชุดนั้น ----
// เก็บเฉพาะ JSON string + gzip buffer (ทิ้ง object array หลัง stringify เพื่อประหยัด RAM)
const SETS = {
  core: {                    // หน้าภาพรวม — เล็กมาก
    load: async () => {
      const summary = await fetchRows(GID_SUMMARY, null, buildSummaryRow, ['Platform']);
      return { summary, extraMeta: { month: latestMonth(summary) || '',
        rows: summary.length, postsAnalyzed: summary.reduce((s, r) => s + r.posts, 0) } };
    },
  },
  posts: {                   // หน้า Pillar
    load: async () => {
      const posts = await fetchRows(GID_POSTS, SELECT_POSTS, buildPostRow, ['Network', 'Pillar', 'Date']);
      return { posts, extraMeta: { postsAnalyzed: posts.length } };
    },
  },
  tutors: {                  // หน้า Tutor
    load: async () => {
      const tutors = await fetchRows(GID_TUTOR, null, buildTutorRow, ['Tutor']);
      const tutorPosts = await fetchRows(GID_TCONTENT, SELECT_TCONTENT, buildTutorPostRow, ['Tutor', 'Network', 'Date']);
      return { tutors, tutorPosts };
    },
  },
  collab: {                  // หน้า IG Collab
    load: async () => {
      const collab = await fetchRows(GID_COLLAB, null, buildCollabRow, ['Tutor']);
      const collabPosts = await fetchRows(GID_COLLABPOSTS, null, buildCollabPostRow, ['Tutor']);
      return { collab, collabPosts };
    },
  },
};

const CACHE = {};        // name -> { ts, json, gz }
const INFLIGHT = {};     // name -> Promise (รวม request ที่ขอพร้อมกันให้ดึงครั้งเดียว)
let META = { source: 'Raw data Pillar SMP', month: '', generatedAt: '', rows: 0, postsAnalyzed: 0 };

async function loadSet(name) {
  const t0 = Date.now();
  const { extraMeta, ...payload } = await SETS[name].load();
  if (extraMeta) META = { ...META, ...extraMeta };
  META.generatedAt = stamp();
  const json = JSON.stringify({ meta: META, ...payload });
  const gz = await gzip(json, { level: 6 });          // async — ไม่บล็อก event loop
  CACHE[name] = { ts: Date.now(), json, gz };
  const counts = Object.entries(payload).map(([k, v]) => `${k}=${v.length}`).join(' ');
  console.log(`[${name}] ready in ${((Date.now()-t0)/1000).toFixed(1)}s  ${counts}  json=${(json.length/1048576).toFixed(2)}MB gz=${(gz.length/1048576).toFixed(2)}MB rss=${(process.memoryUsage().rss/1048576).toFixed(0)}MB`);
}
function refresh(name) {
  if (!INFLIGHT[name]) {
    INFLIGHT[name] = loadSet(name)
      .catch(e => { console.error(`[${name}] refresh failed:`, e.message); })
      .finally(() => { delete INFLIGHT[name]; });
  }
  return INFLIGHT[name];
}

// สำรองไว้กรณีดึงชีตไม่ได้ตอนเพิ่งบูต — ใช้ snapshot ที่ commit ไว้ในโปรเจกต์
let DISK_FALLBACK = null;
try {
  const raw = fs.readFileSync(path.join(PUBLIC, 'content-data.json'), 'utf8');
  const d = JSON.parse(raw);
  if (d && Array.isArray(d.summary)) {
    d.meta = { ...(d.meta || {}), stale: true };
    DISK_FALLBACK = JSON.stringify({ meta: d.meta, summary: d.summary });
  }
} catch (e) { /* ไม่มีก็ไม่เป็นไร */ }

// ---- routes ----
// /healthz ต้องมาก่อนทุกอย่างและตอบทันทีเสมอ (Render ใช้เช็กว่าปลุกเครื่องสำเร็จไหม)
app.get('/healthz', (req, res) => res.status(200).send('ok'));

function serve(name) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-cache');
    const hit = CACHE[name];
    if (!hit) {
      await refresh(name);                                   // ครั้งแรก: ต้องรอ
      if (!CACHE[name]) {
        if (name === 'core' && DISK_FALLBACK) {              // ชีตล่ม -> ส่ง snapshot เก่าดีกว่าจอว่าง
          res.type('application/json');
          return res.end(DISK_FALLBACK);
        }
        return res.status(503).json({ error: 'data unavailable', meta: META });
      }
    } else if (req.query.fresh === '1' || Date.now() - hit.ts >= CACHE_MS) {
      refresh(name);                                         // stale: ส่งของเดิมก่อน แล้วอัปเดตเบื้องหลัง
    }
    const c = CACHE[name];
    res.type('application/json');
    if ((req.headers['accept-encoding'] || '').includes('gzip') && c.gz) {
      res.set('Content-Encoding', 'gzip');
      res.set('Vary', 'Accept-Encoding');
      return res.end(c.gz);
    }
    res.end(c.json);
  };
}

app.get('/content-data.json', serve('core'));      // meta + summary (หน้าภาพรวม)
app.get('/data/posts.json',   serve('posts'));     // meta + posts
app.get('/data/tutors.json',  serve('tutors'));    // meta + tutors + tutorPosts
app.get('/data/collab.json',  serve('collab'));    // meta + collab + collabPosts

app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});
app.use(express.static(PUBLIC));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'content-dashboard.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log('Content Performance Dashboard (live sheet) on port ' + PORT);
  refresh('core');    // อุ่นเฉพาะชุดเล็ก ชุดใหญ่รอให้หน้านั้น ๆ ขอเอง
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message));

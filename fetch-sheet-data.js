/**
 * fetch-sheet-data.js
 * ดึงข้อมูลล่าสุดจาก Google Sheet "Raw data Pillar SMP" -> เขียนทับ public/content-data.json
 *
 * วิธีใช้:   npm run update-data
 * หลังรันแล้ว ถ้าจะให้เว็บบน Render อัปเดตด้วย ให้ commit + push:
 *   git add public/content-data.json && git commit -m "update data" && git push
 *
 * ข้อกำหนด: Node 18+ , ชีตเปิดสิทธิ์ "Anyone with the link -> Viewer" , ใส่ gid ให้ถูกใน CONFIG
 */
const fs = require('fs');
const path = require('path');

const CONFIG = {
  sheetId: '1PORT556ite9ATGh91lYc3KdGAMz6h4fVoL_0vM6u0g4',
  source: 'Raw data Pillar SMP',
  month: 'May 2026',
  tabs: { summary: { gid: '0' }, posts: { gid: '' } },
  topPostsCount: 20,
  outFile: path.join(__dirname, 'public', 'content-data.json'),
};

const csvUrl = (gid) => `https://docs.google.com/spreadsheets/d/${CONFIG.sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`;

function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else {
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
function toObjects(rows) {
  if (!rows.length) return { idx: () => -1, body: [] };
  const head = rows[0].map(h => h.trim());
  const idx = (kw) => head.findIndex(h => h.toLowerCase().includes(kw.toLowerCase()));
  return { idx, body: rows.slice(1).filter(r => r.some(c => c.trim() !== '')) };
}
const num = (v) => { const n = parseFloat(String(v || '').replace(/,/g, '').trim()); return isNaN(n) ? 0 : n; };
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function fetchCsv(gid) {
  const res = await fetch(csvUrl(gid));
  const text = await res.text();
  if (text.trim().startsWith('<') || text.includes('<!DOCTYPE'))
    throw new Error('ได้ HTML แทน CSV — ตรวจสอบว่าชีตเปิดสิทธิ์ "Anyone with the link" และ gid ถูกต้อง');
  return parseCSV(text);
}
function buildSummary(rows) {
  const { idx, body } = toObjects(rows);
  const c = { month: idx('Month'), platform: idx('Platform'), pillar: idx('Profile'),
    reactions: idx('Reactions'), avgEng: idx('Average Engagement'),
    impressions: idx('Impressions/views of posts'), impPerPost: idx('per post'),
    posts: idx('Number of posts'), postsPerDay: idx('per day'), rate: idx('interaction rate') };
  return body.map(r => ({
    month: clean(r[c.month]), platform: clean(r[c.platform]), pillar: clean(r[c.pillar]),
    reactions: Math.round(num(r[c.reactions])), avgEngagement: Math.round(num(r[c.avgEng]) * 100) / 100,
    impressions: Math.round(num(r[c.impressions])), impPerPost: Math.round(num(r[c.impPerPost])),
    posts: Math.round(num(r[c.posts])), postsPerDay: Math.round(num(r[c.postsPerDay]) * 1000) / 1000,
    interactionRate: clean(r[c.rate]),
  })).filter(x => x.platform);
}
function buildPosts(rows) {
  const { idx, body } = toObjects(rows);
  const c = { pillar: idx('Pillar'), date: idx('Date'), message: idx('Message'), profile: idx('Profile'),
    network: idx('Network'), reactions: idx('Reactions'), impressions: idx('Impressions'), link: idx('Link') };
  return body.map(r => {
    let msg = clean(r[c.message]); if (msg.length > 140) msg = msg.slice(0, 140) + '...';
    return { pillar: clean(r[c.pillar]), date: clean(r[c.date]), network: clean(r[c.network]),
      profile: clean(r[c.profile]), engagement: Math.round(num(r[c.reactions])),
      impressions: Math.round(num(r[c.impressions])), link: clean(r[c.link]), message: msg };
  }).filter(x => x.network);
}
(async () => {
  try {
    console.log('⏳ ดึงข้อมูลจาก Google Sheet…');
    const prev = fs.existsSync(CONFIG.outFile) ? JSON.parse(fs.readFileSync(CONFIG.outFile, 'utf8')) : {};
    const summary = buildSummary(await fetchCsv(CONFIG.tabs.summary.gid));
    console.log(`  ✓ สรุปรายเดือน: ${summary.length} แถว`);
    let topPosts = prev.topPosts || [];
    let postsAnalyzed = prev.meta ? prev.meta.postsAnalyzed : 0;
    if (CONFIG.tabs.posts.gid) {
      const posts = buildPosts(await fetchCsv(CONFIG.tabs.posts.gid));
      postsAnalyzed = posts.length;
      topPosts = posts.sort((a, b) => b.engagement - a.engagement).slice(0, CONFIG.topPostsCount);
      console.log(`  ✓ รายโพสต์: ${posts.length} โพสต์ (เก็บ Top ${topPosts.length})`);
    } else console.log('  • ข้ามแท็บรายโพสต์ (ยังไม่ได้ตั้ง gid) — คงข้อมูล Top Posts เดิมไว้');
    const now = new Date(); const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const out = { meta: { source: CONFIG.source, sheetId: CONFIG.sheetId, month: CONFIG.month,
      generatedAt: stamp, rows: summary.length, postsAnalyzed }, summary, topPosts };
    fs.writeFileSync(CONFIG.outFile, JSON.stringify(out, null, 2), 'utf8');
    console.log(`✅ เขียน public/content-data.json สำเร็จ (อัปเดต ${stamp})`);
  } catch (err) { console.error('❌ ดึงข้อมูลไม่สำเร็จ:', err.message); process.exit(1); }
})();

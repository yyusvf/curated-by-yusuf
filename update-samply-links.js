#!/usr/bin/env node
/**
 * Samply Link Updater
 *
 * Samply switched share links from  ?si=<account>  to  ?token=<per-project-uuid>.
 * The project ID is unchanged, so new links can be matched to existing comps
 * automatically — in any order, from any pasted text.
 *
 * Usage:
 *   1. Paste all new Samply links into a text file (one per line, or just dump
 *      them — surrounding text is ignored).
 *   2. node update-samply-links.js new-links.txt
 *   3. node build.js
 *
 *   node update-samply-links.js new-links.txt --dry   → preview, writes nothing
 *   node update-samply-links.js --missing             → list comps still on old links
 */

const fs = require('fs');
const path = require('path');

const ROOT        = process.cwd();
const TRACKER_DIR = path.join(ROOT, 'tracker');
const JSON_PATH   = path.join(ROOT, 'comps-data.json');

const args    = process.argv.slice(2);
const DRY     = args.includes('--dry');
const MISSING = args.includes('--missing');
const inputFile = args.find(a => !a.startsWith('--'));

// Matches https://samply.app/p/<id>  and  /player/<id>, capturing id + optional token
const LINK_RE = /samply\.app\/(?:p|player)\/([A-Za-z0-9_-]+)(\?[^\s"'<>)\]]*)?/g;

function parseLinks(text) {
  const map = new Map(); // projectId -> token
  let m;
  while ((m = LINK_RE.exec(text)) !== null) {
    const id = m[1];
    const qs = m[2] || '';
    const tok = (qs.match(/[?&]token=([0-9a-fA-F-]{8,})/) || [])[1];
    if (tok) map.set(id, tok);
  }
  return map;
}

function findUrlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findUrlFiles(full));
    else if (entry.name.toLowerCase().endsWith('.url')) out.push(full);
  }
  return out;
}

const urlFileRe = /^URL=(.*)$/mi;
function readUrlFile(f) {
  const m = fs.readFileSync(f, 'utf8').match(urlFileRe);
  return m ? m[1].trim() : null;
}
function idOf(url) {
  const m = url && url.match(/samply\.app\/(?:p|player)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
function hasToken(url) { return !!(url && /[?&]token=/.test(url)); }
function newUrl(id, token) { return `https://samply.app/p/${id}?token=${token}`; }

// ─── collect current state ───────────────────────────────────────────────────
if (!fs.existsSync(TRACKER_DIR)) { console.error('tracker/ not found'); process.exit(1); }
const urlFiles = findUrlFiles(TRACKER_DIR).map(f => ({ file: f, url: readUrlFile(f) }));
const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

const jsonEntries = [];
for (const era of data) for (const comp of (era.comps || [])) {
  if (comp.samply) jsonEntries.push({ era: era.id, comp: comp.id, obj: comp });
}

// ─── --missing: report only ──────────────────────────────────────────────────
if (MISSING || !inputFile) {
  const stale = [];
  for (const u of urlFiles) if (u.url && !hasToken(u.url))
    stale.push(`${path.relative(TRACKER_DIR, u.file).split(path.sep).join(String.fromCharCode(47))}  (${idOf(u.url)})`);
  for (const j of jsonEntries) if (!hasToken(j.obj.samply))
    stale.push(`comps-data.json → ${j.era}/${j.comp}  (${idOf(j.obj.samply)})`);

  const okCount = urlFiles.filter(u => hasToken(u.url)).length + jsonEntries.filter(j => hasToken(j.obj.samply)).length;
  console.log(`\n✅  ${okCount} link(s) already on the new token format`);
  console.log(`⚠️   ${stale.length} still on the old format:\n`);
  stale.forEach(s => console.log('   ' + s));
  if (!inputFile) console.log('\nRun:  node update-samply-links.js <file-with-new-links.txt>\n');
  process.exit(0);
}

// ─── apply new links ─────────────────────────────────────────────────────────
if (!fs.existsSync(inputFile)) { console.error(`File not found: ${inputFile}`); process.exit(1); }
const tokens = parseLinks(fs.readFileSync(inputFile, 'utf8'));
console.log(`\n🔎  Found ${tokens.size} link(s) with a token in ${inputFile}\n`);
if (!tokens.size) {
  console.error('No links containing ?token=… were found. Make sure you copied the NEW share links.');
  process.exit(1);
}

let updated = 0, already = 0, untouched = 0;
const usedIds = new Set();

for (const u of urlFiles) {
  const id = idOf(u.url);
  if (!id) continue;
  const tok = tokens.get(id);
  if (!tok) { if (!hasToken(u.url)) untouched++; continue; }
  usedIds.add(id);
  const next = newUrl(id, tok);
  if (u.url === next) { already++; continue; }
  if (!DRY) fs.writeFileSync(u.file, `[InternetShortcut]\r\nURL=${next}\r\n`);
  console.log(`   ✏️  ${path.relative(TRACKER_DIR, u.file).split(path.sep).join(String.fromCharCode(47))}`);
  updated++;
}

for (const j of jsonEntries) {
  const id = idOf(j.obj.samply);
  if (!id) continue;
  const tok = tokens.get(id);
  if (!tok) { if (!hasToken(j.obj.samply)) untouched++; continue; }
  usedIds.add(id);
  const next = newUrl(id, tok);
  if (j.obj.samply === next) { already++; continue; }
  j.obj.samply = next;
  console.log(`   ✏️  comps-data.json → ${j.era}/${j.comp}`);
  updated++;
}

if (!DRY) fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2));

const unmatched = [...tokens.keys()].filter(id => !usedIds.has(id));

console.log(`\n${DRY ? '🧪  DRY RUN — nothing written' : '💾  Written'}`);
console.log(`   ${updated} updated · ${already} already current · ${untouched} still on old links`);
if (unmatched.length) {
  console.log(`\n❓  ${unmatched.length} new link(s) did not match any comp (project ID unknown here):`);
  unmatched.forEach(id => console.log('   ' + id));
}
console.log(`\n👉  Next: node build.js\n`);

#!/usr/bin/env node
/**
 * curated-by-yusuf — Studio
 * Lokales Tool zum Verwalten von Eras/Comps mit UI.
 *
 * Startet einen lokalen Server auf http://localhost:4747
 * und öffnet das UI im Browser.
 *
 * Setup (einmalig):  npm install @aws-sdk/client-s3
 * Start:             node studio/server.js
 *                    (oder Doppelklick auf studio.bat / studio.command)
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ─── PATHS ───────────────────────────────────────────────────────────────────
const ROOT        = path.resolve(__dirname, '..');           // Repo-Root
const TRACKER_DIR = path.join(ROOT, 'tracker');
const JSON_PATH   = path.join(ROOT, 'comps-data.json');
const BUILT_PATH  = path.join(ROOT, 'comps-data-built.json');
const PORT        = 4747;

// ─── R2 CONFIG ───────────────────────────────────────────────────────────────
const R2 = {
  accountId: '790af7ed7ca5243faf0e34df7bc94696',
  accessKey: '681064fae98e11262f3900de31b5de4c',
  secretKey: 'c5db8e4311b3412db4e65796a16127bcc0408f4d8e7bd1d5f32e36bafe2b5f5e',
  bucket:    'curated-by-yusuf',
  publicUrl: 'https://pub-36a7e8a33ae24b2fa57770d9344cbd18.r2.dev',
};

const IMG_EXTS   = new Set(['.jpg','.jpeg','.png','.webp','.gif','.avif']);
const AUDIO_EXTS = new Set(['.mp3','.m4a','.flac','.wav','.ogg','.aac']);

// ─── R2 CLIENT (lazy) ────────────────────────────────────────────────────────
let _s3 = null;
function getS3() {
  if (_s3) return _s3;
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    _s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${R2.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2.accessKey, secretAccessKey: R2.secretKey },
    });
    return _s3;
  } catch {
    return null;
  }
}

// ─── ID3 READER ──────────────────────────────────────────────────────────────
function readID3(filepath) {
  let fd;
  try {
    fd = fs.openSync(filepath, 'r');
    const header = Buffer.alloc(10);
    fs.readSync(fd, header, 0, 10, 0);
    if (header.toString('ascii', 0, 3) !== 'ID3') return {};
    const size = ((header[6]&0x7f)<<21)|((header[7]&0x7f)<<14)|((header[8]&0x7f)<<7)|(header[9]&0x7f);
    const tagData = Buffer.alloc(Math.min(size, 500000));
    fs.readSync(fd, tagData, 0, tagData.length, 10);
    const tags = {};
    let offset = 0;
    while (offset < tagData.length - 10) {
      const frameId = tagData.toString('ascii', offset, offset + 4);
      if (!frameId.match(/^[A-Z0-9]{4}$/)) break;
      const frameSize = tagData.readUInt32BE(offset + 4);
      if (frameSize <= 0 || frameSize > 100000) break;
      if (frameId.startsWith('T') && frameId !== 'TXXX') {
        const fd2 = tagData.slice(offset + 10, offset + 10 + frameSize);
        const enc = fd2[0];
        let text;
        if (enc === 0 || enc === 3) text = fd2.slice(1).toString('utf8').replace(/\0/g,'').trim();
        else if (enc === 1 || enc === 2) text = fd2.slice(3).toString('utf16le').replace(/\0/g,'').trim();
        if (text) tags[frameId] = text;
      }
      offset += 10 + frameSize;
    }
    return tags;
  } catch { return {}; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function parseTitle(raw) {
  const m = raw.match(/\(feat\.?\s+([^)]+)\)/i) || raw.match(/feat\.?\s+(.+)$/i);
  return { title: m ? raw.replace(m[0],'').trim() : raw, feat: m ? m[1].trim() : null };
}
function guessFromFilename(f) {
  const m = f.match(/^(\d+)[\s\-\.]+(.+)\.\w+$/);
  return m ? { n: parseInt(m[1]), title: m[2].trim(), feat: null }
           : { n: null, title: path.basename(f, path.extname(f)), feat: null };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function slugify(str) {
  return str.toLowerCase().trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function loadJSON() {
  if (!fs.existsSync(JSON_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')); }
  catch { return []; }
}
function saveJSON(data) {
  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2));
}

function readTracklistFromFolder(eraId, compId) {
  const compPath = path.join(TRACKER_DIR, eraId, compId);
  if (!fs.existsSync(compPath)) return [];
  const audioFiles = fs.readdirSync(compPath)
    .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase())
             && fs.statSync(path.join(compPath, f)).isFile())
    .sort();
  const tracks = audioFiles.map(f => {
    const tags = readID3(path.join(compPath, f));
    let n, title, feat, editors;
    if (tags['TIT2']) {
      const p = parseTitle(tags['TIT2']);
      title = p.title; feat = p.feat;
      n = tags['TRCK'] ? parseInt(tags['TRCK'].split('/')[0]) : null;
    } else {
      const g = guessFromFilename(f); n = g.n; title = g.title; feat = g.feat;
    }
    if (tags['TPE1']) editors = tags['TPE1'];
    const disc = tags['TPOS'] ? parseInt(tags['TPOS'].split('/')[0]) : null;
    return { n: n||null, title, feat: feat||null, editors: editors||null, _disc: disc, _file: f };
  });
  // Sort by disc (TPOS) then track (TRCK); items without numbers keep file order at the end
  tracks.sort((a, b) => {
    const da = a._disc ?? 1, db = b._disc ?? 1;
    if (da !== db) return da - db;
    const na = a.n ?? Infinity, nb = b.n ?? Infinity;
    if (na !== nb) return na - nb;
    return a._file.localeCompare(b._file);
  });
  return tracks.map(({ _disc, _file, ...t }) => t);
}

// ─── R2 UPLOAD ───────────────────────────────────────────────────────────────
async function uploadToR2(localPath, key) {
  const s3 = getS3();
  if (!s3) throw new Error('AWS SDK nicht installiert. Führe aus: npm install @aws-sdk/client-s3');
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const ext = path.extname(localPath).toLowerCase();
  const mime = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif' }[ext] || 'application/octet-stream';
  await s3.send(new PutObjectCommand({
    Bucket: R2.bucket, Key: key, Body: fs.readFileSync(localPath),
    ContentType: mime, CacheControl: 'public, max-age=31536000',
  }));
}

async function r2Exists(key) {
  const s3 = getS3();
  if (!s3) return false;
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  try { await s3.send(new HeadObjectCommand({ Bucket: R2.bucket, Key: key })); return true; }
  catch { return false; }
}

// Scan tracker for all images, upload new ones
async function uploadAllImages(onProgress) {
  function scan(dir, base='') {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir)) {
      const full = path.join(dir, e);
      const rel  = base ? `${base}/${e}` : e;
      if (fs.statSync(full).isDirectory()) out.push(...scan(full, rel));
      else if (IMG_EXTS.has(path.extname(e).toLowerCase())) out.push({ full, key: `tracker/${rel}` });
    }
    return out;
  }
  const files = scan(TRACKER_DIR);
  let up = 0, skip = 0;
  for (let i = 0; i < files.length; i++) {
    const { full, key } = files[i];
    if (await r2Exists(key)) { skip++; onProgress && onProgress(`⏭️  ${key}`, i+1, files.length); continue; }
    await uploadToR2(full, key);
    up++;
    onProgress && onProgress(`✅ ${key}`, i+1, files.length);
  }
  return { up, skip, total: files.length };
}

// ─── BUILD (comps-data.json + tracker → comps-data-built.json) ───────────────
function runBuild() {
  const data = loadJSON();
  const built = data.map(era => ({
    ...era,
    comps: (era.comps||[]).map(comp => {
      const compPath = path.join(TRACKER_DIR, era.id, comp.id);
      const scanned = { tracklist: [], art: [], samply: null, cover: null };

      if (fs.existsSync(compPath)) {
        const entries = fs.readdirSync(compPath);
        // samply
        const urlFile = entries.find(f => path.extname(f).toLowerCase()==='.url' && fs.statSync(path.join(compPath,f)).isFile());
        if (urlFile) {
          const m = fs.readFileSync(path.join(compPath,urlFile),'utf8').match(/URL=(.+)/i);
          if (m) scanned.samply = m[1].trim();
        }
        // art folder
        const artDir = path.join(compPath, 'art');
        if (fs.existsSync(artDir) && fs.statSync(artDir).isDirectory()) {
          scanned.art = fs.readdirSync(artDir)
            .filter(f => IMG_EXTS.has(path.extname(f).toLowerCase()) && fs.statSync(path.join(artDir,f)).isFile())
            .sort().map(f => `art/${f}`);
        }
        // cover (image named like comp)
        const coverFile = entries.find(f => {
          const ext = path.extname(f).toLowerCase();
          return path.basename(f,ext)===comp.id && IMG_EXTS.has(ext) && fs.statSync(path.join(compPath,f)).isFile();
        });
        if (coverFile) scanned.cover = coverFile;
        // tracklist
        scanned.tracklist = readTracklistFromFolder(era.id, comp.id);
      }

      const tracklist = comp.tracklist?.length ? comp.tracklist
                      : scanned.tracklist.length ? scanned.tracklist
                      : (comp.info||'').split('\n').map((l,i)=>({n:i+1,title:l.trim(),feat:null,editors:null})).filter(t=>t.title);
      let art = scanned.art.length ? scanned.art
               : (comp.art||[]).map(p => { const parts=p.replace(/\\/g,'/').split('/'); const idx=parts.indexOf(comp.id); return idx>=0?parts.slice(idx+1).join('/'):parts[parts.length-1]; });
      const samply = comp.samply || scanned.samply || '';
      const cover = scanned.cover || (comp.cover || comp.id+'.jpg');

      return { ...comp, tracklist, art, samply, cover };
    })
  }));
  fs.writeFileSync(BUILT_PATH, JSON.stringify(built, null, 2));
  const comps = built.reduce((s,e)=>s+e.comps.length,0);
  return { eras: built.length, comps };
}

// ─── GIT ─────────────────────────────────────────────────────────────────────
function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: ROOT }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}
async function gitPush(message) {
  await git(['add', 'comps.html', 'comps-data.json', 'comps-data-built.json', 'index.html']).catch(()=>{});
  await git(['add', '-A', '--', ':!tracker']).catch(()=>{});
  // commit (may fail if nothing to commit)
  try { await git(['commit', '-m', message || 'Update comps via Studio']); }
  catch(e) { if (!/nothing to commit/i.test(e.message)) throw e; }
  await git(['push']);
}

// ─── FILE OPS ────────────────────────────────────────────────────────────────
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function placeFile(eraId, compId, filename, buffer, kind) {
  const compPath = path.join(TRACKER_DIR, eraId, compId);
  ensureDir(compPath);
  const ext = path.extname(filename).toLowerCase();

  if (kind === 'cover') {
    // Save as {compId}.{ext}
    const dest = path.join(compPath, `${compId}${ext}`);
    fs.writeFileSync(dest, buffer);
    return `${compId}${ext}`;
  }
  if (kind === 'art') {
    const artDir = path.join(compPath, 'art');
    ensureDir(artDir);
    const dest = path.join(artDir, filename);
    fs.writeFileSync(dest, buffer);
    return `art/${filename}`;
  }
  if (kind === 'audio') {
    const dest = path.join(compPath, filename);
    fs.writeFileSync(dest, buffer);
    return filename;
  }
  if (kind === 'samply-url') {
    // filename is actually the URL
    const url = filename;
    const dest = path.join(compPath, 'samply.url');
    fs.writeFileSync(dest, `[InternetShortcut]\r\nURL=${url}\r\n`);
    return url;
  }
  // generic
  const dest = path.join(compPath, filename);
  fs.writeFileSync(dest, buffer);
  return filename;
}

// ─── HTTP SERVER ─────────────────────────────────────────────────────────────
function send(res, code, data, type='application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(type==='application/json' ? JSON.stringify(data) : data);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    // ─ UI ─
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    // ─ GET data ─
    if (p === '/api/data' && req.method === 'GET') {
      return send(res, 200, { eras: loadJSON(), r2: R2.publicUrl });
    }

    // ─ POST era ─
    if (p === '/api/era' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString());
      const data = loadJSON();
      const id = body.id || slugify(body.name);
      if (data.find(e => e.id === id)) return send(res, 400, { error: 'Era existiert bereits' });
      data.push({ id, name: body.name, year: body.year||'', description: body.description||'', comps: [] });
      saveJSON(data);
      ensureDir(path.join(TRACKER_DIR, id));
      return send(res, 200, { ok: true, id });
    }

    // ─ PUT era (edit) ─
    if (p === '/api/era' && req.method === 'PUT') {
      const body = JSON.parse((await readBody(req)).toString());
      const data = loadJSON();
      const era = data.find(e => e.id === body.id);
      if (!era) return send(res, 404, { error: 'Era nicht gefunden' });
      if (body.name !== undefined) era.name = body.name;
      if (body.year !== undefined) era.year = body.year;
      if (body.description !== undefined) era.description = body.description;
      saveJSON(data);
      return send(res, 200, { ok: true });
    }

    // ─ POST comp ─
    if (p === '/api/comp' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString());
      const data = loadJSON();
      const era = data.find(e => e.id === body.eraId);
      if (!era) return send(res, 404, { error: 'Era nicht gefunden' });
      const id = body.id || slugify(body.name);
      if (era.comps.find(c => c.id === id)) return send(res, 400, { error: 'Comp existiert bereits' });
      era.comps.push({
        id, name: body.name, editor: body.editor||'', year: body.year||'',
        badges: body.badges||[], samply: body.samply||'', description: body.description||'',
        art: [], tracklist: body.tracklist||[],
      });
      saveJSON(data);
      ensureDir(path.join(TRACKER_DIR, body.eraId, id));
      // Write samply .url if provided
      if (body.samply) placeFile(body.eraId, id, body.samply, null, 'samply-url');
      return send(res, 200, { ok: true, id });
    }

    // ─ PUT comp (edit) ─
    if (p === '/api/comp' && req.method === 'PUT') {
      const body = JSON.parse((await readBody(req)).toString());
      const data = loadJSON();
      const era = data.find(e => e.id === body.eraId);
      if (!era) return send(res, 404, { error: 'Era nicht gefunden' });
      const comp = era.comps.find(c => c.id === body.id);
      if (!comp) return send(res, 404, { error: 'Comp nicht gefunden' });
      ['name','editor','year','samply','description'].forEach(k => { if (body[k] !== undefined) comp[k] = body[k]; });
      if (body.badges !== undefined) comp.badges = body.badges;
      if (body.tracklist !== undefined) comp.tracklist = body.tracklist;
      saveJSON(data);
      if (body.samply) placeFile(body.eraId, body.id, body.samply, null, 'samply-url');
      return send(res, 200, { ok: true });
    }

    // ─ DELETE comp ─
    if (p === '/api/comp' && req.method === 'DELETE') {
      const body = JSON.parse((await readBody(req)).toString());
      const data = loadJSON();
      const era = data.find(e => e.id === body.eraId);
      if (!era) return send(res, 404, { error: 'Era nicht gefunden' });
      era.comps = era.comps.filter(c => c.id !== body.id);
      saveJSON(data);
      return send(res, 200, { ok: true });
    }

    // ─ Read tracklist from folder (ID3) ─
    if (p === '/api/read-tracklist' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString());
      const tl = readTracklistFromFolder(body.eraId, body.compId);
      return send(res, 200, { tracklist: tl });
    }

    // ─ Upload file (cover/art/audio) ─
    if (p === '/api/upload' && req.method === 'POST') {
      const eraId = url.searchParams.get('era');
      const compId = url.searchParams.get('comp');
      const kind = url.searchParams.get('kind');
      const filename = decodeURIComponent(url.searchParams.get('filename')||'file');
      const buffer = await readBody(req);
      const stored = placeFile(eraId, compId, filename, buffer, kind);
      return send(res, 200, { ok: true, stored });
    }

    // ─ PUBLISH: build + upload + push ─
    if (p === '/api/publish' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req) || Buffer.from('{}')).toString() || '{}');
      const steps = body.steps || { build: true, upload: true, push: true };

      // We stream progress via chunked text
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked' });
      const log = (msg) => res.write(msg + '\n');

      try {
        if (steps.build) {
          log('🔨 Build...');
          const b = runBuild();
          log(`   ${b.eras} Eras, ${b.comps} Comps → comps-data-built.json`);
        }
        if (steps.upload) {
          log('☁️  Upload zu R2...');
          const u = await uploadAllImages((m, i, total) => {
            if (i % 25 === 0 || i === total) log(`   [${i}/${total}]`);
          });
          log(`   ${u.up} hochgeladen, ${u.skip} übersprungen`);
        }
        if (steps.push) {
          log('📤 Git push...');
          await gitPush(body.message);
          log('   ✅ Gepusht');
        }
        log('🎉 Fertig!');
      } catch(e) {
        log('❌ Fehler: ' + e.message);
      }
      return res.end();
    }

    return send(res, 404, { error: 'Not found' });
  } catch(e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  const u = `http://localhost:${PORT}`;
  console.log(`\n🎛️   curated-by-yusuf Studio läuft auf ${u}\n`);
  // Open browser
  const cmd = process.platform === 'win32' ? 'start'
            : process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(cmd === 'start' ? 'cmd' : cmd, cmd === 'start' ? ['/c','start',u] : [u], () => {});
});

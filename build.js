#!/usr/bin/env node
/**
 * curated-by-yusuf — Build Script
 *
 * Kombiniert comps-data.json + tracker/ Ordner.
 *
 * Ordnerstruktur:
 *   tracker/
 *     {era-id}/
 *       {comp-id}/
 *         {comp-id}.jpg      ← Cover
 *         irgendwas.url      ← Samply Link (einzige .url Datei)
 *         art/               ← Artworks
 *           bild.jpg
 *         01 Titel.mp3       ← Audio mit ID3-Tags
 *
 * Usage:  node build.js
 *         node build.js /pfad/tracker /pfad/comps-data.json
 */

const fs   = require('fs');
const path = require('path');

const trackerDir = process.argv[2] || path.join(process.cwd(), 'tracker');
const jsonPath   = process.argv[3] || path.join(process.cwd(), 'comps-data.json');
const outPath    = path.join(process.cwd(), 'comps-data-built.json');

const IMG_EXTS   = new Set(['.jpg','.jpeg','.png','.webp','.gif']);
const AUDIO_EXTS = new Set(['.mp3','.m4a','.flac','.wav','.ogg','.aac']);

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
  return {
    title: m ? raw.replace(m[0],'').trim() : raw,
    feat:  m ? m[1].trim() : null,
  };
}

function guessFromFilename(f) {
  const m = f.match(/^(\d+)[\s\-\.]+(.+)\.\w+$/);
  return m ? { n: parseInt(m[1]), title: m[2].trim(), feat: null }
           : { n: null, title: path.basename(f, path.extname(f)), feat: null };
}

// ─── SCAN COMP FOLDER ────────────────────────────────────────────────────────
function scanComp(compPath) {
  const result = { tracklist: [], art: [], samply: null, cover: null };
  if (!fs.existsSync(compPath)) return result;

  const entries = fs.readdirSync(compPath);

  // Samply: einzige .url Datei im Ordner
  const urlFile = entries.find(f => path.extname(f).toLowerCase() === '.url'
    && fs.statSync(path.join(compPath, f)).isFile());
  if (urlFile) {
    const content = fs.readFileSync(path.join(compPath, urlFile), 'utf8');
    const m = content.match(/URL=(.+)/i);
    if (m) result.samply = m[1].trim();
  }

  // Art-Ordner
  const artDir = path.join(compPath, 'art');
  if (fs.existsSync(artDir) && fs.statSync(artDir).isDirectory()) {
    result.art = fs.readdirSync(artDir)
      .filter(f => IMG_EXTS.has(path.extname(f).toLowerCase())
               && fs.statSync(path.join(artDir, f)).isFile())
      .sort()
      .map(f => `art/${f}`);
  }

  // Cover - any image with same name as comp
  let cover = null;
  for (const f of entries) {
    const ext = path.extname(f).toLowerCase();
    const base = path.basename(f, ext);
    if (IMG_EXTS.has(ext) && fs.statSync(path.join(compPath, f)).isFile()) {
      // Extract compId from the path to compare
      cover = f; // Will be validated by caller
    }
  }
  result.cover = cover; // Save for caller to check against compId

  // Audio → Tracklist
  const audioFiles = entries
    .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase())
             && fs.statSync(path.join(compPath, f)).isFile())
    .sort();

  const trackRows = [];
  audioFiles.forEach(f => {
    const tags = readID3(path.join(compPath, f));
    let n, title, feat, editors;
    if (tags['TIT2']) {
      const p = parseTitle(tags['TIT2']);
      title = p.title; feat = p.feat;
      n = tags['TRCK'] ? parseInt(tags['TRCK'].split('/')[0]) : null;
    } else {
      const g = guessFromFilename(f);
      n = g.n; title = g.title; feat = g.feat;
    }
    if (tags['TPE1']) editors = tags['TPE1'];
    const disc = tags['TPOS'] ? parseInt(tags['TPOS'].split('/')[0]) : null;
    if (title) trackRows.push({ n: n||null, title, feat: feat||null, editors: editors||null, _disc: disc, _file: f });
  });
  // Sort by disc (TPOS) then track (TRCK)
  trackRows.sort((a, b) => {
    const da = a._disc ?? 1, db = b._disc ?? 1;
    if (da !== db) return da - db;
    const na = a.n ?? Infinity, nb = b.n ?? Infinity;
    if (na !== nb) return na - nb;
    return a._file.localeCompare(b._file);
  });
  result.tracklist = trackRows.map(({ _disc, _file, ...t }) => t);

  return result;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
if (!fs.existsSync(jsonPath)) { console.error(`❌  JSON nicht gefunden: ${jsonPath}`); process.exit(1); }
if (!fs.existsSync(trackerDir)) { console.error(`❌  tracker/ nicht gefunden: ${trackerDir}`); process.exit(1); }

console.log(`\n📂  JSON:    ${jsonPath}`);
console.log(`📁  tracker: ${trackerDir}\n`);

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
let totTracks=0, totArt=0, totSamply=0, totComps=0;

const built = data.map(era => ({
  ...era,
  comps: (era.comps||[]).map(comp => {
    const compPath = path.join(trackerDir, era.id, comp.id);
    const scanned  = scanComp(compPath);
    totComps++;

    // Tracklist: JSON hat Vorrang, sonst ID3 aus Ordner, sonst info-Text zeilenweise
    let tracklist = comp.tracklist?.length ? comp.tracklist
                  : scanned.tracklist.length ? scanned.tracklist
                  : (comp.info||'').split('\n').map((l,i)=>({n:i+1,title:l.trim(),feat:null,editors:null})).filter(t=>t.title);

    // Art: Ordner hat Vorrang, sonst JSON (Pfade bereinigen)
    let art = scanned.art.length ? scanned.art
             : (comp.art||[]).map(p => {
                 const parts = p.replace(/\\/g,'/').split('/');
                 const idx = parts.indexOf(comp.id);
                 return idx >= 0 ? parts.slice(idx+1).join('/') : parts[parts.length-1];
               });

    // Samply: JSON hat Vorrang, sonst .url Datei
    const samply = comp.samply || scanned.samply || '';

    // Cover: find image file matching comp id (any extension)
    let cover = comp.id + '.jpg'; // default
    if (fs.existsSync(compPath)) {
      const entries = fs.readdirSync(compPath);
      const coverFile = entries.find(f => {
        const ext = path.extname(f).toLowerCase();
        const base = path.basename(f, ext);
        return base === comp.id && IMG_EXTS.has(ext) && fs.statSync(path.join(compPath, f)).isFile();
      });
      if (coverFile) cover = coverFile;
    }

    if (tracklist.length) totTracks += tracklist.length;
    if (art.length) totArt += art.length;
    if (samply) totSamply++;

    // Log
    const markers = [];
    if (scanned.tracklist.length) markers.push(`🎵 ${scanned.tracklist.length}`);
    if (scanned.art.length) markers.push(`🖼️  ${scanned.art.length}`);
    if (scanned.samply) markers.push('🔗');
    if (markers.length) console.log(`   ${comp.id} ${markers.join(' ')}`);

    return { ...comp, tracklist, art, samply, cover };
  })
}));

fs.writeFileSync(outPath, JSON.stringify(built, null, 2));
console.log(`\n✅  ${data.length} Eras · ${totComps} Comps · ${totTracks} Tracks · ${totArt} Artworks · ${totSamply} Samply Links`);
console.log(`💾  ${outPath}\n`);
console.log('🌐  Bilder: https://pub-36a7e8a33ae24b2fa57770d9344cbd18.r2.dev/tracker/...');

#!/usr/bin/env node
/**
 * curated-by-yusuf — Tracker Sync Script
 * 
 * Ordnerstruktur:
 *   tracker/
 *     {era-id}/
 *       {era-id}.jpg          (Era-Cover, optional)
 *       {comp-id}/
 *         {comp-id}.jpg       (Comp-Cover, optional)
 *         01 Titel.mp3        (Tracks mit ID3-Tags)
 *         artwork-1.jpg       (Artworks, optional)
 * 
 * Usage:
 *   node sync.js              → Scannt ./tracker und synct nach Supabase
 *   node sync.js ./pfad       → Anderen Ordner verwenden
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SB_URL = 'https://mrqbtjbtidjuxsuolgue.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ycWJ0amJ0aWRqdXhzdW9sZ3VlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwODgwOTAsImV4cCI6MjA5MzY2NDA5MH0.S6OWEYRY9y51l-DjqiU2h4IXbzfaPPQxb0hoaqfx2XE';

const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac']);

// ─── HTTP HELPER ─────────────────────────────────────────────────────────────
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SB_URL + path);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        } else {
          try { resolve(body ? JSON.parse(body) : null); }
          catch { resolve(body); }
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function upsert(table, rows) {
  if (!rows.length) return;
  // Split into chunks of 100
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    await request('POST', `/rest/v1/${table}`, chunk);
  }
}

async function deleteWhere(table, field, values) {
  if (!values.length) return;
  const list = values.map(v => `"${v}"`).join(',');
  await request('DELETE', `/rest/v1/${table}?${field}=in.(${list})`, null);
}

async function getAll(table, select = '*') {
  return await request('GET', `/rest/v1/${table}?select=${select}&limit=10000`, null) || [];
}

// ─── ID3 READER ──────────────────────────────────────────────────────────────
function readID3(filepath) {
  let fd;
  try {
    fd = fs.openSync(filepath, 'r');
    const header = Buffer.alloc(10);
    fs.readSync(fd, header, 0, 10, 0);

    // Check ID3v2 header
    if (header.toString('ascii', 0, 3) !== 'ID3') return {};

    const size = ((header[6] & 0x7f) << 21) |
                 ((header[7] & 0x7f) << 14) |
                 ((header[8] & 0x7f) << 7)  |
                 (header[9] & 0x7f);

    const tagData = Buffer.alloc(size);
    fs.readSync(fd, tagData, 0, size, 10);

    const tags = {};
    let offset = 0;

    while (offset < size - 10) {
      const frameId = tagData.toString('ascii', offset, offset + 4);
      if (!frameId.match(/^[A-Z0-9]{4}$/)) break;

      const frameSize = tagData.readUInt32BE(offset + 4);
      if (frameSize === 0) break;

      const frameData = tagData.slice(offset + 10, offset + 10 + frameSize);

      // Text frames
      if (frameId.startsWith('T') && frameId !== 'TXXX') {
        const encoding = frameData[0];
        let text;
        if (encoding === 0 || encoding === 3) {
          // ISO-8859-1 or UTF-8
          text = frameData.slice(1).toString('utf8').replace(/\0/g, '').trim();
        } else if (encoding === 1 || encoding === 2) {
          // UTF-16
          text = frameData.slice(3).toString('utf16le').replace(/\0/g, '').trim();
        }
        if (text) tags[frameId] = text;
      }

      offset += 10 + frameSize;
    }

    return tags;
  } catch (e) {
    return {};
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parseTrackNum(str) {
  if (!str) return null;
  const n = parseInt(str.split('/')[0]);
  return isNaN(n) ? null : n;
}

function parseTitle(rawTitle, filename) {
  // Try to extract feat from title: "Title (feat. Artist)"
  const featMatch = rawTitle.match(/\(feat\.?\s+([^)]+)\)/i) ||
                    rawTitle.match(/feat\.?\s+(.+)$/i);
  const feat = featMatch ? featMatch[1].trim() : null;
  const title = featMatch
    ? rawTitle.replace(featMatch[0], '').trim()
    : rawTitle;
  return { title, feat };
}

function guessTrackFromFilename(filename) {
  // "01 Title.mp3" or "01 - Title.mp3" or "01. Title.mp3"
  const m = filename.match(/^(\d+)[\s\-\.]+(.+)\.\w+$/);
  if (m) return { n: parseInt(m[1]), title: m[2].trim(), feat: null };
  return { n: null, title: path.basename(filename, path.extname(filename)).trim(), feat: null };
}

// ─── SLUGIFY ─────────────────────────────────────────────────────────────────
function isImageFile(f) { return IMG_EXTS.has(path.extname(f).toLowerCase()); }
function isAudioFile(f) { return AUDIO_EXTS.has(path.extname(f).toLowerCase()); }

// ─── SCAN ────────────────────────────────────────────────────────────────────
function scanTracker(trackerDir) {
  const eras = [];
  const comps = [];
  const tracks = [];
  const artworks = [];

  if (!fs.existsSync(trackerDir)) {
    console.error(`❌  Ordner nicht gefunden: ${trackerDir}`);
    process.exit(1);
  }

  const eraDirs = fs.readdirSync(trackerDir)
    .filter(f => fs.statSync(path.join(trackerDir, f)).isDirectory())
    .sort();

  eraDirs.forEach((eraId, eraIdx) => {
    const eraPath = path.join(trackerDir, eraId);
    const eraFiles = fs.readdirSync(eraPath);

    eras.push({
      id: eraId,
      name: eraId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      order_index: eraIdx,
    });

    console.log(`📁  Era: ${eraId}`);

    // Comp subdirs
    const compDirs = eraFiles
      .filter(f => fs.statSync(path.join(eraPath, f)).isDirectory())
      .sort();

    compDirs.forEach((compId, compIdx) => {
      const compPath = path.join(eraPath, compId);
      const compFiles = fs.readdirSync(compPath).sort();

      comps.push({
        id: compId,
        era_id: eraId,
        name: compId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        order_index: compIdx,
      });

      console.log(`   💿  Comp: ${compId}`);

      // Scan files in comp
      compFiles.forEach(file => {
        const filePath = path.join(compPath, file);
        const ext = path.extname(file).toLowerCase();
        const basename = path.basename(file);

        if (isAudioFile(file)) {
          // Read ID3 tags
          const tags = readID3(filePath);
          const rawTitle = tags['TIT2'];
          const rawArtist = tags['TPE1'];
          const rawTrack = tags['TRCK'];
          const rawAlbum = tags['TALB'];

          let n, title, feat, editors;

          if (rawTitle) {
            const parsed = parseTitle(rawTitle, basename);
            title = parsed.title;
            feat = parsed.feat;
            n = parseTrackNum(rawTrack);
          } else {
            // Fallback to filename
            const guessed = guessTrackFromFilename(basename);
            n = guessed.n;
            title = guessed.title;
            feat = guessed.feat;
          }

          // Artist field → editors
          if (rawArtist) editors = rawArtist;

          tracks.push({ comp_id: compId, n, title, feat, editors: editors || null });
          console.log(`      🎵  ${n ? `${n}.` : ''} ${title}${feat ? ` feat. ${feat}` : ''}`);
        } else if (isImageFile(file)) {
          // Skip cover (same name as comp) – handled via path helpers
          const nameNoExt = path.basename(file, ext);
          if (nameNoExt !== compId) {
            artworks.push({ comp_id: compId, filename: basename, order_index: artworks.filter(a => a.comp_id === compId).length });
            console.log(`      🖼️   Artwork: ${basename}`);
          }
        }
      });
    });
  });

  return { eras, comps, tracks, artworks };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  const trackerDir = process.argv[2] || path.join(process.cwd(), 'tracker');
  console.log(`\n🔍  Scanne: ${trackerDir}\n`);

  const { eras, comps, tracks, artworks } = scanTracker(trackerDir);

  console.log(`\n📊  Gefunden: ${eras.length} Eras, ${comps.length} Comps, ${tracks.length} Tracks, ${artworks.length} Artworks`);
  console.log('\n⬆️   Sync nach Supabase...\n');

  try {
    // 1. Upsert Eras
    if (eras.length) {
      await upsert('eras', eras);
      console.log(`✅  ${eras.length} Eras`);
    }

    // 2. Upsert Comps
    if (comps.length) {
      await upsert('comps', comps);
      console.log(`✅  ${comps.length} Comps`);
    }

    // 3. Delete old tracks for these comps, then insert fresh
    const compIds = comps.map(c => c.id);
    if (compIds.length) {
      await deleteWhere('tracks', 'comp_id', compIds);
      await deleteWhere('artworks', 'comp_id', compIds);
    }

    // 4. Insert Tracks
    if (tracks.length) {
      await upsert('tracks', tracks);
      console.log(`✅  ${tracks.length} Tracks`);
    }

    // 5. Insert Artworks
    if (artworks.length) {
      await upsert('artworks', artworks);
      console.log(`✅  ${artworks.length} Artworks`);
    }

    console.log('\n🎉  Sync abgeschlossen!\n');
  } catch (e) {
    console.error('\n❌  Sync Fehler:', e.message);
    process.exit(1);
  }
}

main();

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const TRACKER_DIR = path.join(__dirname, 'tracker');
const COVER_MAX = 800;
const ART_MAX = 1600;
const SKIP_BELOW_KB = 50;
const EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files = files.concat(walk(full));
    else if (EXTS.has(path.extname(e.name).toLowerCase())) files.push(full);
  }
  return files;
}

function isArtwork(filePath) {
  const parts = filePath.split(path.sep);
  return parts.includes('art');
}

async function optimizeFile(filePath, index, total) {
  const statBefore = fs.statSync(filePath);
  const beforeKB = statBefore.size / 1024;

  if (beforeKB < SKIP_BELOW_KB) {
    console.log(`[${index}/${total}] SKIP (already small) ${path.relative(TRACKER_DIR, filePath)}`);
    return { saved: 0 };
  }

  const maxPx = isArtwork(filePath) ? ART_MAX : COVER_MAX;
  const ext = path.extname(filePath).toLowerCase();

  try {
    const inputBuffer = fs.readFileSync(filePath);
    const img = sharp(inputBuffer).resize(maxPx, maxPx, { fit: 'inside', withoutEnlargement: true });

    let buf;
    if (ext === '.png') {
      buf = await img.png({ compressionLevel: 8, effort: 10 }).toBuffer();
    } else if (ext === '.webp') {
      buf = await img.webp({ quality: 82 }).toBuffer();
    } else {
      buf = await img.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    }

    // Only write if actually smaller
    if (buf.length < statBefore.size) {
      fs.writeFileSync(filePath, buf);
      const afterKB = buf.length / 1024;
      const pct = Math.round((1 - buf.length / statBefore.size) * 100);
      console.log(`[${index}/${total}] ${path.relative(TRACKER_DIR, filePath)}: ${(beforeKB/1024).toFixed(1)}MB → ${(afterKB/1024).toFixed(1)}MB (-${pct}%)`);
      return { saved: statBefore.size - buf.length };
    } else {
      console.log(`[${index}/${total}] SKIP (already optimal) ${path.relative(TRACKER_DIR, filePath)}`);
      return { saved: 0 };
    }
  } catch (e) {
    console.error(`[${index}/${total}] ERROR ${path.relative(TRACKER_DIR, filePath)}: ${e.message}`);
    return { saved: 0 };
  }
}

async function main() {
  console.log(`Scanning ${TRACKER_DIR}...\n`);
  const files = walk(TRACKER_DIR);
  console.log(`Found ${files.length} images.\n`);

  const CONCURRENCY = 8;
  let totalSaved = 0;
  let done = 0;

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((f, j) => optimizeFile(f, i + j + 1, files.length))
    );
    totalSaved += results.reduce((s, r) => s + r.saved, 0);
  }

  console.log(`\nDone! Total saved: ${(totalSaved / 1024 / 1024).toFixed(1)} MB`);
}

main();

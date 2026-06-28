#!/usr/bin/env node
/**
 * curated-by-yusuf — R2 Upload Script
 * Lädt alle Bilder aus tracker/ nach Cloudflare R2.
 * Nicht in Git committen (enthält Credentials)!
 *
 * Setup:  npm install @aws-sdk/client-s3
 * Usage:  node upload-r2.js
 */

const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const fs   = require('fs');
const path = require('path');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ACCOUNT_ID  = '790af7ed7ca5243faf0e34df7bc94696';
const ACCESS_KEY  = '681064fae98e11262f3900de31b5de4c';
const SECRET_KEY  = 'c5db8e4311b3412db4e65796a16127bcc0408f4d8e7bd1d5f32e36bafe2b5f5e';
const BUCKET      = 'curated-by-yusuf';
const TRACKER_DIR = process.argv[2] || path.join(process.cwd(), 'tracker');

const IMG_EXTS = new Set(['.jpg','.jpeg','.png','.webp','.gif','.avif']);

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
});

function getMimeType(ext) {
  return { '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png',
           '.webp':'image/webp', '.gif':'image/gif', '.avif':'image/avif' }[ext] || 'application/octet-stream';
}

// Scan all image files recursively
function scanImages(dir, base = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel  = base ? `${base}/${entry}` : entry;
    if (fs.statSync(full).isDirectory()) {
      files.push(...scanImages(full, rel));
    } else if (IMG_EXTS.has(path.extname(entry).toLowerCase())) {
      files.push({ full, key: `tracker/${rel}` });
    }
  }
  return files;
}

async function exists(key) {
  try { await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true; }
  catch { return false; }
}

async function upload(file, key) {
  const body = fs.readFileSync(file);
  const ext  = path.extname(file).toLowerCase();
  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: getMimeType(ext),
    CacheControl: 'public, max-age=31536000',
  }));
}

async function main() {
  if (!fs.existsSync(TRACKER_DIR)) {
    console.error(`❌  tracker/ nicht gefunden: ${TRACKER_DIR}`);
    process.exit(1);
  }

  console.log(`\n🔍  Scanne: ${TRACKER_DIR}`);
  const files = scanImages(TRACKER_DIR);
  console.log(`📁  ${files.length} Bilder gefunden\n`);

  let uploaded = 0, skipped = 0, failed = 0;

  for (let i = 0; i < files.length; i++) {
    const { full, key } = files[i];
    const progress = `[${i+1}/${files.length}]`;

    try {
      // Skip if already uploaded
      if (await exists(key)) {
        process.stdout.write(`⏭️   ${progress} ${key}\n`);
        skipped++;
        continue;
      }
      await upload(full, key);
      process.stdout.write(`✅  ${progress} ${key}\n`);
      uploaded++;
    } catch(e) {
      console.error(`❌  ${progress} ${key} — ${e.message}`);
      failed++;
    }
  }

  console.log(`\n🎉  Fertig: ${uploaded} hochgeladen · ${skipped} übersprungen · ${failed} Fehler\n`);
  console.log(`🌐  Base URL: https://pub-36a7e8a33ae24b2fa57770d9344cbd18.r2.dev\n`);
}

main();

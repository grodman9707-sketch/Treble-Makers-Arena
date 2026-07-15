#!/usr/bin/env node
/**
 * Manual / cron offsite backup helper.
 *
 * Copies the newest file in backups/ (or data.json) to BACKUP_OFFSITE_DIR
 * and/or runs BACKUP_OFFSITE_CMD with the file path.
 *
 * Usage (from repo root):
 *   node scripts/offsite-backup.js
 *
 * Cron example (every 6 hours):
 *   0 */6 * * * cd /opt/treble-makers && /usr/bin/node scripts/offsite-backup.js >> logs/backup.log 2>&1
 */

try { require('dotenv').config(); } catch { /* optional */ }

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data.json');
const BACKUP_DIR = path.join(ROOT, 'backups');
const OFFSITE_DIR = (process.env.BACKUP_OFFSITE_DIR || '').trim();
const OFFSITE_CMD = (process.env.BACKUP_OFFSITE_CMD || '').trim();

function latestBackup() {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => /^data-.*\.json$/.test(f))
    .map(f => ({ f, m: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? path.join(BACKUP_DIR, files[0].f) : null;
}

function main() {
  let src = latestBackup();
  if (!src && fs.existsSync(DATA_FILE)) src = DATA_FILE;
  if (!src) {
    console.error('No data.json or backups found.');
    process.exit(1);
  }

  if (!OFFSITE_DIR && !OFFSITE_CMD) {
    console.error('Set BACKUP_OFFSITE_DIR and/or BACKUP_OFFSITE_CMD in .env');
    process.exit(1);
  }

  if (OFFSITE_DIR) {
    fs.mkdirSync(OFFSITE_DIR, { recursive: true });
    const dest = path.join(OFFSITE_DIR, path.basename(src));
    fs.copyFileSync(src, dest);
    console.log(`Copied ${src} → ${dest}`);
  }

  if (OFFSITE_CMD) {
    const result = spawnSync(OFFSITE_CMD, [src], { shell: true, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}

main();

#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const filePath = process.argv[2];
if (!filePath) {
  process.stderr.write('Usage: node scripts/retained-tee.mjs <log-file>\n');
  process.exit(1);
}

const positiveIntEnv = (name, fallback) => {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const maxLines = positiveIntEnv('PIKICLAW_LOG_MAX_LINES', 5000);
const maxAgeMs = positiveIntEnv('PIKICLAW_LOG_MAX_AGE_MS', 24 * 60 * 60 * 1000);
const trimEveryWrites = positiveIntEnv('PIKICLAW_LOG_TRIM_EVERY_WRITES', 200);

const trimRetainedLogFile = () => {
  try {
    const stat = fs.statSync(filePath);
    if (Date.now() - stat.mtimeMs > maxAgeMs) {
      fs.writeFileSync(filePath, '');
      return;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const normalized = content.replace(/\r\n/g, '\n');
    const hasTrailingNewline = normalized.endsWith('\n');
    const lines = normalized.split('\n');
    if (hasTrailingNewline) lines.pop();
    if (lines.length <= maxLines) return;
    fs.writeFileSync(filePath, `${lines.slice(-maxLines).join('\n')}\n`);
  } catch {}
};

fs.mkdirSync(path.dirname(filePath), { recursive: true });
trimRetainedLogFile();

let writes = 0;
process.stdin.on('data', chunk => {
  process.stdout.write(chunk);
  try {
    fs.appendFileSync(filePath, chunk);
    writes++;
    if (writes === 1 || writes % trimEveryWrites === 0) trimRetainedLogFile();
  } catch {}
});

process.stdin.on('end', () => {
  trimRetainedLogFile();
});

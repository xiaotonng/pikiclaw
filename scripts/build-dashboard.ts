/**
 * Build the React dashboard into a single HTML file,
 * then embed it into src/dashboard-ui.ts as a template string export.
 *
 * Usage: npx tsx scripts/build-dashboard.ts
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DASHBOARD_DIR = path.join(ROOT, 'dashboard');
const DIST_HTML = path.join(DASHBOARD_DIR, 'dist', 'index.html');
const OUTPUT_TS = path.join(ROOT, 'src', 'dashboard-ui.ts');

// 1. Run vite build inside dashboard/
console.log('[build-dashboard] Building React app...');
execSync('npx vite build', { cwd: DASHBOARD_DIR, stdio: 'inherit' });

// 2. Read the built single-file HTML
if (!fs.existsSync(DIST_HTML)) {
  console.error('[build-dashboard] ERROR: dist/index.html not found after build');
  process.exit(1);
}
let html = fs.readFileSync(DIST_HTML, 'utf-8');

// 3. Inject version placeholder — replace the literal string %%VERSION%% at runtime
//    We need the dashboard-ui.ts to accept { version } and inject it.
//    Strategy: Insert a meta tag that JS can read, or use a simple string replace.
//    We'll insert a <meta name="codeclaw-version"> tag that the React app can read,
//    but simpler: just use template literal replacement.

// Escape backticks and ${} in the HTML for safe embedding in a JS template literal
html = html.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

// 4. Write dashboard-ui.ts
const tsContent = `/**
 * dashboard-ui.ts — Auto-generated from dashboard/ React app.
 * DO NOT EDIT MANUALLY. Run: npx tsx scripts/build-dashboard.ts
 */

export function getDashboardHtml(opts: { version: string }): string {
  // The React app reads version from window.__CODECLAW_VERSION__
  return \`${html}\`.replace('</head>', \`<script>window.__CODECLAW_VERSION__="\${opts.version}"</script></head>\`);
}
`;

fs.writeFileSync(OUTPUT_TS, tsContent, 'utf-8');
console.log('[build-dashboard] Written', OUTPUT_TS);
console.log('[build-dashboard] Done!');

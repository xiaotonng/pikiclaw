/**
 * macOS LaunchAgent integration for `pikiclaw --daemon`.
 *
 * Every time the user runs pikiclaw with an explicit `--daemon` flag on
 * macOS *without* a LaunchAgent already installed, an osascript dialog asks
 * whether to enable login auto-start. Choosing Enable writes
 * `~/Library/LaunchAgents/ai.pikiclaw.gateway.plist` and loads it via
 * `launchctl bootstrap`. There is intentionally no CLI to disable: the user
 * toggles it off under System Settings → General → Login Items, which is
 * where macOS surfaces every LaunchAgent installed in
 * `~/Library/LaunchAgents`.
 *
 * Decision flow (`maybePromptAutostart`):
 *   1. Non-darwin → no-op.
 *   2. Already running under launchd (PIKICLAW_FROM_LAUNCHD set) → no-op.
 *   3. plist exists but its ProgramArguments no longer point to a valid
 *      binary (e.g. Homebrew migration moved node) → silently rewrite.
 *   4. plist already valid → no-op.
 *   5. Non-interactive (no TTY, CI=1) → no-op.
 *   6. Otherwise → show dialog after a short delay so the bot is already
 *      live when the user sees it. "Not now" silently dismisses; the next
 *      `--daemon` run will ask again.
 */

import { exec, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { whichSync } from '../core/platform.js';

const execFileAsync = promisify(execFile);

const PLIST_LABEL = 'ai.pikiclaw.gateway';
const PLIST_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = path.join(PLIST_DIR, `${PLIST_LABEL}.plist`);
const PIKICLAW_HOME = path.join(os.homedir(), '.pikiclaw');
const PROMPT_DELAY_MS = 3000;

export const FROM_LAUNCHD_ENV = 'PIKICLAW_FROM_LAUNCHD';

interface InvocationCommand {
  program: string;
  args: string[];
}

type DialogChoice = 'enable' | 'not_now' | 'closed';

type LogFn = (msg: string) => void;

/**
 * Resolve the command used to launch pikiclaw, so the plist can re-launch it
 * the same way. We distinguish npx (`.../_npx/<hash>/.../main.js`) from a
 * globally installed binary (`pikiclaw` on PATH).
 */
function detectInvocation(): InvocationCommand | null {
  const entry = process.argv[1] || '';
  const userArgs = process.argv.slice(2);
  if (!userArgs.includes('--daemon')) userArgs.push('--daemon');

  if (entry.includes('/_npx/') || entry.includes('\\_npx\\')) {
    const npxBin = whichSync('npx');
    if (!npxBin) return null;
    return { program: npxBin, args: ['-y', 'pikiclaw@latest', ...userArgs] };
  }

  const pikiclawBin = whichSync('pikiclaw');
  if (pikiclawBin) return { program: pikiclawBin, args: userArgs };
  return null;
}

function plistExists(): boolean {
  try { return fs.statSync(PLIST_PATH).isFile(); } catch { return false; }
}

function isInteractive(): boolean {
  if (process.env.CI) return false;
  if (process.env[FROM_LAUNCHD_ENV]) return false;
  return Boolean(process.stdout.isTTY || process.stderr.isTTY);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  }[c]!));
}

function buildPlistXml(invocation: InvocationCommand): string {
  const programArgs = [invocation.program, ...invocation.args]
    .map(arg => `    <string>${escapeXml(arg)}</string>`)
    .join('\n');
  const stdoutPath = path.join(PIKICLAW_HOME, 'launchd-stdout.log');
  const stderrPath = path.join(PIKICLAW_HOME, 'launchd-stderr.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>${FROM_LAUNCHD_ENV}</key>
    <string>1</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

function plistIsStale(invocation: InvocationCommand): boolean {
  try {
    const xml = fs.readFileSync(PLIST_PATH, 'utf-8');
    return !xml.includes(`<string>${escapeXml(invocation.program)}</string>`);
  } catch {
    return false;
  }
}

async function showEnableDialog(): Promise<DialogChoice> {
  const script = [
    'display dialog ',
    '"Start pikiclaw automatically when you log in?\\n\\n',
    'You can change this anytime in:\\n',
    'System Settings → General → Login Items" ',
    'buttons {"Not now", "Enable"} default button "Enable" ',
    'with title "pikiclaw" with icon note',
  ].join('');
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script]);
    if (stdout.includes('Enable')) return 'enable';
    if (stdout.includes('Not now')) return 'not_now';
    return 'closed';
  } catch {
    // User pressed Cmd-. or closed the dialog — osascript exits non-zero.
    return 'closed';
  }
}

async function bootstrapLaunchAgent(log: LogFn): Promise<boolean> {
  const uid = process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;
  // bootout first so a reinstall replaces any previously-loaded copy. We
  // swallow errors here since bootout fails harmlessly when nothing is loaded.
  await new Promise<void>(resolve => {
    exec(`launchctl bootout ${domain}/${PLIST_LABEL}`, () => resolve());
  });
  try {
    await execFileAsync('launchctl', ['bootstrap', domain, PLIST_PATH]);
    return true;
  } catch (err: any) {
    log(`autostart: launchctl bootstrap failed: ${err?.message || err}`);
    return false;
  }
}

async function installAutostart(log: LogFn, invocation: InvocationCommand): Promise<boolean> {
  try {
    fs.mkdirSync(PLIST_DIR, { recursive: true });
    fs.mkdirSync(PIKICLAW_HOME, { recursive: true });
    fs.writeFileSync(PLIST_PATH, buildPlistXml(invocation));
  } catch (err: any) {
    log(`autostart: failed to write plist: ${err?.message || err}`);
    return false;
  }
  const loaded = await bootstrapLaunchAgent(log);
  if (loaded) log(`autostart: installed LaunchAgent at ${PLIST_PATH}`);
  return loaded;
}

/**
 * Top-level entry called once from the watchdog process when the user passed
 * an explicit `--daemon` flag. Fires and forgets; never throws.
 */
export function maybePromptAutostart(log: LogFn): void {
  if (process.platform !== 'darwin') return;
  if (process.env[FROM_LAUNCHD_ENV]) return;

  const invocation = detectInvocation();
  if (!invocation) return;

  if (plistExists()) {
    if (plistIsStale(invocation)) {
      void installAutostart(msg => log(`autostart (rewrite): ${msg}`), invocation);
    }
    return;
  }

  if (!isInteractive()) return;

  setTimeout(() => {
    void (async () => {
      try {
        const choice = await showEnableDialog();
        if (choice === 'enable') {
          await installAutostart(log, invocation);
        } else {
          log('autostart: not enabled this run; will ask again next time `pikiclaw --daemon` runs');
        }
      } catch (err: any) {
        log(`autostart: prompt failed: ${err?.message || err}`);
      }
    })();
  }, PROMPT_DELAY_MS).unref?.();
}

// ─── exports for tests ─────────────────────────────────────────────────
export const __test = {
  PLIST_LABEL,
  PLIST_PATH,
  detectInvocation,
  buildPlistXml,
  plistIsStale,
  escapeXml,
};

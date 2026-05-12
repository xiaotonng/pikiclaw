/**
 * Cross-platform primitives. All OS-dependent behavior must route through here
 * so the rest of the codebase stays platform-neutral.
 */

import os from 'node:os';
import path from 'node:path';
import which from 'which';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

/**
 * User home directory. Re-reads each call so runtime `$HOME`/`$USERPROFILE`
 * overrides (and tests that mutate them) stay honored. Works on Windows
 * where `$HOME` is not set by default — `os.homedir()` falls back to
 * `$USERPROFILE`.
 */
export function getHome(): string {
  return os.homedir();
}

/** Expand a leading `~` (or `~/`, `~\`) to the user's home directory. */
export function expandTilde(p: string): string {
  if (!p || p[0] !== '~') return p;
  const home = getHome();
  if (p === '~') return home;
  if (p.startsWith('~/') || (IS_WIN && p.startsWith('~\\'))) {
    return path.join(home, p.slice(2));
  }
  return p;
}

/** Locate an executable on PATH, honoring PATHEXT on Windows. */
export function whichSync(cmd: string): string | null {
  return which.sync(cmd, { nothrow: true }) || null;
}

/**
 * Encode an absolute workdir path as a single directory-name segment.
 * Mirrors Claude Code's scheme under `~/.claude/projects/`: every non
 * alphanumeric character collapses to `-`. Critically that includes
 * underscores and dots (e.g. `/path/to/harness_ppt` → `-path-to-harness-ppt`),
 * which matches the encoding Claude Code uses on disk. Replacing only path
 * separators leaves a workdir whose name contains `_` (or `.`) pointing at
 * a directory that does not exist, so session JSONL lookups silently fall
 * back to an empty/truncated result.
 */
export function encodePathAsDirName(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Match a path segment regardless of separator. Useful for probing whether a
 * resolved script path runs under a given binary (e.g. `tsx`, `ts-node`)
 * without hardcoding `/` — which fails on Windows.
 */
export function pathContainsSegment(p: string, segment: string): boolean {
  const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`[\\\\/]${escaped}([\\\\/]|$)`).test(p);
}

/** Null-redirect suffix for shell commands. */
export const DEV_NULL_REDIRECT = IS_WIN ? '2>nul' : '2>/dev/null';

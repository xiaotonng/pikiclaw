#!/usr/bin/env npx tsx
/**
 * E2E test for /restart — standalone script, run directly:
 *
 *   set -a && source .env && set +a && npx tsx test/restart.e2e.test.ts
 *
 * Requires env:
 *   TELEGRAM_BOT_TOKEN — bot token
 *
 * Flow:
 *   1. Spawn bot as child process, record PID1
 *   2. Wait for "polling started" in stdout
 *   3. Send SIGUSR2 to trigger restart (same code path as /restart command)
 *   4. Wait for "new process spawned (PID XXXX)" — extract PID2
 *   5. Wait for old process to exit with code 0
 *   6. Wait for new process to log "polling started"
 *   7. Assert PID1 !== PID2 and new process is alive
 *   8. Clean up (SIGTERM new process)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not set. Aborting.');
  process.exit(1);
}

const CLI_PATH = path.resolve('src/cli.ts');
const TIMEOUT = 90_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForLine(
  proc: ChildProcess,
  pattern: string | RegExp,
  timeoutMs = 60_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout (${timeoutMs}ms) waiting for: ${pattern}`)),
      timeoutMs,
    );
    const check = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        const hit = typeof pattern === 'string' ? line.includes(pattern) : pattern.test(line);
        if (hit) { clearTimeout(timer); resolve(line); return; }
      }
    };
    proc.stdout?.on('data', check);
    proc.stderr?.on('data', check);
  });
}

function waitForExit(proc: ChildProcess, timeoutMs = 30_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null) { resolve(proc.exitCode); return; }
    const timer = setTimeout(() => reject(new Error('Timeout waiting for process exit')), timeoutMs);
    proc.on('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const timer = setTimeout(() => { console.error('FAIL: global timeout'); process.exit(1); }, TIMEOUT);

console.log('--- restart e2e test ---\n');

// 1. Spawn bot with CODECLAW_RESTART_CMD pointing to local code
const child = spawn('npx', ['tsx', CLI_PATH, '-c', 'telegram', '-t', TOKEN], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CODECLAW_RESTART_CMD: `npx tsx ${CLI_PATH}` },
  cwd: process.cwd(),
});

const pid1 = child.pid!;
console.log(`[1] spawned child1  PID=${pid1}`);

child.stdout?.on('data', d => process.stdout.write(`     [child] ${d}`));
child.stderr?.on('data', d => process.stderr.write(`     [child] ${d}`));

// 2. Wait for bot to be ready
await waitForLine(child, 'polling started');
console.log(`[2] child1 ready    (polling started)`);

// 3. Send SIGUSR2
child.kill('SIGUSR2');
console.log(`[3] sent SIGUSR2`);

// 4. Extract new PID from log
const spawnLine = await waitForLine(child, /new process spawned \(PID (\d+)\)/);
const match = spawnLine.match(/PID (\d+)/);
assert(!!match, 'could not extract PID from spawn log');
const pid2 = parseInt(match![1], 10);
console.log(`[4] child2 spawned  PID=${pid2}`);

// 5. Verify PIDs differ
assert(pid2 !== pid1, `PID did not change: ${pid1} === ${pid2}`);
console.log(`[5] PIDs differ     ${pid1} -> ${pid2}  OK`);

// 6. Wait for old process to exit
const exitCode = await waitForExit(child);
assert(exitCode === 0, `child1 exit code = ${exitCode}, expected 0`);
console.log(`[6] child1 exited   code=${exitCode}  OK`);

// 7. Wait for new process to start polling (inherits same stdout pipe)
await waitForLine(child, 'polling started');
console.log(`[7] child2 ready    (polling started)`);

// 8. Verify new process is alive
assert(isAlive(pid2), `child2 (PID ${pid2}) is not alive`);
console.log(`[8] child2 alive    OK`);

// 9. Clean up
process.kill(pid2, 'SIGTERM');
await new Promise(r => setTimeout(r, 2000));
if (isAlive(pid2)) process.kill(pid2, 'SIGKILL');
console.log(`[9] child2 stopped`);

clearTimeout(timer);
console.log('\n--- PASS ---');

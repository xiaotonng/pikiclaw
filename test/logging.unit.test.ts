import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRetainedLogSink,
  normalizeLogLevel,
  pruneRetainedLogFile,
  writeScopedLog,
} from '../src/logging.js';

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('logging helpers', () => {
  const originalLevel = process.env.PIKICLAW_LOG_LEVEL;

  afterEach(() => {
    if (originalLevel == null) delete process.env.PIKICLAW_LOG_LEVEL;
    else process.env.PIKICLAW_LOG_LEVEL = originalLevel;
    vi.restoreAllMocks();
  });

  it('normalizes supported log levels and falls back to info', () => {
    expect(normalizeLogLevel('debug')).toBe('debug');
    expect(normalizeLogLevel('WARN')).toBe('warn');
    expect(normalizeLogLevel('nope')).toBe('info');
  });

  it('suppresses debug logs when runtime level is info', () => {
    process.env.PIKICLAW_LOG_LEVEL = 'info';
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as any);

    const hidden = writeScopedLog('test', 'hidden debug line', { level: 'debug' });
    const shown = writeScopedLog('test', 'visible warn line', { level: 'warn' });

    expect(hidden).toBe(false);
    expect(shown).toBe(true);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(String(stdoutSpy.mock.calls[0]?.[0] || '')).toContain('visible warn line');
  });

  it('prunes retained log files down to the configured line budget', () => {
    const dir = makeTmpDir('pikiclaw-logging-prune-');
    const filePath = path.join(dir, 'test.log');
    fs.writeFileSync(filePath, ['1', '2', '3', '4', '5', ''].join('\n'));

    pruneRetainedLogFile(filePath, { maxLines: 3, maxAgeMs: Number.MAX_SAFE_INTEGER });

    expect(fs.readFileSync(filePath, 'utf8')).toBe(['3', '4', '5', ''].join('\n'));
  });

  it('drops stale retained log files and starts fresh on the next write', () => {
    const dir = makeTmpDir('pikiclaw-logging-stale-');
    const filePath = path.join(dir, 'test.log');
    fs.writeFileSync(filePath, 'old line\n');
    const staleAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(filePath, staleAt, staleAt);

    const sink = createRetainedLogSink(filePath, { maxAgeMs: 24 * 60 * 60 * 1000, trimEveryWrites: 1 });
    sink('fresh line\n');

    expect(fs.readFileSync(filePath, 'utf8')).toBe('fresh line\n');
  });

  it('keeps only the newest retained lines while appending', () => {
    const dir = makeTmpDir('pikiclaw-logging-sink-');
    const filePath = path.join(dir, 'test.log');
    const sink = createRetainedLogSink(filePath, { maxLines: 3, maxAgeMs: Number.MAX_SAFE_INTEGER, trimEveryWrites: 1 });

    sink('a\n');
    sink('b\n');
    sink('c\n');
    sink('d\n');

    expect(fs.readFileSync(filePath, 'utf8')).toBe(['b', 'c', 'd', ''].join('\n'));
  });
});

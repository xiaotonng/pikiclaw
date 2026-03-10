import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type EnvSnapshot = Record<string, string | undefined>;

export function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function captureEnv(keys: readonly string[]): EnvSnapshot {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

export function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

export async function withEnv<T>(
  patch: Record<string, string | undefined>,
  run: () => Promise<T> | T,
): Promise<T> {
  const snapshot = captureEnv(Object.keys(patch));
  restoreEnv(patch);
  try {
    return await run();
  } finally {
    restoreEnv(snapshot);
  }
}

export async function withTempHome<T>(
  run: (homeDir: string) => Promise<T> | T,
  prefix = 'codeclaw-home-',
): Promise<T> {
  const homeDir = makeTmpDir(prefix);
  return withEnv({ HOME: homeDir }, () => run(homeDir));
}

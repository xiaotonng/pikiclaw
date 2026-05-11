// Global vitest setup — runs once per worker before any test file is imported.
//
// Defends against tests accidentally writing to the developer's real
// ~/.pikiclaw/setting.json. Several Bot APIs (switchWorkdir, setUserWorkdir,
// saveUserConfig, …) resolve their target path from PIKICLAW_CONFIG and fall
// back to ~/.pikiclaw/setting.json when it is unset. If a test forgets to
// isolate this variable, every run leaks junk into the user's production
// config and breaks the locally-running pikiclaw daemon.
//
// Tests that need their own clean config can still override PIKICLAW_CONFIG
// inside beforeEach — this only sets a per-worker default.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-test-config-'));
process.env.PIKICLAW_CONFIG = path.join(tmpRoot, 'setting.json');

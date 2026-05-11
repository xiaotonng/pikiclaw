import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getManagedBrowserProfileDir,
  resolveManagedBrowserMcpCommand,
} from '../src/browser-profile.ts';
import {
  buildGuiSetupHints,
  buildSupplementalMcpServers,
  resolveGuiIntegrationConfig,
  resolveMcpServerCommand,
  resolveSendFilePath,
} from '../src/agent/mcp/bridge.ts';
import { makeTmpDir } from './support/env.ts';

function writeFile(filePath: string, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe('resolveMcpServerCommand', () => {
  it('reuses the current CLI entrypoint from source and falls back to the compiled session server', () => {
    // --- Source entrypoint scenario ---
    const root1 = makeTmpDir('pikiclaw-mcp-bridge-');
    const cliPath = path.join(root1, 'src', 'cli', 'main.ts');
    writeFile(cliPath, 'console.log("cli");\n');

    const command1 = resolveMcpServerCommand({
      execPath: '/usr/local/bin/node',
      execArgv: ['--loader', 'tsx', '--inspect=9229'],
      argv: ['node', cliPath],
      moduleUrl: `file://${path.join(root1, 'src', 'agent', 'mcp', 'bridge.ts')}`,
    });

    expect(command1).toEqual({
      command: '/usr/local/bin/node',
      args: ['--loader', 'tsx', cliPath, '--mcp-serve'],
    });

    // --- Compiled session server fallback scenario ---
    const root2 = makeTmpDir('pikiclaw-mcp-bridge-');
    const mcpDir = path.join(root2, 'dist', 'agent', 'mcp');
    const serverPath = path.join(mcpDir, 'session-server.js');
    writeFile(serverPath, 'console.log("server");\n');

    const command2 = resolveMcpServerCommand({
      execPath: '/usr/local/bin/node',
      execArgv: [],
      argv: ['node', path.join(root2, 'other.js')],
      moduleUrl: `file://${path.join(mcpDir, 'bridge.js')}`,
    });

    expect(command2).toEqual({
      command: 'node',
      args: [serverPath],
    });
  });
});

describe('resolveSendFilePath', () => {
  it('prefers workspace-relative files and falls back to workdir-relative files', () => {
    // --- Workspace-relative scenario ---
    const root1 = makeTmpDir('pikiclaw-send-file-');
    const workspacePath1 = path.join(root1, 'workspace');
    const workdir1 = path.join(root1, 'project');
    const workspaceFile = path.join(workspacePath1, 'desktop-screenshot.png');
    const workdirFile1 = path.join(workdir1, 'desktop-screenshot.png');
    writeFile(workspaceFile, 'workspace');
    writeFile(workdirFile1, 'workdir');

    expect(resolveSendFilePath('desktop-screenshot.png', workspacePath1, [], workdir1).path).toBe(workspaceFile);

    // --- Workdir fallback scenario ---
    const root2 = makeTmpDir('pikiclaw-send-file-');
    const workspacePath2 = path.join(root2, 'workspace');
    const workdir2 = path.join(root2, 'project');
    const workdirFile2 = path.join(workdir2, 'desktop-screenshot.png');
    fs.mkdirSync(workspacePath2, { recursive: true });
    writeFile(workdirFile2, 'workdir');

    expect(resolveSendFilePath('desktop-screenshot.png', workspacePath2, [], workdir2).path).toBe(workdirFile2);
  });
});

describe('resolveGuiIntegrationConfig', () => {
  it('defaults browser automation to disabled managed-profile mode', () => {
    const gui = resolveGuiIntegrationConfig({} as any, {});

    expect(gui).toEqual({
      browserEnabled: false,
      browserProfileDir: getManagedBrowserProfileDir(),
      browserHeadless: false,
      peekabooEnabled: false,
    });
  });

  it('prefers env overrides over user config defaults', () => {
    const config = {
      browserEnabled: false,
    };
    const gui = resolveGuiIntegrationConfig(config as any, {
      PIKICLAW_BROWSER_ENABLED: 'true',
      PIKICLAW_BROWSER_HEADLESS: 'true',
    });

    expect(gui).toEqual({
      browserEnabled: true,
      browserProfileDir: getManagedBrowserProfileDir(),
      browserHeadless: true,
      peekabooEnabled: false,
    });
  });

  it('keeps the legacy browser-use-profile env var as a compatibility alias', () => {
    const gui = resolveGuiIntegrationConfig({} as any, {
      PIKICLAW_BROWSER_USE_PROFILE: 'true',
    });

    expect(gui.browserEnabled).toBe(true);
  });
});

describe('buildSupplementalMcpServers', () => {
  it('does not add Playwright MCP when browser automation is disabled', () => {
    const servers = buildSupplementalMcpServers({
      browserEnabled: false,
      browserProfileDir: getManagedBrowserProfileDir(),
      browserHeadless: false,
    });

    expect(servers).toEqual([]);
  });

  it('spawns @playwright/mcp directly in user-data-dir mode when no CDP endpoint is supplied', () => {
    const profileDir = getManagedBrowserProfileDir();
    const expected = resolveManagedBrowserMcpCommand(profileDir, { headless: false });
    const servers = buildSupplementalMcpServers({
      browserEnabled: true,
      browserProfileDir: profileDir,
      browserHeadless: false,
    });

    expect(servers).toEqual([
      {
        name: 'pikiclaw-browser',
        command: expected.command,
        args: expected.args,
      },
    ]);
  });

  it('spawns @playwright/mcp in attach mode when a managed-browser CDP endpoint is supplied', () => {
    const profileDir = path.join('/tmp', 'pikiclaw', 'browser', 'chrome-profile');
    const cdpEndpoint = 'http://127.0.0.1:39222';
    const expected = resolveManagedBrowserMcpCommand(profileDir, { headless: true, cdpEndpoint });
    const servers = buildSupplementalMcpServers({
      browserEnabled: true,
      browserProfileDir: profileDir,
      browserHeadless: true,
    }, {
      cdpEndpoint,
    });

    expect(servers).toEqual([
      {
        name: 'pikiclaw-browser',
        command: expected.command,
        args: expected.args,
      },
    ]);
    expect(expected.args).toContain('--cdp-endpoint');
    expect(expected.args).toContain(cdpEndpoint);
  });
});

describe('buildGuiSetupHints', () => {
  it('returns no browser hints when browser automation is disabled', () => {
    const hints = buildGuiSetupHints({
      browserEnabled: false,
      browserProfileDir: getManagedBrowserProfileDir(),
      browserHeadless: false,
    });

    expect(hints).toEqual([]);
  });

  it('explains the dedicated managed browser profile mode', () => {
    const profileDir = path.join('/tmp', 'pikiclaw', 'browser', 'chrome-profile');
    const hints = buildGuiSetupHints({
      browserEnabled: true,
      browserProfileDir: profileDir,
      browserHeadless: true,
    });

    expect(hints).toEqual([
      `managed browser profile mode enabled; runtime sessions reuse ${profileDir}; configured MCP browser mode=headless. This mode keeps automation isolated from your everyday browser. If the managed browser is already open, pikiclaw will try to attach to it first. When using browser_tabs, use action="new" to open a tab, not "create".`,
    ]);
  });
});

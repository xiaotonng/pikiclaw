import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildGuiSetupHints,
  buildSupplementalMcpServers,
  resolveGuiIntegrationConfig,
  resolveMcpServerCommand,
  resolveSendFilePath,
} from '../src/mcp-bridge.ts';
import { makeTmpDir } from './support/env.ts';

function writeFile(filePath: string, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe('resolveMcpServerCommand', () => {
  it('reuses the current CLI entrypoint from source and falls back to the compiled session server', () => {
    // --- Source entrypoint scenario ---
    const root1 = makeTmpDir('pikiclaw-mcp-bridge-');
    const cliPath = path.join(root1, 'src', 'cli.ts');
    writeFile(cliPath, 'console.log("cli");\n');

    const command1 = resolveMcpServerCommand({
      execPath: '/usr/local/bin/node',
      execArgv: ['--loader', 'tsx', '--inspect=9229'],
      argv: ['node', cliPath],
      moduleUrl: `file://${path.join(root1, 'src', 'mcp-bridge.ts')}`,
    });

    expect(command1).toEqual({
      command: '/usr/local/bin/node',
      args: ['--loader', 'tsx', cliPath, '--mcp-serve'],
    });

    // --- Compiled session server fallback scenario ---
    const root2 = makeTmpDir('pikiclaw-mcp-bridge-');
    const distDir = path.join(root2, 'dist');
    const serverPath = path.join(distDir, 'mcp-session-server.js');
    writeFile(serverPath, 'console.log("server");\n');

    const command2 = resolveMcpServerCommand({
      execPath: '/usr/local/bin/node',
      execArgv: [],
      argv: ['node', path.join(root2, 'other.js')],
      moduleUrl: `file://${path.join(distDir, 'mcp-bridge.js')}`,
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
  it('defaults browser automation to visible extension mode when not configured', () => {
    const gui = resolveGuiIntegrationConfig({} as any, {});

    expect(gui).toEqual({
      browserEnabled: true,
      browserHeadless: false,
      browserIsolated: false,
      browserUseExtension: true,
      browserExtensionToken: '',
      desktopEnabled: process.platform === 'darwin',
      desktopAppiumUrl: 'http://127.0.0.1:4723',
    });
  });

  it('prefers env overrides over user config defaults', () => {
    const config = {
      browserGuiEnabled: true,
      browserGuiHeadless: false,
      browserGuiIsolated: false,
      desktopGuiEnabled: false,
      desktopAppiumUrl: 'http://config-appium:4723',
    };
    const gui = resolveGuiIntegrationConfig(config as any, {
      PIKICLAW_BROWSER_GUI: 'false',
      PIKICLAW_BROWSER_HEADLESS: 'true',
      PIKICLAW_BROWSER_ISOLATED: 'true',
      PIKICLAW_BROWSER_USE_EXTENSION: 'true',
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'token-from-env',
      PIKICLAW_DESKTOP_GUI: 'true',
      PIKICLAW_DESKTOP_APPIUM_URL: 'http://env-appium:4723',
    });

    expect(gui).toEqual({
      browserEnabled: false,
      browserHeadless: true,
      browserIsolated: true,
      browserUseExtension: true,
      browserExtensionToken: 'token-from-env',
      desktopEnabled: true,
      desktopAppiumUrl: 'http://env-appium:4723',
    });
  });
});

describe('buildSupplementalMcpServers', () => {
  it('adds Playwright MCP with the expected flags', () => {
    const servers = buildSupplementalMcpServers({
      browserEnabled: true,
      browserHeadless: true,
      browserIsolated: true,
      browserUseExtension: false,
      browserExtensionToken: '',
      desktopEnabled: true,
      desktopAppiumUrl: 'http://127.0.0.1:4723',
    });

    expect(servers).toEqual([
      {
        name: 'pikiclaw-browser',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'],
      },
    ]);
  });

  it('skips browser integration in extension mode when no token is configured', () => {
    const servers = buildSupplementalMcpServers({
      browserEnabled: true,
      browserHeadless: false,
      browserIsolated: false,
      browserUseExtension: true,
      browserExtensionToken: '',
      desktopEnabled: true,
      desktopAppiumUrl: 'http://127.0.0.1:4723',
    });

    expect(servers).toEqual([]);
  });

  it('uses extension mode to connect to the existing Chrome profile when configured', () => {
    const servers = buildSupplementalMcpServers({
      browserEnabled: true,
      browserHeadless: false,
      browserIsolated: false,
      browserUseExtension: true,
      browserExtensionToken: 'token-from-config',
      desktopEnabled: true,
      desktopAppiumUrl: 'http://127.0.0.1:4723',
    });

    expect(servers).toEqual([
      {
        name: 'pikiclaw-browser',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest', '--extension'],
        env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'token-from-config' },
      },
    ]);
  });
});

describe('buildGuiSetupHints', () => {
  it('tells users to install the Playwright extension when extension mode is enabled', () => {
    const hints = buildGuiSetupHints({
      browserEnabled: true,
      browserHeadless: false,
      browserIsolated: false,
      browserUseExtension: true,
      browserExtensionToken: '',
      desktopEnabled: true,
      desktopAppiumUrl: 'http://127.0.0.1:4723',
    });

    expect(hints).toEqual([
      'browser extension mode enabled; install Playwright MCP Bridge in the current Chrome profile first: https://chromewebstore.google.com/detail/playwright-mcp-bridge/mmlmfjhmonkocbjadbfplnigmagldckm',
      'after installing the extension, open its UI to copy PLAYWRIGHT_MCP_EXTENSION_TOKEN if you want to skip the browser approval prompt',
    ]);
  });

  it('stays quiet when browser automation does not use extension mode', () => {
    const hints = buildGuiSetupHints({
      browserEnabled: true,
      browserHeadless: false,
      browserIsolated: false,
      browserUseExtension: false,
      browserExtensionToken: '',
      desktopEnabled: true,
      desktopAppiumUrl: 'http://127.0.0.1:4723',
    });

    expect(hints).toEqual([]);
  });
});

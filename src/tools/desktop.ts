/**
 * tools/desktop.ts — macOS desktop GUI tools backed by Appium Mac2.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fetch } from 'undici';
import type { McpToolModule, ToolContext, ToolResult } from './types.js';
import { toolLog, toolResult } from './types.js';

const DEFAULT_APPIUM_URL = 'http://127.0.0.1:4723';
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const ARTIFACT_DIR = '.pikiclaw-desktop';

type LocatorStrategy = 'xpath' | 'accessibility id' | 'id' | 'name' | 'class name';

interface DesktopSessionState {
  sessionId: string;
  bundleId: string;
  appiumUrl: string;
  capabilities: Record<string, unknown>;
}

interface AppiumResponse {
  sessionId?: string;
  value?: any;
}

let activeSession: DesktopSessionState | null = null;

const tools: McpToolModule['tools'] = [
  {
    name: 'desktop_status',
    description: 'Check whether the macOS desktop backend is available and whether a desktop session is active.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'desktop_open_app',
    description: 'Open or attach to a macOS app by bundle ID using the Appium Mac2 driver.',
    inputSchema: {
      type: 'object',
      properties: {
        bundleId: {
          type: 'string',
          description: 'macOS bundle ID, for example com.apple.finder or com.google.Chrome.',
        },
        forceNewSession: {
          type: 'boolean',
          description: 'Close any existing desktop session before opening the new app.',
        },
      },
      required: ['bundleId'],
    },
  },
  {
    name: 'desktop_snapshot',
    description: 'Dump the current macOS UI tree from Appium Mac2 and save the full XML into the session workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: {
          type: 'number',
          description: 'Maximum number of XML characters to inline in the tool result. Default 4000.',
        },
      },
    },
  },
  {
    name: 'desktop_click',
    description: 'Click a macOS desktop element by elementId or by locator.',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: {
          type: 'string',
          description: 'Existing element id returned by Appium.',
        },
        strategy: {
          type: 'string',
          enum: ['xpath', 'accessibility id', 'id', 'name', 'class name'],
          description: 'Locator strategy to use when selector is provided. Default xpath.',
        },
        selector: {
          type: 'string',
          description: 'Locator value, for example an XPath query.',
        },
      },
    },
  },
  {
    name: 'desktop_type',
    description: 'Type text into a macOS desktop element by elementId or by locator.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to enter.',
        },
        clear: {
          type: 'boolean',
          description: 'Clear the target element before typing. Default true.',
        },
        elementId: {
          type: 'string',
          description: 'Existing element id returned by Appium.',
        },
        strategy: {
          type: 'string',
          enum: ['xpath', 'accessibility id', 'id', 'name', 'class name'],
          description: 'Locator strategy to use when selector is provided. Default xpath.',
        },
        selector: {
          type: 'string',
          description: 'Locator value, for example an XPath query.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'desktop_screenshot',
    description: 'Capture a PNG screenshot of the current macOS desktop session and save it into the session workspace.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'desktop_close_session',
    description: 'Close the active Appium Mac2 desktop session.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

function currentAppiumUrl(): string {
  return String(process.env.PIKICLAW_DESKTOP_APPIUM_URL || DEFAULT_APPIUM_URL).trim() || DEFAULT_APPIUM_URL;
}

function desktopEnabled(): boolean {
  const raw = String(process.env.PIKICLAW_DESKTOP_GUI || '').trim().toLowerCase();
  if (!raw) return process.platform === 'darwin';
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function desktopUnsupported(): ToolResult {
  return toolResult('Desktop GUI is only supported on macOS in this build.', true);
}

function desktopSetupHint(message: string): ToolResult {
  return toolResult(
    `${message}\n` +
    'Enable desktop automation in the pikiclaw dashboard (Extensions > Desktop Automation > Setup).\n' +
    'Also ensure Accessibility permission is granted to the terminal app running pikiclaw.',
    true,
  );
}

function buildUrl(base: string, pathname: string): URL {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return new URL(pathname.replace(/^\//, ''), normalizedBase);
}

function artifactDir(ctx: ToolContext): string {
  const dir = path.join(ctx.workspace, ARTIFACT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function elementIdFromValue(value: any): string | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value[ELEMENT_KEY] || value.ELEMENT || value.elementId;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

function appiumMessage(payload: any, fallback: string): string {
  const message = payload?.value?.message || payload?.message || payload?.error;
  if (typeof message === 'string' && message.trim()) return message.trim();
  return fallback;
}

async function appiumRequest(
  method: string,
  pathname: string,
  body?: unknown,
  appiumUrl = currentAppiumUrl(),
): Promise<AppiumResponse> {
  let responseText = '';
  try {
    const response = await fetch(buildUrl(appiumUrl, pathname), {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    responseText = await response.text();
    let payload: any = {};
    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = { value: responseText };
      }
    }
    if (!response.ok) throw new Error(appiumMessage(payload, `Appium request failed with HTTP ${response.status}`));
    return payload;
  } catch (error: any) {
    const detail = String(error?.message || error || '').trim();
    if (/ECONNREFUSED|fetch failed|ENOTFOUND|ECONNRESET/i.test(detail)) {
      throw new Error(`Appium server is not reachable at ${appiumUrl}`);
    }
    throw new Error(detail || `Appium request failed for ${pathname}`);
  }
}

async function appiumStatus(appiumUrl = currentAppiumUrl()): Promise<any> {
  return appiumRequest('GET', '/status', undefined, appiumUrl);
}

async function deleteActiveSession(): Promise<void> {
  if (!activeSession) return;
  const { sessionId, appiumUrl } = activeSession;
  activeSession = null;
  try {
    await appiumRequest('DELETE', `/session/${encodeURIComponent(sessionId)}`, undefined, appiumUrl);
  } catch {}
}

async function activateApp(session: DesktopSessionState): Promise<void> {
  await appiumRequest(
    'POST',
    `/session/${encodeURIComponent(session.sessionId)}/execute/sync`,
    { script: 'macos: activateApp', args: [{ bundleId: session.bundleId }] },
    session.appiumUrl,
  );
}

async function createSession(bundleId: string, appiumUrl = currentAppiumUrl()): Promise<DesktopSessionState> {
  const payload = {
    capabilities: {
      alwaysMatch: {
        platformName: 'mac',
        'appium:automationName': 'Mac2',
        'appium:bundleId': bundleId,
        'appium:newCommandTimeout': 300,
      },
      firstMatch: [{}],
    },
  };
  const response = await appiumRequest('POST', '/session', payload, appiumUrl);
  const value = response.value || {};
  const sessionId = String(response.sessionId || value.sessionId || '').trim();
  if (!sessionId) throw new Error('Appium did not return a session id.');
  const session: DesktopSessionState = {
    sessionId,
    bundleId,
    appiumUrl,
    capabilities: typeof value.capabilities === 'object' && value.capabilities ? value.capabilities : {},
  };
  activeSession = session;
  try { await activateApp(session); } catch {}
  return session;
}

async function ensureSession(bundleId?: string): Promise<DesktopSessionState> {
  if (process.platform !== 'darwin') throw new Error('Desktop GUI is only supported on macOS in this build.');
  const targetBundleId = typeof bundleId === 'string' ? bundleId.trim() : '';
  if (activeSession && (!targetBundleId || activeSession.bundleId === targetBundleId)) return activeSession;
  if (!targetBundleId) throw new Error('No desktop session is active. Call desktop_open_app first.');
  if (activeSession && activeSession.bundleId !== targetBundleId) await deleteActiveSession();
  return createSession(targetBundleId);
}

function normalizeStrategy(value: unknown): LocatorStrategy {
  const strategy = String(value || 'xpath').trim().toLowerCase();
  switch (strategy) {
    case 'xpath':
    case 'accessibility id':
    case 'id':
    case 'name':
    case 'class name':
      return strategy;
    default:
      throw new Error(`Unsupported locator strategy: ${strategy}`);
  }
}

async function resolveElementId(session: DesktopSessionState, args: Record<string, unknown>): Promise<string> {
  const direct = typeof args.elementId === 'string' ? args.elementId.trim() : '';
  if (direct) return direct;
  const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
  if (!selector) throw new Error('Provide either elementId or selector.');
  const using = normalizeStrategy(args.strategy);
  const response = await appiumRequest(
    'POST',
    `/session/${encodeURIComponent(session.sessionId)}/element`,
    { using, value: selector },
    session.appiumUrl,
  );
  const resolved = elementIdFromValue(response.value);
  if (!resolved) throw new Error(`No element matched ${using}: ${selector}`);
  return resolved;
}

function saveArtifact(ctx: ToolContext, filename: string, content: Buffer | string): string {
  const filePath = path.join(artifactDir(ctx), filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

async function handleStatus(): Promise<ToolResult> {
  if (!desktopEnabled()) return toolResult('Desktop GUI tools are disabled for this session.', true);
  if (process.platform !== 'darwin') return desktopUnsupported();
  try {
    const url = currentAppiumUrl();
    const status = await appiumStatus(url);
    return toolResult(JSON.stringify({
      ok: true,
      backend: 'appium-mac2',
      appiumUrl: url,
      ready: status?.value?.ready ?? true,
      session: activeSession ? {
        sessionId: activeSession.sessionId,
        bundleId: activeSession.bundleId,
      } : null,
      build: status?.value?.build || null,
    }, null, 2));
  } catch (error: any) {
    return desktopSetupHint(String(error?.message || error || 'Desktop backend unavailable'));
  }
}

async function handleOpenApp(args: Record<string, unknown>): Promise<ToolResult> {
  if (!desktopEnabled()) return toolResult('Desktop GUI tools are disabled for this session.', true);
  if (process.platform !== 'darwin') return desktopUnsupported();
  const bundleId = typeof args.bundleId === 'string' ? args.bundleId.trim() : '';
  const forceNewSession = !!args.forceNewSession;
  if (!bundleId) return toolResult('Error: "bundleId" is required.', true);
  toolLog('desktop_open_app', `bundleId=${bundleId} forceNewSession=${forceNewSession}`);
  try {
    await appiumStatus();
    if (forceNewSession) await deleteActiveSession();
    const session = await ensureSession(bundleId);
    return toolResult(JSON.stringify({
      ok: true,
      backend: 'appium-mac2',
      appiumUrl: session.appiumUrl,
      sessionId: session.sessionId,
      bundleId: session.bundleId,
      capabilities: session.capabilities,
    }, null, 2));
  } catch (error: any) {
    return desktopSetupHint(String(error?.message || error || 'Failed to open desktop app'));
  }
}

async function handleSnapshot(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!desktopEnabled()) return toolResult('Desktop GUI tools are disabled for this session.', true);
  if (process.platform !== 'darwin') return desktopUnsupported();
  const maxChars = Math.max(500, Math.min(12_000, Math.round(Number(args.maxChars) || 4_000)));
  try {
    const session = await ensureSession();
    const response = await appiumRequest('GET', `/session/${encodeURIComponent(session.sessionId)}/source`, undefined, session.appiumUrl);
    const xml = typeof response.value === 'string' ? response.value : '';
    if (!xml) throw new Error('Appium returned an empty source.');
    const filePath = saveArtifact(ctx, `desktop-source-${Date.now()}.xml`, xml);
    return toolResult(JSON.stringify({
      ok: true,
      sessionId: session.sessionId,
      bundleId: session.bundleId,
      savedPath: filePath,
      preview: xml.slice(0, maxChars),
      truncated: xml.length > maxChars,
    }, null, 2));
  } catch (error: any) {
    return desktopSetupHint(String(error?.message || error || 'Failed to capture desktop snapshot'));
  }
}

async function handleClick(args: Record<string, unknown>): Promise<ToolResult> {
  if (!desktopEnabled()) return toolResult('Desktop GUI tools are disabled for this session.', true);
  if (process.platform !== 'darwin') return desktopUnsupported();
  try {
    const session = await ensureSession();
    const elementId = await resolveElementId(session, args);
    await appiumRequest(
      'POST',
      `/session/${encodeURIComponent(session.sessionId)}/element/${encodeURIComponent(elementId)}/click`,
      {},
      session.appiumUrl,
    );
    return toolResult(`Clicked desktop element ${elementId}.`);
  } catch (error: any) {
    return desktopSetupHint(String(error?.message || error || 'Failed to click desktop element'));
  }
}

async function handleType(args: Record<string, unknown>): Promise<ToolResult> {
  if (!desktopEnabled()) return toolResult('Desktop GUI tools are disabled for this session.', true);
  if (process.platform !== 'darwin') return desktopUnsupported();
  const rawText = typeof args.text === 'string' ? args.text : '';
  if (!rawText) return toolResult('Error: "text" is required.', true);
  const clear = args.clear !== false;
  try {
    const session = await ensureSession();
    const elementId = await resolveElementId(session, args);
    if (clear) {
      await appiumRequest(
        'POST',
        `/session/${encodeURIComponent(session.sessionId)}/element/${encodeURIComponent(elementId)}/clear`,
        {},
        session.appiumUrl,
      );
    }
    await appiumRequest(
      'POST',
      `/session/${encodeURIComponent(session.sessionId)}/element/${encodeURIComponent(elementId)}/value`,
      { text: rawText, value: [...rawText] },
      session.appiumUrl,
    );
    return toolResult(`Typed ${rawText.length} characters into desktop element ${elementId}.`);
  } catch (error: any) {
    return desktopSetupHint(String(error?.message || error || 'Failed to type into desktop element'));
  }
}

async function handleScreenshot(ctx: ToolContext): Promise<ToolResult> {
  if (!desktopEnabled()) return toolResult('Desktop GUI tools are disabled for this session.', true);
  if (process.platform !== 'darwin') return desktopUnsupported();
  try {
    const session = await ensureSession();
    const response = await appiumRequest('GET', `/session/${encodeURIComponent(session.sessionId)}/screenshot`, undefined, session.appiumUrl);
    const base64 = typeof response.value === 'string' ? response.value : '';
    if (!base64) throw new Error('Appium returned an empty screenshot.');
    const filePath = saveArtifact(ctx, `desktop-screenshot-${Date.now()}.png`, Buffer.from(base64, 'base64'));
    return toolResult(JSON.stringify({
      ok: true,
      sessionId: session.sessionId,
      bundleId: session.bundleId,
      savedPath: filePath,
    }, null, 2));
  } catch (error: any) {
    return desktopSetupHint(String(error?.message || error || 'Failed to capture desktop screenshot'));
  }
}

async function handleCloseSession(): Promise<ToolResult> {
  if (!desktopEnabled()) return toolResult('Desktop GUI tools are disabled for this session.', true);
  if (process.platform !== 'darwin') return desktopUnsupported();
  if (!activeSession) return toolResult('No desktop session is active.');
  const session = activeSession;
  await deleteActiveSession();
  return toolResult(`Closed desktop session ${session.sessionId} (${session.bundleId}).`);
}

export const desktopTools: McpToolModule = {
  tools,
  handle(name, args, ctx) {
    switch (name) {
      case 'desktop_status': return handleStatus();
      case 'desktop_open_app': return handleOpenApp(args);
      case 'desktop_snapshot': return handleSnapshot(args, ctx);
      case 'desktop_click': return handleClick(args);
      case 'desktop_type': return handleType(args);
      case 'desktop_screenshot': return handleScreenshot(ctx);
      case 'desktop_close_session': return handleCloseSession();
      default: return toolResult(`Unknown desktop tool: ${name}`, true);
    }
  },
};

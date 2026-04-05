/**
 * Dashboard API routes: session CRUD, workspace, streaming state.
 */

import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadUserConfig } from '../../core/config/user-config.js';
import { listAgents, type Agent, type SessionInfo } from '../../agent/index.js';
import { getSessionStatusForBot } from '../../bot/session-status.js';
import {
  cancelSessionTask,
  getSessionStreamState,
  queueDashboardSessionTask,
  steerSessionTask,
} from '../session-control.js';
import {
  querySessions, querySessionTail, querySessionMessages,
  getWorkspaceOverviews,
  updateSession, linkSessions,
  buildMigrationContext,
  exportSession, importSession,
  loadWorkspaces, addWorkspace, removeWorkspace, updateWorkspace,
  resolveUserStatus,
  type UserStatus, type SessionQueryResult,
} from '../../bot/session-hub.js';
import { DASHBOARD_PAGINATION } from '../../core/constants.js';
import { runtime, type DashboardEvent } from '../runtime.js';
import type { Bot } from '../../bot/bot.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_SESSION_PAGE_SIZE = DASHBOARD_PAGINATION.defaultPageSize;
const MAX_SESSION_PAGE_SIZE = DASHBOARD_PAGINATION.maxPageSize;

function parsePageNumber(value: string | null | undefined, fallback = 0): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parsePageSize(value: string | null | undefined, fallback = DEFAULT_SESSION_PAGE_SIZE): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_SESSION_PAGE_SIZE);
}

type DashboardSessionInfo = SessionInfo & { isCurrent?: boolean; workspaceName?: string };

function paginateSessionResult<T>(items: T[], page: number, limit: number) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * limit;
  return {
    sessions: items.slice(start, start + limit),
    page: safePage,
    limit,
    total,
    totalPages,
    hasMore: safePage + 1 < totalPages,
  };
}

const STALE_RUNNING_THRESHOLD_MS = 120_000; // 2 minutes — if a managed record claims 'running' but the bot has no runtime for it, treat as stale after this threshold

function enrichWithRuntimeStatus(sessions: SessionInfo[], bot: Bot | null): DashboardSessionInfo[] {
  return sessions.map(session => {
    const status = bot ? getSessionStatusForBot(bot, session) : null;
    let isRunning = status ? status.isRunning : !!session.running;
    // Stale 'running' detection: after a crash/restart the managed record may
    // still say runState='running' while no bot runtime is tracking the session.
    // Downgrade to incomplete if the last update is old enough.
    if (isRunning && status && !status.runtime && session.runState === 'running') {
      const age = session.runUpdatedAt ? Date.now() - Date.parse(session.runUpdatedAt) : Infinity;
      if (age > STALE_RUNNING_THRESHOLD_MS) isRunning = false;
    }
    return {
      ...session,
      running: isRunning,
      runState: isRunning ? 'running' as const : (session.runState === 'running' ? 'incomplete' : session.runState),
      isCurrent: status?.isCurrent ?? false,
    };
  });
}

function readStringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isUploadFile(value: unknown): value is {
  name?: string;
  type?: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
} {
  return !!value
    && typeof value === 'object'
    && typeof (value as any).arrayBuffer === 'function';
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    case 'image/svg+xml': return '.svg';
    default: return '';
  }
}

function sanitizeUploadFileName(rawName: string, mimeType: string, index: number): string {
  const baseName = path.basename(rawName || `attachment-${index + 1}`);
  const parsed = path.parse(baseName);
  const safeStem = (parsed.name || `attachment-${index + 1}`)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || `attachment-${index + 1}`;
  const ext = parsed.ext || extensionForMimeType(mimeType) || '.bin';
  return `${safeStem}${ext.toLowerCase()}`;
}

async function materializeUploadedFiles(entries: unknown[]): Promise<{ attachments: string[]; cleanup: () => Promise<void> }> {
  const files = entries.filter(isUploadFile);
  if (!files.length) {
    return { attachments: [], cleanup: async () => {} };
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pikiclaw-dashboard-upload-'));
  try {
    const attachments: string[] = [];
    for (const [index, file] of files.entries()) {
      const filename = sanitizeUploadFileName(String(file.name || ''), String(file.type || ''), index);
      const filePath = path.join(tempDir, filename);
      await fs.promises.writeFile(filePath, Buffer.from(await file.arrayBuffer()));
      attachments.push(filePath);
    }
    return {
      attachments,
      cleanup: async () => {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (error) {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function parseSessionSendRequest(c: any): Promise<{
  workdir: string;
  agent: string;
  sessionId: string;
  prompt: string;
  model: string;
  effort: string;
  attachments: string[];
  cleanup: () => Promise<void>;
}> {
  const contentType = String(c.req.header('content-type') || '').toLowerCase();
  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const uploads = await materializeUploadedFiles(form.getAll('attachments'));
    return {
      workdir: readStringField(form.get('workdir')),
      agent: readStringField(form.get('agent')),
      sessionId: readStringField(form.get('sessionId')),
      prompt: readStringField(form.get('prompt')),
      model: readStringField(form.get('model')),
      effort: readStringField(form.get('effort')).toLowerCase(),
      attachments: uploads.attachments,
      cleanup: uploads.cleanup,
    };
  }

  const body = await c.req.json();
  return {
    workdir: readStringField(body?.workdir),
    agent: readStringField(body?.agent),
    sessionId: readStringField(body?.sessionId),
    prompt: readStringField(body?.prompt),
    model: readStringField(body?.model),
    effort: readStringField(body?.effort).toLowerCase(),
    attachments: [],
    cleanup: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const app = new Hono();

// ==========================================================================
// Legacy session routes (backward-compat for dashboard-ui)
// ==========================================================================

// Sessions per agent: GET /api/sessions/:agent
app.get('/api/sessions/:agent', async (c) => {
  const agent = c.req.param('agent') as Agent;
  const config = loadUserConfig();
  const workdir = runtime.getRequestWorkdir(config);
  const page = parsePageNumber(c.req.query('page'));
  const limit = parsePageSize(c.req.query('limit'));
  const botRef = runtime.getBotRef();

  runtime.debug(
    `[sessions] endpoint=single agent=${agent} resolvedWorkdir=${workdir} exists=${fs.existsSync(workdir)} ` +
    `page=${page} limit=${limit}`,
  );

  const result = await querySessions({ workdir, agent });
  const enriched = enrichWithRuntimeStatus(result.sessions, botRef);
  const paged = paginateSessionResult(enriched, page, limit);

  runtime.debug(
    `[sessions] endpoint=single agent=${agent} ok=${result.ok} total=${result.total} ` +
    `returned=${paged.sessions.length} error=${result.errors.join('; ') || '(none)'}`,
  );

  return c.json({
    ok: result.ok,
    error: result.errors[0] || null,
    ...paged,
  });
});

// All sessions (swim lane): GET /api/sessions
app.get('/api/sessions', async (c) => {
  const config = loadUserConfig();
  const workdir = runtime.getRequestWorkdir(config);
  const page = parsePageNumber(c.req.query('page'));
  const limit = parsePageSize(c.req.query('limit'));
  const botRef = runtime.getBotRef();

  runtime.debug(
    `[sessions] endpoint=all resolvedWorkdir=${workdir} exists=${fs.existsSync(workdir)} ` +
    `page=${page} limit=${limit}`,
  );

  const agents = listAgents().agents.filter(a => a.installed);
  const swimLane: Record<string, any> = {};

  await Promise.all(agents.map(async a => {
    const result = await querySessions({ workdir, agent: a.agent });
    const enriched = enrichWithRuntimeStatus(result.sessions, botRef);
    const paged = paginateSessionResult(enriched, page, limit);

    swimLane[a.agent] = {
      ok: result.ok,
      error: result.errors[0] || null,
      ...paged,
    };

    runtime.debug(
      `[sessions] endpoint=all agent=${a.agent} ok=${result.ok} total=${result.total} ` +
      `returned=${paged.sessions.length} error=${result.errors.join('; ') || '(none)'}`,
    );
  }));

  return c.json(swimLane);
});

// Session detail (tail): GET /api/session-detail/:agent/:id
app.get('/api/session-detail/:agent/:id', async (c) => {
  const agent = c.req.param('agent') as Agent;
  const sessionId = decodeURIComponent(c.req.param('id'));
  const config = loadUserConfig();
  const workdir = runtime.getRequestWorkdir(config);
  const limit = parseInt(c.req.query('limit') || '6', 10);

  runtime.debug(
    `[sessions] endpoint=detail agent=${agent} session=${sessionId} limit=${limit} resolvedWorkdir=${workdir} ` +
    `exists=${fs.existsSync(workdir)}`,
  );

  const tail = await querySessionTail({ agent, sessionId, workdir, limit });

  runtime.debug(
    `[sessions] endpoint=detail agent=${agent} session=${sessionId} ok=${tail.ok} ` +
    `messages=${tail.messages.length} error=${tail.error || '(none)'}`,
  );

  return c.json(tail);
});

// ==========================================================================
// Workspace CRUD
// ==========================================================================

app.get('/api/workspaces', (c) => {
  const workspaces = loadWorkspaces();
  // Always include the current runtimeWorkdir, deduplicating by path
  const config = loadUserConfig();
  const rwd = runtime.getRuntimeWorkdir(config);
  if (rwd && !workspaces.some(w => w.path === rwd)) {
    workspaces.unshift({
      path: rwd,
      name: path.basename(rwd),
      order: -1,
      addedAt: new Date().toISOString(),
    });
  }
  return c.json({ ok: true, workspaces });
});

app.post('/api/workspaces', async (c) => {
  try {
    const body = await c.req.json();
    const wsPath = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!wsPath) return c.json({ ok: false, error: 'path is required' }, 400);
    const entry = addWorkspace(wsPath, body?.name);
    return c.json({ ok: true, workspace: entry });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.delete('/api/workspaces', async (c) => {
  try {
    const body = await c.req.json();
    const wsPath = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!wsPath) return c.json({ ok: false, error: 'path is required' }, 400);
    const removed = removeWorkspace(wsPath);
    return c.json({ ok: true, removed });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.patch('/api/workspaces', async (c) => {
  try {
    const body = await c.req.json();
    const wsPath = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!wsPath) return c.json({ ok: false, error: 'path is required' }, 400);
    const updated = updateWorkspace(wsPath, body);
    return c.json({ ok: true, workspace: updated });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ==========================================================================
// Workspace overviews
// ==========================================================================

app.get('/api/workspace-overviews', async (c) => {
  try {
    const overviews = await getWorkspaceOverviews();
    return c.json({ ok: true, overviews });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ==========================================================================
// Session hub operations
// ==========================================================================

app.post('/api/session-hub/sessions', async (c) => {
  try {
    const body = await c.req.json();
    const workdir = typeof body?.workdir === 'string' ? body.workdir.trim() : '';
    if (!workdir) return c.json({ ok: false, error: 'workdir is required' }, 400);
    const botRef = runtime.getBotRef();
    const result = await querySessions({
      workdir,
      agent: body?.agents,
      userStatus: body?.userStatus,
      limit: body?.limit,
    });
    return c.json({
      ...result,
      sessions: enrichWithRuntimeStatus(result.sessions, botRef),
    });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/status', async (c) => {
  try {
    const body = await c.req.json();
    const { workdir, agent, sessionId, status } = body || {};
    if (!workdir || !agent || !sessionId || !status) {
      return c.json({ ok: false, error: 'workdir, agent, sessionId, and status are required' }, 400);
    }
    const updated = updateSession(workdir, agent, sessionId, { userStatus: status as UserStatus });
    return c.json({ ok: true, updated });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/note', async (c) => {
  try {
    const body = await c.req.json();
    const { workdir, agent, sessionId, note } = body || {};
    if (!workdir || !agent || !sessionId) {
      return c.json({ ok: false, error: 'workdir, agent, and sessionId are required' }, 400);
    }
    const updated = updateSession(workdir, agent, sessionId, { userNote: note ?? null });
    return c.json({ ok: true, updated });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/link', async (c) => {
  try {
    const body = await c.req.json();
    if (!body?.a || !body?.b || !body?.workdir) {
      return c.json({ ok: false, error: 'workdir, a: {agent, sessionId}, b: {agent, sessionId} required' }, 400);
    }
    const linked = linkSessions(body.workdir, body.a, body.b);
    return c.json({ ok: true, linked });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/messages', async (c) => {
  try {
    const body = await c.req.json();
    const { workdir, agent, sessionId, lastNTurns, turnOffset, turnLimit } = body || {};
    if (!workdir || !agent || !sessionId) {
      return c.json({ ok: false, error: 'workdir, agent, and sessionId are required' }, 400);
    }
    const rich = body?.rich !== false;
    const result = await querySessionMessages({
      agent,
      sessionId,
      workdir,
      lastNTurns: Number.isFinite(lastNTurns) ? lastNTurns : undefined,
      turnOffset: Number.isFinite(turnOffset) ? turnOffset : undefined,
      turnLimit: Number.isFinite(turnLimit) ? turnLimit : undefined,
      rich,
    });
    return c.json(result);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/migrate', async (c) => {
  try {
    const body = await c.req.json();
    if (!body?.source || !body?.target) {
      return c.json({ ok: false, error: 'source and target are required' }, 400);
    }
    const result = await buildMigrationContext({
      source: body.source,
      target: body.target,
      lastNTurns: body.lastNTurns,
    });
    return c.json(result);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/export', async (c) => {
  try {
    const body = await c.req.json();
    if (!body?.workdir || !body?.agent || !body?.sessionId) {
      return c.json({ ok: false, error: 'workdir, agent, sessionId are required' }, 400);
    }
    const result = await exportSession({
      workdir: body.workdir,
      agent: body.agent,
      sessionId: body.sessionId,
      format: body.format || 'markdown',
      lastNTurns: body.lastNTurns,
    });
    return c.json(result);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/import', async (c) => {
  try {
    const body = await c.req.json();
    if (!body?.workdir || !body?.agent || !body?.content) {
      return c.json({ ok: false, error: 'workdir, agent, and content are required' }, 400);
    }
    const result = importSession({
      workdir: body.workdir,
      agent: body.agent,
      content: body.content,
      format: body.format,
    });
    return c.json(result);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ==========================================================================
// Session interaction (send / recall / steer / stream)
// ==========================================================================

app.post('/api/session-hub/session/send', async (c) => {
  try {
    const { workdir, agent, sessionId, prompt, model, effort, attachments, cleanup } = await parseSessionSendRequest(c);
    const queued = queueDashboardSessionTask({
      workdir,
      agent,
      sessionId,
      prompt,
      model,
      effort,
      attachments,
    });
    await cleanup();
    if (!queued.ok) {
      const status = queued.error === 'Bot is not running' ? 503 : 400;
      return c.json(queued, status);
    }
    runtime.debug(
      `[session-send] queued task=${queued.taskId} session=${queued.sessionKey} attachments=${attachments.length} ` +
      `prompt="${(prompt || '[attachments only]').slice(0, 80)}"`,
    );
    return c.json(queued);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// Polling endpoint: GET /api/session-hub/session/stream-state?agent=X&sessionId=Y
app.get('/api/session-hub/session/stream-state', (c) => {
  const agent = c.req.query('agent') || '';
  const sessionId = c.req.query('sessionId') || '';
  if (!agent || !sessionId) {
    return c.json({ ok: false, error: 'agent and sessionId query params required' }, 400);
  }
  return c.json(getSessionStreamState(agent, sessionId));
});

app.post('/api/session-hub/session/recall', async (c) => {
  try {
    const body = await c.req.json();
    const { taskId } = body || {};
    if (!taskId) {
      return c.json({ ok: false, error: 'taskId is required' }, 400);
    }
    const result = cancelSessionTask(taskId);
    return c.json(result, result.ok ? 200 : 503);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/steer', async (c) => {
  try {
    const body = await c.req.json();
    const { taskId } = body || {};
    if (!taskId) {
      return c.json({ ok: false, error: 'taskId is required' }, 400);
    }
    const result = await steerSessionTask(taskId);
    return c.json(result, result.ok ? 200 : 503);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ==========================================================================
// SSE: push events to dashboard clients
// ==========================================================================

app.get('/api/events', (c) => {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: string) => {
        try { controller.enqueue(encoder.encode(data)); } catch { /* client disconnected */ }
      };

      // SSE keepalive every 25s (avoid proxy/browser timeout)
      const keepalive = setInterval(() => send(':keepalive\n\n'), 25_000);

      const onEvent = (event: DashboardEvent) => {
        send(`data: ${JSON.stringify(event)}\n\n`);
      };

      runtime.events.on('dashboard-event', onEvent);

      // Cleanup when client disconnects
      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(keepalive);
        runtime.events.off('dashboard-event', onEvent);
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

export default app;

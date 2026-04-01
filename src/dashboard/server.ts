/**
 * Hono-based dashboard HTTP server: static files and API routes.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'node:path';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import configRoutes from './routes/config.js';
import agentRoutes, { preloadAgentStatus } from './routes/agents.js';
import sessionRoutes from './routes/sessions.js';
import { runtime } from './runtime.js';
import { registerProcessRuntime } from '../core/process-control.js';
import { VERSION } from '../core/version.js';
import type { Bot } from '../bot/bot.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardOptions {
  port?: number;
  open?: boolean;
  bot?: Bot;
}

export interface DashboardServer {
  port: number;
  url: string;
  close(): Promise<void>;
  attachBot(bot: Bot): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DASHBOARD_PORT_RETRY_LIMIT = 10;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startDashboard(opts: DashboardOptions = {}): Promise<DashboardServer> {
  const preferredPort = opts.port || 3939;
  if (opts.bot) runtime.attachBot(opts.bot);

  const app = new Hono();

  // -- API routes --
  app.route('/', configRoutes);
  app.route('/', agentRoutes);
  app.route('/', sessionRoutes);

  // -- Static files: serve dashboard build output --
  // Resolve path relative to this file's location (src/ or dist/)
  const dashboardRoot = path.resolve(import.meta.dirname, '..', '..', 'dashboard', 'dist');

  // Serve /assets/* for Vite-hashed JS/CSS bundles
  app.use('/assets/*', serveStatic({ root: dashboardRoot }));

  // Serve other static files at root level (favicon, manifest, etc.)
  app.use('/*', serveStatic({
    root: dashboardRoot,
    onNotFound: () => {
      // Fall through to the SPA catch-all below
    },
  }));

  // SPA fallback: serve index.html for all non-API routes
  app.get('*', async (c) => {
    // Don't catch API routes that fell through (shouldn't happen, but guard anyway)
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Not Found' }, 404);
    }
    const indexPath = path.join(dashboardRoot, 'index.html');
    try {
      const html = fs.readFileSync(indexPath, 'utf-8');
      return c.html(html);
    } catch {
      return c.text('Dashboard build not found. Run: npm run build:dashboard', 500);
    }
  });

  // -- Process runtime registration --
  let nodeServer: ReturnType<typeof serve> | null = null;

  const unregisterProcessRuntime = registerProcessRuntime({
    label: 'dashboard',
    prepareForRestart: () => new Promise<void>(resolve => {
      if (!nodeServer) {
        resolve();
        return;
      }
      nodeServer.close(() => resolve());
    }),
  });

  // -- Start server with port retry --
  return new Promise<DashboardServer>((resolve, reject) => {
    let nextPort = preferredPort;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    function tryListen(port: number) {
      try {
        const server = serve({
          fetch: app.fetch,
          port,
        }, (info) => {
          if (settled) return;
          settled = true;
          nodeServer = server;
          const actualPort = info.port;
          const dashUrl = `http://localhost:${actualPort}`;
          const ts = new Date().toTimeString().slice(0, 8);
          process.stdout.write(`[pikiclaw ${ts}] dashboard: ${dashUrl}\n`);

          // Preload agent status cache so the first dashboard page load is instant
          preloadAgentStatus();

          if (opts.open !== false) {
            const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
            exec(`${cmd} ${dashUrl}`);
          }

          resolve({
            port: actualPort,
            url: dashUrl,
            attachBot(bot: Bot) {
              runtime.attachBot(bot);
            },
            close() {
              return new Promise<void>(resolveClose => {
                unregisterProcessRuntime();
                if (!server) {
                  resolveClose();
                  return;
                }
                server.close(() => resolveClose());
              });
            },
          });
        });

        // Handle EADDRINUSE by retrying on next port
        server.on('error', (err: NodeJS.ErrnoException) => {
          if (settled) return;
          if (err.code === 'EADDRINUSE') {
            if (nextPort >= preferredPort + DASHBOARD_PORT_RETRY_LIMIT) {
              fail(new Error(`Dashboard ports ${preferredPort}-${preferredPort + DASHBOARD_PORT_RETRY_LIMIT} are already in use.`));
              return;
            }
            nextPort += 1;
            tryListen(nextPort);
            return;
          }
          fail(err);
        });

        server.on('close', () => {
          unregisterProcessRuntime();
        });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    }

    tryListen(preferredPort);
  });
}

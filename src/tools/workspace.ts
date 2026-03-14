/**
 * tools/workspace.ts — Workspace file tools.
 *
 *   workspace_list_files — returns workspace path, staged files, and directory listing
 *   workspace_send_file  — sends a file back to the IM chat
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import type { McpToolModule, ToolContext, ToolResult } from './types.js';
import { toolResult, toolLog } from './types.js';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools: McpToolModule['tools'] = [
  {
    name: 'im_list_files',
    description: 'List files in the session workspace.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subdirectory: {
          type: 'string',
          description: 'Workspace-relative subdirectory.',
        },
      },
    },
  },
  {
    name: 'im_send_file',
    description: 'Send a file to the user in IM.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Path to send. Supports absolute paths, @workspace/..., @workdir/..., @tmp/..., workspace-relative paths, and unique bare filenames.',
        },
        caption: {
          type: 'string',
          description: 'Caption.',
        },
        kind: {
          type: 'string',
          enum: ['photo', 'document'],
          description: 'Optional file kind.',
        },
      },
      required: ['path', 'caption'],
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function summarizeSendFileArgs(filePath: string, caption: string, kind?: string): string {
  const text = [
    `path=${JSON.stringify(filePath || '')}`,
    `kind=${JSON.stringify(kind || 'auto')}`,
    `caption=${JSON.stringify(caption || '')}`,
  ].join(' ');
  return text.length <= 240 ? text : `${text.slice(0, 237).trimEnd()}...`;
}

function handleListFiles(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const subdir = typeof args?.subdirectory === 'string' ? args.subdirectory : '';
  const dir = subdir ? path.resolve(ctx.workspace, subdir) : ctx.workspace;
  toolLog('im_list_files', `dir=${dir} subdir=${subdir || '(root)'}`);

  // Security: ensure we stay within workspace
  const realWorkspace = safeRealpath(ctx.workspace);
  const realDir = safeRealpath(dir);
  if (!realWorkspace || !realDir || !realDir.startsWith(realWorkspace)) {
    toolLog('im_list_files', `REJECTED path outside workspace: ${dir}`);
    return toolResult('Error: path is outside the workspace', true);
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const workspaceRelDir = path.relative(ctx.workspace, dir);
    const files = entries.map(e => {
      const entry: Record<string, unknown> = { name: e.name, type: e.isDirectory() ? 'directory' : 'file' };
      const relPath = workspaceRelDir && workspaceRelDir !== '' && workspaceRelDir !== '.'
        ? path.posix.join(toPosix(workspaceRelDir), e.name)
        : e.name;
      entry.path = relPath;
      entry.alias = `@workspace/${relPath}`;
      if (e.isFile()) {
        try { entry.size = fs.statSync(path.join(dir, e.name)).size; } catch {}
      }
      return entry;
    });
    toolLog('im_list_files', `OK ${files.length} entries`);
    return toolResult(JSON.stringify({
      workspacePath: ctx.workspace,
      workdirPath: ctx.workdir || null,
      tempPath: os.tmpdir(),
      pathAliases: {
        workspaceRoot: '@workspace',
        workdirRoot: ctx.workdir ? '@workdir' : null,
        tempRoot: '@tmp',
        notes: [
          'Use @workspace/... for files in the session workspace.',
          ctx.workdir ? 'Use @workdir/... for files in the agent workdir.' : null,
          'Use @tmp/... for screenshots and other temp files.',
          'A bare filename also works if it uniquely matches a staged file or /tmp file.',
        ].filter(Boolean),
      },
      stagedFiles: ctx.stagedFiles.map(relPath => ({
        path: relPath,
        alias: `@workspace/${toPosix(relPath)}`,
        basename: path.basename(relPath),
      })),
      files,
    }, null, 2));
  } catch (e: any) {
    toolLog('im_list_files', `ERROR ${e.message}`);
    return toolResult(`Error listing directory: ${e.message}`, true);
  }
}

async function handleSendFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const filePath = typeof args?.path === 'string' ? args.path.trim() : '';
  const caption = typeof args?.caption === 'string' ? args.caption.trim() : '';
  const kind = typeof args?.kind === 'string' ? args.kind : undefined;
  const argSummary = summarizeSendFileArgs(filePath, caption, kind);
  toolLog('im_send_file', argSummary);
  if (!filePath) { toolLog('im_send_file', 'ERROR missing path'); return toolResult(`Error: "path" is required (${argSummary})`, true); }
  if (!caption) { toolLog('im_send_file', 'ERROR missing caption'); return toolResult(`Error: "caption" is required (${argSummary})`, true); }
  if (!ctx.callbackUrl) { toolLog('im_send_file', 'ERROR no callback URL'); return toolResult(`Error: MCP callback URL is not configured (${argSummary})`, true); }

  try {
    const result = await callbackSendFile(ctx.callbackUrl, filePath, {
      caption,
      kind,
    });
    if (result.ok) {
      toolLog('im_send_file', `OK sent ${filePath}`);
      return toolResult(`File sent successfully: ${filePath}`);
    } else {
      toolLog('im_send_file', `FAILED ${result.error || 'unknown error'}`);
      return toolResult(`Failed to send file: ${result.error || 'unknown error'} (${argSummary})`, true);
    }
  } catch (e: any) {
    toolLog('im_send_file', `ERROR ${e.message}`);
    return toolResult(`Error sending file: ${e.message} (${argSummary})`, true);
  }
}

// ---------------------------------------------------------------------------
// HTTP callback
// ---------------------------------------------------------------------------

function callbackSendFile(
  callbackUrl: string,
  filePath: string,
  opts: { caption?: string; kind?: string },
): Promise<{ ok: boolean; error?: string }> {
  const body = JSON.stringify({ path: filePath, ...opts });
  const url = new URL('/send-file', callbackUrl);

  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, error: 'invalid callback response' }); }
      });
    });
    req.on('error', e => reject(e));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeRealpath(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; }
}

function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

export const workspaceTools: McpToolModule = {
  tools,
  handle(name, args, ctx) {
    switch (name) {
      case 'im_list_files': return handleListFiles(args, ctx);
      case 'im_send_file': return handleSendFile(args, ctx);
      default: return toolResult(`Unknown workspace tool: ${name}`, true);
    }
  },
};

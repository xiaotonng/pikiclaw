/**
 * tools/ask-user.ts — im_ask_user: block the current turn and route a question
 * to the user via IM or dashboard. Used in place of Claude's native
 * `AskUserQuestion`, which is unusable in `-p` mode.
 */

import http from 'node:http';
import type { McpToolModule, ToolContext, ToolResult } from './types.js';
import { toolResult, toolLog } from './types.js';

interface AskUserOption { label: string; description?: string; value?: string }

const tools: McpToolModule['tools'] = [
  {
    name: 'im_ask_user',
    description:
      'Ask the user a question and block until they reply. Equivalent to '
      + '`AskUserQuestion`, routed through the IM channel or dashboard. '
      + 'Supply `options` whenever the answer is enumerable so the user can '
      + 'tap a choice. Use only when you genuinely need user input to '
      + 'proceed; for routine clarifications, pick a sensible default and '
      + 'continue.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string', description: 'Question text shown to the user.' },
        header: { type: 'string', description: 'Optional short header (≤ 24 chars).' },
        hint: { type: 'string', description: 'Optional helper text shown alongside the question.' },
        options: {
          type: 'array',
          description: 'Predefined choices. Omit for a freeform answer.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Option label, returned verbatim if selected.' },
              description: { type: 'string', description: 'Optional secondary description.' },
            },
            required: ['label'],
          },
        },
        allow_freeform: {
          type: 'boolean',
          description: 'When options are supplied, also accept freeform text (default true).',
        },
      },
      required: ['question'],
    },
  },
];

async function handleAskUser(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const question = typeof args?.question === 'string' ? args.question.trim() : '';
  const header = typeof args?.header === 'string' ? args.header.trim() : '';
  const hint = typeof args?.hint === 'string' ? args.hint.trim() : '';
  const allowFreeform = args?.allow_freeform == null ? true : !!args.allow_freeform;
  const rawOptions = Array.isArray(args?.options) ? (args.options as any[]) : [];
  const options: AskUserOption[] = rawOptions
    .map((o: any) => ({
      label: typeof o?.label === 'string' ? o.label.trim() : '',
      description: typeof o?.description === 'string' ? o.description.trim() : '',
    }))
    .filter(o => o.label);

  if (!question) {
    toolLog('im_ask_user', 'ERROR missing question');
    return toolResult('Error: "question" is required', true);
  }
  if (!ctx.callbackUrl) {
    toolLog('im_ask_user', 'ERROR no callback URL');
    return toolResult('Error: MCP callback URL is not configured', true);
  }

  toolLog('im_ask_user', `question="${question.slice(0, 160)}" options=${options.length} freeform=${allowFreeform}`);

  try {
    const response = await callbackAskUser(ctx.callbackUrl, { question, header, hint, allowFreeform, options });
    if (response.ok) {
      const answer = (response.answer || '').trim();
      toolLog('im_ask_user', `OK answer="${answer.slice(0, 160)}"`);
      return toolResult(answer || '(no response)');
    }
    toolLog('im_ask_user', `FAILED ${response.error || 'unknown error'}`);
    return toolResult(`Failed to get user response: ${response.error || 'unknown error'}`, true);
  } catch (e: any) {
    toolLog('im_ask_user', `ERROR ${e.message}`);
    return toolResult(`Error asking user: ${e.message}`, true);
  }
}

interface AskUserResponse { ok: boolean; answer?: string; error?: string }

function callbackAskUser(
  callbackUrl: string,
  body: { question: string; header: string; hint: string; allowFreeform: boolean; options: AskUserOption[] },
): Promise<AskUserResponse> {
  const payload = JSON.stringify(body);
  const url = new URL('/ask-user', callbackUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, error: 'invalid callback response' }); }
      });
    });
    req.on('error', e => reject(e));
    // User reply has no upper bound — never time out the socket.
    req.setTimeout(0);
    req.write(payload);
    req.end();
  });
}

export const askUserTools: McpToolModule = {
  tools,
  handle(name, args, ctx) {
    if (name === 'im_ask_user') return handleAskUser(args, ctx);
    return toolResult(`Unknown ask-user tool: ${name}`, true);
  },
};

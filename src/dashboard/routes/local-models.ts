/**
 * Dashboard API: Local Model backends (Ollama / LM Studio).
 *
 * Surfaces a single probe endpoint that the dashboard polls when the user
 * opens the "Local Models" section, plus a connect action that links a
 * detected backend into the regular Provider/Profile model layer so the
 * agent cards above pick it up without any further configuration.
 *
 *   GET  /api/local-models/probe    → which backends are running, what models
 *                                     they have, and whether we already have a
 *                                     Provider pointing at each one.
 *   POST /api/local-models/connect  → idempotently create the Provider for the
 *                                     named backend; returns its id.
 *
 * Endpoints:
 *   - Ollama   default baseURL → http://127.0.0.1:11434
 *              version probe   → GET  /api/version
 *              model list      → GET  /api/tags
 *              OpenAI compat   → /v1/chat/completions, /v1/models
 *
 *   - LM Studio default baseURL → http://127.0.0.1:1234
 *               probe + models  → GET /v1/models  (200 OK iff server up)
 */

import { Hono } from 'hono';
import { LOCAL_MODELS, type LocalModelEntry } from '../../catalog/local-models.js';
import {
  listProviders, addProvider, type ProviderConfig,
} from '../../model/index.js';

const router = new Hono();

// ---------------------------------------------------------------------------
// Backend descriptors
// ---------------------------------------------------------------------------

interface BackendSpec {
  id: 'ollama' | 'lmstudio';
  label: string;
  baseURL: string;          // e.g. http://127.0.0.1:11434 (no /v1 suffix)
  openAIBaseURL: string;    // e.g. http://127.0.0.1:11434/v1 (passed to ProviderConfig)
  versionPath: string;      // 200-OK probe used for "is the server running?"
}

const BACKENDS: BackendSpec[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    baseURL: 'http://127.0.0.1:11434',
    openAIBaseURL: 'http://127.0.0.1:11434/v1',
    versionPath: '/api/version',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    baseURL: 'http://127.0.0.1:1234',
    openAIBaseURL: 'http://127.0.0.1:1234/v1',
    // LM Studio has no /api/version; /v1/models doubles as a liveness probe
    // and is what we need anyway to list models, so reuse it for both.
    versionPath: '/v1/models',
  },
];

const PROBE_TIMEOUT_MS = 1500;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Per-backend detection
// ---------------------------------------------------------------------------

interface DetectedModel {
  id: string;        // raw model id as the backend reports it (e.g. 'qwen3-coder:7b')
  sizeBytes?: number;
}

interface BackendStatus {
  id: BackendSpec['id'];
  label: string;
  detected: boolean;
  version?: string;
  baseURL: string;
  openAIBaseURL: string;
  models: DetectedModel[];
  /** id of the Provider that already points at this backend's baseURL, if any. */
  existingProviderId: string | null;
  /** Per-backend installation hints, used by the UI when detection fails. */
  installHint: { homepage: string; brewFormula?: string };
}

async function probeOllama(spec: BackendSpec): Promise<{ detected: boolean; version?: string; models: DetectedModel[] }> {
  type VersionRes = { version: string };
  type TagsRes = { models?: Array<{ name: string; size?: number }> };
  const ver = await fetchJson<VersionRes>(`${spec.baseURL}${spec.versionPath}`);
  if (!ver) return { detected: false, models: [] };
  const tags = await fetchJson<TagsRes>(`${spec.baseURL}/api/tags`, 3000);
  const models: DetectedModel[] = (tags?.models || []).map(m => ({
    id: m.name,
    sizeBytes: typeof m.size === 'number' ? m.size : undefined,
  }));
  return { detected: true, version: ver.version, models };
}

async function probeLmStudio(spec: BackendSpec): Promise<{ detected: boolean; version?: string; models: DetectedModel[] }> {
  type ModelsRes = { data?: Array<{ id: string }> };
  // /v1/models doubles as both liveness probe and model list. We can't get a
  // version string back from LM Studio's OpenAI-compat layer, so we leave
  // `version` undefined and the UI just shows "detected".
  const res = await fetchJson<ModelsRes>(`${spec.baseURL}${spec.versionPath}`, 3000);
  if (!res) return { detected: false, models: [] };
  return {
    detected: true,
    models: (res.data || []).map(m => ({ id: m.id })),
  };
}

function installHintFor(id: BackendSpec['id']): BackendStatus['installHint'] {
  if (id === 'ollama') return { homepage: 'https://ollama.com/download', brewFormula: 'ollama' };
  return { homepage: 'https://lmstudio.ai/' };
}

/**
 * Normalize a provider baseURL for comparison: drop trailing slashes and
 * collapse the localhost ↔ 127.0.0.1 distinction. Users who connected via
 * the legacy Custom template often typed `http://localhost:11434/v1`, and
 * we want those to count as already-connected against our `127.0.0.1`
 * default so we don't offer them a duplicate Connect button.
 */
function normalizeBaseURL(raw: string): string {
  return raw
    .replace(/\/+$/, '')
    .replace(/^http:\/\/localhost(?=[:/]|$)/i, 'http://127.0.0.1')
    .replace(/^https:\/\/localhost(?=[:/]|$)/i, 'https://127.0.0.1');
}

function findProviderForBackend(providers: ProviderConfig[], spec: BackendSpec): ProviderConfig | null {
  const target = normalizeBaseURL(spec.openAIBaseURL);
  return providers.find(p => normalizeBaseURL(p.baseURL) === target) || null;
}

async function probeBackend(spec: BackendSpec, providers: ProviderConfig[]): Promise<BackendStatus> {
  const result = spec.id === 'ollama' ? await probeOllama(spec) : await probeLmStudio(spec);
  const existing = findProviderForBackend(providers, spec);
  return {
    id: spec.id,
    label: spec.label,
    detected: result.detected,
    version: result.version,
    baseURL: spec.baseURL,
    openAIBaseURL: spec.openAIBaseURL,
    models: result.models,
    existingProviderId: existing?.id || null,
    installHint: installHintFor(spec.id),
  };
}

// ---------------------------------------------------------------------------
// Catalog match — join detected models against curated recommendations
// ---------------------------------------------------------------------------

/**
 * Whether `entry` is plausibly satisfied by an already-pulled model. We match
 * on the tag prefix (before `:`) so a user who pulled `qwen3-coder:7b-q5_K_M`
 * still gets credit for the curated `qwen3-coder:7b` entry without us caring
 * about quantization suffix differences.
 */
function isEntryInstalled(entry: LocalModelEntry, installed: DetectedModel[]): string | null {
  const candidates: string[] = [];
  if (entry.ollamaTag) candidates.push(entry.ollamaTag);
  if (entry.lmstudioId) candidates.push(entry.lmstudioId);
  for (const m of installed) {
    for (const c of candidates) {
      const base = c.split(':')[0].toLowerCase();
      if (m.id.toLowerCase().startsWith(base)) return m.id;
    }
  }
  return null;
}

interface CatalogJoinEntry extends LocalModelEntry {
  installed: { backend: BackendSpec['id']; id: string } | null;
}

function joinCatalog(backends: BackendStatus[]): CatalogJoinEntry[] {
  return LOCAL_MODELS.map(entry => {
    for (const b of backends) {
      if (!b.detected) continue;
      const hit = isEntryInstalled(entry, b.models);
      if (hit) return { ...entry, installed: { backend: b.id, id: hit } };
    }
    return { ...entry, installed: null };
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get('/api/local-models/probe', async c => {
  try {
    const providers = listProviders();
    const backends = await Promise.all(BACKENDS.map(spec => probeBackend(spec, providers)));
    const catalog = joinCatalog(backends);
    return c.json({ ok: true, backends, catalog });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e) }, 500);
  }
});

/**
 * POST /api/local-models/pull — stream Ollama's `/api/pull` progress to the
 * dashboard so the user can see download progress without leaving the page.
 *
 * Request: { backend: 'ollama', model: 'qwen3-coder:7b' }
 * Response: application/x-ndjson — each line is an Ollama event:
 *   {"status":"pulling manifest"}
 *   {"status":"downloading","digest":"sha256:…","total":N,"completed":M}
 *   {"status":"success"}
 *   {"error":"…"}        ← on failure
 *
 * We forward the upstream stream verbatim. The browser reads via
 * fetch().body.getReader() and parses NDJSON line-by-line; cancelling the
 * fetch on the client side aborts the upstream request via AbortController.
 *
 * LM Studio is intentionally NOT supported here: it has no HTTP pull API,
 * only the `lms get <id>` CLI command. The UI degrades to a copy-command
 * fallback for that backend.
 */
router.post('/api/local-models/pull', async c => {
  let body: any;
  try { body = await c.req.json(); } catch { body = {}; }
  const backendId = String(body.backend || 'ollama');
  const model = String(body.model || '').trim();
  if (backendId !== 'ollama') {
    return c.json({ ok: false, error: 'Only Ollama supports streaming pull; LM Studio uses its CLI (lms get).' }, 400);
  }
  if (!model) return c.json({ ok: false, error: 'model is required' }, 400);

  const ollama = BACKENDS.find(b => b.id === 'ollama')!;
  const controller = new AbortController();
  // Wire client disconnect → upstream abort so Ollama isn't left pulling for
  // a tab the user already closed.
  c.req.raw.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  let upstream: Response;
  try {
    upstream = await fetch(`${ollama.baseURL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: controller.signal,
    });
  } catch (e: any) {
    return c.json({ ok: false, error: `Ollama not reachable: ${e?.message || e}` }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    return c.json({ ok: false, error: `Ollama pull failed (HTTP ${upstream.status}): ${text.slice(0, 200)}` }, 502);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',
    },
  });
});

router.post('/api/local-models/connect', async c => {
  let body: any;
  try { body = await c.req.json(); } catch { body = {}; }
  const backendId = String(body.backend || '');
  const spec = BACKENDS.find(b => b.id === backendId);
  if (!spec) return c.json({ ok: false, error: `Unknown backend: ${backendId}` }, 400);

  // Idempotent: if a Provider already exists for this backend's baseURL,
  // return its id without creating a duplicate.
  const providers = listProviders();
  const existing = findProviderForBackend(providers, spec);
  if (existing) return c.json({ ok: true, providerId: existing.id, alreadyConnected: true });

  // Neither Ollama nor LM Studio require an API key, but the store layer's
  // addProvider() insists on either an apiKey or a credentialRef. Pass a
  // placeholder; backends ignore the Authorization header. The placeholder is
  // a sentinel ("local-no-auth") rather than something that looks like a real
  // key, so future code can recognize and special-case local providers.
  try {
    const provider = await addProvider({
      kind: 'openai-compatible',
      name: spec.label,
      baseURL: spec.openAIBaseURL,
      apiKey: 'local-no-auth',
    });
    return c.json({ ok: true, providerId: provider.id, alreadyConnected: false });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e) }, 500);
  }
});

export default router;

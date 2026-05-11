/**
 * Dashboard API routes for extension management — MCP servers and skills.
 *
 * Catalog-first design: GET /catalog returns a unified list of recommended
 * registry entries merged with the user's installed servers, each tagged with
 * a single `state` field. The frontend uses that state to render the right CTA
 * (Install / Authorize / Enable / Disable / Remove).
 *
 * OAuth endpoints:
 *   POST /oauth/start    — kicks off auth-code flow, returns auth URL + state
 *   GET  /oauth/callback — provider redirects here; exchanges code for tokens
 *   POST /oauth/revoke   — clears stored tokens for a server
 */

import { Hono } from 'hono';
import { execFile } from 'node:child_process';
import {
  addGlobalMcpExtension, removeGlobalMcpExtension, updateGlobalMcpExtension,
  addWorkspaceMcpExtension, removeWorkspaceMcpExtension, updateWorkspaceMcpExtension,
  getCatalogItems, buildInstalledConfigFromRecommended,
  checkMcpHealth, getCachedHealth, cacheHealth,
  getRecommendedMcpServer,
  listSkills, installSkill, removeSkill,
  getRecommendedSkillRepos, searchSkillRepos, searchMcpServers,
  startAuthorization, completeAuthorization, deleteMcpToken, getMcpToken,
} from '../../agent/index.js';
import type { McpServerConfig } from '../../core/config/user-config.js';
import { loadUserConfig, saveUserConfig } from '../../core/config/user-config.js';
import { runtime } from '../runtime.js';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Builtin catalog entries don't live in `extensions.mcp` — they're toggled by
 * a top-level config flag. Each catalogId maps to one flag; add a branch when
 * registering a new builtin.
 */
function setBuiltinEnabled(catalogId: string, enabled: boolean): boolean {
  if (catalogId === 'pikiclaw-browser') {
    saveUserConfig({ ...loadUserConfig(), browserEnabled: enabled });
    return true;
  }
  if (catalogId === 'peekaboo') {
    saveUserConfig({ ...loadUserConfig(), peekabooEnabled: enabled });
    return true;
  }
  return false;
}

const app = new Hono();

function isValidWorkdir(dir: string | undefined | null): dir is string {
  if (!dir || typeof dir !== 'string') return false;
  if (!path.isAbsolute(dir)) return false;
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function getCallbackRedirectUri(c: { req: { url: string } }): string {
  // Build from the current request so the URL matches whatever port/origin
  // the dashboard is actually served on (dev, prod, custom port, etc.).
  const origin = new URL(c.req.url).origin;
  return `${origin}/api/extensions/mcp/oauth/callback`;
}

// ---------------------------------------------------------------------------
// MCP — unified catalog
// ---------------------------------------------------------------------------

/** GET /api/extensions/mcp/catalog — Unified recommended + installed list with state. */
app.get('/api/extensions/mcp/catalog', (c) => {
  const workdir = c.req.query('workdir') || runtime.getRequestWorkdir();
  const scopeParam = c.req.query('scope');
  const scope = scopeParam === 'global' || scopeParam === 'workspace' || scopeParam === 'both'
    ? scopeParam
    : undefined;
  const items = getCatalogItems({ workdir, scope });
  return c.json({ ok: true, items });
});

/**
 * POST /api/extensions/mcp/install
 * Install a recommended registry entry. Body:
 *   { catalogId, scope, workdir?, credentials?, enable? }
 * Missing credentials for mcp-oauth servers is fine — they'll surface as
 * `needs_auth` in the catalog, and the UI should call /oauth/start next.
 */
app.post('/api/extensions/mcp/install', async (c) => {
  try {
    const body = await c.req.json();
    const {
      catalogId,
      scope = 'global',
      workdir: reqWorkdir,
      credentials,
      enable = true,
    } = body as {
      catalogId: string;
      scope?: 'global' | 'workspace';
      workdir?: string;
      credentials?: Record<string, string>;
      enable?: boolean;
    };
    if (!catalogId?.trim()) return c.json({ ok: false, error: 'catalogId is required' }, 400);
    const rec = getRecommendedMcpServer(catalogId.trim());
    if (!rec) return c.json({ ok: false, error: `unknown catalogId: ${catalogId}` }, 404);
    if (rec.isBuiltin) {
      const ok = setBuiltinEnabled(rec.id, enable !== false);
      return c.json({ ok, enabled: ok && enable !== false });
    }

    // Don't enable yet for mcp-oauth if no token exists — user still needs to authorize.
    let shouldEnable = enable;
    if (rec.auth.type === 'mcp-oauth' && !getMcpToken(rec.id)) shouldEnable = false;
    if (rec.auth.type === 'credentials') {
      for (const f of rec.auth.fields) {
        if (f.required && !(credentials || {})[f.key]?.trim()) {
          shouldEnable = false;
          break;
        }
      }
    }

    const config = buildInstalledConfigFromRecommended(rec, { enabled: shouldEnable, credentials });

    if (scope === 'workspace') {
      const wd = reqWorkdir || runtime.getRequestWorkdir();
      if (!isValidWorkdir(wd)) return c.json({ ok: false, error: 'valid workdir is required for workspace scope' }, 400);
      addWorkspaceMcpExtension(wd, rec.id, config);
    } else {
      addGlobalMcpExtension(rec.id, config);
    }
    return c.json({ ok: true, enabled: shouldEnable });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'internal error' }, 500);
  }
});

/**
 * POST /api/extensions/mcp/toggle
 * Enable/disable an installed server by its installed key.
 */
app.post('/api/extensions/mcp/toggle', async (c) => {
  try {
    const body = await c.req.json();
    const { name, enabled, scope = 'global', workdir: reqWorkdir } = body as {
      name: string;
      enabled: boolean;
      scope?: 'global' | 'workspace';
      workdir?: string;
    };
    if (!name?.trim()) return c.json({ ok: false, error: 'name is required' }, 400);

    if (setBuiltinEnabled(name.trim(), !!enabled)) {
      return c.json({ ok: true, updated: true });
    }

    const patch: Partial<McpServerConfig> = { enabled: !!enabled };
    let updated: boolean;
    if (scope === 'workspace') {
      const wd = reqWorkdir || runtime.getRequestWorkdir();
      if (!isValidWorkdir(wd)) return c.json({ ok: false, error: 'valid workdir is required' }, 400);
      updated = updateWorkspaceMcpExtension(wd, name.trim(), patch);
    } else {
      updated = updateGlobalMcpExtension(name.trim(), patch);
    }
    return c.json({ ok: true, updated });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'internal error' }, 500);
  }
});

/** POST /api/extensions/mcp/update — patch config fields (credentials, url, etc.). */
app.post('/api/extensions/mcp/update', async (c) => {
  try {
    const body = await c.req.json();
    const { name, patch, scope = 'global', workdir: reqWorkdir } = body as {
      name: string;
      patch: Partial<McpServerConfig>;
      scope?: 'global' | 'workspace';
      workdir?: string;
    };
    if (!name?.trim()) return c.json({ ok: false, error: 'name is required' }, 400);

    let updated: boolean;
    if (scope === 'workspace') {
      const wd = reqWorkdir || runtime.getRequestWorkdir();
      if (!isValidWorkdir(wd)) return c.json({ ok: false, error: 'valid workdir is required' }, 400);
      updated = updateWorkspaceMcpExtension(wd, name.trim(), patch);
    } else {
      updated = updateGlobalMcpExtension(name.trim(), patch);
    }
    return c.json({ ok: true, updated });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'internal error' }, 500);
  }
});

/** POST /api/extensions/mcp/remove — uninstall. Also clears any OAuth tokens. */
app.post('/api/extensions/mcp/remove', async (c) => {
  try {
    const body = await c.req.json();
    const { name, scope = 'global', workdir: reqWorkdir, catalogId } = body as {
      name: string;
      scope?: 'global' | 'workspace';
      workdir?: string;
      catalogId?: string;
    };
    if (!name?.trim()) return c.json({ ok: false, error: 'name is required' }, 400);

    if (setBuiltinEnabled(name.trim(), false)) {
      return c.json({ ok: true, removed: true });
    }

    let removed: boolean;
    if (scope === 'workspace') {
      const wd = reqWorkdir || runtime.getRequestWorkdir();
      if (!isValidWorkdir(wd)) return c.json({ ok: false, error: 'valid workdir is required' }, 400);
      removed = removeWorkspaceMcpExtension(wd, name.trim());
    } else {
      removed = removeGlobalMcpExtension(name.trim());
    }
    if (catalogId) deleteMcpToken(catalogId);
    return c.json({ ok: true, removed });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'internal error' }, 500);
  }
});

/** POST /api/extensions/mcp/custom — add a user-defined server not in the registry. */
app.post('/api/extensions/mcp/custom', async (c) => {
  try {
    const body = await c.req.json();
    const { name, config, scope = 'global', workdir: reqWorkdir } = body as {
      name: string;
      config: McpServerConfig;
      scope?: 'global' | 'workspace';
      workdir?: string;
    };
    if (!name?.trim()) return c.json({ ok: false, error: 'name is required' }, 400);
    if (!config) return c.json({ ok: false, error: 'config is required' }, 400);

    const clean: McpServerConfig = { ...config };
    delete (clean as any).catalogId;
    if (clean.enabled === undefined) clean.enabled = true;

    if (scope === 'workspace') {
      const wd = reqWorkdir || runtime.getRequestWorkdir();
      if (!isValidWorkdir(wd)) return c.json({ ok: false, error: 'valid workdir is required for workspace scope' }, 400);
      addWorkspaceMcpExtension(wd, name.trim(), clean);
    } else {
      addGlobalMcpExtension(name.trim(), clean);
    }
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'internal error' }, 500);
  }
});

/** POST /api/extensions/mcp/health — health check with 10-min cache per catalogId. */
app.post('/api/extensions/mcp/health', async (c) => {
  try {
    const body = await c.req.json();
    const { id, config, noCache } = body as { id: string; config: McpServerConfig; noCache?: boolean };
    if (!id?.trim()) return c.json({ ok: false, error: 'id is required' }, 400);
    if (!config) return c.json({ ok: false, error: 'config is required' }, 400);

    if (!noCache) {
      const cached = getCachedHealth(id, config);
      if (cached) return c.json({ ...cached, cached: true });
    }

    const result = await checkMcpHealth(config);
    cacheHealth(id, config, result);
    return c.json(result);
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'internal error' }, 500);
  }
});

/** GET /api/extensions/mcp/search — search community MCP servers (fallback path). */
app.get('/api/extensions/mcp/search', async (c) => {
  const query = c.req.query('q') || '';
  const parsed = parseInt(c.req.query('limit') || '20', 10);
  const limit = Math.min(Number.isFinite(parsed) ? parsed : 20, 50);
  try {
    const results = await searchMcpServers(query, limit);
    return c.json({ ok: true, results });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message, results: [] });
  }
});

// ---------------------------------------------------------------------------
// MCP — OAuth
// ---------------------------------------------------------------------------

/** POST /api/extensions/mcp/oauth/start — returns authUrl the client should open. */
app.post('/api/extensions/mcp/oauth/start', async (c) => {
  try {
    const body = await c.req.json();
    const { catalogId } = body as { catalogId: string };
    if (!catalogId?.trim()) return c.json({ ok: false, error: 'catalogId is required' }, 400);
    const rec = getRecommendedMcpServer(catalogId.trim());
    if (!rec) return c.json({ ok: false, error: `unknown catalogId: ${catalogId}` }, 404);
    if (rec.auth.type !== 'mcp-oauth') {
      return c.json({ ok: false, error: 'this server does not use OAuth' }, 400);
    }
    if (rec.transport.type !== 'http') {
      return c.json({ ok: false, error: 'OAuth is only supported for http transport' }, 400);
    }

    const redirectUri = getCallbackRedirectUri(c);
    const { authUrl, state } = await startAuthorization({
      serverId: rec.id,
      auth: rec.auth,
      resourceUrl: rec.transport.url,
      redirectUri,
      clientName: 'Pikiclaw',
    });
    return c.json({ ok: true, authUrl, state });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'oauth start failed' }, 500);
  }
});

/** GET /api/extensions/mcp/oauth/callback — browser landing page for the provider redirect. */
app.get('/api/extensions/mcp/oauth/callback', async (c) => {
  const code = c.req.query('code') || '';
  const state = c.req.query('state') || '';
  const providerError = c.req.query('error') || '';
  const providerDesc = c.req.query('error_description') || '';

  const render = (opts: { ok: boolean; title: string; detail: string }) => c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${opts.ok ? 'Authorized' : 'Authorization failed'}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f1115; color: #d4d4d8; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
    .card { max-width: 420px; padding: 28px; border: 1px solid #262a33; border-radius: 14px; background: #161922; text-align: center; }
    .icon { font-size: 40px; margin-bottom: 12px; }
    h1 { font-size: 17px; margin: 0 0 6px; font-weight: 600; color: #f4f4f5; }
    p { font-size: 13px; line-height: 1.55; color: #a1a1aa; margin: 0; }
    .close { display: inline-block; margin-top: 16px; font-size: 12px; color: #6366f1; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${opts.ok ? '✅' : '⚠️'}</div>
    <h1>${opts.title}</h1>
    <p>${opts.detail}</p>
    <a class="close" href="javascript:window.close()">Close window</a>
  </div>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'mcp-oauth', ok: ${opts.ok}, state: ${JSON.stringify(state)} }, '*');
      }
    } catch (e) {}
    setTimeout(function () { try { window.close(); } catch (e) {} }, 1500);
  </script>
</body>
</html>`);

  if (providerError) {
    return render({
      ok: false,
      title: 'Authorization was cancelled',
      detail: providerDesc || providerError,
    });
  }
  if (!code || !state) {
    return render({
      ok: false,
      title: 'Missing code or state',
      detail: 'The provider did not return the expected parameters.',
    });
  }
  try {
    const result = await completeAuthorization({ state, code });
    return render({
      ok: true,
      title: 'Authorized successfully',
      detail: `Pikiclaw can now connect to ${result.serverId}. You can close this window and return to the dashboard.`,
    });
  } catch (e: any) {
    return render({
      ok: false,
      title: 'Token exchange failed',
      detail: e?.message || 'Unknown error',
    });
  }
});

/** POST /api/extensions/mcp/oauth/revoke — clear stored tokens. */
app.post('/api/extensions/mcp/oauth/revoke', async (c) => {
  try {
    const body = await c.req.json();
    const { catalogId } = body as { catalogId: string };
    if (!catalogId?.trim()) return c.json({ ok: false, error: 'catalogId is required' }, 400);
    const removed = deleteMcpToken(catalogId.trim());
    return c.json({ ok: true, removed });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'internal error' }, 500);
  }
});

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

interface SkillCatalogItem {
  id: string;
  name: string;
  description: string;
  descriptionZh: string;
  source: string;
  category: string;
  recommendedScope: 'global' | 'workspace' | 'both';
  homepage?: string;
  installed: boolean;
  scope?: 'global' | 'project';
  installedNames: string[];
  /** GitHub stars — undefined when the metadata fetch hasn't completed or failed. */
  stars?: number;
  /** ISO timestamp of the repo's most recent push. */
  pushedAt?: string;
  /** Brand logo URL — explicit `iconUrl` from the manifest, else GitHub owner avatar. */
  iconUrl?: string;
  /**
   * Total number of skills discovered in the remote repo. Undefined while the
   * GitHub Contents listing is cold or has failed — frontend re-fetches via
   * /skills/list when the detail modal opens.
   */
  totalCount?: number;
  /** True when the remote listing was capped by GitHub Contents API. */
  partial?: boolean;
}

/**
 * Extract the GitHub owner slug from a skill `source`. Accepts both the
 * compact `owner/repo` form and full `https://github.com/owner/repo[...]`
 * URLs. Returns null when the source doesn't look like a GitHub reference,
 * in which case the dashboard falls back to a letter avatar.
 */
function extractGithubOwner(source: string): string | null {
  if (!source) return null;
  const cleaned = source.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '');
  const owner = cleaned.split('/')[0]?.trim();
  if (!owner) return null;
  // GitHub usernames: alphanumerics + single hyphens, 1–39 chars.
  return /^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(owner) ? owner : null;
}

/**
 * In-memory cache of GitHub repo metadata for skill catalog entries. We use
 * stars as the authority signal — popular repos float to the top — and
 * `pushedAt` to surface staleness. A single 24-hour TTL is enough; if the
 * dashboard reloads more often we serve cached data instantly.
 *
 * The fetch is best-effort: rate limits or network failures leave the catalog
 * intact (just without star counts), so the page never breaks because of
 * GitHub being down.
 */
interface RepoMeta { stars: number; pushedAt: string }
const githubMetaCache = new Map<string, { value: RepoMeta; cachedAt: number }>();
const GITHUB_META_TTL_MS = 24 * 60 * 60 * 1000;
let githubMetaInflight: Promise<void> | null = null;

/**
 * Remote skill listings — cached per source. Each entry is the list of
 * directories under the repo that contain a SKILL.md file. Same TTL as the
 * stars cache (24h); on miss the catalog response simply omits totalCount and
 * the modal triggers a fresh fetch when opened.
 */
export interface RemoteSkillInfo {
  name: string;
  /** First non-empty line of the SKILL.md description frontmatter, when cheap to read. */
  description?: string;
  /** Path under the repo (e.g. "skills/mcp-builder"). For Open-on-GitHub links. */
  path: string;
}
interface RemoteSkillsResult {
  skills: RemoteSkillInfo[];
  /** True when the GitHub Contents listing was capped (we didn't paginate beyond ~1000). */
  partial: boolean;
}
const remoteSkillsCache = new Map<string, { value: RemoteSkillsResult; cachedAt: number }>();
const REMOTE_SKILLS_TTL_MS = 24 * 60 * 60 * 1000;
const remoteSkillsInflight = new Map<string, Promise<RemoteSkillsResult | null>>();

/**
 * Resolve a GitHub API token without making the user export anything. Order:
 *   1. `GITHUB_TOKEN` env var (explicit override wins).
 *   2. `gh auth token` — pikiclaw recommends `gh` in its CLI catalog, so any
 *      user who's set up the CLI extensions has a token already. Cached for
 *      10 minutes since tokens rarely rotate; on rotation the next refresh
 *      picks it up automatically.
 *
 * Returns null when neither path works (gh missing or not signed in). In that
 * case GitHub Contents calls fall back to the 60 req/h unauth limit, which is
 * still enough for most casual users.
 */
let githubTokenCache: { value: string; resolvedAt: number } | null = null;
let githubTokenInflight: Promise<string | null> | null = null;
const GITHUB_TOKEN_TTL_MS = 10 * 60 * 1000;

async function resolveGithubToken(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (githubTokenCache && Date.now() - githubTokenCache.resolvedAt < GITHUB_TOKEN_TTL_MS) {
    return githubTokenCache.value;
  }
  // Singleflight: if a probe is already in flight, await its result instead of
  // spawning N parallel `gh` subprocesses. The 14-source catalog warm-up used
  // to race here and one keyring lock-contention failure would poison the
  // cache for the next 10 minutes. We also only cache on success — a null
  // result just falls through to the next caller's probe.
  if (githubTokenInflight) return githubTokenInflight;
  githubTokenInflight = (async () => {
    const value = await new Promise<string | null>((resolve) => {
      try {
        execFile('gh', ['auth', 'token'], { timeout: 3_000 }, (err, stdout) => {
          if (err) { resolve(null); return; }
          const out = (stdout?.toString() || '').trim();
          resolve(out || null);
        });
      } catch { resolve(null); }
    });
    if (value) githubTokenCache = { value, resolvedAt: Date.now() };
    return value;
  })().finally(() => { githubTokenInflight = null; });
  return githubTokenInflight;
}

function parseSourceToOwnerRepo(source: string): { owner: string; repo: string } | null {
  if (!source) return null;
  const cleaned = source.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/, '');
  const [owner, repo] = cleaned.split('/');
  if (!owner || !repo) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(owner)) return null;
  if (!/^[a-z0-9._-]+$/i.test(repo)) return null;
  return { owner, repo };
}

interface GhContentEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'symlink' | 'submodule';
}

async function fetchGithubContents(owner: string, repo: string, path: string): Promise<GhContentEntry[] | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(path)}`;
  try {
    const headers: Record<string, string> = {
      'User-Agent': 'pikiclaw-dashboard',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const token = await resolveGithubToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    return data as GhContentEntry[];
  } catch { return null; }
}

/**
 * Discover skills inside a remote repo. Tries the two common layouts:
 *   1. `<repo>/skills/<name>/SKILL.md`   (Anthropic-style)
 *   2. `<repo>/<name>/SKILL.md`          (flat layout)
 *
 * Returns a deduplicated list of subdirectory names that look like skills.
 * Best-effort — a missing SKILL.md inside a subdir just gets included if the
 * subdir name matches sensible conventions, since some repos lazy-load.
 */
async function listRemoteSkillsFromGithub(source: string): Promise<RemoteSkillsResult | null> {
  const cached = remoteSkillsCache.get(source);
  if (cached && Date.now() - cached.cachedAt < REMOTE_SKILLS_TTL_MS) return cached.value;

  const inflight = remoteSkillsInflight.get(source);
  if (inflight) return inflight;

  const promise = (async () => {
    const parsed = parseSourceToOwnerRepo(source);
    if (!parsed) return null;
    const { owner, repo } = parsed;

    // Look for skills/ subdir first; fall back to root if absent.
    let listing = await fetchGithubContents(owner, repo, 'skills');
    let basePath = 'skills';
    if (!listing || listing.length === 0) {
      listing = await fetchGithubContents(owner, repo, '');
      basePath = '';
    }
    if (!listing) return null;

    const directories = listing.filter(e => e.type === 'dir' && !e.name.startsWith('.'));

    // To keep one repo from costing 100+ subsequent fetches (verifying SKILL.md
    // inside each subdir), we skip the per-skill verification and instead
    // accept any directory under the resolved base as a candidate skill. This
    // matches how `npx skills add` itself enumerates targets.
    const skills: RemoteSkillInfo[] = directories.map(d => ({
      name: d.name,
      path: d.path,
    }));

    // Some repos return >1000 entries; GitHub's contents endpoint caps there.
    const partial = directories.length >= 1000;
    const result: RemoteSkillsResult = { skills, partial };
    remoteSkillsCache.set(source, { value: result, cachedAt: Date.now() });
    return result;
  })().finally(() => remoteSkillsInflight.delete(source));

  remoteSkillsInflight.set(source, promise);
  return promise;
}

/** GET /api/extensions/skills/list?source=owner/repo — list a repo's available skills. */
app.get('/api/extensions/skills/list', async (c) => {
  const source = c.req.query('source')?.trim();
  if (!source) return c.json({ ok: false, error: 'source is required', skills: [] }, 400);
  const result = await listRemoteSkillsFromGithub(source);
  if (!result) {
    return c.json({
      ok: false,
      error: 'failed to list remote skills',
      skills: [],
      partial: false,
    }, 502);
  }
  return c.json({ ok: true, skills: result.skills, partial: result.partial });
});

async function fetchOneRepoMeta(source: string): Promise<RepoMeta | null> {
  // Accept either `owner/repo` or a full GitHub URL.
  const slug = source.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  if (!/^[^/]+\/[^/]+$/.test(slug)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const token = await resolveGithubToken();
    const res = await fetch(`https://api.github.com/repos/${slug}`, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'pikiclaw-dashboard',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json() as { stargazers_count?: number; pushed_at?: string };
    if (typeof data.stargazers_count !== 'number') return null;
    return { stars: data.stargazers_count, pushedAt: data.pushed_at || '' };
  } catch { return null; }
}

async function ensureRepoMeta(sources: string[]): Promise<void> {
  const now = Date.now();
  const stale = sources.filter(s => {
    const hit = githubMetaCache.get(s);
    return !hit || now - hit.cachedAt > GITHUB_META_TTL_MS;
  });
  if (stale.length === 0) return;
  if (githubMetaInflight) { await githubMetaInflight; return; }
  githubMetaInflight = (async () => {
    await Promise.all(stale.map(async s => {
      const meta = await fetchOneRepoMeta(s);
      if (meta) githubMetaCache.set(s, { value: meta, cachedAt: now });
    }));
  })();
  try { await githubMetaInflight; } finally { githubMetaInflight = null; }
}

/** GET /api/extensions/skills/catalog — unified recommended + installed skills view. */
app.get('/api/extensions/skills/catalog', async (c) => {
  const workdir = c.req.query('workdir') || runtime.getRequestWorkdir();
  const scopeParam = c.req.query('scope');
  const scope = scopeParam === 'global' || scopeParam === 'workspace' || scopeParam === 'both'
    ? scopeParam
    : undefined;

  // Workspace view requires a workdir; global view can use the global skills dir without one.
  if (scope === 'workspace' && !workdir) {
    return c.json({ ok: false, error: 'workdir is required', items: [], installed: [] }, 400);
  }

  const installedResult = listSkills(workdir);
  const installed = installedResult.skills || [];
  const recommended = getRecommendedSkillRepos();

  const filtered = recommended.filter(repo => {
    if (!scope) return true;
    return repo.recommendedScope === scope || repo.recommendedScope === 'both';
  });

  // Best-effort GitHub metadata. We don't await on a cold cache here so the
  // first paint isn't blocked by GitHub latency — if results are still cold,
  // they'll appear on the next refresh (the dashboard already does SWR).
  const sources = filtered.map(r => r.source);
  const allCached = sources.every(s => githubMetaCache.has(s));
  if (allCached) {
    // Cheap path: nothing to fetch, just return.
  } else {
    await ensureRepoMeta(sources).catch(() => { /* non-fatal */ });
  }

  // Fire-and-forget warm-up for the remote-skills listing on any source we
  // haven't seen yet. On the first ever catalog load this won't return totals,
  // but the SWR refresh on the dashboard picks them up moments later.
  for (const s of sources) {
    if (!remoteSkillsCache.has(s) && !remoteSkillsInflight.has(s)) {
      void listRemoteSkillsFromGithub(s).catch(() => { /* non-fatal */ });
    }
  }

  // Build a lookup keyed by installed-skill name (lowercased) so we can quickly
  // mark a repo's remote skills as installed. Scope-filter once up front.
  const scopedInstalled = scope === 'global'
    ? installed.filter(s => s.scope === 'global')
    : scope === 'workspace'
      ? installed.filter(s => s.scope === 'project')
      : installed;
  const installedByName = new Map<string, typeof scopedInstalled[number]>();
  for (const s of scopedInstalled) installedByName.set(s.name.toLowerCase(), s);

  const items: SkillCatalogItem[] = filtered.map(repo => {
    const meta = githubMetaCache.get(repo.source)?.value;
    const remote = remoteSkillsCache.get(repo.source)?.value;
    const owner = extractGithubOwner(repo.source);
    const iconUrl = repo.iconUrl
      ?? (owner ? `https://github.com/${owner}.png?size=80` : undefined);

    // Prefer the remote-listing intersection over the static `repo.skills` hint
    // — most catalog entries don't bother filling the hint, and the GitHub
    // listing is authoritative when cached.
    let installedSkillNames: string[];
    if (remote) {
      installedSkillNames = remote.skills
        .map(s => s.name)
        .filter(name => installedByName.has(name.toLowerCase()));
    } else {
      const hints = (repo.skills || []).map(s => s.toLowerCase());
      installedSkillNames = scopedInstalled
        .filter(s => hints.includes(s.name.toLowerCase()))
        .map(s => s.name);
    }
    const firstMatch = installedSkillNames[0]
      ? installedByName.get(installedSkillNames[0].toLowerCase())
      : undefined;

    return {
      id: repo.id,
      name: repo.name,
      description: repo.description,
      descriptionZh: repo.descriptionZh,
      source: repo.source,
      category: repo.category,
      recommendedScope: repo.recommendedScope,
      homepage: repo.homepage,
      installed: installedSkillNames.length > 0,
      scope: firstMatch?.scope,
      installedNames: installedSkillNames,
      stars: meta?.stars,
      pushedAt: meta?.pushedAt,
      iconUrl,
      totalCount: remote?.skills.length,
      partial: remote?.partial,
    };
  });

  // Authority = community popularity. Sort by stars desc, with no-data entries
  // sinking to the bottom so the most-loved repos surface first.
  items.sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1));

  return c.json({ ok: true, items, installed });
});

/** POST /api/extensions/skills/install — install a skill via npx skills add. */
app.post('/api/extensions/skills/install', async (c) => {
  try {
    const body = await c.req.json();
    const { source, global: isGlobal, skill, workdir: reqWorkdir } = body as {
      source: string;
      global?: boolean;
      skill?: string;
      workdir?: string;
    };
    if (!source?.trim()) return c.json({ ok: false, error: 'source is required' }, 400);

    const workdir = reqWorkdir || runtime.getRequestWorkdir();
    if (!isGlobal && !isValidWorkdir(workdir)) {
      return c.json({ ok: false, error: 'valid workdir is required for project-scoped install' }, 400);
    }

    const result = await installSkill(source.trim(), { global: isGlobal, skill, workdir });
    return c.json(result);
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'installation failed' }, 500);
  }
});

/** POST /api/extensions/skills/remove — remove an installed skill. */
app.post('/api/extensions/skills/remove', async (c) => {
  try {
    const body = await c.req.json();
    const { name, global: isGlobal, workdir: reqWorkdir } = body as {
      name: string;
      global?: boolean;
      workdir?: string;
    };
    if (!name?.trim()) return c.json({ ok: false, error: 'name is required' }, 400);

    const workdir = reqWorkdir || runtime.getRequestWorkdir();
    const result = removeSkill(name.trim(), { global: isGlobal, workdir });
    return c.json(result);
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'removal failed' }, 500);
  }
});

/** GET /api/extensions/skills/search — search community skills. */
app.get('/api/extensions/skills/search', async (c) => {
  const query = c.req.query('q') || '';
  try {
    const results = await searchSkillRepos(query);
    return c.json({ ok: true, results });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message, results: [] });
  }
});

export default app;

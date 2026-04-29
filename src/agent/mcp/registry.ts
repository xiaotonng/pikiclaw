/**
 * MCP extension registry — curated recommended servers, recommended skills, community search.
 *
 * Schema supports three transport × auth combinations:
 *   - stdio  + none         (local, zero-config)
 *   - stdio  + credentials  (local, needs API key/token)
 *   - http   + none         (rare)
 *   - http   + credentials  (remote with API key)
 *   - http   + mcp-oauth    (remote SaaS via MCP OAuth spec)
 *
 * For MCP-OAuth servers, `authorizationEndpoint` / `tokenEndpoint` can be
 * pre-declared (fast path) or omitted (discovered via MCP Protected Resource
 * Metadata at `<url>/.well-known/oauth-protected-resource`).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpTransportSpec =
  | { type: 'stdio'; command: string; args: string[] }
  | { type: 'http'; url: string };

export interface CredentialField {
  key: string;
  label: string;
  labelZh: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  helpUrl?: string;
}

export type McpAuthSpec =
  | { type: 'none' }
  | { type: 'credentials'; fields: CredentialField[] }
  | {
      type: 'mcp-oauth';
      /** Optional pre-declared authorization endpoint (skips discovery). */
      authorizationEndpoint?: string;
      /** Optional pre-declared token endpoint. */
      tokenEndpoint?: string;
      /** Optional pre-declared dynamic client registration endpoint. */
      registrationEndpoint?: string;
      /** Optional pre-registered public client id (skips DCR). */
      clientId?: string;
      /** Requested OAuth scopes. */
      scopes?: string[];
    };

export type McpCategory = 'dev' | 'productivity' | 'communication' | 'data' | 'search' | 'utility';

/**
 * Where a recommended server belongs in the UI:
 *   - `global`    — SaaS/remote services with account-level auth; install once,
 *                   use everywhere (GitHub, Atlassian, Notion, Slack, …).
 *   - `workspace` — tools that depend on project context (`${WORKDIR}`, local
 *                   data, project connection string).
 *   - `both`      — zero-config local utilities that make sense either place
 *                   (Fetch, Memory, Time).
 */
export type RecommendedScope = 'global' | 'workspace' | 'both';

export interface RecommendedMcpServer {
  id: string;
  name: string;
  description: string;
  descriptionZh: string;
  category: McpCategory;
  recommendedScope: RecommendedScope;
  transport: McpTransportSpec;
  auth: McpAuthSpec;
  iconSlug?: string;
  /** Optional override URL for the brand logo (SVG/PNG). Falls back to simpleicons CDN via iconSlug. */
  iconUrl?: string;
  homepage?: string;
}

export type SkillCategory = 'general' | 'dev' | 'productivity';

export interface RecommendedSkillRepo {
  id: string;
  name: string;
  description: string;
  descriptionZh: string;
  source: string;
  skills?: string[];
  category: SkillCategory;
  recommendedScope: RecommendedScope;
  homepage?: string;
}

export interface McpSearchResult {
  name: string;
  description: string;
  npmPackage?: string;
  source?: string;
  stars?: number;
}

export interface SkillSearchResult {
  name: string;
  description: string;
  source: string;
  author?: string;
  stars?: number;
}

// ---------------------------------------------------------------------------
// Recommended MCP servers + skill repos — data lives in src/catalog/
//
// This module owns the *types* and helper functions. Edit
// `src/catalog/mcp-servers.ts` and `src/catalog/skill-repos.ts` to add or hide
// entries; the arrays below are just pointers back at that catalog.
// ---------------------------------------------------------------------------

import { MCP_SERVERS, SKILL_REPOS } from '../../catalog/index.js';

const RECOMMENDED_MCP_SERVERS: RecommendedMcpServer[] = MCP_SERVERS;
const RECOMMENDED_SKILL_REPOS: RecommendedSkillRepo[] = SKILL_REPOS;


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getRecommendedMcpServers(): RecommendedMcpServer[] {
  return RECOMMENDED_MCP_SERVERS;
}

export function getRecommendedMcpServer(id: string): RecommendedMcpServer | undefined {
  return RECOMMENDED_MCP_SERVERS.find(s => s.id === id);
}

export function getRecommendedSkillRepos(): RecommendedSkillRepo[] {
  return RECOMMENDED_SKILL_REPOS;
}

/**
 * Search the official MCP Registry API for servers.
 * Falls back to npm search if the registry is unreachable.
 */
export async function searchMcpServers(query: string, limit = 20): Promise<McpSearchResult[]> {
  if (!query.trim()) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  try {
    const url = `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.servers)) {
        return data.servers.map((s: any) => ({
          name: s.name || s.display_name || '',
          description: s.description || '',
          npmPackage: s.npm_package || undefined,
          source: s.repository || s.url || undefined,
          stars: typeof s.stars === 'number' ? s.stars : undefined,
        })).filter((s: McpSearchResult) => s.name);
      }
      if (Array.isArray(data)) {
        return data.slice(0, limit).map((s: any) => ({
          name: s.name || '',
          description: s.description || '',
          source: s.repository || s.url || undefined,
        })).filter((s: McpSearchResult) => s.name);
      }
    }
  } catch {
    clearTimeout(timer);
  }

  try {
    const npmUrl = `https://registry.npmjs.org/-/v1/search?text=mcp+server+${encodeURIComponent(query)}&size=${limit}`;
    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), 5_000);
    const res = await fetch(npmUrl, { signal: controller2.signal });
    clearTimeout(timer2);

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.objects)) {
        return data.objects.map((o: any) => ({
          name: o.package?.name || '',
          description: o.package?.description || '',
          npmPackage: o.package?.name,
        })).filter((s: McpSearchResult) => s.name);
      }
    }
  } catch { /* fallback failed */ }

  return [];
}

/**
 * Search for skills via npm search (`agent skill` keywords).
 */
export async function searchSkills(query: string, limit = 20): Promise<SkillSearchResult[]> {
  if (!query.trim()) return [];
  try {
    const npmUrl = `https://registry.npmjs.org/-/v1/search?text=agent+skill+${encodeURIComponent(query)}&size=${limit}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(npmUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) return [];
    const data = await res.json();

    if (Array.isArray(data.objects)) {
      return data.objects.map((o: any) => ({
        name: o.package?.name || '',
        description: o.package?.description || '',
        source: o.package?.links?.repository || o.package?.name || '',
        author: o.package?.publisher?.username,
      })).filter((s: SkillSearchResult) => s.name);
    }
  } catch { /* unreachable */ }
  return [];
}

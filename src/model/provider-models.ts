/**
 * Provider model-list cache.
 *
 * Backs the GET /api/models/providers/:id/models endpoint and the agent-status
 * + IM /models surfaces. Each entry is a list of model ids the provider's
 * /models endpoint reported, plus a fetch timestamp for TTL invalidation.
 *
 * Cache is in-memory only — providers' validation state already persists in
 * setting.json; the model list itself can be re-fetched cheaply on demand.
 */

import { getProvider } from './store.js';
import { validateProvider, type ProviderModelInfo } from './validation.js';
import type { ProviderConfig } from './types.js';

const TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CacheEntry {
  models: string[];
  modelInfos: ProviderModelInfo[];
  fetchedAt: number;
  providerUpdatedAt: string;
}

// Cache is pinned to globalThis so module re-instantiation under tsx ESM
// (e.g. when the same file is imported via different specifier strings) can't
// fragment it into multiple disjoint maps. Without this, `getProviderModelList`
// from `dashboard/routes/models.ts` (barrel) and `peekProviderModelList` from
// `dashboard/routes/agents.ts` (also barrel) were writing/reading two
// different Map instances, making the peek perpetually miss.
// Cache pinned to globalThis so module re-instantiation under tsx ESM
// (where the same file imported via different specifier strings ends up as
// separate ESM module instances) can't fragment it into multiple disjoint
// maps. Without this, `getProviderModelList` from `dashboard/routes/models.ts`
// and `peekProviderModelList` from `dashboard/routes/agents.ts` would be
// writing/reading two different Map instances and the peek would
// perpetually miss.
const GLOBAL_KEY = Symbol.for('pikiclaw.providerModelsCache');
const _existing = (globalThis as any)[GLOBAL_KEY] as Map<string, CacheEntry> | undefined;
const cache: Map<string, CacheEntry> = _existing || new Map<string, CacheEntry>();
if (!_existing) (globalThis as any)[GLOBAL_KEY] = cache;

function isFresh(entry: CacheEntry, provider: ProviderConfig): boolean {
  if (entry.providerUpdatedAt !== provider.updatedAt) return false;
  return (Date.now() - entry.fetchedAt) < TTL_MS;
}

/**
 * Get the model list for a provider, fetching from /models on cache miss or
 * when the provider config has been updated since the last fetch.
 */
export async function getProviderModelList(providerId: string, opts: { forceRefresh?: boolean } = {}): Promise<{
  models: string[];
  modelInfos: ProviderModelInfo[];
  fetchedAt: number;
  fromCache: boolean;
} | null> {
  const provider = getProvider(providerId);
  if (!provider) return null;

  const cached = cache.get(providerId);
  if (!opts.forceRefresh && cached && isFresh(cached, provider)) {
    return {
      models: cached.models,
      modelInfos: cached.modelInfos,
      fetchedAt: cached.fetchedAt,
      fromCache: true,
    };
  }

  const result = await validateProvider(provider);
  const entry: CacheEntry = {
    models: result.models,
    modelInfos: result.modelInfos,
    fetchedAt: Date.now(),
    providerUpdatedAt: provider.updatedAt,
  };
  cache.set(providerId, entry);
  return {
    models: entry.models,
    modelInfos: entry.modelInfos,
    fetchedAt: entry.fetchedAt,
    fromCache: false,
  };
}

/**
 * Invalidate cached model list (e.g. after a provider edit/delete).
 */
export function invalidateProviderModels(providerId: string): void {
  cache.delete(providerId);
}

/**
 * Synchronous peek for a single model's cached metadata (context length,
 * pricing). Returns `null` on cache miss or when the entry is stale relative
 * to the provider's `updatedAt` — callers should treat that as "unknown" and
 * fall back to whatever the agent CLI reports. Pair with
 * `prefetchProviderModels` to populate the cache lazily for the next call.
 */
export function peekProviderModelInfo(providerId: string, modelId: string): ProviderModelInfo | null {
  const provider = getProvider(providerId);
  if (!provider) return null;
  const entry = cache.get(providerId);
  if (!entry || !isFresh(entry, provider)) return null;
  return entry.modelInfos.find(info => info.id === modelId) ?? null;
}

/**
 * Synchronous peek for the full cached model list of a provider. Returns
 * `null` on cache miss / stale entry — callers should fall back and let a
 * background refresh populate it (`prefetchProviderModels`).
 */
export function peekProviderModelList(providerId: string): ProviderModelInfo[] | null {
  const provider = getProvider(providerId);
  if (!provider) return null;
  const entry = cache.get(providerId);
  if (!entry || !isFresh(entry, provider)) return null;
  return entry.modelInfos;
}

/**
 * Fire-and-forget cache fill. Safe to call repeatedly: no-ops when the cache
 * is already fresh, otherwise triggers a single in-flight fetch and discards
 * the result (the next sync peek will see the populated cache).
 */
export function prefetchProviderModels(providerId: string): void {
  void getProviderModelList(providerId).catch(() => {});
}

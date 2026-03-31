import type { ApiRequestOptions } from './api';
import { api } from './api';
import type { SessionHubResult, SessionMessagesResult } from './types';

const WORKSPACE_CACHE_TTL_MS = 5_000;
const MESSAGE_CACHE_TTL_MS = 15_000;
const MAX_WORKSPACE_CACHE_ENTRIES = 8;
const MAX_MESSAGE_CACHE_ENTRIES = 10;
const MESSAGE_PREFETCH_CONCURRENCY = 1;

interface CacheEntry<T> {
  value?: T;
  expiresAt: number;
  promise?: Promise<T>;
}

export interface SessionMessagesQuery {
  workdir: string;
  agent: string;
  sessionId: string;
  rich?: boolean;
  lastNTurns?: number;
  turnOffset?: number;
  turnLimit?: number;
}

const workspaceCache = new Map<string, CacheEntry<SessionHubResult>>();
const messageCache = new Map<string, CacheEntry<SessionMessagesResult>>();
const queuedMessagePrefetches = new Set<string>();
const messagePrefetchQueue: Array<() => Promise<void>> = [];
let activeMessagePrefetches = 0;

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function touchCacheEntry<T>(cache: Map<string, CacheEntry<T>>, key: string, entry: CacheEntry<T>, maxEntries: number) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function getFreshValue<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry?.value) return null;
  if (entry.expiresAt <= Date.now()) return null;
  touchCacheEntry(cache, key, entry, cache === messageCache ? MAX_MESSAGE_CACHE_ENTRIES : MAX_WORKSPACE_CACHE_ENTRIES);
  return entry.value;
}

function normalizeSessionMessagesQuery(query: SessionMessagesQuery) {
  return {
    workdir: query.workdir,
    agent: query.agent,
    sessionId: query.sessionId,
    rich: query.rich ?? true,
    lastNTurns: isFiniteNumber(query.lastNTurns) ? query.lastNTurns : undefined,
    turnOffset: isFiniteNumber(query.turnOffset) ? query.turnOffset : undefined,
    turnLimit: isFiniteNumber(query.turnLimit) ? query.turnLimit : undefined,
  };
}

function sessionMessagesCacheKey(query: SessionMessagesQuery): string {
  const normalized = normalizeSessionMessagesQuery(query);
  return [
    normalized.workdir,
    normalized.agent,
    normalized.sessionId,
    normalized.rich ? 'rich' : 'plain',
    normalized.lastNTurns ?? '',
    normalized.turnOffset ?? '',
    normalized.turnLimit ?? '',
  ].join('::');
}

function pumpMessagePrefetchQueue() {
  while (activeMessagePrefetches < MESSAGE_PREFETCH_CONCURRENCY) {
    const next = messagePrefetchQueue.shift();
    if (!next) return;
    activeMessagePrefetches += 1;
    void next().finally(() => {
      activeMessagePrefetches = Math.max(0, activeMessagePrefetches - 1);
      pumpMessagePrefetchQueue();
    });
  }
}

export function peekWorkspaceSessions(workdir: string, opts: { allowStale?: boolean } = {}): SessionHubResult | null {
  const entry = workspaceCache.get(workdir);
  if (!entry?.value) return null;
  if (opts.allowStale || entry.expiresAt > Date.now()) return entry.value;
  return null;
}

export async function loadWorkspaceSessions(
  workdir: string,
  opts: { force?: boolean; request?: ApiRequestOptions } = {},
): Promise<SessionHubResult> {
  const key = workdir;
  if (!opts.force) {
    const cached = getFreshValue(workspaceCache, key);
    if (cached) return cached;
  }

  const existing = workspaceCache.get(key);
  if (existing?.promise) return existing.promise;

  const request = api.getWorkspaceSessions(workdir, opts.request).then(result => {
    touchCacheEntry(workspaceCache, key, {
      value: result,
      expiresAt: result.ok ? Date.now() + WORKSPACE_CACHE_TTL_MS : 0,
    }, MAX_WORKSPACE_CACHE_ENTRIES);
    return result;
  }).finally(() => {
    const current = workspaceCache.get(key);
    if (!current?.promise) return;
    touchCacheEntry(workspaceCache, key, {
      value: current.value,
      expiresAt: current.expiresAt,
    }, MAX_WORKSPACE_CACHE_ENTRIES);
  });

  touchCacheEntry(workspaceCache, key, {
    value: existing?.value,
    expiresAt: existing?.expiresAt ?? 0,
    promise: request,
  }, MAX_WORKSPACE_CACHE_ENTRIES);

  return request;
}

export function peekSessionMessages(query: SessionMessagesQuery, opts: { allowStale?: boolean } = {}): SessionMessagesResult | null {
  const key = sessionMessagesCacheKey(query);
  const entry = messageCache.get(key);
  if (!entry?.value?.ok) return null;
  if (opts.allowStale || entry.expiresAt > Date.now()) return entry.value;
  return null;
}

export async function loadSessionMessages(
  query: SessionMessagesQuery,
  opts: { force?: boolean; request?: ApiRequestOptions } = {},
): Promise<SessionMessagesResult> {
  const normalized = normalizeSessionMessagesQuery(query);
  const key = sessionMessagesCacheKey(normalized);
  if (!opts.force) {
    const cached = getFreshValue(messageCache, key);
    if (cached?.ok) return cached;
  }

  const existing = messageCache.get(key);
  if (existing?.promise) return existing.promise;

  const request = api.getSessionMessages(
    normalized.workdir,
    normalized.agent,
    normalized.sessionId,
    {
      rich: normalized.rich,
      lastNTurns: normalized.lastNTurns,
      turnOffset: normalized.turnOffset,
      turnLimit: normalized.turnLimit,
    },
    opts.request,
  ).then(result => {
    touchCacheEntry(messageCache, key, {
      value: result,
      expiresAt: result.ok ? Date.now() + MESSAGE_CACHE_TTL_MS : 0,
    }, MAX_MESSAGE_CACHE_ENTRIES);
    return result;
  }).finally(() => {
    const current = messageCache.get(key);
    if (!current?.promise) return;
    touchCacheEntry(messageCache, key, {
      value: current.value,
      expiresAt: current.expiresAt,
    }, MAX_MESSAGE_CACHE_ENTRIES);
  });

  touchCacheEntry(messageCache, key, {
    value: existing?.value,
    expiresAt: existing?.expiresAt ?? 0,
    promise: request,
  }, MAX_MESSAGE_CACHE_ENTRIES);

  return request;
}

export function prefetchSessionMessages(query: SessionMessagesQuery) {
  const key = sessionMessagesCacheKey(query);
  if (peekSessionMessages(query)) return;
  if (queuedMessagePrefetches.has(key)) return;
  if (messageCache.get(key)?.promise) return;

  queuedMessagePrefetches.add(key);
  messagePrefetchQueue.push(async () => {
    try {
      await loadSessionMessages(query);
    } catch {
      // Best-effort warm-up only.
    } finally {
      queuedMessagePrefetches.delete(key);
    }
  });
  pumpMessagePrefetchQueue();
}

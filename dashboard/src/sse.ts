/**
 * sse.ts — Singleton SSE connection + React hook for dashboard push events.
 *
 * Provides `useDashboardEvent(type, callback)` — components subscribe to
 * specific event types and receive push updates without polling.
 */

import { useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Types (mirror of DashboardEvent from server)
// ---------------------------------------------------------------------------

export type DashboardEventType = 'stream-update' | 'sessions-changed';

export interface DashboardEvent {
  type: DashboardEventType;
  key?: string;
  snapshot?: unknown;
}

type Listener = (event: DashboardEvent) => void;

// ---------------------------------------------------------------------------
// Singleton SSE connection
// ---------------------------------------------------------------------------

const listeners = new Map<DashboardEventType, Set<Listener>>();
let eventSource: EventSource | null = null;
let refCount = 0;

function dispatch(event: DashboardEvent) {
  const set = listeners.get(event.type);
  if (set) for (const fn of set) fn(event);
}

function connect() {
  if (eventSource) return;
  const es = new EventSource('/api/events');
  es.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data) as DashboardEvent;
      dispatch(event);
    } catch { /* malformed event */ }
  };
  es.onerror = () => {
    // EventSource auto-reconnects — nothing to do.
    // Browser will retry with exponential backoff.
  };
  eventSource = es;
}

function disconnect() {
  if (!eventSource) return;
  eventSource.close();
  eventSource = null;
}

function subscribe(type: DashboardEventType, fn: Listener) {
  let set = listeners.get(type);
  if (!set) { set = new Set(); listeners.set(type, set); }
  set.add(fn);
  refCount++;
  if (refCount === 1) connect();
}

function unsubscribe(type: DashboardEventType, fn: Listener) {
  const set = listeners.get(type);
  if (set) {
    set.delete(fn);
    if (set.size === 0) listeners.delete(type);
  }
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0) disconnect();
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Subscribe to dashboard SSE events of a given type.
 *
 * The callback is stable — it is always called with the latest closure
 * without re-subscribing on every render.
 *
 * @param type   The event type to listen for (or null to disable).
 * @param callback  Called when a matching event arrives.
 */
export function useDashboardEvent(
  type: DashboardEventType | null,
  callback: (event: DashboardEvent) => void,
): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    if (!type) return;
    const handler: Listener = (event) => cbRef.current(event);
    subscribe(type, handler);
    return () => unsubscribe(type, handler);
  }, [type]);
}

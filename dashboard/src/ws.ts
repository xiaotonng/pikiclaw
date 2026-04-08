/**
 * ws.ts — Singleton WebSocket connection + React hook for dashboard push events.
 *
 * Replaces the previous SSE layer with bidirectional WebSocket communication.
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
// Singleton WebSocket connection with auto-reconnect
// ---------------------------------------------------------------------------

const listeners = new Map<DashboardEventType, Set<Listener>>();
const reconnectListeners = new Set<() => void>();
let ws: WebSocket | null = null;
let refCount = 0;
let wasConnected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 500;
const MAX_RECONNECT_DELAY = 8_000;

function dispatch(event: DashboardEvent) {
  const set = listeners.get(event.type);
  if (set) for (const fn of set) fn(event);
}

function getWsUrl(): string {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}/ws`;
}

function connect() {
  if (ws) return;
  clearReconnectTimer();

  const socket = new WebSocket(getWsUrl());

  socket.onopen = () => {
    const isReconnect = wasConnected;
    wasConnected = true;
    reconnectDelay = 500; // reset backoff on success
    if (isReconnect) {
      for (const fn of reconnectListeners) fn();
    }
  };

  socket.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data) as DashboardEvent | { type: string };
      if (event.type === 'pong') return; // keepalive response
      dispatch(event as DashboardEvent);
    } catch { /* malformed message */ }
  };

  socket.onclose = () => {
    ws = null;
    if (refCount > 0) scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose will fire after onerror — reconnect handled there
  };

  ws = socket;
}

function disconnect() {
  clearReconnectTimer();
  if (!ws) return;
  ws.close();
  ws = null;
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (refCount > 0) connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
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

// Reconnect on visibility change (tab becomes visible again)
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && refCount > 0 && !ws) {
      reconnectDelay = 500;
      connect();
    }
  });
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Subscribe to dashboard WebSocket events of a given type.
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

/**
 * Fires callback when the WebSocket connection is re-established after a drop.
 * Useful for refreshing stale state that may have been missed during downtime.
 */
export function useDashboardReconnect(callback: () => void): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    const handler = () => cbRef.current();
    reconnectListeners.add(handler);
    return () => { reconnectListeners.delete(handler); };
  }, []);
}

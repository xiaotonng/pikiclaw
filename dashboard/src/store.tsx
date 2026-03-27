import { create } from 'zustand';
import { api } from './api';
import { hasPendingChannelValidation } from './channel-status';
import type { AppState, HostInfo, SessionInfo } from './types';
import type { Locale } from './i18n';

/* ── Toast ── */
export interface Toast {
  id: number;
  message: string;
  ok: boolean;
}

export type Theme = 'dark' | 'light';

/* ── Helpers ── */
let _toastId = 0;

function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem('pikiclaw-theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {}
  return 'dark';
}

function getInitialLocale(): Locale {
  try {
    const stored = localStorage.getItem('pikiclaw-locale');
    if (stored === 'en' || stored === 'zh-CN') return stored;
  } catch {}
  return 'zh-CN';
}

/* ── Store shape ── */
interface StoreState {
  /* ── Data slices ── */
  state: AppState | null;
  host: HostInfo | null;
  toasts: Toast[];
  allSessions: Record<string, { sessions: SessionInfo[] }>;
  theme: Theme;
  locale: Locale;

  /* ── Actions ── */
  toast: (msg: string, ok?: boolean) => void;
  setTheme: (t: Theme) => void;
  setLocale: (l: Locale) => void;
  reload: () => Promise<AppState | null>;
  reloadUntil: (
    predicate: (state: AppState) => boolean,
    opts?: { attempts?: number; intervalMs?: number },
  ) => Promise<AppState | null>;
  loadSessions: () => Promise<void>;
}

/* ── Apply theme to DOM once at module load ── */
const initialTheme = getInitialTheme();
document.documentElement.dataset.theme = initialTheme;

/* ══════════════════════════════════════════════════════
   Zustand Store — selector-based, no Provider needed.
   Components subscribe only to the slices they read:
     const locale = useStore(s => s.locale);
   Actions are stable refs and never cause re-renders.
   ══════════════════════════════════════════════════════ */
export const useStore = create<StoreState>()((set, get) => ({
  /* ── Initial data ── */
  state: null,
  host: null,
  toasts: [],
  allSessions: {},
  theme: initialTheme,
  locale: getInitialLocale(),

  /* ── Toast ── */
  toast: (message, ok = true) => {
    const id = ++_toastId;
    set((prev) => ({ toasts: [...prev.toasts, { id, message, ok }] }));
    setTimeout(() => {
      set((prev) => ({ toasts: prev.toasts.filter((t) => t.id !== id) }));
    }, 3000);
  },

  /* ── Theme ── */
  setTheme: (t) => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('pikiclaw-theme', t); } catch {}
    set({ theme: t });
  },

  /* ── Locale ── */
  setLocale: (l) => {
    try { localStorage.setItem('pikiclaw-locale', l); } catch {}
    set({ locale: l });
  },

  /* ── Reload app state + host ── */
  reload: async () => {
    try {
      const statePromise = api.getState();
      const hostPromise = api.getHost().catch(() => null);
      const d = await statePromise;
      const h = await hostPromise;
      set({ state: d, ...(h ? { host: h } : {}) });
      return d;
    } catch (e) {
      console.error('loadState:', e);
      return null;
    }
  },

  /* ── Reload with polling until predicate ── */
  reloadUntil: async (predicate, opts) => {
    const attempts = opts?.attempts ?? 8;
    const intervalMs = opts?.intervalMs ?? 250;
    let latest: AppState | null = null;
    for (let i = 0; i < attempts; i++) {
      latest = await get().reload();
      if (latest && predicate(latest)) return latest;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
    }
    return latest;
  },

  /* ── Load sessions (legacy, for non-hub tabs) ── */
  loadSessions: async () => {
    try {
      const [s, h, ses] = await Promise.all([
        api.getState(),
        api.getHost(),
        api.getSessions(),
      ]);
      set({
        state: s,
        host: h,
        allSessions: ses as Record<string, { sessions: SessionInfo[] }>,
      });
    } catch (e) {
      console.error('loadSessions:', e);
    }
  },
}));

/* ── Kick off initial load ── */
void useStore.getState().reload();

/* ══════════════════════════════════════════════════════
   Channel validation polling — runs as a store subscription.
   Fires when channels have pending validation.
   Updates only the `state` slice.
   ══════════════════════════════════════════════════════ */
let _channelPollTimer: ReturnType<typeof setTimeout> | null = null;

useStore.subscribe((cur, prev) => {
  // Only react to state changes (channel validation results)
  if (cur.state === prev.state) return;

  // Clear any pending timer
  if (_channelPollTimer) { clearTimeout(_channelPollTimer); _channelPollTimer = null; }

  // Skip if no channels need validation
  if (!hasPendingChannelValidation(cur.state?.setupState?.channels || null)) return;

  _channelPollTimer = setTimeout(() => {
    _channelPollTimer = null;
    void useStore.getState().reload();
  }, 1500);
});

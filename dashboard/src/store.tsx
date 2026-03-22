import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { hasPendingChannelValidation } from './channel-status';
import { DEFAULT_DASHBOARD_TAB, type DashboardTab } from './tabs';
import type { AppState, HostInfo, SessionInfo } from './types';
import type { Locale } from './i18n';

/* ── Toast ── */
export interface Toast {
  id: number;
  message: string;
  ok: boolean;
}

export type Theme = 'dark' | 'light';

/* ── Store value ── */
interface StoreValue {
  state: AppState | null;
  tab: DashboardTab;
  setTab: (t: DashboardTab) => void;
  reload: () => Promise<AppState | null>;
  reloadUntil: (predicate: (state: AppState) => boolean, opts?: { attempts?: number; intervalMs?: number }) => Promise<AppState | null>;
  toasts: Toast[];
  toast: (msg: string, ok?: boolean) => void;
  host: HostInfo | null;
  allSessions: Record<string, { sessions: SessionInfo[] }>;
  loadSessions: () => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  locale: Locale;
  setLocale: (l: Locale) => void;
}

const Ctx = createContext<StoreValue>(null!);

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

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<DashboardTab>(DEFAULT_DASHBOARD_TAB);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [host, setHost] = useState<HostInfo | null>(null);
  const [allSessions, setAllSessions] = useState<Record<string, { sessions: SessionInfo[] }>>({});
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('pikiclaw-theme', t); } catch {}
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try { localStorage.setItem('pikiclaw-locale', l); } catch {}
  }, []);

  // Apply theme on mount
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, []);

  const reload = useCallback(async () => {
    try {
      // Load state first (fast) so UI can render immediately;
      // host info loads in parallel but doesn't block state rendering
      const statePromise = api.getState();
      const hostPromise = api.getHost().then(h => setHost(h)).catch(() => {});
      const d = await statePromise;
      setState(d);
      await hostPromise;
      return d;
    } catch (e) {
      console.error('loadState:', e);
      return null;
    }
  }, []);

  const reloadUntil = useCallback(async (
    predicate: (nextState: AppState) => boolean,
    opts?: { attempts?: number; intervalMs?: number },
  ) => {
    const attempts = opts?.attempts ?? 8;
    const intervalMs = opts?.intervalMs ?? 250;
    let latest: AppState | null = null;
    for (let i = 0; i < attempts; i++) {
      latest = await reload();
      if (latest && predicate(latest)) return latest;
      if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return latest;
  }, [reload]);

  const toast = useCallback((message: string, ok = true) => {
    const id = ++_toastId;
    setToasts(prev => [...prev, { id, message, ok }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const [s, h, ses] = await Promise.all([api.getState(), api.getHost(), api.getSessions()]);
      setState(s);
      setHost(h);
      setAllSessions(ses as Record<string, { sessions: SessionInfo[] }>);
    } catch (e) {
      console.error('loadSessions:', e);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!hasPendingChannelValidation(state?.setupState?.channels || null)) return;
    const timer = setTimeout(() => {
      void reload();
    }, 1500);
    return () => clearTimeout(timer);
  }, [state, reload]);

  return (
    <Ctx.Provider value={{ state, tab, setTab, reload, reloadUntil, toasts, toast, host, allSessions, loadSessions, theme, setTheme, locale, setLocale }}>
      {children}
    </Ctx.Provider>
  );
}

export function useStore() {
  return useContext(Ctx);
}

import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { Badge, Spinner } from './ui';
import type { DirEntry } from '../types';

/* ═══════════════════════════════════════════════════════
   DirBrowser — Shared directory picker used by both
   WorkdirModal and the session workspace sidebar.
   ═══════════════════════════════════════════════════════ */

export interface DirBrowserProps {
  /** Initial path to browse from */
  initialPath?: string;
  /** Height constraint for the directory listing */
  maxHeight?: number;
  minHeight?: number;
  /** Called when a path is confirmed (double-click on git dir, or via onConfirm parent) */
  onSelect?: (path: string, isGit: boolean) => void;
  /** Compact mode for sidebar embedding (smaller text, no gradient fades) */
  compact?: boolean;
  /** i18n function */
  t: (key: string) => string;
}

export interface DirBrowserHandle {
  currentPath: string;
  isGit: boolean;
  browse: (dir?: string) => Promise<void>;
}

export function DirBrowser({
  initialPath,
  maxHeight = 420,
  minHeight = 200,
  onSelect,
  compact,
  t,
}: DirBrowserProps) {
  const [currentPath, setCurrentPath] = useState('');
  const [inputPath, setInputPath] = useState('');
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [parentDir, setParentDir] = useState('');
  const [isGit, setIsGit] = useState(false);
  const [breadcrumbs, setBreadcrumbs] = useState<{ label: string; path: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const browse = useCallback(async (dir?: string) => {
    setLoading(true);
    setError('');
    try {
      const r = await api.lsDir(dir);
      if (!r.ok) { setError(r.error || t('modal.cannotRead')); setLoading(false); return; }
      setCurrentPath(r.path);
      setInputPath(r.path);
      setDirs(r.dirs);
      setParentDir(r.parent);
      setIsGit(r.isGit);
      const parts = r.path.split('/').filter(Boolean);
      let acc = '';
      setBreadcrumbs(parts.map(p => { acc += '/' + p; return { label: p, path: acc }; }));
      onSelect?.(r.path, r.isGit);
    } catch {
      setError(t('modal.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t, onSelect]);

  useEffect(() => {
    if (initialPath !== undefined) browse(initialPath || undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const textSm = compact ? 'text-[11px]' : 'text-xs';
  const pyItem = compact ? 'py-[5px]' : 'py-[7px]';

  return (
    <div>
      {/* Breadcrumbs */}
      <div className={`flex items-center gap-1 ${compact ? 'text-[10px]' : 'text-[11px]'} font-mono text-fg-4 mb-2 flex-wrap`}>
        <span className="cursor-pointer hover:text-fg-2 transition-colors" onClick={() => browse('/')}>~</span>
        {breadcrumbs.map((b, i) => (
          <span key={i}>
            <span className="text-fg-6">/</span>
            <span className="cursor-pointer hover:text-fg-2 transition-colors" onClick={() => browse(b.path)}>{b.label}</span>
          </span>
        ))}
        {isGit && <Badge variant="accent" className="ml-1 !text-[9px] !py-0 !px-1.5">git</Badge>}
      </div>

      {/* Directory listing */}
      <div className="relative">
        {!compact && (
          <>
            <div
              className="pointer-events-none absolute inset-x-0 top-0 z-10 h-5 rounded-t-lg"
              style={{ background: 'linear-gradient(to bottom, var(--th-panel-alt), rgba(0, 0, 0, 0))' }}
            />
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-5 rounded-b-lg"
              style={{ background: 'linear-gradient(to top, var(--th-panel-alt), rgba(0, 0, 0, 0))' }}
            />
          </>
        )}
        <div
          className="border border-edge rounded-lg overflow-y-auto overscroll-contain scroll-smooth bg-panel-alt"
          style={{ maxHeight, minHeight, scrollbarGutter: 'stable' }}
        >
          {loading ? (
            <div className={`${textSm} text-fg-5 p-4 text-center flex items-center justify-center gap-2`}>
              <Spinner className="h-3 w-3 text-fg-5" />
            </div>
          ) : error ? (
            <div className={`${textSm} text-red-500/70 p-4`}>{error}</div>
          ) : (
            <>
              {parentDir && parentDir !== currentPath && (
                <div
                  className={`flex items-center gap-2 px-3 ${pyItem} cursor-pointer hover:bg-panel transition-colors border-b border-edge`}
                  onClick={() => browse(parentDir)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-fg-5 shrink-0"><polyline points="15 18 9 12 15 6" /></svg>
                  <span className={`${textSm} text-fg-4`}>..</span>
                </div>
              )}
              {dirs.length === 0 && !parentDir && (
                <div className={`${textSm} text-fg-5 p-4 text-center`}>{t('modal.emptyDir')}</div>
              )}
              {dirs.map(d => (
                <div
                  key={d.path}
                  className={`flex items-center gap-2 px-3 ${pyItem} cursor-pointer hover:bg-panel transition-colors`}
                  onClick={() => browse(d.path)}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={d.name === '.git' ? 'var(--th-primary)' : 'currentColor'} strokeWidth="1.8" className="text-fg-5 shrink-0">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                  <span className={`${textSm} text-fg-3`}>{d.name}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Manual input */}
      <div className="mt-2">
        <input
          className={`w-full rounded-lg border border-edge bg-inset px-2.5 py-1.5 ${textSm} font-mono text-fg outline-none placeholder:text-fg-5 focus:border-edge-h transition-colors`}
          placeholder={t('modal.manualInput')}
          value={inputPath}
          onChange={e => setInputPath(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') browse(inputPath); }}
        />
      </div>
    </div>
  );
}

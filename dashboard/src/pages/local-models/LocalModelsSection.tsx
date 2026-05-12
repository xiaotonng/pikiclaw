/**
 * Local Models section — lives on the Agents page, after `<ModelsSection>`.
 *
 * Detects whether Ollama or LM Studio are running on localhost, joins the
 * curated coding-model catalog against the user's installed model list, and
 * lets the user one-click "Connect" a detected backend so the agent cards
 * above can immediately pick its model in their Provider dropdown.
 *
 * Hardware fit:
 *   The host's total unified memory comes from /api/host (already in the
 *   store). For each curated model we compare against `minRamGb`:
 *     totalGb ≥ minRamGb + 4   → ✅ comfortable
 *     totalGb ≥ minRamGb        → ⚠️ tight
 *     otherwise                 → ❌ won't fit
 *   The +4 GB headroom matches what Ollama recommends for the OS + KV cache.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type OllamaPullEvent } from '../../api';
import { useStore } from '../../store';
import type { Locale } from '../../i18n';
import type { LocalBackendStatus, LocalModelCatalogEntry } from '../../types';
import { BrandIcon } from '../../components/BrandIcon';
import { Badge, Button, Spinner } from '../../components/ui';

const RAM_HEADROOM_GB = 4;

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

interface Copy {
  sectionTitle: string;
  sectionHint: string;
  hostLabel: string;
  hostUnknown: string;
  backendsLabel: string;
  detected: string;
  notDetected: string;
  version: string;
  installedModels: (n: number) => string;
  connect: string;
  connecting: string;
  connected: string;
  installPrompt: string;
  installCta: string;
  homepageCta: string;
  catalogLabel: string;
  fitOk: string;
  fitTight: string;
  fitNoGo: string;
  installedBadge: string;
  pullCta: string;
  pullCancel: string;
  pullStatusManifest: string;
  pullStatusVerifying: string;
  pullStatusWriting: string;
  pullStatusDone: string;
  pullFailed: string;
  needsOllamaHint: string;
  needsBackendForLmHint: (cmd: string) => string;
  copyPullCmd: string;
  copied: string;
  refresh: string;
  refreshing: string;
  loadFailed: string;
  toastConnected: string;
  toastAlreadyConnected: string;
  toastConnectFailed: string;
  toastPulled: string;
}

function getCopy(locale: Locale): Copy {
  if (locale === 'zh-CN') {
    return {
      sectionTitle: '本地模型',
      sectionHint: '在本机检测 Ollama / LM Studio，并按你的内存推荐合适的开源模型。已接入的本地服务会作为一个供应商，自动出现在上方智能体卡片的「供应商」下拉里。',
      hostLabel: '本机',
      hostUnknown: '检测中…',
      backendsLabel: '本地推理后端',
      detected: '已运行',
      notDetected: '未检测到',
      version: '版本',
      installedModels: n => `已下载 ${n} 个模型`,
      connect: '接入到智能体',
      connecting: '接入中…',
      connected: '已接入',
      installPrompt: '未在本机检测到此后端，安装后启动即可使用。',
      installCta: '安装',
      homepageCta: '官网',
      catalogLabel: '为本机推荐的模型',
      fitOk: '推荐',
      fitTight: '勉强可跑',
      fitNoGo: '内存不足',
      installedBadge: '已安装',
      pullCta: '一键下载',
      pullCancel: '取消',
      pullStatusManifest: '获取清单…',
      pullStatusVerifying: '校验中…',
      pullStatusWriting: '写入中…',
      pullStatusDone: '下载完成',
      pullFailed: '下载失败',
      needsOllamaHint: '先启动 Ollama 即可一键下载',
      needsBackendForLmHint: cmd => `LM Studio 没有 HTTP 拉取接口，请在终端执行 \`${cmd}\``,
      copyPullCmd: '复制命令',
      copied: '已复制',
      refresh: '刷新',
      refreshing: '刷新中…',
      loadFailed: '加载失败',
      toastConnected: '已接入，可在智能体卡片选择该供应商',
      toastAlreadyConnected: '此后端已接入',
      toastConnectFailed: '接入失败',
      toastPulled: '模型已下载到 Ollama',
    };
  }
  return {
    sectionTitle: 'Local Models',
    sectionHint: 'Detect Ollama / LM Studio on this machine and surface coding models that fit your RAM. Connected backends appear as a regular provider in the agent cards above.',
    hostLabel: 'This Mac',
    hostUnknown: 'Detecting…',
    backendsLabel: 'Local backends',
    detected: 'Running',
    notDetected: 'Not detected',
    version: 'Version',
    installedModels: n => `${n} models pulled`,
    connect: 'Connect to agents',
    connecting: 'Connecting…',
    connected: 'Connected',
    installPrompt: 'Not detected on this machine. Install and launch it to enable local models.',
    installCta: 'Install',
    homepageCta: 'Homepage',
    catalogLabel: 'Recommended for your machine',
    fitOk: 'Recommended',
    fitTight: 'Tight fit',
    fitNoGo: 'Not enough RAM',
    installedBadge: 'Installed',
    pullCta: 'Download',
    pullCancel: 'Cancel',
    pullStatusManifest: 'Fetching manifest…',
    pullStatusVerifying: 'Verifying…',
    pullStatusWriting: 'Writing manifest…',
    pullStatusDone: 'Download complete',
    pullFailed: 'Download failed',
    needsOllamaHint: 'Start Ollama to enable one-click download',
    needsBackendForLmHint: cmd => `LM Studio has no HTTP pull API; run \`${cmd}\` in a terminal instead`,
    copyPullCmd: 'Copy command',
    copied: 'Copied',
    refresh: 'Refresh',
    refreshing: 'Refreshing…',
    loadFailed: 'Failed to load local backends',
    toastConnected: 'Connected — pick it in any agent\'s Provider dropdown',
    toastAlreadyConnected: 'Backend is already connected',
    toastConnectFailed: 'Connect failed',
    toastPulled: 'Model downloaded to Ollama',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Fit = 'ok' | 'tight' | 'no-go';

function fitFor(totalGb: number | null, minRamGb: number): Fit {
  if (totalGb === null) return 'tight';
  if (totalGb >= minRamGb + RAM_HEADROOM_GB) return 'ok';
  if (totalGb >= minRamGb) return 'tight';
  return 'no-go';
}

function pullCommandFor(backend: 'ollama' | 'lmstudio', entry: LocalModelCatalogEntry): string | null {
  if (backend === 'ollama' && entry.ollamaTag) return `ollama pull ${entry.ollamaTag}`;
  if (backend === 'lmstudio' && entry.lmstudioId) return `lms get ${entry.lmstudioId}`;
  return null;
}

function formatGb(bytes: number | undefined | null): string {
  if (!bytes || !Number.isFinite(bytes)) return '—';
  return `${(bytes / 1024 ** 3).toFixed(0)} GB`;
}

// ---------------------------------------------------------------------------
// Pull progress state
// ---------------------------------------------------------------------------

interface PullState {
  status: 'idle' | 'running' | 'done' | 'error';
  /** 0..1 download progress for the current layer; null while in manifest /
   *  verifying / writing phases where Ollama doesn't report bytes. */
  fraction: number | null;
  /** Human-readable phase label, taken straight from Ollama's `status` field. */
  phase: string;
  /** Last error string, when status === 'error'. */
  error: string | null;
}

const IDLE_PULL: PullState = { status: 'idle', fraction: null, phase: '', error: null };

function describePhase(evt: OllamaPullEvent, copy: Copy): { phase: string; fraction: number | null } {
  if (evt.error) return { phase: evt.error, fraction: null };
  const status = (evt.status || '').toLowerCase();
  if (status.startsWith('pulling manifest')) return { phase: copy.pullStatusManifest, fraction: null };
  if (status.startsWith('verifying')) return { phase: copy.pullStatusVerifying, fraction: null };
  if (status.startsWith('writing')) return { phase: copy.pullStatusWriting, fraction: null };
  if (status === 'success') return { phase: copy.pullStatusDone, fraction: 1 };
  if (status.startsWith('downloading') && typeof evt.total === 'number' && typeof evt.completed === 'number' && evt.total > 0) {
    return { phase: `${Math.round((evt.completed / evt.total) * 100)}%`, fraction: evt.completed / evt.total };
  }
  return { phase: evt.status || '', fraction: null };
}

// ---------------------------------------------------------------------------
// Backend card
// ---------------------------------------------------------------------------

function BackendCard({
  backend,
  copy,
  busy,
  onConnect,
}: {
  backend: LocalBackendStatus;
  copy: Copy;
  busy: boolean;
  onConnect: (backend: LocalBackendStatus) => void;
}) {
  const isConnected = !!backend.existingProviderId;
  return (
    <div className="glass rounded-md border border-edge px-4 py-3 shadow-[0_1px_0_rgba(255,255,255,0.02),0_4px_12px_rgba(15,23,42,0.05)]">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-edge bg-panel-alt">
            <BrandIcon brand={backend.id} size={22} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[15px] font-semibold text-fg">{backend.label}</div>
              {backend.detected
                ? <Badge variant="ok">{copy.detected}</Badge>
                : <Badge variant="muted">{copy.notDetected}</Badge>}
              {isConnected && <Badge variant="accent">{copy.connected}</Badge>}
            </div>
            <div className="mt-1 text-[12px] leading-relaxed text-fg-5">
              {backend.detected ? (
                <>
                  {backend.version && <>{copy.version} {backend.version} · </>}
                  {copy.installedModels(backend.models.length)} · <span className="font-mono">{backend.baseURL}</span>
                </>
              ) : (
                <span>{copy.installPrompt}</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {backend.detected && !isConnected && (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => onConnect(backend)}>
              {busy ? copy.connecting : copy.connect}
            </Button>
          )}
          {!backend.detected && (
            <div className="flex items-center gap-2">
              {backend.installHint.brewFormula && (
                <code className="rounded-md border border-edge bg-panel-alt px-2 py-1 text-[11px] text-fg-3">
                  brew install {backend.installHint.brewFormula}
                </code>
              )}
              <a
                href={backend.installHint.homepage}
                target="_blank"
                rel="noreferrer"
                className="text-[12px] text-accent underline-offset-2 hover:underline"
              >
                {backend.installHint.brewFormula ? copy.homepageCta : copy.installCta}
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Catalog row
// ---------------------------------------------------------------------------

function CatalogRow({
  entry,
  totalRamGb,
  detectedBackends,
  pull,
  copy,
  locale,
  onStartPull,
  onCancelPull,
  onCopyHint,
}: {
  entry: LocalModelCatalogEntry;
  totalRamGb: number | null;
  detectedBackends: LocalBackendStatus[];
  pull: PullState;
  copy: Copy;
  locale: Locale;
  onStartPull: (entry: LocalModelCatalogEntry) => void;
  onCancelPull: (entry: LocalModelCatalogEntry) => void;
  onCopyHint: (cmd: string) => void;
}) {
  const fit = fitFor(totalRamGb, entry.minRamGb);
  const ollamaDetected = detectedBackends.some(b => b.id === 'ollama' && b.detected);
  const lmDetected = detectedBackends.some(b => b.id === 'lmstudio' && b.detected);
  const lmCmd = entry.lmstudioId ? pullCommandFor('lmstudio', entry) : null;
  const blurb = locale === 'zh-CN' ? entry.descriptionZh : entry.description;

  // Decide which install affordance to show on the right side:
  //   1) already installed → nothing
  //   2) RAM won't fit → nothing (badge alone makes the case)
  //   3) Ollama running + has Ollama tag → in-app one-click Pull
  //   4) LM Studio running (but not Ollama) + has LM Studio id → copy `lms get …`
  //      since LM Studio has no HTTP pull API
  //   5) Neither backend running → muted hint asking the user to start one
  let action: 'pull' | 'lm-copy' | 'wait' | 'none' = 'none';
  if (!entry.installed && fit !== 'no-go') {
    if (ollamaDetected && entry.ollamaTag) action = 'pull';
    else if (lmDetected && lmCmd) action = 'lm-copy';
    else if (!ollamaDetected && !lmDetected && (entry.ollamaTag || lmCmd)) action = 'wait';
  }

  return (
    <div className="rounded-md border border-edge bg-panel-alt px-3.5 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[13px] font-semibold text-fg">{entry.name}</div>
            <span className="text-[11px] text-fg-5">{entry.publisher}</span>
            {fit === 'ok' && <Badge variant="ok">{copy.fitOk}</Badge>}
            {fit === 'tight' && <Badge variant="warn">{copy.fitTight}</Badge>}
            {fit === 'no-go' && <Badge variant="err">{copy.fitNoGo}</Badge>}
            {entry.installed && <Badge variant="accent">{copy.installedBadge}</Badge>}
          </div>
          <div className="mt-1 text-[12px] leading-relaxed text-fg-4">{blurb}</div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-fg-5">
            <span>{entry.paramsB}B params</span>
            <span>{entry.sizeGb} GB on disk</span>
            <span>≥ {entry.minRamGb} GB RAM</span>
            {entry.homepage && (
              <a
                href={entry.homepage}
                target="_blank"
                rel="noreferrer"
                className="text-accent underline-offset-2 hover:underline"
              >
                {locale === 'zh-CN' ? '模型主页' : 'Model card'}
              </a>
            )}
          </div>

          {/* Inline progress strip below the metadata when a pull is active or
              finished. We keep it within the same row so the user sees the
              before / during / after states of one operation without the row
              jumping around. */}
          {(pull.status === 'running' || pull.status === 'error') && (
            <div className="mt-2">
              <div className="flex items-center justify-between text-[11px] text-fg-4">
                <span>{pull.status === 'error' ? `${copy.pullFailed}: ${pull.error}` : pull.phase}</span>
                {pull.status === 'running' && (
                  <button
                    type="button"
                    onClick={() => onCancelPull(entry)}
                    className="text-[11px] text-fg-5 underline-offset-2 hover:text-fg-3 hover:underline"
                  >
                    {copy.pullCancel}
                  </button>
                )}
              </div>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-panel">
                <div
                  className={pull.status === 'error' ? 'h-full bg-rose-500/70' : 'h-full bg-accent'}
                  style={{
                    width: pull.fraction !== null
                      ? `${Math.max(2, Math.round(pull.fraction * 100))}%`
                      : '12%',
                    transition: 'width 200ms linear',
                    // Indeterminate phase (manifest / verifying): subtle pulse
                    // to communicate "still working" without lying about %.
                    animation: pull.fraction === null && pull.status === 'running'
                      ? 'pulse 1.6s ease-in-out infinite'
                      : undefined,
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Right-side action. Kept aligned to the top of the row so the
            progress strip below doesn't push it around mid-pull. */}
        <div className="flex shrink-0 items-center gap-2 self-start">
          {action === 'pull' && (
            <Button
              variant="primary"
              size="sm"
              disabled={pull.status === 'running'}
              onClick={() => onStartPull(entry)}
            >
              {pull.status === 'running' ? <><Spinner className="h-3 w-3" /> {pull.phase || copy.pullCta}</> : copy.pullCta}
            </Button>
          )}
          {action === 'lm-copy' && lmCmd && (
            <>
              <code className="rounded-md border border-edge bg-panel px-2 py-1 font-mono text-[11px] text-fg-3">{lmCmd}</code>
              <button
                type="button"
                onClick={() => onCopyHint(lmCmd)}
                className="text-[12px] text-accent underline-offset-2 hover:underline"
              >
                {copy.copyPullCmd}
              </button>
            </>
          )}
          {action === 'wait' && (
            <span className="text-[11px] text-fg-5">{copy.needsOllamaHint}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------

export function LocalModelsSection({ onConnected }: { onConnected?: () => void | Promise<void> }) {
  const locale = useStore(s => s.locale);
  const toast = useStore(s => s.toast);
  const host = useStore(s => s.host);
  const copy = useMemo(() => getCopy(locale), [locale]);

  const [backends, setBackends] = useState<LocalBackendStatus[]>([]);
  const [catalog, setCatalog] = useState<LocalModelCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [pulls, setPulls] = useState<Record<string, PullState>>({});
  // Track in-flight pulls so the user can cancel them. We don't store the
  // controllers in React state because mutating them shouldn't trigger
  // re-renders — they're imperative resources.
  const pullCancelsRef = useRef<Record<string, () => void>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.probeLocalModels();
      if (!res.ok) throw new Error(res.error || copy.loadFailed);
      setBackends(res.backends || []);
      setCatalog(res.catalog || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [copy.loadFailed]);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleConnect = useCallback(async (b: LocalBackendStatus) => {
    setConnecting(b.id);
    try {
      const res = await api.connectLocalBackend(b.id);
      if (!res.ok) throw new Error(res.error || copy.toastConnectFailed);
      toast(res.alreadyConnected ? copy.toastAlreadyConnected : copy.toastConnected);
      await refresh();
      if (onConnected) await onConnected();
    } catch (e: any) {
      toast(`${copy.toastConnectFailed}: ${e?.message || String(e)}`, false);
    } finally {
      setConnecting(null);
    }
  }, [copy, onConnected, refresh, toast]);

  const handleCopyHint = useCallback((cmd: string) => {
    void navigator.clipboard?.writeText(cmd);
    toast(copy.copied);
  }, [copy.copied, toast]);

  const updatePull = useCallback((id: string, patch: Partial<PullState>) => {
    setPulls(prev => ({ ...prev, [id]: { ...(prev[id] ?? IDLE_PULL), ...patch } }));
  }, []);

  const handleStartPull = useCallback(async (entry: LocalModelCatalogEntry) => {
    if (!entry.ollamaTag) return;
    const id = entry.id;
    // Reset any prior terminal state so the progress strip starts clean.
    updatePull(id, { status: 'running', fraction: null, phase: copy.pullStatusManifest, error: null });
    const stream = api.pullLocalModel('ollama', entry.ollamaTag);
    pullCancelsRef.current[id] = stream.cancel;
    let succeeded = false;
    try {
      for await (const evt of stream.events) {
        if (evt.error) throw new Error(evt.error);
        const { phase, fraction } = describePhase(evt, copy);
        updatePull(id, { phase, fraction: fraction ?? null });
        if (evt.status === 'success') { succeeded = true; }
      }
      if (succeeded) {
        updatePull(id, { status: 'done', fraction: 1, phase: copy.pullStatusDone, error: null });
        toast(copy.toastPulled);
        await refresh();
        // After a successful pull we auto-connect the backend so the agent
        // dropdown sees Ollama immediately — without this the user would
        // have to scroll up and press Connect themselves, defeating the
        // "one-click" pitch.
        const ollama = backends.find(b => b.id === 'ollama');
        if (ollama && !ollama.existingProviderId) {
          try {
            await api.connectLocalBackend('ollama');
            await refresh();
          } catch { /* best-effort; surfaced via toast in handleConnect path */ }
        }
        if (onConnected) await onConnected();
      } else {
        // Stream ended without success/error — treat as failure to avoid
        // leaving a "running" bar forever.
        updatePull(id, { status: 'error', error: copy.pullFailed, fraction: null });
      }
    } catch (e: any) {
      const message = e?.name === 'AbortError' ? copy.pullCancel : (e?.message || String(e));
      updatePull(id, { status: 'error', error: message, fraction: null });
    } finally {
      delete pullCancelsRef.current[id];
    }
  }, [backends, copy, onConnected, refresh, toast, updatePull]);

  const handleCancelPull = useCallback((entry: LocalModelCatalogEntry) => {
    const cancel = pullCancelsRef.current[entry.id];
    if (cancel) cancel();
  }, []);

  // Abort any in-flight pulls if the section unmounts (e.g. tab switch).
  useEffect(() => () => {
    for (const cancel of Object.values(pullCancelsRef.current)) {
      try { cancel(); } catch { /* swallow */ }
    }
  }, []);

  const totalRamGb = host?.totalMem ? host.totalMem / 1024 ** 3 : null;
  const hostSummary = host
    ? `${host.cpuModel || host.arch} · ${formatGb(host.totalMem)} RAM`
    : copy.hostUnknown;

  // Sort: ok > tight > no-go (within group keep catalog order). Installed
  // entries float to the top of their group so users see what they already
  // have first.
  const sortedCatalog = useMemo(() => {
    const fitScore = (e: LocalModelCatalogEntry): number => {
      const f = fitFor(totalRamGb, e.minRamGb);
      return f === 'ok' ? 0 : f === 'tight' ? 1 : 2;
    };
    const installedScore = (e: LocalModelCatalogEntry): number => (e.installed ? 0 : 1);
    return [...catalog].sort((a, b) => {
      const fa = fitScore(a); const fb = fitScore(b);
      if (fa !== fb) return fa - fb;
      return installedScore(a) - installedScore(b);
    });
  }, [catalog, totalRamGb]);

  return (
    <div className="space-y-3">
      {/* Host summary + refresh */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] text-fg-5">
          <span className="font-semibold uppercase tracking-[0.14em] text-fg-5">{copy.hostLabel}</span>
          <span className="mx-2 text-fg-6">·</span>
          <span className="text-fg-3">{hostSummary}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
          {loading ? <><Spinner className="h-3 w-3" /> {copy.refreshing}</> : <><span aria-hidden="true">↻</span> {copy.refresh}</>}
        </Button>
      </div>

      {/* Backends */}
      <div className="space-y-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-5">{copy.backendsLabel}</div>
        {loading && backends.length === 0 ? (
          <div className="rounded-md border border-edge bg-panel-alt px-4 py-6 text-center text-[12px] text-fg-5">
            <Spinner className="mr-2 inline-block h-3 w-3" />
            {copy.refreshing}
          </div>
        ) : (
          backends.map(b => (
            <BackendCard
              key={b.id}
              backend={b}
              copy={copy}
              busy={connecting === b.id}
              onConnect={handleConnect}
            />
          ))
        )}
        {error && (
          <div className="rounded-md border border-rose-700/40 bg-rose-900/20 px-3 py-2 text-xs text-rose-200">
            {error}
          </div>
        )}
      </div>

      {/* Catalog */}
      {sortedCatalog.length > 0 && (
        <div className="space-y-2 pt-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-5">{copy.catalogLabel}</div>
          {sortedCatalog.map(entry => (
            <CatalogRow
              key={entry.id}
              entry={entry}
              totalRamGb={totalRamGb}
              detectedBackends={backends}
              pull={pulls[entry.id] ?? IDLE_PULL}
              copy={copy}
              locale={locale}
              onStartPull={handleStartPull}
              onCancelPull={handleCancelPull}
              onCopyHint={handleCopyHint}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default LocalModelsSection;

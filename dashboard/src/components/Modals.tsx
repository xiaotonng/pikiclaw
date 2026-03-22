import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../store';
import { createT } from '../i18n';
import { api } from '../api';
import { Modal, ModalHeader, Button, Input, Label, Badge } from './ui';
import { fmtTime, getAgentMeta, sessionDisplayDetail, sessionDisplayState } from '../utils';
import type { BrowserStatusResponse, SessionInfo, SessionTailMessage, DirEntry } from '../types';

const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com';

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'AbortError'
    || /aborted/i.test(error.message)
  );
}

function requestErrorText(error: unknown, t: (key: string) => string): string {
  if (error instanceof Error && /timed out/i.test(error.message)) return t('modal.requestTimeout');
  return t('modal.networkError');
}

/* ═══════════════════════════════════════════════════
   Telegram Modal
   ═══════════════════════════════════════════════════ */
export function TelegramModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, toast, reloadUntil, locale } = useStore();
  const t = createT(locale);
  const [token, setToken] = useState('');
  const [ids, setIds] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (open) {
      setToken(stateRef.current?.config.telegramBotToken || '');
      setIds(stateRef.current?.config.telegramAllowedChatIds || '');
      setShowToken(false);
      setResult(null);
    } else {
      requestRef.current?.abort();
      requestRef.current = null;
      setSaving(false);
    }
  }, [open]);

  useEffect(() => () => {
    requestRef.current?.abort();
    requestRef.current = null;
  }, []);

  const handleSave = async () => {
    if (!token.trim()) { toast(t('modal.inputToken'), false); return; }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setSaving(true);
    setResult(null);
    let shouldClose = false;
    try {
      const r = await api.validateTelegramConfig(token.trim(), ids.trim(), {
        signal: controller.signal,
        timeoutMs: 12_000,
      });
      if (!r.ok) {
        setResult({ ok: false, text: '\u2717 ' + (r.error || t('modal.validationFailed')) });
        return;
      }
      const normalizedIds = r.normalizedAllowedChatIds ?? ids.trim();
      setResult({ ok: true, text: '\u2713 @' + (r.bot?.username || 'bot') + (r.bot?.displayName ? ' (' + r.bot.displayName + ')' : '') });
      const channels = new Set<string>(
        (state?.setupState?.channels || [])
          .filter(item => (item.ready || item.configured) && item.channel !== 'telegram')
          .map(item => item.channel),
      );
      channels.add('telegram');
      await api.saveConfig({
        telegramBotToken: token.trim(),
        telegramAllowedChatIds: normalizedIds,
        channels: [...channels],
      });
      const refreshed = await reloadUntil(nextState => {
        const channel = nextState.setupState?.channels?.find(item => item.channel === 'telegram');
        return nextState.config.telegramBotToken === token.trim()
          && (nextState.config.telegramAllowedChatIds || '') === normalizedIds
          && !!channel?.ready;
      }, { attempts: 10, intervalMs: 350 });
      if (!refreshed) {
        setResult({ ok: false, text: '\u2717 ' + t('modal.refreshStateFailed') });
        toast(t('modal.refreshStateFailed'), false);
        return;
      }
      toast(t('modal.tgSaved'));
      shouldClose = true;
    } catch (err) {
      if (isAbortError(err)) return;
      const text = requestErrorText(err, t);
      setResult({ ok: false, text: '\u2717 ' + text });
      toast(text, false);
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      setSaving(false);
      if (shouldClose) onClose();
    }
  };

  const handleRequestClose = () => {
    requestRef.current?.abort();
    requestRef.current = null;
    onClose();
  };

  return (
    <Modal open={open} onClose={handleRequestClose}>
      <ModalHeader title={t('modal.configureTelegram')} onClose={handleRequestClose} />
      <div className="space-y-4">
        <div>
          <Label>{t('modal.botToken')}</Label>
          <div className="flex gap-2">
            <Input
              type={showToken ? 'text' : 'password'}
              className="flex-1 font-mono text-xs"
              placeholder={t('modal.pasteToken')}
              value={token}
              onChange={e => setToken(e.target.value)}
            />
            <Button variant="ghost" size="sm" className="!w-[34px] !p-0" onClick={() => setShowToken(!showToken)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </Button>
          </div>
        </div>
        {result && (
          <div className="text-xs" style={{ color: result.ok ? 'var(--th-ok)' : 'var(--th-err)' }}>
            {result.text}
          </div>
        )}
        <div>
          <Label>{t('modal.allowedIds')} <span className="text-fg-5">({t('modal.optional')})</span></Label>
          <Input className="font-mono text-xs" placeholder={t('modal.commaSep')} value={ids} onChange={e => setIds(e.target.value)} />
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-6">
        <Button variant="ghost" onClick={handleRequestClose}>{t('modal.cancel')}</Button>
        <Button variant="primary" disabled={saving} onClick={handleSave}>{saving ? t('modal.validating') : t('modal.validateSave')}</Button>
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════
   Feishu Modal
   ═══════════════════════════════════════════════════ */
export function FeishuModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, toast, reloadUntil, locale } = useStore();
  const t = createT(locale);
  const [appId, setAppId] = useState('');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (open) {
      setAppId(stateRef.current?.config.feishuAppId || '');
      setSecret(stateRef.current?.config.feishuAppSecret || '');
      setResult(null);
    } else {
      requestRef.current?.abort();
      requestRef.current = null;
      setSaving(false);
    }
  }, [open]);

  useEffect(() => () => {
    requestRef.current?.abort();
    requestRef.current = null;
  }, []);

  const handleSave = async () => {
    if (!appId.trim()) { toast(t('modal.inputAppId'), false); return; }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setSaving(true);
    setResult(null);
    let shouldClose = false;
    try {
      const validated = await api.validateFeishuConfig(appId.trim(), secret.trim(), {
        signal: controller.signal,
        timeoutMs: 20_000,
      });
      if (!validated.ok) {
        setResult({ ok: false, text: '\u2717 ' + (validated.error || t('modal.validationFailed')) });
        return;
      }
      setResult({ ok: true, text: '\u2713 ' + (validated.app?.displayName || validated.app?.appId || appId.trim()) });
      const channels = new Set<string>(
        (state?.setupState?.channels || [])
          .filter(item => (item.ready || item.configured) && item.channel !== 'feishu')
          .map(item => item.channel),
      );
      channels.add('feishu');
      await api.saveConfig({
        feishuAppId: appId.trim(),
        feishuAppSecret: secret.trim(),
        channels: [...channels],
      });
      const refreshed = await reloadUntil(nextState => {
        const channel = nextState.setupState?.channels?.find(item => item.channel === 'feishu');
        return nextState.config.feishuAppId === appId.trim()
          && nextState.config.feishuAppSecret === secret.trim()
          && !!channel?.ready;
      }, { attempts: 10, intervalMs: 350 });
      if (!refreshed) {
        setResult({ ok: false, text: '\u2717 ' + t('modal.refreshStateFailed') });
        toast(t('modal.refreshStateFailed'), false);
        return;
      }
      toast(t('modal.feishuSaved'));
      shouldClose = true;
    } catch (err) {
      if (isAbortError(err)) return;
      const text = requestErrorText(err, t);
      setResult({ ok: false, text: '\u2717 ' + text });
      toast(text, false);
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      setSaving(false);
      if (shouldClose) onClose();
    }
  };

  const handleRequestClose = () => {
    requestRef.current?.abort();
    requestRef.current = null;
    onClose();
  };

  return (
    <Modal open={open} onClose={handleRequestClose}>
      <ModalHeader title={t('modal.configureFeishu')} onClose={handleRequestClose} />
      <div className="space-y-4">
        <div>
          <Label>{t('modal.appId')}</Label>
          <Input className="font-mono text-xs" placeholder={t('modal.feishuPlaceholder')} value={appId} onChange={e => setAppId(e.target.value)} />
        </div>
        <div>
          <Label>{t('modal.appSecret')}</Label>
          <Input type="password" className="font-mono text-xs" placeholder={t('modal.appSecret')} value={secret} onChange={e => setSecret(e.target.value)} />
        </div>
        {result && (
          <div className="text-xs" style={{ color: result.ok ? 'var(--th-ok)' : 'var(--th-err)' }}>
            {result.text}
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 mt-6">
        <Button variant="ghost" onClick={handleRequestClose}>{t('modal.cancel')}</Button>
        <Button variant="primary" disabled={saving} onClick={handleSave}>{saving ? t('modal.validating') : t('modal.validateSave')}</Button>
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════
   Weixin Modal
   ═══════════════════════════════════════════════════ */
export function WeixinModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, toast, reloadUntil, locale } = useStore();
  const t = createT(locale);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_WEIXIN_BASE_URL);
  const [busy, setBusy] = useState(false);
  const [qrUrl, setQrUrl] = useState('');
  const [sessionKey, setSessionKey] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (open) {
      setBaseUrl(stateRef.current?.config.weixinBaseUrl || DEFAULT_WEIXIN_BASE_URL);
      setBusy(false);
      setQrUrl('');
      setSessionKey('');
      setResult(null);
    } else {
      requestRef.current?.abort();
      requestRef.current = null;
      setBusy(false);
    }
  }, [open]);

  useEffect(() => () => {
    requestRef.current?.abort();
    requestRef.current = null;
  }, []);

  const handleRequestClose = () => {
    requestRef.current?.abort();
    requestRef.current = null;
    onClose();
  };

  const waitForLogin = useCallback(async (
    controller: AbortController,
    nextSessionKey: string,
    nextBaseUrl: string,
  ) => {
    while (!controller.signal.aborted) {
      const waited = await api.waitWeixinLogin(nextSessionKey, nextBaseUrl, {
        signal: controller.signal,
        timeoutMs: 45_000,
      });
      if (!waited.ok && !waited.connected) {
        setResult({ ok: false, text: '\u2717 ' + (waited.error || waited.message || t('modal.validationFailed')) });
        return false;
      }

      if (waited.qrcodeUrl) setQrUrl(waited.qrcodeUrl);
      if (waited.status === 'scaned') {
        setResult({ ok: true, text: t('modal.weixinScanned') });
      } else if (waited.status === 'expired') {
        setResult({ ok: true, text: t('modal.weixinQrRefreshed') });
      } else if (!waited.connected) {
        setResult({ ok: true, text: t('modal.weixinWaitingScan') });
      }

      if (!waited.connected) continue;

      setResult({ ok: true, text: t('modal.weixinLoginSuccess') });
      const normalizedBaseUrl = waited.baseUrl || nextBaseUrl;
      const botToken = waited.botToken || '';
      const accountId = waited.accountId || '';
      const validated = await api.validateWeixinConfig(normalizedBaseUrl, botToken, accountId, {
        signal: controller.signal,
        timeoutMs: 12_000,
      });
      if (!validated.ok) {
        setResult({ ok: false, text: '\u2717 ' + (validated.error || t('modal.validationFailed')) });
        return false;
      }

      const finalBaseUrl = validated.normalizedBaseUrl || normalizedBaseUrl;
      const channels = new Set<string>(
        (stateRef.current?.setupState?.channels || [])
          .filter(item => (item.ready || item.configured) && item.channel !== 'weixin')
          .map(item => item.channel),
      );
      channels.add('weixin');
      await api.saveConfig({
        weixinBaseUrl: finalBaseUrl,
        weixinBotToken: botToken,
        weixinAccountId: accountId,
        channels: [...channels],
      });
      const refreshed = await reloadUntil(nextState => {
        const channel = nextState.setupState?.channels?.find(item => item.channel === 'weixin');
        return nextState.config.weixinBaseUrl === finalBaseUrl
          && nextState.config.weixinBotToken === botToken
          && nextState.config.weixinAccountId === accountId
          && !!channel?.ready;
      }, { attempts: 12, intervalMs: 350 });
      if (!refreshed) {
        setResult({ ok: false, text: '\u2717 ' + t('modal.refreshStateFailed') });
        toast(t('modal.refreshStateFailed'), false);
        return false;
      }

      toast(t('modal.weixinSaved'));
      return true;
    }
    return false;
  }, [reloadUntil, t, toast]);

  const handleStart = async () => {
    if (!baseUrl.trim()) { toast(t('modal.inputWeixinBaseUrl'), false); return; }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    setQrUrl('');
    setSessionKey('');
    setResult(null);
    let shouldClose = false;
    try {
      const started = await api.startWeixinLogin(baseUrl.trim(), {
        signal: controller.signal,
        timeoutMs: 12_000,
      });
      if (!started.ok || !started.qrcodeUrl) {
        setResult({ ok: false, text: '\u2717 ' + (started.error || started.message || t('modal.validationFailed')) });
        return;
      }

      setQrUrl(started.qrcodeUrl);
      setSessionKey(started.sessionKey);
      setResult({ ok: true, text: t('modal.weixinWaitingScan') });
      shouldClose = await waitForLogin(controller, started.sessionKey, baseUrl.trim());
    } catch (error) {
      if (isAbortError(error)) return;
      const text = requestErrorText(error, t);
      setResult({ ok: false, text: '\u2717 ' + text });
      toast(text, false);
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      setBusy(false);
      if (shouldClose) onClose();
    }
  };

  return (
    <Modal open={open} onClose={handleRequestClose}>
      <ModalHeader title={t('modal.configureWeixin')} onClose={handleRequestClose} />
      <div className="space-y-4">
        <div className="text-xs leading-relaxed text-fg-4">{t('modal.weixinScanHint')}</div>
        <div>
          <Label>{t('modal.weixinBaseUrl')}</Label>
          <Input
            className="font-mono text-xs"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder={DEFAULT_WEIXIN_BASE_URL}
          />
          <div className="mt-1 text-[11px] text-fg-5">{t('modal.weixinDefaultBaseUrlHint')}</div>
        </div>
        {qrUrl && (
          <div className="rounded-xl border border-edge bg-panel-alt p-4">
            <img
              src={qrUrl}
              alt={t('modal.weixinQrAlt')}
              className="mx-auto h-56 w-56 rounded-lg bg-white p-3 object-contain"
            />
            {sessionKey && <div className="mt-2 truncate text-center font-mono text-[10px] text-fg-5">{sessionKey}</div>}
          </div>
        )}
        {result && (
          <div className="text-xs" style={{ color: result.ok ? 'var(--th-ok)' : 'var(--th-err)' }}>
            {result.text}
          </div>
        )}
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={handleRequestClose}>{t('modal.cancel')}</Button>
        <Button variant="primary" disabled={busy} onClick={handleStart}>
          {busy
            ? (qrUrl ? t('modal.validating') : t('modal.weixinGeneratingQr'))
            : (qrUrl ? t('modal.weixinRetry') : t('modal.weixinGenerateQr'))}
        </Button>
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════
   Workdir Modal
   ═══════════════════════════════════════════════════ */
export function WorkdirModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, toast, reload, locale } = useStore();
  const t = createT(locale);
  const runtimeWorkdir = state?.bot?.workdir || state?.runtimeWorkdir || '';
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
      if (!r.ok) { setError(r.error || t('modal.cannotRead')); return; }
      setCurrentPath(r.path);
      setInputPath(r.path);
      setDirs(r.dirs);
      setParentDir(r.parent);
      setIsGit(r.isGit);
      const parts = r.path.split('/').filter(Boolean);
      let acc = '';
      setBreadcrumbs(parts.map(p => { acc += '/' + p; return { label: p, path: acc }; }));
    } catch { setError(t('modal.loadFailed')); }
    finally { setLoading(false); }
  }, [t]);

  useEffect(() => {
    if (open) {
      browse(runtimeWorkdir || undefined);
    }
  }, [open, runtimeWorkdir, browse]);

  const handleConfirm = async () => {
    const p = inputPath.trim() || currentPath;
    if (!p) { toast(t('modal.selectDirFirst'), false); return; }
    try {
      const r = await api.switchWorkdir(p);
      if (r.ok) { toast(t('modal.switchedTo') + r.workdir); onClose(); setTimeout(reload, 300); }
      else toast(r.error || t('modal.switchFailed'), false);
    } catch { toast(t('modal.switchFailed'), false); }
  };

  const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return (
    <Modal
      open={open}
      onClose={onClose}
      panelStyle={{
        width: 'min(500px, calc(100vw - 2rem))',
        maxWidth: 'min(500px, calc(100vw - 2rem))',
      }}
    >
      <ModalHeader title={t('modal.switchWorkdir')} onClose={onClose} />

      <div className="flex items-center gap-1 text-[11px] font-mono text-fg-4 mb-3 flex-wrap">
        <span className="cursor-pointer hover:text-fg-2 transition-colors" onClick={() => browse('/')}>~</span>
        {breadcrumbs.map((b, i) => (
          <span key={i}>
            <span className="text-fg-6">/</span>
            <span className="cursor-pointer hover:text-fg-2 transition-colors" onClick={() => browse(b.path)}>{b.label}</span>
          </span>
        ))}
        {isGit && <Badge variant="accent" className="ml-1 !text-[9px] !py-0 !px-1.5">git</Badge>}
      </div>

      <div className="relative">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-5 rounded-t-lg"
          style={{ background: 'linear-gradient(to bottom, var(--th-panel-alt), rgba(0, 0, 0, 0))' }}
        />
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-5 rounded-b-lg"
          style={{ background: 'linear-gradient(to top, var(--th-panel-alt), rgba(0, 0, 0, 0))' }}
        />
        <div
          className="border border-edge rounded-lg overflow-y-auto overscroll-contain scroll-smooth bg-panel-alt"
          style={{ maxHeight: 420, minHeight: 240, scrollbarGutter: 'stable' }}
        >
          {loading ? (
            <div className="text-xs text-fg-5 p-4 text-center">{t('sessions.loading')}</div>
          ) : error ? (
            <div className="text-xs text-red-500/70 p-4">{error}</div>
          ) : (
            <>
              {parentDir && parentDir !== currentPath && (
                <div
                  className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-panel transition-colors border-b border-edge"
                  onClick={() => browse(parentDir)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-fg-5 shrink-0"><polyline points="15 18 9 12 15 6"/></svg>
                  <span className="text-xs text-fg-4">..</span>
                </div>
              )}
              {dirs.length === 0 && !parentDir && (
                <div className="text-xs text-fg-5 p-4 text-center">{t('modal.emptyDir')}</div>
              )}
              {dirs.map(d => (
                <div
                  key={d.path}
                  className="flex items-center gap-2.5 px-3 py-[7px] cursor-pointer hover:bg-panel transition-colors"
                  onClick={() => browse(d.path)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={d.name === '.git' ? 'var(--th-primary)' : 'currentColor'} strokeWidth="1.8" className="text-fg-5 shrink-0">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                  </svg>
                  <span className="text-xs text-fg-3">{escHtml(d.name)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="mt-3">
        <Input
          className="font-mono text-xs"
          placeholder={t('modal.manualInput')}
          value={inputPath}
          onChange={e => setInputPath(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') browse(inputPath); }}
        />
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onClose}>{t('modal.cancel')}</Button>
        <Button variant="primary" onClick={handleConfirm}>{t('modal.selectDir')}</Button>
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════
   Session Detail Modal
   ═══════════════════════════════════════════════════ */
export function SessionDetailModal({ open, onClose, agent, sessionId, session }: {
  open: boolean; onClose: () => void;
  agent: string; sessionId: string; session: SessionInfo | null;
}) {
  const { locale } = useStore();
  const t = createT(locale);
  const [messages, setMessages] = useState<SessionTailMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open || !agent || !sessionId) {
      requestRef.current?.abort();
      requestRef.current = null;
      setLoading(false);
      return;
    }

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError('');
    setMessages([]);
    api.getSessionDetail(agent, sessionId, 12, {
      signal: controller.signal,
      timeoutMs: 30_000,
    }).then(r => {
      if (!r.ok) {
        setError(r.error || t('modal.loadFailed'));
        return;
      }
      if (!r.messages?.length) {
        setError(t('modal.noConv'));
        return;
      }
      setMessages(r.messages);
    }).catch(err => {
      if (isAbortError(err)) return;
      setError(requestErrorText(err, t));
    }).finally(() => {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    });

    return () => {
      controller.abort();
      if (requestRef.current === controller) requestRef.current = null;
    };
  }, [open, agent, sessionId, t]);

  const m = getAgentMeta(agent);
  const displayState = session ? sessionDisplayState(session) : 'completed';
  const displayDetail = session ? sessionDisplayDetail(session) : null;

  return (
    <Modal open={open} onClose={onClose} wide>
      <ModalHeader title={session?.title || sessionId?.slice(0, 20) || 'Session'} onClose={onClose} />

      {session && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] mb-4 pb-4 border-b border-edge">
          <div className="text-fg-4">{t('sessions.agent')}</div><div className="font-medium text-fg-2">{m.label}</div>
          <div className="text-fg-4">Model</div><div className="font-mono text-[11px] text-fg-3">{session.model || '—'}</div>
          <div className="text-fg-4">{t('modal.createdAt')}</div><div className="text-fg-3">{fmtTime(session.createdAt)}</div>
          <div className="text-fg-4">{t('modal.status')}</div>
          <div className="flex flex-wrap items-center gap-2">
            {session.isCurrent && <Badge variant="accent" className="!text-[10px]">{t('sessions.current')}</Badge>}
            {displayState === 'running' && <Badge variant="ok" className="!text-[10px]">{t('status.running')}</Badge>}
            {displayState === 'incomplete' && <Badge variant="warn" className="!text-[10px]">{t('sessions.incomplete')}</Badge>}
            {displayState === 'completed' && <Badge variant="muted" className="!text-[10px]">{t('sessions.completed')}</Badge>}
          </div>
          {displayState === 'incomplete' && displayDetail && (
            <>
              <div className="text-fg-4">{t('sessions.lastIssue')}</div>
              <div className="text-amber-200/80">{displayDetail}</div>
            </>
          )}
          <div className="text-fg-4">Session ID</div><div className="font-mono text-[10px] text-fg-5 truncate" title={sessionId}>{sessionId}</div>
          <div className="text-fg-4">{t('modal.workdir')}</div><div className="font-mono text-[10px] text-fg-5 truncate" title={session.workdir || ''}>{session.workdir || '—'}</div>
        </div>
      )}

      <div className="text-[13px] font-semibold text-fg-3 mb-3">{t('modal.recentConv')}</div>
      <div className="max-h-[40vh] overflow-y-auto">
        {loading ? (
          <div className="space-y-3">
            <div className="w-28 rounded-md bg-panel px-3 py-1 text-[10px] text-fg-5">{t('modal.loadingConv')}</div>
            {Array.from({ length: 3 }, (_, index) => (
              <div
                key={index}
                className={`rounded-xl border p-3 ${index % 2 === 0 ? 'border-indigo-500/10 bg-indigo-500/[0.06]' : 'border-edge bg-panel'}`}
              >
                <div className="mb-2 h-3 w-16 rounded-md bg-panel animate-shimmer" />
                <div className="mb-2 h-3 w-full rounded-md bg-panel animate-shimmer" />
                <div className="h-3 w-2/3 rounded-md bg-panel animate-shimmer" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="text-xs text-fg-5">{error}</div>
        ) : (
          messages.map((msg, i) => {
            const isUser = msg.role === 'user';
            const text = msg.text?.length > 600 ? msg.text.slice(0, 600) + '\n...' : msg.text;
            return (
              <div
                key={i}
                className={`p-2.5 px-3.5 rounded-xl text-xs leading-[1.7] whitespace-pre-wrap break-words mb-2 ${
                  isUser
                    ? 'bg-indigo-500/[0.06] border border-indigo-500/10 text-fg-2'
                    : 'bg-panel border border-edge text-fg-3'
                }`}
              >
                <div className="text-[10px] font-medium mb-1" style={{ color: isUser ? 'var(--th-primary)' : undefined }}>
                  {isUser ? 'User' : 'Assistant'}
                </div>
                <div>{text}</div>
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════
   Managed Browser Setup Modal
   ═══════════════════════════════════════════════════ */
export function BrowserSetupModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved?: () => void }) {
  const { toast, locale } = useStore();
  const t = createT(locale);
  const [status, setStatus] = useState<BrowserStatusResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (open) {
      setSubmitting(false);
      setResult(null);
      api.getBrowser().then(next => {
        setStatus(next);
        setEnabled(!!next.browser.enabled);
      }).catch(() => setStatus(null));
    }
  }, [open]);

  const browser = status?.browser;
  const savedEnabled = !!browser?.enabled;
  const modeChanged = !!browser && savedEnabled !== enabled;
  const profileDir = browser?.profileDir || '';
  const selectedInfoLabel = t('ext.profileDir');
  const selectedInfoValue = profileDir;
  const profileReady = !!browser?.chromeInstalled && !!browser?.profileCreated;
  const browserStatusLabel = !status
    ? t('status.loading')
    : !browser?.enabled
      ? t('ext.disabled')
      : profileReady
        ? t('ext.browserReady')
        : browser?.chromeInstalled
          ? t('ext.chromeInstalled')
          : t('ext.needsSetup');
  const browserStatusVariant = !status
    ? 'muted' as const
    : !browser?.enabled
      ? 'muted' as const
      : profileReady
        ? 'ok' as const
        : browser?.chromeInstalled
          ? 'warn' as const
          : 'err' as const;

  const handleSubmit = async () => {
    setSubmitting(true);
    setResult(null);
    try {
      await api.saveConfig({ browserEnabled: enabled });
      const next = await api.getBrowser();
      setStatus(next);
      onSaved?.();
    } catch {
      setResult({ ok: false, text: '\u2717 ' + t('ext.browserModeSaveFailed') });
      toast(t('ext.browserModeSaveFailed'), false);
      setSubmitting(false);
      return;
    }

    if (!enabled) {
      setResult({ ok: true, text: '\u2713 ' + t('ext.browserDisabledSaved') });
      toast(t('ext.browserDisabledSaved'));
      setSubmitting(false);
      return;
    }

    try {
      const r = await api.setupBrowser();
      if (!r.ok) {
        setResult({ ok: false, text: '\u2717 ' + (r.error || t('ext.browserLaunchFailed')) });
        toast(r.error || t('ext.browserLaunchFailed'), false);
        return;
      }
      setStatus(prev => prev ? { ...prev, browser: r.browser } : {
        browser: r.browser,
        desktop: {
          enabled: false,
          installed: false,
          running: false,
          appiumUrl: '',
        },
      });
      setResult({ ok: true, text: '\u2713 ' + t('ext.browserEnabledLaunched') });
      toast(t('ext.browserEnabledLaunched'));
      onSaved?.();
    } catch {
      setResult({ ok: false, text: '\u2717 ' + t('ext.browserLaunchFailed') });
      toast(t('ext.browserLaunchFailed'), false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalHeader title={t('ext.setupBrowser')} description={t('ext.setupBrowserDesc')} onClose={onClose} />
      <div className="space-y-5">
        <div className="rounded-lg border border-edge bg-panel-alt p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={browserStatusVariant}>{browserStatusLabel}</Badge>
            {browser && (
              <>
                <Badge variant={savedEnabled ? 'accent' : 'muted'}>
                  {savedEnabled ? t('ext.enabled') : t('ext.disabled')}
                </Badge>
                {modeChanged && <Badge variant="warn">{t('ext.pendingModeChange')}</Badge>}
                {browser.running && (
                  <Badge variant="accent">
                    {t('ext.browserOpen')}
                    {browser.pid ? ` · PID ${browser.pid}` : ''}
                  </Badge>
                )}
              </>
            )}
          </div>
          <div className="mt-3">
            <Label>{selectedInfoLabel}</Label>
            <div className="flex items-center gap-2">
              <Input
                className="font-mono text-xs flex-1"
                value={selectedInfoValue || '—'}
                readOnly
                onClick={e => (e.target as HTMLInputElement).select()}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!selectedInfoValue}
                onClick={() => {
                  if (!selectedInfoValue) return;
                  navigator.clipboard.writeText(selectedInfoValue);
                  toast(t('ext.step2Copied'));
                }}
              >
                {t('ext.copyPath')}
              </Button>
            </div>
          </div>
          <div className="mt-3 text-xs text-fg-5">
            {enabled ? t('ext.profileModeDesc') : t('ext.browserDescDisabled')}
          </div>
          {browser?.detail && <div className="mt-2 text-xs text-fg-5">{browser.detail}</div>}
          {result && (
            <div className="mt-3 text-xs" style={{ color: result.ok ? 'var(--th-ok)' : 'var(--th-err)' }}>
              {result.text}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-edge bg-panel-alt p-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={enabled}
              onChange={event => setEnabled(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border border-edge bg-inset"
            />
            <div>
              <div className="text-sm font-medium text-fg-2 mb-1">{t('ext.browserEnableToggle')}</div>
              <div className="text-xs text-fg-4">{t('ext.browserEnableToggleDesc')}</div>
            </div>
          </label>
        </div>

        <div className="rounded-lg border border-edge bg-panel-alt p-4">
          <div className="text-sm font-medium text-fg-2 mb-1">
            {enabled ? t('ext.step2Title') : t('ext.browserDisabledStepTitle')}
          </div>
          <div className="text-xs text-fg-4">
            {enabled ? t('ext.step2Desc') : t('ext.browserDisabledHint')}
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-6">
        <Button variant="ghost" onClick={onClose}>{t('modal.cancel')}</Button>
        <Button variant="primary" disabled={submitting} onClick={handleSubmit}>
          {submitting
            ? t('ext.launching')
            : enabled
              ? t('ext.enableAndLaunchBrowser')
              : t('ext.saveBrowserDisabled')}
        </Button>
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════
   Desktop Setup Modal
   ═══════════════════════════════════════════════════ */
export function DesktopSetupModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved?: () => void }) {
  const { toast, locale } = useStore();
  const t = createT(locale);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (open) {
      setInstalling(false);
      setEnabling(false);
      setResult(null);
      api.getBrowser().then(ext => {
        setInstalled(ext.desktop.installed);
      }).catch(() => {});
    }
  }, [open]);

  const handleInstall = async () => {
    setInstalling(true);
    setResult(null);
    try {
      const r = await api.desktopInstall();
      if (r.ok) {
        setInstalled(true);
        setResult({ ok: true, text: '\u2713 ' + t('ext.desktopInstalled') });
        toast(t('ext.desktopInstalled'));
      } else {
        setResult({ ok: false, text: '\u2717 ' + (r.error || t('ext.desktopInstallFailed')) });
      }
    } catch {
      setResult({ ok: false, text: '\u2717 ' + t('ext.desktopInstallFailed') });
    } finally {
      setInstalling(false);
    }
  };

  const handleEnable = async () => {
    setEnabling(true);
    setResult(null);
    try {
      const r = await api.desktopToggle(true);
      if (r.ok) {
        setResult({ ok: true, text: '\u2713 ' + t('ext.desktopStarted') });
        toast(t('ext.desktopStarted'));
        onSaved?.();
        setTimeout(onClose, 600);
      } else {
        setResult({ ok: false, text: '\u2717 ' + (r.error || t('ext.desktopInstallFailed')) });
      }
    } catch {
      setResult({ ok: false, text: '\u2717 ' + t('ext.desktopInstallFailed') });
    } finally {
      setEnabling(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalHeader title={t('ext.setupDesktop')} description={t('ext.setupDesktopDesc')} onClose={onClose} />
      <div className="space-y-5">
        {/* Step 1: Install */}
        <div className="rounded-lg border border-edge bg-panel-alt p-4">
          <div className="text-sm font-medium text-fg-2 mb-1">{t('ext.desktopStep1Title')}</div>
          <div className="text-xs text-fg-4 mb-3">{t('ext.desktopStep1Desc')}</div>
          {result && !installed && (
            <div className="mb-2 text-xs" style={{ color: result.ok ? 'var(--th-ok)' : 'var(--th-err)' }}>
              {result.text}
            </div>
          )}
          <Button
            variant={installed ? 'ghost' : 'outline'}
            size="sm"
            disabled={installing || installed}
            onClick={handleInstall}
          >
            {installing ? t('ext.desktopInstalling') : installed ? t('ext.desktopStep1Done') : t('ext.desktopStep1Action')}
          </Button>
        </div>

        {/* Step 2: Enable & Start */}
        <div className="rounded-lg border border-edge bg-panel-alt p-4">
          <div className="text-sm font-medium text-fg-2 mb-1">{t('ext.desktopStep2Title')}</div>
          <div className="text-xs text-fg-4 mb-3">{t('ext.desktopStep2Desc')}</div>
          {result && installed && (
            <div className="mb-2 text-xs" style={{ color: result.ok ? 'var(--th-ok)' : 'var(--th-err)' }}>
              {result.text}
            </div>
          )}
          <Button
            variant="primary"
            size="sm"
            disabled={!installed || enabling}
            onClick={handleEnable}
          >
            {enabling ? t('ext.desktopStarting') : t('ext.desktopStep2Action')}
          </Button>
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-6">
        <Button variant="ghost" onClick={onClose}>{t('modal.cancel')}</Button>
      </div>
    </Modal>
  );
}

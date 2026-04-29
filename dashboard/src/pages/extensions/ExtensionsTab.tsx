/**
 * Extensions tab — global MCP servers, Skills, and built-in automation.
 *
 * Two-section layout:
 *   1. Connected — installed items in "ready" / "needs_auth" / "disabled" state,
 *      presented as polished brand-coloured cards.
 *   2. Available — remaining recommended items grouped by category, cards use
 *      tinted brand backgrounds with stagger-in animation on first paint.
 *
 * Scope filtering keeps global-only integrations (GitHub, Atlassian, Notion…)
 * out of the workspace modal, and workspace-specific tools (Filesystem, SQLite,
 * Postgres) out of the global tab. Registry ↔ UI sync is via `recommendedScope`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import type {
  BrowserStatusResponse,
  CliCatalogItem,
  McpAuthSpec,
  McpCatalogItem,
  McpCatalogState,
  McpServerConfig,
  SkillCatalogItem,
  SkillInfo,
} from '../../types';
import { cn } from '../../utils';
import { BrandIcon } from '../../components/BrandIcon';
import { Badge, Button, Input, Modal, ModalHeader, Spinner, SectionLabel, TabsList, TabsTrigger } from '../../components/ui';
import { SettingRowAction, SettingRowCard, SettingRowLead } from '../shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function L(locale: string, zh: string, en: string): string {
  return locale === 'zh-CN' ? zh : en;
}

function authKindLabel(locale: string, auth: McpAuthSpec): string {
  if (auth.type === 'mcp-oauth') return L(locale, 'OAuth', 'OAuth');
  if (auth.type === 'credentials') return L(locale, 'API Key', 'API Key');
  return L(locale, '无需配置', 'No auth');
}

/** Signature colour for a brand, used for gradient tints and avatar fills. */
const BRAND_PALETTE: Record<string, { hex: string; letter?: string }> = {
  github:           { hex: '#24292f', letter: 'GH' },
  atlassian:        { hex: '#0052cc', letter: 'A' },
  notion:           { hex: '#111827', letter: 'N' },
  linear:           { hex: '#5e6ad2', letter: 'L' },
  sentry:           { hex: '#362d59', letter: 'S' },
  cloudflare:       { hex: '#f6821f', letter: 'CF' },
  gamma:            { hex: '#9f2eff', letter: 'G' },
  huggingface:      { hex: '#ff9d00', letter: 'HF' },
  slack:            { hex: '#4a154b', letter: 'S' },
  lark:             { hex: '#00d6b9', letter: 'L' },
  feishu:           { hex: '#00d6b9', letter: 'F' },
  stripe:           { hex: '#635bff', letter: 'S' },
  perplexity:       { hex: '#20b8cd', letter: 'P' },
  brave:            { hex: '#fb542b', letter: 'B' },
  filesystem:       { hex: '#64748b', letter: 'FS' },
  fetch:            { hex: '#0ea5e9', letter: 'F' },
  memory:           { hex: '#a855f7', letter: 'M' },
  time:             { hex: '#10b981', letter: 'T' },
  sqlite:           { hex: '#0369a1', letter: 'SQ' },
  postgres:         { hex: '#336791', letter: 'PG' },
};

const DEFAULT_BRAND: { hex: string; letter?: string } = { hex: '#6b7280' };

function brandInfo(slug?: string, fallbackName?: string) {
  const key = (slug || '').toLowerCase();
  const brand = BRAND_PALETTE[key] || DEFAULT_BRAND;
  const letter = brand.letter
    || (fallbackName || '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 2)
      .toUpperCase()
    || '?';
  return { hex: brand.hex, letter };
}

/** Hex → rgba with given alpha. */
function withAlpha(hex: string, alpha: number): string {
  const m = hex.replace('#', '');
  const full = m.length === 3
    ? m.split('').map(c => c + c).join('')
    : m.padEnd(6, '0').slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ---------------------------------------------------------------------------
// Cached catalog hook — SWR via localStorage
// ---------------------------------------------------------------------------

function useCachedResource<T>(
  key: string,
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
): { data: T | null; loading: boolean; refresh: () => Promise<void> } {
  const [data, setData] = useState<T | null>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetcher();
      if (!mountedRef.current) return;
      setData(next);
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* quota */ }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps]);

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [refresh]);

  return { data, loading, refresh };
}

// ---------------------------------------------------------------------------
// Small UI atoms
// ---------------------------------------------------------------------------

const ExternalLinkIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

const ZapIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

const CheckCircleIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);

const PowerIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18.36 6.64a9 9 0 1 1-12.73 0" /><line x1="12" y1="2" x2="12" y2="12" />
  </svg>
);

const LockIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
  </svg>
);

const AlertIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>
  </svg>
);

/**
 * Slugs we use for the built-in brands that ship as local SVGs (Claude, Codex,
 * Telegram icons, etc.). Anything else is resolved against the SimpleIcons CDN.
 */
const LOCAL_BRAND_SLUGS = new Set([
  'claude', 'codex', 'gemini', 'telegram', 'feishu', 'weixin',
  'playwright', 'appium', 'vscode', 'cursor', 'windsurf', 'finder',
]);

/**
 * Map our internal iconSlug values to an Iconify icon id. Iconify aggregates
 * multiple icon sets — we use `logos:*` (multi-colored brand logos) as the
 * primary source, falling back to `icon-park:*` for brands only ByteDance-era
 * sets cover (Lark), and `simple-icons:*` when logos:* doesn't exist.
 *
 * Anything not in `ICONIFY_ICONS` falls through to the letter avatar — this
 * avoids console 404s and keeps generic utility items (no brand identity) from
 * pretending to have a real logo.
 */
const ICONIFY_ICONS: Record<string, string> = {
  // Prefer `-icon` (mark-only) variants over wordmarks so the logo renders
  // legibly inside a 32–36px avatar. Fall back to wordmark only if no
  // mark-only icon exists in the iconify catalogs.
  github:                    'logos:github-icon',
  atlassian:                 'logos:atlassian',
  notion:                    'logos:notion-icon',
  linear:                    'logos:linear-icon',
  sentry:                    'logos:sentry-icon',
  cloudflare:                'logos:cloudflare-icon',
  'cloudflare-docs':         'logos:cloudflare-icon',
  'cloudflare-bindings':     'logos:cloudflare-icon',
  'cloudflare-observability':'logos:cloudflare-icon',
  slack:                     'logos:slack-icon',
  lark:                      'icon-park:lark',
  feishu:                    'icon-park:lark',
  stripe:                    'logos:stripe',          // no -icon variant; wordmark only
  perplexity:                'logos:perplexity-icon',
  brave:                     'logos:brave',           // no -icon variant; lion mark
  'brave-search':            'logos:brave',
  huggingface:               'logos:hugging-face-icon',
  postgres:                  'logos:postgresql',
  postgresql:                'logos:postgresql',
  sqlite:                    'logos:sqlite',
  vercel:                    'logos:vercel-icon',
  netlify:                   'logos:netlify-icon',
  supabase:                  'logos:supabase-icon',
  heroku:                    'logos:heroku-icon',
  docker:                    'logos:docker-icon',
  pnpm:                      'logos:pnpm',
  aws:                       'logos:aws',
  'google-cloud':            'logos:google-cloud',
  googlecloud:               'logos:google-cloud',
  amazonwebservices:         'logos:aws',
};

/**
 * Logos that are wordmarks (text-heavy) rather than icon-only marks. These need
 * extra rendered size so the text inside the avatar circle stays legible.
 * Everything else uses the standard square mark ratio.
 */
const WORDMARK_ICONS = new Set(['stripe']);

function resolveBrandLogoUrl(iconSlug?: string, iconUrl?: string): string | undefined {
  if (iconUrl) return iconUrl;
  if (!iconSlug) return undefined;
  if (LOCAL_BRAND_SLUGS.has(iconSlug)) return undefined;
  const iconId = ICONIFY_ICONS[iconSlug];
  if (!iconId) return undefined;
  return `https://api.iconify.design/${iconId}.svg`;
}

/**
 * Two render modes:
 *   - Real-logo mode (iconify `logos:*`): neutral white/panel avatar with a
 *     subtle brand-tint ring and soft shadow. The multi-color SVG renders in
 *     its authentic palette — no filter, no invert.
 *   - Letter-fallback mode (no logo available): brand-color gradient square
 *     with white initials. Keeps the visual hierarchy when a brand has no
 *     stable CDN logo (Gamma, generic utilities, custom MCPs).
 */
function BrandAvatar({
  iconSlug,
  iconUrl,
  name,
  size = 32,
  className,
}: { iconSlug?: string; iconUrl?: string; name: string; size?: number; className?: string }) {
  const { hex, letter } = brandInfo(iconSlug, name);
  const [imgFailed, setImgFailed] = useState(false);
  const remoteUrl = resolveBrandLogoUrl(iconSlug, iconUrl);
  const useLocalBrand = iconSlug && LOCAL_BRAND_SLUGS.has(iconSlug);
  const useRemote = !!remoteUrl && !imgFailed;
  const useRealLogo = useLocalBrand || useRemote;
  // Mark-only logos render at ~76% of the avatar; wordmarks need ~92% so the
  // text inside the chip is still readable at 32–36px.
  const isWordmark = !!iconSlug && WORDMARK_ICONS.has(iconSlug);
  const logoSize = Math.round(size * (isWordmark ? 0.92 : 0.76));

  if (useRealLogo) {
    return (
      <div
        className={cn(
          'relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white',
          className,
        )}
        style={{
          width: size,
          height: size,
          boxShadow: `0 0 0 1px ${withAlpha(hex, 0.18)}, 0 4px 12px ${withAlpha(hex, 0.14)}`,
        }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: `linear-gradient(135deg, ${withAlpha(hex, 0.06)} 0%, transparent 70%)` }}
        />
        {useLocalBrand ? (
          <BrandIcon brand={iconSlug!} size={logoSize} />
        ) : (
          <img
            src={remoteUrl}
            alt=""
            width={logoSize}
            height={logoSize}
            loading="lazy"
            decoding="async"
            onError={() => setImgFailed(true)}
            className="relative"
          />
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl font-semibold text-white',
        className,
      )}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, ${withAlpha(hex, 1)} 0%, ${withAlpha(hex, 0.82)} 100%)`,
        boxShadow: `0 1px 0 rgba(255,255,255,0.08) inset, 0 6px 14px ${withAlpha(hex, 0.28)}`,
        fontSize: Math.max(10, Math.round(size * 0.36)),
        letterSpacing: letter.length > 1 ? '-0.02em' : 0,
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(circle at 30% 20%, rgba(255,255,255,0.22), transparent 55%)' }}
      />
      <span className="relative">{letter}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// State pill
// ---------------------------------------------------------------------------

function StatePill({ state, locale }: { state: McpCatalogState; locale: string }) {
  if (state === 'ready') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold text-[var(--th-ok)]"
            style={{ background: 'color-mix(in oklab, var(--th-ok) 12%, transparent)' }}>
        <CheckCircleIcon size={10} />{L(locale, '已连接', 'Connected')}
      </span>
    );
  }
  if (state === 'disabled') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-edge bg-inset/60 px-2 py-0.5 text-[10px] font-medium text-fg-5">
        <PowerIcon size={10} />{L(locale, '已停用', 'Paused')}
      </span>
    );
  }
  if (state === 'needs_auth') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold text-[var(--th-warn)]"
            style={{ background: 'color-mix(in oklab, var(--th-warn) 12%, transparent)' }}>
        <LockIcon size={10} />{L(locale, '待授权', 'Needs auth')}
      </span>
    );
  }
  if (state === 'unhealthy') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold text-[var(--th-err)]"
            style={{ background: 'color-mix(in oklab, var(--th-err) 12%, transparent)' }}>
        <AlertIcon size={10} />{L(locale, '异常', 'Unhealthy')}
      </span>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Credentials Dialog
// ---------------------------------------------------------------------------

function CredentialsDialog({
  open, onClose, locale, item, initial, onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  locale: string;
  item: McpCatalogItem | null;
  initial?: Record<string, string>;
  onSubmit: (credentials: Record<string, string>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open && item && item.auth.type === 'credentials') {
      const seed: Record<string, string> = {};
      for (const f of item.auth.fields) seed[f.key] = initial?.[f.key] || '';
      setValues(seed);
    }
  }, [open, item, initial]);

  if (!item || item.auth.type !== 'credentials') return null;
  const missingRequired = item.auth.fields.some(f => f.required && !(values[f.key] || '').trim());

  const submit = async () => {
    setSubmitting(true);
    try { await onSubmit(values); } finally { setSubmitting(false); }
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalHeader
        title={L(locale, `配置 ${item.name}`, `Configure ${item.name}`)}
        description={locale === 'zh-CN' ? item.descriptionZh : item.description}
        onClose={onClose}
      />
      <div className="space-y-3">
        {item.auth.fields.map(field => (
          <div key={field.key}>
            <label className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-5">
                {locale === 'zh-CN' ? field.labelZh : field.label}
                {field.required && <span className="ml-1 text-err">*</span>}
              </span>
              {field.helpUrl && (
                <a href={field.helpUrl} target="_blank" rel="noreferrer"
                  className="flex items-center gap-1 text-[11px] text-primary hover:text-primary/80">
                  {L(locale, '获取', 'Get one')} <ExternalLinkIcon />
                </a>
              )}
            </label>
            <Input
              value={values[field.key] || ''}
              onChange={e => setValues({ ...values, [field.key]: e.target.value })}
              type={field.secret ? 'password' : 'text'}
              placeholder={field.placeholder}
              className="font-mono text-[12px]"
            />
          </div>
        ))}
        <div className="flex justify-end gap-2 border-t border-edge pt-3">
          <Button variant="ghost" onClick={onClose}>{L(locale, '取消', 'Cancel')}</Button>
          <Button variant="primary" disabled={submitting || missingRequired} onClick={submit}>
            {submitting ? <Spinner /> : L(locale, '保存并启用', 'Save & Enable')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Custom MCP Dialog
// ---------------------------------------------------------------------------

function CustomMcpDialog({
  open, onClose, locale, scope, workdir, onAdded,
}: {
  open: boolean;
  onClose: () => void;
  locale: string;
  scope: 'global' | 'workspace';
  workdir?: string;
  onAdded: () => void;
}) {
  const toast = useStore(s => s.toast);
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [command, setCommand] = useState('npx');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [env, setEnv] = useState<Array<{ k: string; v: string }>>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(''); setTransport('stdio'); setCommand('npx'); setArgs(''); setUrl(''); setEnv([]);
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const envObj: Record<string, string> = {};
      for (const { k, v } of env) if (k.trim()) envObj[k.trim()] = v;
      const config: McpServerConfig = transport === 'http'
        ? { type: 'http', url: url.trim(), enabled: true, ...(Object.keys(envObj).length ? { headers: envObj } : {}) }
        : {
            type: 'stdio',
            command: command.trim(),
            args: args.trim() ? args.trim().split(/\s+/) : [],
            enabled: true,
            ...(Object.keys(envObj).length ? { env: envObj } : {}),
          };
      await api.addCustomMcp(name.trim(), config, scope, workdir);
      toast(L(locale, `${name} 已添加`, `${name} added`), true);
      onAdded();
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Failed', false);
    } finally { setSubmitting(false); }
  };

  return (
    <Modal open={open} onClose={onClose} wide>
      <ModalHeader
        title={L(locale, '添加自定义 MCP 服务', 'Add Custom MCP Server')}
        description={L(locale, '不在推荐列表中的自定义服务。', 'For servers not in the recommended catalog.')}
        onClose={onClose}
      />
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-5">{L(locale, '名称', 'Name')}</label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="my-server" />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-5">{L(locale, '传输', 'Transport')}</label>
            <div className="flex gap-1.5">
              {(['stdio', 'http'] as const).map(t => (
                <button key={t}
                  onClick={() => setTransport(t)}
                  className={cn(
                    'flex-1 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors',
                    transport === t ? 'border-primary/40 bg-primary/10 text-primary' : 'border-edge bg-inset/50 text-fg-4 hover:bg-inset',
                  )}
                >{t}</button>
              ))}
            </div>
          </div>
        </div>
        {transport === 'stdio' ? (
          <>
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-5">{L(locale, '命令', 'Command')}</label>
              <Input value={command} onChange={e => setCommand(e.target.value)} className="font-mono" placeholder="npx" />
            </div>
            <div>
              <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-5">{L(locale, '参数', 'Arguments')}</label>
              <Input value={args} onChange={e => setArgs(e.target.value)} className="font-mono" placeholder="-y @example/server" />
            </div>
          </>
        ) : (
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-5">URL</label>
            <Input value={url} onChange={e => setUrl(e.target.value)} className="font-mono" placeholder="https://example.com/mcp" />
          </div>
        )}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-5">
              {transport === 'http' ? L(locale, 'Headers', 'Headers') : L(locale, '环境变量', 'Env')}
            </span>
            <button className="text-[11px] font-medium text-primary hover:text-primary/80" onClick={() => setEnv([...env, { k: '', v: '' }])}>
              + {L(locale, '添加', 'Add')}
            </button>
          </div>
          {env.length > 0 && (
            <div className="space-y-1 rounded-md border border-edge bg-inset/40 p-2">
              {env.map((row, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Input className="w-2/5 !h-7 !text-[12px] font-mono" value={row.k}
                    onChange={e => { const n = [...env]; n[i] = { ...n[i], k: e.target.value }; setEnv(n); }} placeholder="KEY" />
                  <Input className="flex-1 !h-7 !text-[12px] font-mono" value={row.v}
                    onChange={e => { const n = [...env]; n[i] = { ...n[i], v: e.target.value }; setEnv(n); }}
                    type={/token|secret|key|bearer/i.test(row.k) ? 'password' : 'text'} placeholder="value" />
                  <button className="shrink-0 rounded p-1 text-fg-5 hover:text-err" onClick={() => setEnv(env.filter((_, j) => j !== i))}>
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-edge pt-3">
          <Button variant="ghost" onClick={onClose}>{L(locale, '取消', 'Cancel')}</Button>
          <Button variant="primary" disabled={!name.trim() || submitting} onClick={submit}>
            {submitting ? <Spinner /> : L(locale, '添加', 'Add')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Custom Skill Dialog
// ---------------------------------------------------------------------------

function CustomSkillDialog({
  open, onClose, locale, scope, workdir, onInstalled,
}: {
  open: boolean;
  onClose: () => void;
  locale: string;
  scope: 'global' | 'workspace';
  workdir?: string;
  onInstalled: () => void;
}) {
  const toast = useStore(s => s.toast);
  const [source, setSource] = useState('');
  const [skillName, setSkillName] = useState('');
  const [installing, setInstalling] = useState(false);

  useEffect(() => { if (open) { setSource(''); setSkillName(''); } }, [open]);

  const submit = async () => {
    if (!source.trim()) return;
    setInstalling(true);
    try {
      const r = await api.installSkill(source.trim(), scope === 'global', skillName.trim() || undefined, workdir);
      if (r.ok) {
        toast(L(locale, '技能安装成功', 'Skill installed'), true);
        onInstalled();
        onClose();
      } else toast(r.error || 'Failed', false);
    } catch (e: any) {
      toast(e?.message || 'Failed', false);
    } finally { setInstalling(false); }
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalHeader
        title={L(locale, '安装自定义技能', 'Install Custom Skill')}
        description={L(locale, '通过 npx skills add 从 GitHub 仓库安装。', 'Installs via npx skills add from a GitHub repo.')}
        onClose={onClose}
      />
      <div className="space-y-3">
        <div>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-5">{L(locale, 'GitHub 来源', 'GitHub Source')}</label>
          <Input value={source} onChange={e => setSource(e.target.value)} placeholder="owner/repo" className="font-mono" />
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-5">{L(locale, '指定技能（可选）', 'Specific skill (optional)')}</label>
          <Input value={skillName} onChange={e => setSkillName(e.target.value)} placeholder={L(locale, '留空安装全部', 'Leave empty for all')} />
        </div>
        <div className="flex justify-end gap-2 border-t border-edge pt-3">
          <Button variant="ghost" onClick={onClose}>{L(locale, '取消', 'Cancel')}</Button>
          <Button variant="primary" disabled={!source.trim() || installing} onClick={submit}>
            {installing ? <Spinner /> : L(locale, '安装', 'Install')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// OAuth popup helper
// ---------------------------------------------------------------------------

function openOAuthPopup(authUrl: string, expectedState: string): Promise<boolean> {
  return new Promise((resolve) => {
    const popup = window.open(authUrl, 'pikiclaw_mcp_oauth', 'width=640,height=780,noopener=no');
    if (!popup) { resolve(false); return; }

    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMessage);
      clearInterval(watcher);
      resolve(ok);
    };

    const onMessage = (ev: MessageEvent) => {
      const data = ev.data;
      if (!data || data.type !== 'mcp-oauth') return;
      if (expectedState && data.state !== expectedState) return;
      finish(!!data.ok);
      try { popup.close(); } catch {}
    };
    window.addEventListener('message', onMessage);

    const watcher = setInterval(() => {
      if (popup.closed) finish(false);
    }, 500);
  });
}

// ---------------------------------------------------------------------------
// Connected Card — rich visual for installed services
// ---------------------------------------------------------------------------

function ConnectedCard({
  item, locale, busy, index,
  onPrimary, onRemove, onReauth, onReconfigure,
}: {
  item: McpCatalogItem;
  locale: string;
  busy: boolean;
  index: number;
  onPrimary: () => void;
  onRemove: () => void;
  onReauth?: () => void;
  onReconfigure?: () => void;
}) {
  const { hex } = brandInfo(item.iconSlug, item.name);
  const primaryLabel = (() => {
    switch (item.state) {
      case 'ready': return L(locale, '停用', 'Pause');
      case 'unhealthy': return L(locale, '停用', 'Pause');
      case 'disabled': return L(locale, '启用', 'Enable');
      case 'needs_auth':
        return item.auth.type === 'mcp-oauth' ? L(locale, '授权', 'Authorize') : L(locale, '配置', 'Configure');
      default: return L(locale, '启用', 'Enable');
    }
  })();

  const cardStyle: CSSProperties = {
    background: `linear-gradient(140deg, ${withAlpha(hex, 0.05)} 0%, ${withAlpha(hex, 0.01)} 60%, transparent 100%)`,
    borderColor: withAlpha(hex, 0.18),
    animationDelay: `${Math.min(index, 8) * 40}ms`,
  };

  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-xl border p-4',
        'transition-[transform,box-shadow,border-color] duration-200',
        'hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(15,23,42,0.09)]',
        'animate-in-up',
      )}
      style={cardStyle}
    >
      <div
        className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full opacity-40 blur-2xl transition-opacity duration-300 group-hover:opacity-60"
        style={{ background: withAlpha(hex, 0.35) }}
      />

      <div className="relative flex items-start gap-3">
        <BrandAvatar iconSlug={item.iconSlug} iconUrl={item.iconUrl} name={item.name} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="truncate text-[14px] font-semibold text-fg">{item.name}</div>
            {item.homepage && (
              <a href={item.homepage} target="_blank" rel="noreferrer"
                 className="text-fg-5 hover:text-fg-3 transition-colors">
                <ExternalLinkIcon />
              </a>
            )}
          </div>
          <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-fg-4">
            {locale === 'zh-CN' ? item.descriptionZh : item.description}
          </div>
        </div>
        <StatePill state={item.state} locale={locale} />
      </div>

      <div className="relative mt-3 flex items-center justify-between border-t border-edge/60 pt-3">
        <span className="inline-flex items-center gap-1 text-[11px] text-fg-5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: hex, opacity: 0.8 }} />
          {authKindLabel(locale, item.auth)}
        </span>
        <div className="flex items-center gap-1">
          {item.installed && item.state !== 'needs_auth' && onReauth && (
            <Button variant="ghost" size="sm" onClick={onReauth} disabled={busy}>
              {L(locale, '重新授权', 'Re-auth')}
            </Button>
          )}
          {item.installed && item.state !== 'needs_auth' && onReconfigure && (
            <Button variant="ghost" size="sm" onClick={onReconfigure} disabled={busy}>
              {L(locale, '编辑', 'Edit')}
            </Button>
          )}
          <Button
            variant={item.state === 'disabled' || item.state === 'needs_auth' ? 'primary' : 'ghost'}
            size="sm"
            onClick={onPrimary}
            disabled={busy}
          >
            {busy ? <Spinner /> : primaryLabel}
          </Button>
          {item.installed && (
            <Button variant="ghost" size="sm" onClick={onRemove} disabled={busy} className="hover:!text-err">
              {L(locale, '移除', 'Remove')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Available Card — for discoverable recommended services
// ---------------------------------------------------------------------------

function AvailableCard({
  item, locale, busy, index, onPrimary,
}: {
  item: McpCatalogItem;
  locale: string;
  busy: boolean;
  index: number;
  onPrimary: () => void;
}) {
  const primaryLabel = (() => {
    if (item.auth.type === 'mcp-oauth') return L(locale, '授权并启用', 'Authorize');
    if (item.auth.type === 'credentials') return L(locale, '配置并启用', 'Configure');
    return L(locale, '启用', 'Install');
  })();

  return (
    <div
      className={cn(
        'group relative flex flex-col gap-3 rounded-xl border border-edge bg-panel-alt p-4',
        'transition-[transform,box-shadow,border-color] duration-200',
        'hover:-translate-y-0.5 hover:border-edge-h hover:shadow-[0_12px_28px_rgba(15,23,42,0.09)]',
        'animate-in-up',
      )}
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
    >
      <div className="flex items-start gap-3">
        <BrandAvatar iconSlug={item.iconSlug} iconUrl={item.iconUrl} name={item.name} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="truncate text-[13.5px] font-semibold text-fg">{item.name}</div>
            {item.homepage && (
              <a href={item.homepage} target="_blank" rel="noreferrer"
                 className="text-fg-5 hover:text-fg-3 transition-colors">
                <ExternalLinkIcon />
              </a>
            )}
          </div>
          <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-fg-4">
            {locale === 'zh-CN' ? item.descriptionZh : item.description}
          </div>
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between">
        <span className="inline-flex items-center gap-1 text-[11px] text-fg-5">
          {authKindLabel(locale, item.auth)}
        </span>
        <Button variant="outline" size="sm" onClick={onPrimary} disabled={busy}
                className="group-hover:border-edge-h">
          {busy ? <Spinner /> : primaryLabel}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skill Card
// ---------------------------------------------------------------------------

function SkillCard({
  item, locale, busy, index, onInstall, onRemove,
}: {
  item: SkillCatalogItem;
  locale: string;
  busy: boolean;
  index: number;
  onInstall: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        'group relative flex flex-col gap-3 rounded-xl border border-edge bg-panel-alt p-4',
        'transition-[transform,box-shadow,border-color] duration-200',
        'hover:-translate-y-0.5 hover:border-edge-h hover:shadow-[0_12px_28px_rgba(15,23,42,0.09)]',
        'animate-in-up',
      )}
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
    >
      <div className="flex items-start gap-3">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-white"
          style={{
            background: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)',
            boxShadow: '0 6px 16px rgba(245, 158, 11, 0.25)',
          }}
        >
          <ZapIcon size={14} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="truncate text-[13.5px] font-semibold text-fg">{item.name}</div>
            {item.homepage && (
              <a href={item.homepage} target="_blank" rel="noreferrer"
                 className="text-fg-5 hover:text-fg-3 transition-colors">
                <ExternalLinkIcon />
              </a>
            )}
          </div>
          <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-fg-4">
            {locale === 'zh-CN' ? item.descriptionZh : item.description}
          </div>
        </div>
        {item.installed && (
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold text-[var(--th-ok)]"
                style={{ background: 'color-mix(in oklab, var(--th-ok) 12%, transparent)' }}>
            <CheckCircleIcon size={10} />{L(locale, '已安装', 'Installed')}
          </span>
        )}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2">
        <div className="min-w-0 flex flex-col gap-0.5">
          <span className="truncate text-[11px] text-fg-5">{item.source}</span>
          {(item.stars !== undefined || item.pushedAt) && (
            <span className="flex items-center gap-2 text-[10.5px] text-fg-5">
              {item.stars !== undefined && (
                <span className="inline-flex items-center gap-0.5 font-medium text-fg-4">
                  <StarIcon size={10} />{formatStarCount(item.stars)}
                </span>
              )}
              {item.pushedAt && <span>· {formatRelativeTime(item.pushedAt, locale)}</span>}
            </span>
          )}
        </div>
        {item.installed ? (
          <Button variant="ghost" size="sm" onClick={onRemove} disabled={busy} className="hover:!text-err">
            {busy ? <Spinner /> : L(locale, '移除', 'Remove')}
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={onInstall} disabled={busy}>
            {busy ? <Spinner /> : L(locale, '安装', 'Install')}
          </Button>
        )}
      </div>
    </div>
  );
}

const StarIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

function formatStarCount(n: number): string {
  if (n >= 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatRelativeTime(iso: string, locale: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const day = 24 * 60 * 60 * 1000;
  const days = Math.max(1, Math.floor(diff / day));
  if (days < 30) return locale === 'zh-CN' ? `${days} 天前` : `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return locale === 'zh-CN' ? `${months} 个月前` : `${months}mo ago`;
  const years = Math.floor(months / 12);
  return locale === 'zh-CN' ? `${years} 年前` : `${years}y ago`;
}

// ---------------------------------------------------------------------------
// Category grouping
// ---------------------------------------------------------------------------

const CATEGORY_META: Record<string, { zh: string; en: string; order: number }> = {
  dev:           { zh: '开发工具',     en: 'Development',     order: 0 },
  productivity:  { zh: '生产力',       en: 'Productivity',    order: 1 },
  communication: { zh: '协作沟通',     en: 'Communication',   order: 2 },
  data:          { zh: '数据',         en: 'Data',            order: 3 },
  search:        { zh: '搜索',         en: 'Search',          order: 4 },
  utility:       { zh: '工具',         en: 'Utility',         order: 5 },
  custom:        { zh: '自定义',       en: 'Custom',          order: 6 },
};

function groupByCategory(items: McpCatalogItem[]): Array<{ key: string; items: McpCatalogItem[] }> {
  const groups = new Map<string, McpCatalogItem[]>();
  for (const item of items) {
    const arr = groups.get(item.category) || [];
    arr.push(item);
    groups.set(item.category, arr);
  }
  return [...groups.entries()]
    .sort((a, b) => (CATEGORY_META[a[0]]?.order ?? 99) - (CATEGORY_META[b[0]]?.order ?? 99))
    .map(([key, items]) => ({ key, items }));
}

// ---------------------------------------------------------------------------
// MCP Catalog Section — connected + available two-part layout
// ---------------------------------------------------------------------------

function McpCatalogSection({
  scope, workdir, locale,
}: {
  scope: 'global' | 'workspace';
  workdir?: string;
  locale: string;
}) {
  const toast = useStore(s => s.toast);
  const cacheKey = `pikiclaw.mcp.catalog.${scope}.${workdir || ''}`;
  const { data, loading, refresh } = useCachedResource<McpCatalogItem[]>(
    cacheKey,
    async () => (await api.getMcpCatalog(workdir, scope)).items || [],
    [workdir, scope],
  );

  const [search, setSearch] = useState('');
  const [credsTarget, setCredsTarget] = useState<McpCatalogItem | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const items = data || [];
  const scopedItems = useMemo(() => {
    // When showing workspace, also show items already installed in workspace; when global,
    // restrict to items that are either not installed or installed globally.
    return items.filter(i => !i.installed || i.scope === scope || !i.scope);
  }, [items, scope]);

  const filtered = useMemo(() => {
    if (!search.trim()) return scopedItems;
    const q = search.trim().toLowerCase();
    return scopedItems.filter(i =>
      i.name.toLowerCase().includes(q)
      || i.description.toLowerCase().includes(q)
      || i.descriptionZh.includes(q)
      || i.id.toLowerCase().includes(q),
    );
  }, [scopedItems, search]);

  const connectedItems = useMemo(
    () => filtered.filter(i => i.installed),
    [filtered],
  );
  const availableGroups = useMemo(
    () => groupByCategory(filtered.filter(i => !i.installed)),
    [filtered],
  );

  const runInstall = useCallback(async (item: McpCatalogItem, credentials?: Record<string, string>) => {
    if (!item.isRecommended) return;
    setBusy(item.id);
    try {
      const r = await api.installMcp(item.id, scope, credentials, workdir, true);
      if (!r.ok) throw new Error(r.error || 'install failed');
      await refresh();
      return r.enabled ?? false;
    } catch (e: any) {
      toast(e?.message || 'Failed', false);
      return false;
    } finally { setBusy(null); }
  }, [scope, workdir, refresh, toast]);

  const runOAuth = useCallback(async (item: McpCatalogItem) => {
    setBusy(item.id);
    try {
      if (!item.installed) {
        const r = await api.installMcp(item.id, scope, undefined, workdir, false);
        if (!r.ok) throw new Error(r.error || 'install failed');
      }
      const start = await api.startMcpOAuth(item.id);
      if (!start.ok || !start.authUrl || !start.state) throw new Error(start.error || 'oauth start failed');
      const ok = await openOAuthPopup(start.authUrl, start.state);
      if (ok) {
        await api.toggleMcp(item.id, true, scope, workdir);
        toast(L(locale, `${item.name} 授权成功`, `${item.name} authorized`), true);
      } else {
        toast(L(locale, '授权未完成', 'Authorization not completed'), false);
      }
      await refresh();
    } catch (e: any) {
      toast(e?.message || 'OAuth failed', false);
    } finally { setBusy(null); }
  }, [scope, workdir, locale, toast, refresh]);

  const runToggle = useCallback(async (item: McpCatalogItem, enabled: boolean) => {
    if (!item.installedKey) return;
    setBusy(item.id);
    try {
      await api.toggleMcp(item.installedKey, enabled, item.scope === 'workspace' ? 'workspace' : 'global', workdir);
      await refresh();
    } catch (e: any) { toast(e?.message || 'Failed', false); }
    finally { setBusy(null); }
  }, [workdir, refresh, toast]);

  const runRemove = useCallback(async (item: McpCatalogItem) => {
    if (!item.installedKey) return;
    setBusy(item.id);
    try {
      await api.removeMcp(item.installedKey, item.scope === 'workspace' ? 'workspace' : 'global', item.isRecommended ? item.id : undefined, workdir);
      await refresh();
    } catch (e: any) { toast(e?.message || 'Failed', false); }
    finally { setBusy(null); }
  }, [workdir, refresh, toast]);

  const runCredentialsSubmit = useCallback(async (credentials: Record<string, string>) => {
    if (!credsTarget) return;
    const ok = await runInstall(credsTarget, credentials);
    if (ok !== false) setCredsTarget(null);
  }, [credsTarget, runInstall]);

  const handleConnectedPrimary = useCallback((item: McpCatalogItem) => {
    if (item.state === 'ready' || item.state === 'unhealthy') { void runToggle(item, false); return; }
    if (item.state === 'disabled') { void runToggle(item, true); return; }
    if (item.state === 'needs_auth') {
      if (item.auth.type === 'mcp-oauth') { void runOAuth(item); return; }
      if (item.auth.type === 'credentials') { setCredsTarget(item); return; }
    }
  }, [runToggle, runOAuth]);

  const handleAvailablePrimary = useCallback((item: McpCatalogItem) => {
    if (item.auth.type === 'mcp-oauth') { void runOAuth(item); return; }
    if (item.auth.type === 'credentials') { setCredsTarget(item); return; }
    void runInstall(item);
  }, [runOAuth, runInstall]);

  const showSpinner = loading && !data;

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <SectionLabel>MCP Servers</SectionLabel>
          {!loading && (
            <span className="text-[11px] text-fg-5">
              {connectedItems.length} {L(locale, '已连接', 'connected')} · {scopedItems.length - connectedItems.length} {L(locale, '可添加', 'available')}
            </span>
          )}
          {loading && <Spinner className="h-3 w-3" />}
        </div>
        <div className="flex items-center gap-1.5">
          <div className="relative">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                 className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-5">
              <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={L(locale, '搜索...', 'Search...')}
              className="h-7 w-52 rounded-md border border-edge bg-inset/50 pl-7 pr-2.5 text-[12px] text-fg outline-none placeholder:text-fg-5/50 focus:border-primary/30 focus:bg-inset"
            />
          </div>
        </div>
      </div>

      {showSpinner ? (
        <div className="flex items-center justify-center py-10"><Spinner /></div>
      ) : (
        <div className="space-y-5">
          {/* Connected */}
          {connectedItems.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-5">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--th-ok)]"></span>
                {L(locale, '已连接', 'Connected')}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {connectedItems.map((item, i) => (
                  <ConnectedCard
                    key={item.id}
                    item={item}
                    locale={locale}
                    busy={busy === item.id}
                    index={i}
                    onPrimary={() => handleConnectedPrimary(item)}
                    onRemove={() => void runRemove(item)}
                    onReauth={item.auth.type === 'mcp-oauth' ? () => void runOAuth(item) : undefined}
                    onReconfigure={item.auth.type === 'credentials' ? () => setCredsTarget(item) : undefined}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Available */}
          {availableGroups.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-5">
                <span className="h-1.5 w-1.5 rounded-full bg-fg-5"></span>
                {connectedItems.length === 0
                  ? L(locale, '推荐的服务', 'Recommended services')
                  : L(locale, '更多可选', 'More options')}
              </div>
              <div className="space-y-4">
                {availableGroups.map(group => (
                  <CategoryGroup key={group.key} groupKey={group.key} locale={locale}>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {group.items.map((item, i) => (
                        <AvailableCard
                          key={item.id}
                          item={item}
                          locale={locale}
                          busy={busy === item.id}
                          index={i}
                          onPrimary={() => handleAvailablePrimary(item)}
                        />
                      ))}
                    </div>
                  </CategoryGroup>
                ))}
              </div>
            </div>
          )}

          {connectedItems.length === 0 && availableGroups.length === 0 && (
            <EmptyState
              title={L(locale, '没有匹配的服务', 'No matching services')}
              subtitle={L(locale, '试试别的关键词', 'Try a different search term')}
            />
          )}
        </div>
      )}

      <div className="mt-3 flex justify-end">
        <button
          className="text-[12px] text-fg-4 hover:text-fg-2 transition-colors"
          onClick={() => setCustomOpen(true)}
        >
          + {L(locale, '添加自定义 MCP', 'Add custom MCP')}
        </button>
      </div>

      <CredentialsDialog
        open={!!credsTarget}
        onClose={() => setCredsTarget(null)}
        locale={locale}
        item={credsTarget}
        initial={credsTarget?.config?.env || credsTarget?.config?.headers}
        onSubmit={runCredentialsSubmit}
      />
      <CustomMcpDialog
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        locale={locale}
        scope={scope}
        workdir={workdir}
        onAdded={refresh}
      />
    </section>
  );
}

function CategoryGroup({
  groupKey, locale, children,
}: {
  groupKey: string;
  locale: string;
  children: ReactNode;
}) {
  const meta = CATEGORY_META[groupKey];
  const label = meta ? L(locale, meta.zh, meta.en) : groupKey;
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium text-fg-5">{label}</div>
      {children}
    </div>
  );
}

function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-edge py-10 text-center">
      <div className="text-[13px] font-medium text-fg-3">{title}</div>
      {subtitle && <div className="mt-1 text-[12px] text-fg-5">{subtitle}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skills Catalog Section
// ---------------------------------------------------------------------------

function SkillsCatalogSection({
  scope, workdir, locale,
}: {
  scope: 'global' | 'workspace';
  workdir?: string;
  locale: string;
}) {
  const toast = useStore(s => s.toast);
  const cacheKey = `pikiclaw.skills.catalog.${scope}.${workdir || ''}`;
  const { data, loading, refresh } = useCachedResource<{ items: SkillCatalogItem[]; installed: SkillInfo[] }>(
    cacheKey,
    async () => {
      const r = await api.getSkillsCatalog(workdir, scope);
      return { items: r.items || [], installed: r.installed || [] };
    },
    [workdir, scope],
  );

  const [customOpen, setCustomOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const items = data?.items || [];
  const installedSkills = useMemo(() => {
    const all = data?.installed || [];
    const targetScope = scope === 'global' ? 'global' : 'project';
    return all.filter(s => s.scope === targetScope);
  }, [data, scope]);

  // Separate installed (known repos) from installed custom skills
  const orphanInstalled = useMemo(() => {
    return installedSkills.filter(s => !items.some(i => i.installedNames.includes(s.name)));
  }, [installedSkills, items]);

  const installRepo = useCallback(async (item: SkillCatalogItem) => {
    setBusy(item.id);
    try {
      const r = await api.installSkill(item.source, scope === 'global', undefined, workdir);
      if (r.ok) {
        toast(L(locale, `${item.name} 已安装`, `${item.name} installed`), true);
        await refresh();
      } else toast(r.error || 'Failed', false);
    } catch (e: any) { toast(e?.message || 'Failed', false); }
    finally { setBusy(null); }
  }, [scope, workdir, locale, toast, refresh]);

  const removeInstalled = useCallback(async (name: string) => {
    setBusy(name);
    try {
      const r = await api.removeExtensionSkill(name, scope === 'global', workdir);
      if (r.ok) {
        toast(L(locale, `${name} 已移除`, `${name} removed`), true);
        await refresh();
      } else toast(r.error || 'Failed', false);
    } catch (e: any) { toast(e?.message || 'Failed', false); }
    finally { setBusy(null); }
  }, [scope, workdir, locale, toast, refresh]);

  const showSpinner = loading && !data;

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <SectionLabel>Skills</SectionLabel>
          {!loading && (
            <span className="text-[11px] text-fg-5">
              {installedSkills.length} {L(locale, '已安装', 'installed')}
            </span>
          )}
          {loading && <Spinner className="h-3 w-3" />}
        </div>
        <Button variant="outline" size="sm" onClick={() => setCustomOpen(true)}>
          + {L(locale, '从 GitHub 安装', 'Install from GitHub')}
        </Button>
      </div>

      {showSpinner ? (
        <div className="flex items-center justify-center py-10"><Spinner /></div>
      ) : items.length === 0 && orphanInstalled.length === 0 ? (
        <EmptyState
          title={L(locale, '暂无可用的技能包', 'No skill packs available')}
          subtitle={L(locale, '从 GitHub 导入一个开始使用', 'Import from GitHub to get started')}
        />
      ) : (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item, i) => (
              <SkillCard
                key={item.id}
                item={item}
                locale={locale}
                busy={busy === item.id}
                index={i}
                onInstall={() => void installRepo(item)}
                onRemove={() => item.installedNames.forEach(n => void removeInstalled(n))}
              />
            ))}
          </div>

          {orphanInstalled.length > 0 && (
            <div>
              <div className="mb-1.5 text-[11px] font-medium text-fg-5">
                {L(locale, '自定义技能', 'Custom skills')}
              </div>
              <div className="space-y-1.5">
                {orphanInstalled.map(skill => (
                  <SettingRowCard key={skill.name}>
                    <SettingRowLead
                      icon={<ZapIcon size={14} />}
                      title={skill.label || skill.name}
                      subtitle={skill.description || undefined}
                      badge={<Badge variant="ok">{L(locale, '已安装', 'Installed')}</Badge>}
                    />
                    <div className="min-w-0 xl:col-span-2">
                      {skill.mcpRequires?.length ? <Badge variant="muted">MCP: {skill.mcpRequires.join(', ')}</Badge> : null}
                    </div>
                    <SettingRowAction>
                      <Button variant="ghost" size="sm" onClick={() => void removeInstalled(skill.name)} disabled={busy === skill.name} className="hover:!text-err">
                        {L(locale, '移除', 'Remove')}
                      </Button>
                    </SettingRowAction>
                  </SettingRowCard>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <CustomSkillDialog
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        locale={locale}
        scope={scope}
        workdir={workdir}
        onInstalled={refresh}
      />
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  CLI tools — detection, install hints, and streaming sign-in
// ═══════════════════════════════════════════════════════════════════════════

const CLI_CATEGORY_META: Record<string, { zh: string; en: string; order: number }> = {
  dev:          { zh: '开发工具',   en: 'Developer', order: 1 },
  cloud:        { zh: '云平台',     en: 'Cloud',     order: 2 },
  data:         { zh: '数据',       en: 'Data',      order: 3 },
  productivity: { zh: '生产力',     en: 'Productivity', order: 4 },
};

function cliStatePill({
  state,
  locale,
}: { state: CliCatalogItem['state']; locale: string }) {
  if (state === 'ready') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold text-[var(--th-ok)]"
            style={{ background: 'color-mix(in oklab, var(--th-ok) 12%, transparent)' }}>
        <CheckCircleIcon size={10} />{L(locale, '已登录', 'Signed in')}
      </span>
    );
  }
  if (state === 'installed_not_auth') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
            style={{ background: 'color-mix(in oklab, #f59e0b 14%, transparent)' }}>
        <LockIcon size={10} />{L(locale, '待登录', 'Sign-in needed')}
      </span>
    );
  }
  if (state === 'not_installed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-edge bg-inset/60 px-2 py-0.5 text-[10px] font-medium text-fg-5">
        {L(locale, '未安装', 'Not installed')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-edge bg-inset/60 px-2 py-0.5 text-[10px] font-medium text-fg-5">
      ...
    </span>
  );
}

/** A read-only terminal pane. Takes a stream of chunks and prints them. */
function StreamingTerminal({
  chunks,
  running,
  emptyHint,
}: { chunks: string[]; running: boolean; emptyHint?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [chunks.length]);
  const text = chunks.join('');
  return (
    <div
      ref={containerRef}
      className="relative h-56 overflow-auto rounded-xl border border-edge/60 bg-[#0b0f16] p-3 font-mono text-[11.5px] leading-[1.55] text-[#cdd6f4] scrollbar-thin"
      style={{ boxShadow: '0 1px 0 rgba(255,255,255,0.03) inset' }}
    >
      {!text ? (
        <div className="flex h-full items-center justify-center text-[#6c7086]">
          {running ? (
            <span className="inline-flex items-center gap-2">
              <Spinner /> {emptyHint || 'Starting…'}
            </span>
          ) : (emptyHint || 'No output yet')}
        </div>
      ) : (
        <pre className="whitespace-pre-wrap break-words">{text}</pre>
      )}
    </div>
  );
}

/**
 * Interactive sign-in panel.
 *   - For oauth-web: starts the auth session, streams output via SSE, polls until
 *     the CLI reports ready, then closes.
 *   - For token: renders the credential form, posts values, reports ready.
 */
function CliSignInPanel({
  cli,
  locale,
  onSignedIn,
  onCancel,
}: {
  cli: CliCatalogItem;
  locale: string;
  onSignedIn: () => void;
  onCancel: () => void;
}) {
  const [chunks, setChunks] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const cleanup = useCallback(() => {
    try { sourceRef.current?.close(); } catch { /* ignore */ }
    sourceRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const startOAuth = useCallback(async () => {
    setChunks([]);
    setErrorMsg(null);
    setStatusLine(null);
    setRunning(true);
    try {
      const r = await api.startCliAuth(cli.id);
      if (!r.ok || !r.sessionId) throw new Error(r.error || 'start failed');
      setSessionId(r.sessionId);
      const es = new EventSource(`/api/extensions/cli/auth/stream?sessionId=${encodeURIComponent(r.sessionId)}`);
      sourceRef.current = es;
      es.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data);
          if (ev.type === 'output') {
            setChunks(prev => prev.length > 400 ? [...prev.slice(-400), ev.chunk] : [...prev, ev.chunk]);
          } else if (ev.type === 'status') {
            setStatusLine(ev.status.state === 'ready'
              ? L(locale, '已检测到登录成功', 'Sign-in detected')
              : L(locale, '等待授权完成…', 'Waiting for authorization…'));
          } else if (ev.type === 'error') {
            setErrorMsg(ev.message || 'error');
          } else if (ev.type === 'done') {
            setRunning(false);
            cleanup();
            if (ev.ok) onSignedIn();
          }
        } catch { /* malformed */ }
      };
      es.addEventListener('close', () => {
        setRunning(false);
        cleanup();
      });
      es.onerror = () => {
        if (!running) return;
        setErrorMsg(L(locale, '连接中断', 'Stream disconnected'));
      };
    } catch (e: any) {
      setRunning(false);
      setErrorMsg(e?.message || 'failed to start sign-in');
    }
  }, [cli.id, cleanup, locale, onSignedIn, running]);

  const cancelOAuth = useCallback(async () => {
    if (sessionId) {
      try { await api.cancelCliAuth(sessionId); } catch { /* ignore */ }
    }
    cleanup();
    setRunning(false);
    onCancel();
  }, [sessionId, cleanup, onCancel]);

  // Token flow
  const [tokenValues, setTokenValues] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const applyToken = useCallback(async () => {
    setApplying(true);
    setErrorMsg(null);
    try {
      const r = await api.applyCliToken(cli.id, tokenValues);
      if (r.ok) onSignedIn();
      else setErrorMsg(r.error || L(locale, '应用凭据失败', 'Failed to apply credentials'));
    } catch (e: any) {
      setErrorMsg(e?.message || 'failed');
    } finally {
      setApplying(false);
    }
  }, [cli.id, tokenValues, locale, onSignedIn]);

  if (cli.auth.type === 'oauth-web') {
    const hint = locale === 'zh-CN' ? (cli.auth.loginHintZh || cli.auth.loginHint) : cli.auth.loginHint;
    return (
      <div className="space-y-3">
        {hint && <div className="text-[12px] leading-relaxed text-fg-4">{hint}</div>}
        <StreamingTerminal
          chunks={chunks}
          running={running}
          emptyHint={L(locale, '点击「开始登录」后将在此展示命令行输出', 'Click "Start sign-in" to stream CLI output here')}
        />
        {errorMsg && (
          <div className="text-[12px] text-[var(--th-err)]">{errorMsg}</div>
        )}
        {statusLine && !errorMsg && (
          <div className="text-[12px] text-[var(--th-ok)]">{statusLine}</div>
        )}
        <div className="flex items-center gap-2">
          {!running ? (
            <>
              <Button variant="primary" size="sm" onClick={startOAuth}>
                {L(locale, '开始登录', 'Start sign-in')}
              </Button>
              <Button variant="ghost" size="sm" onClick={onCancel}>
                {L(locale, '取消', 'Cancel')}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={cancelOAuth}>
              {L(locale, '中止', 'Abort')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (cli.auth.type === 'token') {
    const hint = locale === 'zh-CN' ? (cli.auth.loginHintZh || cli.auth.loginHint) : cli.auth.loginHint;
    return (
      <div className="space-y-3">
        {hint && <div className="text-[12px] leading-relaxed text-fg-4">{hint}</div>}
        <div className="space-y-2">
          {(cli.auth.tokenFields || []).map(f => (
            <label key={f.key} className="block text-[12px]">
              <div className="mb-1 text-fg-3">
                {locale === 'zh-CN' ? f.labelZh : f.label}
                {f.required && <span className="ml-1 text-[var(--th-err)]">*</span>}
              </div>
              <Input
                type={f.secret ? 'password' : 'text'}
                value={tokenValues[f.key] || ''}
                onChange={e => setTokenValues(v => ({ ...v, [f.key]: e.target.value }))}
                placeholder={f.placeholder || ''}
                className="w-full"
              />
              {f.helpUrl && (
                <a className="mt-1 inline-block text-[11px] text-primary hover:underline" href={f.helpUrl} target="_blank" rel="noreferrer">
                  {L(locale, '如何获取', 'How to get this')} ↗
                </a>
              )}
            </label>
          ))}
        </div>
        {errorMsg && (
          <div className="text-[12px] text-[var(--th-err)]">{errorMsg}</div>
        )}
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={applyToken} disabled={applying}>
            {applying ? L(locale, '验证中…', 'Verifying…') : L(locale, '保存并验证', 'Save & verify')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>{L(locale, '取消', 'Cancel')}</Button>
        </div>
      </div>
    );
  }

  return null;
}

/** Show a neat, copyable block of install commands. */
function InstallCommandBlock({ commands, locale }: { commands: { cmd: string; label?: string }[]; locale: string }) {
  return (
    <div className="space-y-2">
      {commands.map((c, i) => (
        <div key={i} className="overflow-hidden rounded-lg border border-edge/70 bg-panel/60">
          {c.label && (
            <div className="flex items-center justify-between border-b border-edge/50 bg-panel-alt/40 px-3 py-1 text-[11px] font-medium text-fg-4">
              <span>{c.label}</span>
            </div>
          )}
          <div className="flex items-start gap-2 px-3 py-2 font-mono text-[12px] text-fg-2">
            <span className="mt-[2px] select-none text-fg-5">$</span>
            <code className="min-w-0 flex-1 break-all">{c.cmd}</code>
            <button
              type="button"
              onClick={() => { void navigator.clipboard?.writeText(c.cmd); }}
              className="shrink-0 rounded px-2 py-0.5 text-[10.5px] text-fg-5 transition-colors hover:bg-panel-h hover:text-fg-2"
              title={L(locale, '复制到剪贴板', 'Copy to clipboard')}
            >
              {L(locale, '复制', 'Copy')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function CliDetailModal({
  cli,
  open,
  onClose,
  onChanged,
  locale,
}: {
  cli: CliCatalogItem | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  locale: string;
}) {
  const [signingIn, setSigningIn] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutErr, setLogoutErr] = useState<string | null>(null);

  // Close flow when sign-in state changes away from the dialog.
  useEffect(() => {
    if (!open) { setSigningIn(false); setLogoutErr(null); }
  }, [open]);

  const platformCommands = useMemo(() => {
    if (!cli) return [];
    return cli.install[cli.platform] || [];
  }, [cli]);

  if (!cli) return null;

  const installed = cli.state !== 'not_installed';
  const ready = cli.state === 'ready';

  const handleLogout = async () => {
    setLoggingOut(true);
    setLogoutErr(null);
    try {
      const r = await api.logoutCli(cli.id);
      if (!r.ok) setLogoutErr(r.error || L(locale, '登出失败', 'Logout failed'));
      onChanged();
    } catch (e: any) {
      setLogoutErr(e?.message || 'failed');
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} wide>
      <ModalHeader
        title={cli.name}
        description={locale === 'zh-CN' ? cli.descriptionZh : cli.description}
        onClose={onClose}
      />
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <BrandAvatar iconSlug={cli.iconSlug} iconUrl={cli.iconUrl} name={cli.name} size={44} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-fg">
              {cli.name}
              {cli.homepage && (
                <a href={cli.homepage} target="_blank" rel="noreferrer" className="text-fg-5 hover:text-primary">
                  <ExternalLinkIcon />
                </a>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-fg-4">
              {cliStatePill({ state: cli.state, locale })}
              {cli.version && <span className="font-mono text-fg-5">v{cli.version}</span>}
              {ready && cli.authDetail && (
                <span className="truncate text-fg-5">· {cli.authDetail}</span>
              )}
            </div>
          </div>
        </div>

        {!installed && (
          <section className="space-y-2">
            <div className="text-[12px] font-semibold text-fg-3">
              {L(locale, '安装', 'Install')}
            </div>
            <div className="text-[11.5px] leading-relaxed text-fg-5">
              {L(locale,
                '复制下面的命令到终端运行。我们不自动代为安装 — 包管理器往往需要 sudo 或交互式确认。',
                'Copy a command below and run it in your terminal. We don\'t auto-install — package managers often need sudo or interactive confirmation.')}
            </div>
            {platformCommands.length > 0 ? (
              <InstallCommandBlock commands={platformCommands} locale={locale} />
            ) : (
              <div className="text-[12px] text-fg-5">
                {L(locale, '请查看官方文档', 'Check the official installation docs')}
              </div>
            )}
            {cli.install.docs && (
              <a href={cli.install.docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11.5px] text-primary hover:underline">
                {L(locale, '查看安装文档', 'Installation docs')} ↗
              </a>
            )}
            <div className="pt-2">
              <Button variant="outline" size="sm" onClick={onChanged}>
                {L(locale, '我已安装，重新检测', "I've installed, re-check")}
              </Button>
            </div>
          </section>
        )}

        {installed && cli.auth.type !== 'none' && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-[12px] font-semibold text-fg-3">
                {L(locale, '登录', 'Sign in')}
              </div>
              {ready && !signingIn && (
                <Button variant="ghost" size="sm" onClick={handleLogout} disabled={loggingOut}>
                  {loggingOut ? L(locale, '登出中…', 'Signing out…') : L(locale, '登出', 'Sign out')}
                </Button>
              )}
            </div>
            {logoutErr && <div className="text-[11.5px] text-[var(--th-err)]">{logoutErr}</div>}
            {ready && !signingIn ? (
              <div className="rounded-lg border border-edge/70 bg-panel/60 p-3 text-[12px] text-fg-3">
                <div className="flex items-center gap-2">
                  <CheckCircleIcon size={12} />
                  <span>{L(locale, '你已经登录，命令行工具可直接使用。', 'Already signed in — the CLI is ready to use.')}</span>
                </div>
                <div className="mt-2">
                  <Button variant="outline" size="sm" onClick={() => setSigningIn(true)}>
                    {L(locale, '重新登录', 'Re-authenticate')}
                  </Button>
                </div>
              </div>
            ) : (
              <CliSignInPanel
                cli={cli}
                locale={locale}
                onSignedIn={() => { setSigningIn(false); onChanged(); }}
                onCancel={() => setSigningIn(false)}
              />
            )}
          </section>
        )}

        {installed && cli.auth.type === 'none' && (
          <section className="rounded-lg border border-edge/70 bg-panel/60 p-3 text-[12px] text-fg-3">
            <div className="flex items-center gap-2">
              <CheckCircleIcon size={12} />
              <span>{L(locale, '无需授权 — 可直接使用。', 'No authentication required — ready to use.')}</span>
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}

function CliConnectedCard({
  item,
  onClick,
  locale,
  animationDelay,
}: { item: CliCatalogItem; onClick: () => void; locale: string; animationDelay?: string }) {
  const { hex } = brandInfo(item.iconSlug, item.name);
  return (
    <button
      type="button"
      onClick={onClick}
      className="animate-in-up group relative w-full overflow-hidden rounded-2xl border border-edge/70 bg-panel p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_28px_rgba(15,23,42,0.09)] focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--th-glow-a)]"
      style={{
        background: `linear-gradient(135deg, ${withAlpha(hex, 0.06)} 0%, ${withAlpha(hex, 0.02)} 100%), var(--th-panel)`,
        animationDelay,
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full opacity-60"
        style={{ background: `radial-gradient(closest-side, ${withAlpha(hex, 0.18)}, transparent 70%)` }}
      />
      <div className="relative flex items-start gap-3">
        <BrandAvatar iconSlug={item.iconSlug} iconUrl={item.iconUrl} name={item.name} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-[13px] font-semibold text-fg">{item.name}</div>
            {cliStatePill({ state: item.state, locale })}
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-fg-5">
            {item.version ? <span className="font-mono">v{item.version}</span> : null}
            {item.version && item.authDetail ? ' · ' : null}
            {item.authDetail}
          </div>
          <div className="mt-1 truncate text-[11.5px] text-fg-4">
            {locale === 'zh-CN' ? item.descriptionZh : item.description}
          </div>
        </div>
      </div>
    </button>
  );
}

function CliAvailableCard({
  item,
  onClick,
  locale,
  animationDelay,
}: { item: CliCatalogItem; onClick: () => void; locale: string; animationDelay?: string }) {
  const { hex } = brandInfo(item.iconSlug, item.name);
  const cta = item.state === 'not_installed'
    ? L(locale, '安装', 'Install')
    : item.state === 'installed_not_auth' ? L(locale, '登录', 'Sign in')
    : L(locale, '查看', 'Details');
  return (
    <button
      type="button"
      onClick={onClick}
      className="animate-in-up group relative w-full overflow-hidden rounded-2xl border border-edge/60 bg-panel p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-edge hover:shadow-[0_12px_28px_rgba(15,23,42,0.07)] focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_var(--th-glow-a)]"
      style={{ animationDelay }}
    >
      <div className="flex items-start gap-3">
        <BrandAvatar iconSlug={item.iconSlug} iconUrl={item.iconUrl} name={item.name} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-fg">{item.name}</span>
            {item.homepage && (
              <a href={item.homepage} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="text-fg-5 transition-colors hover:text-primary">
                <ExternalLinkIcon />
              </a>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-fg-4">
            {locale === 'zh-CN' ? item.descriptionZh : item.description}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[11px] text-fg-5">
          {item.auth.type === 'oauth-web' ? L(locale, '浏览器授权', 'OAuth')
            : item.auth.type === 'token' ? L(locale, 'Token', 'Token')
            : L(locale, '免配置', 'No auth')}
        </span>
        <span
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors group-hover:text-primary"
          style={{ background: `${withAlpha(hex, 0.08)}`, color: hex }}
        >
          {cta}
        </span>
      </div>
    </button>
  );
}

function CliCatalogSection({
  locale,
  scope,
}: {
  locale: string;
  scope: 'global' | 'workspace';
}) {
  const { data, loading, refresh } = useCachedResource<CliCatalogItem[]>(
    `pikiclaw:cli:catalog`,
    async () => {
      const r = await api.getCliCatalog();
      if (!r.ok) throw new Error(r.error || 'failed');
      return r.items || [];
    },
    [],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const items = useMemo(() => {
    const all = data || [];
    if (scope === 'workspace') return all; // CLI tools are machine-wide; we still show the list
    return all;
  }, [data, scope]);
  const selected = selectedId ? items.find(i => i.id === selectedId) || null : null;

  const connected = items.filter(i => i.state === 'ready');
  const available = items.filter(i => i.state !== 'ready');
  const groupedAvailable = useMemo(() => {
    const map = new Map<string, CliCatalogItem[]>();
    for (const it of available) {
      const k = it.category;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(it);
    }
    return [...map.entries()].sort(([a], [b]) => (CLI_CATEGORY_META[a]?.order ?? 99) - (CLI_CATEGORY_META[b]?.order ?? 99));
  }, [available]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <SectionLabel>{L(locale, 'CLI 工具', 'CLI Tools')}</SectionLabel>
        <div className="flex items-center gap-3 text-[11px] text-fg-5">
          <span>{connected.length} {L(locale, '已登录', 'signed in')} · {available.length} {L(locale, '可用', 'available')}</span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded px-2 py-0.5 text-fg-5 transition-colors hover:bg-panel-h hover:text-fg-2"
          >
            {loading ? L(locale, '刷新中…', 'Refreshing…') : L(locale, '刷新', 'Refresh')}
          </button>
        </div>
      </div>

      {scope === 'workspace' && (
        <div className="rounded-lg border border-edge/60 bg-inset/40 px-3 py-2 text-[11.5px] text-fg-4">
          {L(locale,
            'CLI 工具安装于机器层面，项目视图下同样可见。',
            'CLI tools are installed machine-wide and are shown here for convenience.')}
        </div>
      )}

      {connected.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[11px] font-semibold text-fg-3">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--th-ok)]"></span>
            {L(locale, '已登录', 'Signed in')}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {connected.map((c, i) => (
              <CliConnectedCard
                key={c.id}
                item={c}
                locale={locale}
                animationDelay={`${Math.min(i, 12) * 30}ms`}
                onClick={() => setSelectedId(c.id)}
              />
            ))}
          </div>
        </div>
      )}

      {available.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-[11px] font-semibold text-fg-3">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-fg-5/50"></span>
            {L(locale, '推荐工具', 'Available')}
          </div>
          {groupedAvailable.map(([cat, list]) => (
            <div key={cat} className="space-y-2">
              <div className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-fg-5">
                {locale === 'zh-CN' ? (CLI_CATEGORY_META[cat]?.zh || cat) : (CLI_CATEGORY_META[cat]?.en || cat)}
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {list.map((item, i) => (
                  <CliAvailableCard
                    key={item.id}
                    item={item}
                    locale={locale}
                    animationDelay={`${Math.min(i, 12) * 30}ms`}
                    onClick={() => setSelectedId(item.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && items.length === 0 && (
        <EmptyState
          title={L(locale, '暂无可用 CLI', 'No CLI tools available')}
          subtitle={L(locale, '稍后再试，或重启一下服务。', 'Try again later, or restart the service.')}
        />
      )}

      <CliDetailModal
        cli={selected}
        open={!!selected}
        onClose={() => setSelectedId(null)}
        onChanged={() => { void refresh(); }}
        locale={locale}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Built-in automation row
// ---------------------------------------------------------------------------

function BuiltinRow({
  brand,
  title,
  badge,
  onClick,
  buttonLabel,
}: {
  brand: string;
  title: string;
  badge: { label: string; variant: 'ok' | 'warn' | 'muted' | 'accent' };
  onClick: () => void;
  buttonLabel: string;
}) {
  return (
    <SettingRowCard>
      <SettingRowLead
        icon={<BrandIcon brand={brand} size={14} />}
        title={title}
        badge={<Badge variant={badge.variant}>{badge.label}</Badge>}
      />
      <div className="min-w-0 xl:col-span-2" />
      <SettingRowAction>
        <Button variant="outline" size="sm" onClick={onClick}>{buttonLabel}</Button>
      </SettingRowAction>
    </SettingRowCard>
  );
}

// ---------------------------------------------------------------------------
// Public: tab (global scope) and modal body (workspace scope)
// ---------------------------------------------------------------------------

type ExtensionTab = 'mcp' | 'cli' | 'skill';

function ExtensionTabNav({
  active,
  onChange,
  locale,
  counts,
}: {
  active: ExtensionTab;
  onChange: (tab: ExtensionTab) => void;
  locale: string;
  counts?: Partial<Record<ExtensionTab, number>>;
}) {
  const tabs: Array<{
    id: ExtensionTab;
    icon: ReactNode;
    labelZh: string;
    labelEn: string;
  }> = [
    {
      id: 'mcp',
      labelZh: 'MCP 服务',
      labelEn: 'MCP',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" /><circle cx="4" cy="5" r="1.6" /><circle cx="20" cy="5" r="1.6" /><circle cx="4" cy="19" r="1.6" /><circle cx="20" cy="19" r="1.6" />
          <path d="M6 6 l4 4 M18 6 l-4 4 M6 18 l4 -4 M18 18 l-4 -4" />
        </svg>
      ),
    },
    {
      id: 'cli',
      labelZh: '命令行',
      labelEn: 'CLI',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 17 l5 -5 -5 -5" /><path d="M12 19 h8" />
        </svg>
      ),
    },
    {
      id: 'skill',
      labelZh: '技能包',
      labelEn: 'Skills',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2 l3 7 h7 l-5.5 4.5 2 7.5 L12 17 l-6.5 4 2 -7.5 L2 9 h7 z" />
        </svg>
      ),
    },
  ];

  return (
    <TabsList className="w-fit bg-panel/80 backdrop-blur">
      {tabs.map(t => (
        <TabsTrigger
          key={t.id}
          active={active === t.id}
          onClick={() => onChange(t.id)}
          className="gap-1.5 px-3.5"
        >
          <span className="shrink-0">{t.icon}</span>
          <span>{locale === 'zh-CN' ? t.labelZh : t.labelEn}</span>
          {counts?.[t.id] !== undefined && (
            <span className={cn(
              'ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold',
              active === t.id ? 'bg-primary/12 text-primary' : 'bg-inset/70 text-fg-5',
            )}>
              {counts[t.id]}
            </span>
          )}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

export function ExtensionsTab({
  onOpenBrowserSetup,
  onOpenDesktopSetup,
}: {
  onOpenBrowserSetup: () => void;
  onOpenDesktopSetup: () => void;
}) {
  const locale = useStore(s => s.locale);
  const state = useStore(s => s.state);
  const workdir = state?.config?.workdir || '';
  const [tab, setTab] = useState<ExtensionTab>(() => {
    try {
      const saved = localStorage.getItem('pikiclaw:extensions:tab');
      return (saved === 'mcp' || saved === 'cli' || saved === 'skill') ? saved : 'mcp';
    } catch { return 'mcp'; }
  });
  const switchTab = useCallback((next: ExtensionTab) => {
    setTab(next);
    try { localStorage.setItem('pikiclaw:extensions:tab', next); } catch { /* quota */ }
  }, []);

  const [snapshot, setSnapshot] = useState<BrowserStatusResponse | null>(null);
  const refreshAutomation = useCallback(async () => {
    try { setSnapshot(await api.getBrowser()); } catch { /* ignore */ }
  }, []);
  useEffect(() => { void refreshAutomation(); }, [refreshAutomation, state]);

  const browser = snapshot?.browser;
  const desktop = snapshot?.desktop;
  const browserBadge: { label: string; variant: 'ok' | 'warn' | 'muted' | 'accent' } = !browser
    ? { label: '...', variant: 'muted' }
    : !browser.enabled ? { label: L(locale, '已关闭', 'Disabled'), variant: 'muted' }
    : browser.running ? { label: L(locale, '运行中', 'Running'), variant: 'ok' }
    : browser.status === 'ready' ? { label: L(locale, '就绪', 'Ready'), variant: 'ok' }
    : { label: L(locale, '需配置', 'Needs setup'), variant: 'warn' };
  const desktopBadge: { label: string; variant: 'ok' | 'warn' | 'muted' | 'accent' } = !desktop
    ? { label: '...', variant: 'muted' }
    : !desktop.installed ? { label: L(locale, '未安装', 'Not installed'), variant: 'muted' }
    : desktop.running ? { label: L(locale, '运行中', 'Running'), variant: 'ok' }
    : { label: L(locale, '已安装', 'Installed'), variant: 'accent' };

  return (
    <div className="animate-in space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <div className="text-[13px] leading-relaxed text-fg-4">
            {L(locale,
              '管理一次授权即可全局复用的服务与工具。项目专属的扩展请在工作台侧栏配置。',
              'One-time authorization, use everywhere. Project-specific extensions live in the Workbench sidebar.',
            )}
          </div>
        </div>
        <ExtensionTabNav active={tab} onChange={switchTab} locale={locale} />
      </div>

      <div key={tab} className="animate-in-fade">
        {tab === 'mcp' && (
          <div className="space-y-7">
            <McpCatalogSection scope="global" workdir={workdir} locale={locale} />
            <section>
              <div className="mb-3"><SectionLabel>{L(locale, '内置自动化', 'Built-in Automation')}</SectionLabel></div>
              <div className="space-y-1.5">
                <BuiltinRow
                  brand="playwright"
                  title={L(locale, '浏览器自动化', 'Browser Automation')}
                  badge={browserBadge}
                  onClick={onOpenBrowserSetup}
                  buttonLabel={browser?.enabled ? L(locale, '管理', 'Manage') : L(locale, '配置', 'Setup')}
                />
                <BuiltinRow
                  brand="appium"
                  title={L(locale, '桌面自动化', 'Desktop Automation')}
                  badge={desktopBadge}
                  onClick={onOpenDesktopSetup}
                  buttonLabel={desktop?.running ? L(locale, '管理', 'Manage') : L(locale, '配置', 'Setup')}
                />
              </div>
            </section>
          </div>
        )}
        {tab === 'cli' && <CliCatalogSection locale={locale} scope="global" />}
        {tab === 'skill' && <SkillsCatalogSection scope="global" workdir={workdir} locale={locale} />}
      </div>
    </div>
  );
}

/**
 * Workspace-scoped catalog body — rendered inside WorkspaceExtensionsModal.
 */
export function WorkspaceExtensionsBody({ workdir }: { workdir: string }) {
  const locale = useStore(s => s.locale);
  const [tab, setTab] = useState<ExtensionTab>(() => {
    try {
      const saved = localStorage.getItem('pikiclaw:extensions-ws:tab');
      return (saved === 'mcp' || saved === 'cli' || saved === 'skill') ? saved : 'mcp';
    } catch { return 'mcp'; }
  });
  const switchTab = useCallback((next: ExtensionTab) => {
    setTab(next);
    try { localStorage.setItem('pikiclaw:extensions-ws:tab', next); } catch { /* quota */ }
  }, []);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="text-[13px] leading-relaxed text-fg-4">
          {L(locale,
            '仅对当前工作区生效 — 依赖项目目录的本地服务和专属技能包。',
            'Scoped to this workspace — local services that depend on project context and project-specific skill packs.',
          )}
        </div>
        <ExtensionTabNav active={tab} onChange={switchTab} locale={locale} />
      </div>
      <div key={tab} className="animate-in-fade">
        {tab === 'mcp' && <McpCatalogSection scope="workspace" workdir={workdir} locale={locale} />}
        {tab === 'cli' && <CliCatalogSection locale={locale} scope="workspace" />}
        {tab === 'skill' && <SkillsCatalogSection scope="workspace" workdir={workdir} locale={locale} />}
      </div>
    </div>
  );
}

/**
 * Credential injector — turn an active Profile into the env vars and
 * additional argv that should be applied when spawning a specific agent.
 *
 * This is the single point where pikiclaw's Profile abstraction is
 * translated into per-agent quirks. Adding a new agent (e.g. OpenCode)
 * = adding one entry to AGENT_INJECT_TABLE.
 */

import { resolveCredential } from '../core/secrets/index.js';
import { getActiveProfile, getProvider } from './store.js';
import { peekProviderModelInfo, prefetchProviderModels } from './provider-models.js';
import type { ProviderConfig, ModelProfileConfig, ProviderKind } from './types.js';

export interface InjectedSpawnConfig {
  /** Env vars to merge into the child process environment. */
  env: Record<string, string>;
  /** Extra argv tokens to append to the agent CLI invocation (Hermes only). */
  argvAppend: string[];
  /**
   * Codex-only: TOML key=value pairs the driver should pass as `-c` overrides
   * to `codex app-server`. Used to configure `model_providers.<slug>.*` and
   * `model_provider` without touching the user's `~/.codex/config.toml`.
   */
  codexConfigOverrides?: string[];
  /** When set, override the agent's `model` opt (Claude/Codex/Gemini). */
  modelOverride?: string;
  /**
   * Real context window for the bound model — sourced from the provider's
   * cached `/models` listing (e.g. OpenRouter publishes `context_length`).
   * Drivers use this instead of the value the agent CLI reports for unknown
   * models (cc falls back to its Claude defaults; codex similar). `undefined`
   * means we don't know yet — fall back to whatever the CLI advertises.
   */
  contextWindow?: number;
  /**
   * Provider display name (e.g. "OpenRouter") — surfaced in IM footers and
   * the dashboard turn header so the user can tell at a glance that the turn
   * is being served by a BYOK provider rather than the agent CLI's native
   * auth path. Always set when an active Profile is bound.
   */
  providerName?: string;
  /** When set, files to write before spawn (path → content). */
  configFiles?: Record<string, string>;
  /** When set, override HOME / similar to redirect agent's data dir. */
  homeOverride?: string;
  /** Diagnostic message returned for logging / UI. */
  detail: string;
}

const EMPTY: InjectedSpawnConfig = { env: {}, argvAppend: [], detail: '' };

// ---------------------------------------------------------------------------
// Shared host-based provider identification
// ---------------------------------------------------------------------------

function providerHost(provider: ProviderConfig): string {
  try { return new URL(provider.baseURL).host.toLowerCase(); } catch { return ''; }
}

/**
 * Stable slug used to identify the provider in TOML-style configs (Codex
 * `model_providers.<slug>`, Hermes ACP `<slug>:<model>`). Host-aware so a
 * "DeepSeek personal" provider always resolves to `deepseek`, regardless of
 * its display name.
 */
function providerSlug(provider: ProviderConfig): string {
  if (provider.kind === 'anthropic') return 'anthropic';
  if (provider.kind === 'openai') return 'openai';
  if (provider.kind === 'google') return 'google';
  const host = providerHost(provider);
  if (host.includes('deepseek')) return 'deepseek';
  if (host.includes('moonshot') || host.includes('kimi')) return 'kimi';
  if (host.includes('minimax')) return 'minimax';
  if (host.includes('zhipuai') || host.includes('z.ai') || host.includes('bigmodel')) return 'zai';
  if (host.includes('x.ai')) return 'xai';
  if (host.includes('stepfun')) return 'stepfun';
  if (host.includes('dashscope') || host.includes('qwen')) return 'qwen';
  if (host.includes('volces') || host.includes('volcengine') || host.includes('doubao')) return 'doubao';
  if (host.includes('openrouter')) return 'openrouter';
  return 'openrouter';
}

/**
 * Canonical env-var name(s) carrying the credential for a provider. Returned
 * as a map so e.g. Google fans out to both `GOOGLE_API_KEY` and
 * `GEMINI_API_KEY` for SDKs that expect either.
 */
function providerCredentialEnv(provider: ProviderConfig, apiKey: string): Record<string, string> {
  if (provider.kind === 'anthropic') return { ANTHROPIC_API_KEY: apiKey };
  if (provider.kind === 'openai') return { OPENAI_API_KEY: apiKey };
  if (provider.kind === 'google') return { GOOGLE_API_KEY: apiKey, GEMINI_API_KEY: apiKey };
  const host = providerHost(provider);
  if (host.includes('openrouter')) return { OPENROUTER_API_KEY: apiKey };
  if (host.includes('deepseek')) return { DEEPSEEK_API_KEY: apiKey };
  if (host.includes('moonshot') || host.includes('kimi')) return { KIMI_API_KEY: apiKey, MOONSHOT_API_KEY: apiKey };
  if (host.includes('minimax')) return { MINIMAX_API_KEY: apiKey };
  if (host.includes('zhipuai') || host.includes('z.ai') || host.includes('bigmodel')) return { ZAI_API_KEY: apiKey, ZHIPU_API_KEY: apiKey };
  if (host.includes('x.ai')) return { XAI_API_KEY: apiKey };
  if (host.includes('stepfun')) return { STEPFUN_API_KEY: apiKey };
  if (host.includes('dashscope') || host.includes('qwen')) return { DASHSCOPE_API_KEY: apiKey, QWEN_API_KEY: apiKey };
  if (host.includes('volces') || host.includes('volcengine') || host.includes('doubao')) return { ARK_API_KEY: apiKey, DOUBAO_API_KEY: apiKey };
  return { OPENROUTER_API_KEY: apiKey };
}

/** Pick the single env var Codex's `model_providers.<slug>.env_key` should reference. */
function codexEnvKey(provider: ProviderConfig): string {
  const keys = Object.keys(providerCredentialEnv(provider, ''));
  return keys[0] || 'OPENROUTER_API_KEY';
}

/** Escape a string for embedding inside a TOML double-quoted string literal. */
function tomlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Anthropic-protocol baseURL: the SDK appends `/v1/messages` itself, so
 * `ANTHROPIC_BASE_URL` must NOT carry a trailing `/v1` (otherwise requests
 * land on `/v1/v1/messages` and 404). Providers (OpenRouter, DeepSeek, …)
 * publish their endpoints with `/v1` for OpenAI-protocol callers, so we
 * keep that as the canonical stored form and strip it here for Claude.
 */
function anthropicBaseURL(rawBaseURL: string): string {
  return rawBaseURL.replace(/\/+$/, '').replace(/\/v1$/, '');
}

// ---------------------------------------------------------------------------
// Per-agent translation rules
// ---------------------------------------------------------------------------

type AgentInjector = (
  provider: ProviderConfig,
  profile: ModelProfileConfig,
  apiKey: string,
) => InjectedSpawnConfig | Promise<InjectedSpawnConfig>;

/**
 * Claude Code respects `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` (or
 * `ANTHROPIC_AUTH_TOKEN`) as a BYOK route. The CLI itself is unchanged.
 * The model is overridden via opts.claudeModel (handled in stream.ts).
 *
 * For OpenAI-compatible providers (OpenRouter, DeepSeek native, …), the
 * baseURL must point to an Anthropic-protocol-compatible endpoint
 * (`/v1/messages`-shaped). OpenRouter's `/api/v1` and DeepSeek's
 * `/anthropic/v1` both qualify.
 */
const claudeInjector: AgentInjector = (provider, profile, apiKey) => {
  if (provider.kind !== 'anthropic' && provider.kind !== 'openai-compatible') {
    return {
      ...EMPTY,
      detail: `Claude BYOK requires Anthropic or OpenAI-compatible (Anthropic-API-shaped) provider; got ${provider.kind}.`,
    };
  }
  return {
    env: {
      ANTHROPIC_BASE_URL: anthropicBaseURL(provider.baseURL),
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_AUTH_TOKEN: apiKey,
    },
    argvAppend: [],
    modelOverride: profile.modelId,
    detail: `Claude BYOK → ${provider.name} / ${profile.modelId}`,
  };
};

/**
 * Codex CLI honours `model_providers.<slug>` definitions in `config.toml`.
 * Setting `OPENAI_BASE_URL` alone is not enough — Codex still routes through
 * the default `openai` provider's auth flow. The robust path is to declare a
 * one-shot `model_providers.<slug>` via `-c` overrides and bind it via
 * `model_provider="<slug>"`. The credential lives in the env var named by
 * `env_key`, picked host-aware (e.g. `OPENROUTER_API_KEY` for openrouter.ai).
 *
 * Note on `wire_api`: codex 0.130 dropped `"chat"` ("no longer supported"); we
 * omit the field entirely so codex picks its current default (`responses`),
 * which OpenRouter and other major OpenAI-compatible providers accept.
 */
const codexInjector: AgentInjector = (provider, profile, apiKey) => {
  if (provider.kind !== 'openai' && provider.kind !== 'openai-compatible') {
    return {
      ...EMPTY,
      detail: `Codex BYOK requires OpenAI-compatible provider; got ${provider.kind}.`,
    };
  }
  const slug = providerSlug(provider);
  const envKey = codexEnvKey(provider);
  const overrides = [
    `model_providers.${slug}.name="${tomlEscape(provider.name)}"`,
    `model_providers.${slug}.base_url="${tomlEscape(provider.baseURL)}"`,
    `model_providers.${slug}.env_key="${envKey}"`,
    `model_provider="${slug}"`,
  ];
  return {
    env: { [envKey]: apiKey },
    argvAppend: [],
    codexConfigOverrides: overrides,
    modelOverride: profile.modelId,
    detail: `Codex BYOK → ${provider.name} / ${profile.modelId} (provider=${slug})`,
  };
};

/** Gemini CLI accepts `GEMINI_API_KEY` but does not allow custom baseURL. */
const geminiInjector: AgentInjector = (provider, profile, apiKey) => {
  if (provider.kind !== 'google') {
    return {
      ...EMPTY,
      detail: `Gemini BYOK only supports Google AI Studio keys; got ${provider.kind}.`,
    };
  }
  return {
    env: { GEMINI_API_KEY: apiKey },
    argvAppend: [],
    modelOverride: profile.modelId,
    detail: `Gemini BYOK → ${provider.name} / ${profile.modelId}`,
  };
};

/**
 * Hermes injector. Two channels:
 *   1. Env vars carry the credential — `hermes acp` honours `OPENROUTER_API_KEY`,
 *      `ANTHROPIC_API_KEY`, etc. just like the top-level `hermes` CLI.
 *   2. The model is bound *per-session* by the driver via the ACP
 *      `session/set_model` request — `hermes acp` does NOT accept `-m` /
 *      `--provider` (only `--accept-hooks`); appending `-m` here used to make
 *      every BYOK-bound spawn die with `unrecognized arguments`.
 *
 * The model is handed to the driver via `modelOverride` (an ACP-style
 * `<provider>:<model>` string). The driver passes it to `session/set_model`
 * after `session/new` returns; if the user has no Profile bound, no
 * `set_model` call is made and Hermes uses its `~/.hermes/config.yaml`
 * default.
 */
const hermesInjector: AgentInjector = (provider, profile, apiKey) => {
  const env = providerCredentialEnv(provider, apiKey);
  const slug = providerSlug(provider);
  // Only strip a leading `<slug>/` or `<slug>:` if the user accidentally
  // stored a redundant provider prefix. Do NOT strip the *first segment* of
  // a slash-separated model id wholesale — for OpenRouter the canonical
  // model id is `vendor/model` (e.g. `deepseek/deepseek-v4-flash`), and
  // dropping the `vendor/` part yields a non-existent model.
  let bareModel = profile.modelId;
  if (bareModel.startsWith(`${slug}/`) || bareModel.startsWith(`${slug}:`)) {
    bareModel = bareModel.slice(slug.length + 1);
  }
  return {
    env,
    argvAppend: [],
    modelOverride: `${slug}:${bareModel}`,
    detail: `Hermes → ${provider.name} / ${profile.modelId}`,
  };
};

const AGENT_INJECT_TABLE: Record<string, AgentInjector | undefined> = {
  claude: claudeInjector,
  codex: codexInjector,
  gemini: geminiInjector,
  hermes: hermesInjector,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the active Profile for an agent and return the spawn config to
 * inject. Returns `null` when no Profile is bound (caller should fall back
 * to the agent's native auth / default model).
 */
export async function resolveAgentInjection(agentId: string): Promise<InjectedSpawnConfig | null> {
  const profile = getActiveProfile(agentId);
  if (!profile) return null;
  const provider = getProvider(profile.providerId);
  if (!provider) return null;
  const injector = AGENT_INJECT_TABLE[agentId];
  if (!injector) return null;

  let apiKey: string;
  try {
    apiKey = await resolveCredential(provider.credential);
  } catch (e: any) {
    throw new Error(`Failed to resolve credential for ${provider.name}: ${e?.message || e}`);
  }

  const result = await injector(provider, profile, apiKey);
  // Attach the provider display name so renders can surface "via <provider>"
  // — this is what tells the user the turn is going through a BYOK route.
  result.providerName = provider.name;
  // Attach the real context window from the provider's cached /models listing.
  // Sync peek — no network blocking; on miss we kick off a fetch so the *next*
  // session has it, and this turn falls back to the CLI's advertised value.
  const cached = peekProviderModelInfo(provider.id, profile.modelId);
  if (cached?.contextLength && cached.contextLength > 0) {
    result.contextWindow = cached.contextLength;
  } else {
    prefetchProviderModels(provider.id);
  }
  return result;
}

/** Returns `true` if the given agent is bound to a Profile. */
export function isAgentBoundToProfile(agentId: string): boolean {
  return getActiveProfile(agentId) !== null;
}

/**
 * CLI tool registry — curated command-line tools agents commonly need.
 *
 * Each entry declares how to install the binary on each OS, how to detect the
 * install / auth state, and (optionally) how to drive the sign-in flow.
 *
 * Two auth types are supported today:
 *   - oauth-web: the CLI has a first-party `<cli> auth login --web` flavor that
 *     prints a device code and opens the browser. We spawn it, stream output,
 *     and poll the status command to know when the user finished in the browser.
 *   - token: the user pastes an API key; we set it via the CLI's config command
 *     (or via env var for CLIs that only read from env).
 *
 * Keep this list opinionated and small — better to nail the common case than to
 * ship a wall of half-working entries.
 */

import type { CredentialField } from '../mcp/registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CliCategory =
  | 'dev'        // 研发工具:source control / containers / package managers
  | 'cloud'      // 云与部署:IaaS / PaaS / serverless platforms
  | 'data'       // 数据与后端:databases, analytics, BaaS
  | 'commerce'   // 商业支付:payments, e-commerce
  | 'social'     // 社交通讯:chat / messaging / social network CLIs
  | 'content';   // 内容创作:note-taking, publishing, content platforms

export type CliAuthType = 'oauth-web' | 'token' | 'none';

export interface CliInstallCommand {
  /** Shell one-liner shown in the UI (with syntax highlighting). */
  cmd: string;
  /** Short label shown above the command (e.g. "Homebrew"). */
  label?: string;
}

export interface CliInstallSpec {
  darwin?: CliInstallCommand[];
  linux?: CliInstallCommand[];
  win?: CliInstallCommand[];
  docs?: string;
}

export interface CliAuthSpec {
  type: CliAuthType;
  /**
   * Argv for the status check. Must exit 0 when authed, non-zero otherwise.
   * Kept as argv (not string) to avoid shell quoting surprises.
   */
  statusArgv?: string[];
  /** Argv for the interactive login — used for oauth-web. */
  loginArgv?: string[];
  /** Argv for logout / credential wipe. */
  logoutArgv?: string[];
  /** For token auth: fields to collect from the user. */
  tokenFields?: CredentialField[];
  /**
   * For token auth: a function-ish template that produces the argv to apply
   * the token(s). `${FIELD}` placeholders are replaced from the user's input.
   * If the CLI reads from an env var instead, leave this empty and use envKey.
   */
  applyTokenArgv?: string[];
  /**
   * For token auth via env var (e.g. STRIPE_API_KEY). We don't persist env
   * vars — we write to the config file the CLI expects, if provided.
   */
  envKey?: string;
  /**
   * Short hint the UI renders above the login button, e.g. "opens a browser".
   */
  loginHint?: string;
  loginHintZh?: string;
}

export interface RecommendedCli {
  id: string;
  binary: string;
  name: string;
  description: string;
  descriptionZh: string;
  category: CliCategory;
  iconSlug?: string;
  iconUrl?: string;
  homepage?: string;
  install: CliInstallSpec;
  auth: CliAuthSpec;
  /** Argv to read the version. First non-empty stdout line wins. */
  versionArgv?: string[];
  /**
   * Where the recommendation applies:
   *  - 'global'    — user installs once, reused across projects
   *  - 'workspace' — project-specific (rare for CLIs)
   *  - 'both'      — applies either place
   *
   * Most CLIs are global — kept here to stay symmetric with MCP/Skills.
   */
  recommendedScope?: 'global' | 'workspace' | 'both';
}

// ---------------------------------------------------------------------------
// Recommended CLI tools — data lives in src/catalog/
//
// This module owns the *types* and helper functions. Edit
// `src/catalog/cli-tools.ts` to add or hide a CLI tool entry.
// ---------------------------------------------------------------------------

import { CLI_TOOLS } from '../../catalog/index.js';

const RECOMMENDED_CLIS: RecommendedCli[] = CLI_TOOLS;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getRecommendedClis(): RecommendedCli[] {
  return RECOMMENDED_CLIS;
}

export function getRecommendedCli(id: string): RecommendedCli | undefined {
  return RECOMMENDED_CLIS.find(c => c.id === id);
}

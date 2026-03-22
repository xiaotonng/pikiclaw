/**
 * constants.ts — Centralized timeout, retry, and numeric constants.
 *
 * Grouped by domain / module so each subsystem can import only the
 * bucket it needs.
 */

import path from 'node:path';

// ---------------------------------------------------------------------------
// MCP bridge
// ---------------------------------------------------------------------------

/** Timeouts for the per-stream MCP callback server and tool operations. */
export const MCP_TIMEOUTS = {
  /** Max time to wait for the sendFile callback to complete. */
  sendFile: 60_000,
  /** Max time to receive the HTTP request body on the callback server. */
  requestBody: 10_000,
  /** Server-level: max time for an entire request lifecycle. */
  serverRequest: 90_000,
  /** Server-level: max time to receive request headers. */
  serverHeaders: 10_000,
  /** Timeout for `codex mcp add` registration commands. */
  codexMcpAdd: 10_000,
  /** Timeout for `codex mcp remove` cleanup commands. */
  codexMcpRemove: 5_000,
};

/** Maximum artifact file size the MCP bridge will accept (20 MB). */
export const MCP_ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** Timeouts used by the dashboard HTTP server and its status endpoints. */
export const DASHBOARD_TIMEOUTS = {
  /** Timeout for agent model discovery (Codex cold-start can be slow). */
  agentStatusModels: 4_000,
  /** Timeout for agent usage data fetch. */
  agentStatusUsage: 1_500,
  /** Timeout for channel credential validation requests. */
  channelStatusValidation: 3_000,
  /** How long validated channel states are cached before re-checking. */
  channelStatusCacheTtl: 20_000,
  /** Timeout for agent npm install via the dashboard. */
  agentInstall: 10 * 60_000,
  /** Default timeout for dashboard-spawned shell commands. */
  runCommand: 30_000,
  /** Timeout for Appium reachability checks. */
  appiumReachable: 3_000,
  /** Delay between Appium server startup polls. */
  appiumStartPoll: 1_000,
};

// ---------------------------------------------------------------------------
// Browser automation
// ---------------------------------------------------------------------------

/**
 * Stable relative path for the managed Chrome profile under the home directory.
 * Keep this outside config-specific directories so `npm run dev` and the main
 * runtime share the same browser login state.
 */
export const MANAGED_BROWSER_PROFILE_SUBPATH = path.join('.pikiclaw', 'browser', 'chrome-profile');

/** Base Playwright MCP args for the managed browser integration. */
export const PLAYWRIGHT_MCP_PACKAGE_NAME = '@playwright/mcp';
export const PLAYWRIGHT_MCP_PACKAGE_VERSION = '0.0.68';
export const PLAYWRIGHT_MCP_PACKAGE_SPEC = `${PLAYWRIGHT_MCP_PACKAGE_NAME}@${PLAYWRIGHT_MCP_PACKAGE_VERSION}`;
export const PLAYWRIGHT_MCP_BROWSER_ARGS = ['--browser', 'chrome'] as const;

/** Dashboard session pagination limits. */
export const DASHBOARD_PAGINATION = {
  defaultPageSize: 6,
  maxPageSize: 30,
};

/** Timeouts for macOS permission checks and JXA scripts (dashboard). */
export const DASHBOARD_PERMISSION_TIMEOUTS = {
  /** Default timeout for osascript / JXA calls. */
  jxaDefault: 5_000,
  /** Timeout for accessibility keystroke probe. */
  accessibilityProbe: 4_000,
  /** Timeout for CGPreflight accessibility check. */
  accessibilityPreflight: 4_000,
  /** Timeout for CGRequest accessibility request. */
  accessibilityRequest: 6_000,
  /** Timeout for screencapture permission probe. */
  screenRecordingProbe: 5_000,
  /** Timeout for CGPreflight screen capture check. */
  screenRecordingPreflight: 4_000,
  /** Timeout for CGRequest screen capture request. */
  screenRecordingRequest: 6_000,
  /** Timeout for `open` command to launch System Preferences. */
  openSystemPreferences: 3_000,
  /** Timeout for parent process tree detection. */
  detectTerminal: 3_000,
};

/** Timeouts for Appium installation steps (dashboard). */
export const DASHBOARD_APPIUM_TIMEOUTS = {
  /** Timeout for `which appium`. */
  whichAppium: 5_000,
  /** Timeout for `appium driver list`. */
  driverList: 15_000,
  /** Timeout for `npm install appium`. */
  npmInstallAppium: 300_000,
  /** Timeout for `appium driver install mac2`. */
  driverInstallMac2: 120_000,
};

// ---------------------------------------------------------------------------
// CLI / Daemon
// ---------------------------------------------------------------------------

/** Daemon (watchdog) restart timing constants. */
export const DAEMON_TIMEOUTS = {
  /** Initial delay before restarting a crashed child. */
  restartDelay: 3_000,
  /** Maximum back-off delay for repeated rapid crashes. */
  maxRestartDelay: 60_000,
  /** If the child runs shorter than this, treat it as a rapid crash. */
  rapidCrashWindow: 10_000,
  /** Polling interval while waiting for dashboard config to become ready. */
  configPollInterval: 1_000,
};

// ---------------------------------------------------------------------------
// Bot orchestration / shutdown
// ---------------------------------------------------------------------------

/** Time to wait before force-exiting during bot shutdown. */
export const BOT_SHUTDOWN_FORCE_EXIT_MS = 3_000;

// ---------------------------------------------------------------------------
// Bot runtime
// ---------------------------------------------------------------------------

/** Bot-level timing constants. */
export const BOT_TIMEOUTS = {
  /** Default run timeout for agent streams (seconds). */
  defaultRunTimeoutS: 7200,
  /** Interval for macOS user-activity caffeinate pulses. */
  macosUserActivityPulseInterval: 20_000,
  /** Timeout (seconds) for the caffeinate assertion per pulse. */
  macosUserActivityPulseTimeoutS: 30,
};

// ---------------------------------------------------------------------------
// Live preview (stream feedback)
// ---------------------------------------------------------------------------

/** Timing constants for the channel-agnostic live preview controller. */
export const STREAM_PREVIEW_TIMEOUTS = {
  /** Interval between heartbeat edits that refresh the elapsed timer. */
  heartbeat: 5_000,
  /** Interval between typing indicator pulses. */
  typing: 4_000,
  /** After this idle time, a "stalled" notice is shown. */
  stalledNotice: 15_000,
};

// ---------------------------------------------------------------------------
// Channels — Telegram
// ---------------------------------------------------------------------------

/** Telegram channel transport constants. */
export const TELEGRAM_LIMITS = {
  /** Maximum text length per Telegram message. */
  maxMessageLength: 4096,
  /** Maximum file size for send/receive (20 MB). */
  fileMaxBytes: 20 * 1024 * 1024,
  /** Maximum back-off delay for polling/connect retries. */
  maxRetryDelay: 60_000,
};

// ---------------------------------------------------------------------------
// Channels — Feishu
// ---------------------------------------------------------------------------

/** Feishu channel transport constants. */
export const FEISHU_LIMITS = {
  /** Card markdown budget (card JSON limit ~30 KB). */
  cardMax: 28_000,
  /** Maximum file size for send/receive (20 MB). */
  fileMaxBytes: 20 * 1024 * 1024,
  /** Maximum back-off delay for WebSocket reconnection retries. */
  wsStartRetryMaxDelay: 60_000,
  /** Initial retry delay for Feishu WebSocket connection. */
  wsStartRetryInitialDelay: 3_000,
};

/** Feishu bot rendering limit for card payloads. */
export const FEISHU_BOT_CARD_MAX = 25_000;

// ---------------------------------------------------------------------------
// Channels — Weixin
// ---------------------------------------------------------------------------

/** Weixin channel transport constants. */
export const WEIXIN_LIMITS = {
  /** Conservative text split budget for plain-text replies. */
  maxMessageLength: 1200,
  /** Long-poll timeout for getupdates. */
  longPollTimeout: 35_000,
  /** Maximum back-off delay for polling retries. */
  maxRetryDelay: 60_000,
};

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/** Timeouts for channel credential validation flows. */
export const VALIDATION_TIMEOUTS = {
  /** Default timeout for Feishu credential validation. */
  feishuDefault: 15_000,
  /** Timeout for fetching Feishu bot info after credential validation. */
  feishuBotInfo: 5_000,
  /** Timeout for Telegram token validation (setup wizard). */
  telegramToken: 8_000,
  /** Default timeout for Weixin credential validation. */
  weixinDefault: 8_000,
  /** Long-poll timeout for dashboard QR login wait calls. */
  weixinQrPoll: 35_000,
};

// ---------------------------------------------------------------------------
// Agent auto-update
// ---------------------------------------------------------------------------

/** Timeouts for the background agent auto-update system. */
export const AGENT_UPDATE_TIMEOUTS = {
  /** After this duration a stale lock file is removed. */
  lockStale: 60 * 60_000,
  /** Maximum time for an agent update command to run. */
  commandTimeout: 15 * 60_000,
  /** Timeout for `npm prefix -g`. */
  npmPrefix: 10_000,
  /** Timeout for `npm view <pkg> version`. */
  npmView: 20_000,
};

// ---------------------------------------------------------------------------
// Code agent (shared layer)
// ---------------------------------------------------------------------------

/** Caching TTLs for agent detection and version lookups. */
export const AGENT_DETECT_TIMEOUTS = {
  /** How long a binary-detection result is cached. */
  detectTtl: 1_000,
  /** How long a version string is cached. */
  versionTtl: 5 * 60_000,
  /** Timeout for the `--version` command itself. */
  versionCommand: 900,
};

/** Grace period added to the user-configured timeout before hard-killing the agent. */
export const AGENT_STREAM_HARD_KILL_GRACE_MS = 10_000;

/** Codex-specific grace period added to the user-configured timeout. */
export const CODEX_STREAM_HARD_KILL_GRACE_MS = 5_000;

/**
 * If a session file was modified more recently than this threshold,
 * consider the session "running". Shared across Claude, Codex, and Gemini drivers.
 */
export const SESSION_RUNNING_THRESHOLD_MS = 10_000;

// ---------------------------------------------------------------------------
// Driver — Codex
// ---------------------------------------------------------------------------

/** Timeout for the Codex app-server to become ready after spawn. */
export const CODEX_APPSERVER_SPAWN_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Driver — Gemini
// ---------------------------------------------------------------------------

/** Timeouts for Gemini usage / quota queries. */
export const GEMINI_USAGE_TIMEOUTS = {
  /** Max time for the curl quota request. */
  request: 5_000,
  /** Extra buffer added to the curl timeout for the execSync wrapper. */
  execSyncBuffer: 3_000,
};

// ---------------------------------------------------------------------------
// User config sync
// ---------------------------------------------------------------------------

/** Default interval for the user config file sync poll. */
export const USER_CONFIG_SYNC_DEFAULT_INTERVAL_MS = 1_000;

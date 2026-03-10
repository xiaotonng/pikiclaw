import crypto from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

export type Agent = 'codex' | 'claude';

export interface CodexCumulativeUsage {
  input: number;
  output: number;
  cached: number;
}

export interface StreamPreviewMeta {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  contextPercent: number | null;
}

export interface StreamPreviewPlanStep {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
}

export interface StreamPreviewPlan {
  explanation: string | null;
  steps: StreamPreviewPlanStep[];
}

export interface StreamOpts {
  agent: Agent;
  prompt: string;
  workdir: string;
  timeout: number;
  localSessionId?: string | null;
  sessionId: string | null;
  model: string | null;
  thinkingEffort: string;
  onText: (
    text: string,
    thinking: string,
    activity?: string,
    meta?: StreamPreviewMeta,
    plan?: StreamPreviewPlan | null,
  ) => void;
  /** Local file paths to attach (images, documents, etc.) */
  attachments?: string[];
  // codex
  codexModel?: string;
  codexFullAccess?: boolean;
  codexDeveloperInstructions?: string;
  codexExtraArgs?: string[];
  /** Previous cumulative token totals for this Codex session (used when a resumed turn only reports totals). */
  codexPrevCumulative?: CodexCumulativeUsage;
  // claude
  claudeModel?: string;
  claudePermissionMode?: string;
  claudeAppendSystemPrompt?: string;
  claudeExtraArgs?: string[];
  /** Override stdin payload (used for stream-json multimodal input) */
  _stdinOverride?: string;
}

export interface StreamResult {
  ok: boolean;
  message: string;
  thinking: string | null;
  localSessionId: string | null;
  sessionId: string | null;
  workspacePath: string | null;
  model: string | null;
  thinkingEffort: string;
  elapsedS: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  /** Context window size as reported by the CLI (Claude: result.modelUsage, Codex: models_cache.json) */
  contextWindow: number | null;
  /** Tokens used in context (input + cached + cacheCreation + output) */
  contextUsedTokens: number | null;
  /** Percentage of context window used, null if contextWindow is unknown */
  contextPercent: number | null;
  /** Raw cumulative token totals reported by Codex when available (null for Claude). */
  codexCumulative: CodexCumulativeUsage | null;
  error: string | null;
  stopReason: string | null;
  incomplete: boolean;
  activity: string | null;
  artifacts: BotArtifact[];
}

export type ArtifactKind = 'photo' | 'document';

export interface BotArtifact {
  filePath: string;
  filename: string;
  kind: ArtifactKind;
  caption?: string;
}

interface LocalSessionRecord {
  localSessionId: string;
  agent: Agent;
  workdir: string;
  engineSessionId: string | null;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  model: string | null;
  stagedFiles: string[];
}

interface SessionIndexData {
  version: number;
  sessions: LocalSessionRecord[];
}

interface EnsureSessionWorkspaceOpts {
  agent: Agent;
  workdir: string;
  localSessionId?: string | null;
  sessionId?: string | null;
  title?: string | null;
}

interface SessionWorkspaceInfo {
  localSessionId: string;
  workspacePath: string;
  manifestPath: string;
  record: LocalSessionRecord;
}

export interface StageSessionFilesOpts {
  agent: Agent;
  workdir: string;
  files: string[];
  localSessionId?: string | null;
  sessionId?: string | null;
  title?: string | null;
}

export interface StageSessionFilesResult {
  localSessionId: string;
  workspacePath: string;
  importedFiles: string[];
}

const CODECLAW_DIR = '.codeclaw';
const CODECLAW_SESSIONS_DIR = path.join(CODECLAW_DIR, 'sessions');
const CODECLAW_SESSION_INDEX = path.join(CODECLAW_SESSIONS_DIR, 'index.json');
const CODECLAW_LEGACY_WORKSPACES_DIR = path.join(CODECLAW_DIR, 'workspaces');
const SESSION_WORKSPACE_DIR = 'workspace';
const SESSION_META_FILE = 'session.json';
const SESSION_RETURN_MANIFEST = 'return.json';
const ARTIFACT_MAX_FILES = 8;
const ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
const ARTIFACT_PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const Q = (a: string) => /[^a-zA-Z0-9_./:=@-]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a;

function agentLog(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`[agent ${ts}] ${msg}\n`);
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const item = String(value || '').trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    deduped.push(item);
  }
  return deduped;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function removeFileIfExists(filePath: string) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {}
}

function sessionIndexPath(workdir: string): string {
  return path.join(workdir, CODECLAW_SESSION_INDEX);
}

function sessionDirPath(workdir: string, agent: Agent, localSessionId: string): string {
  return path.join(workdir, CODECLAW_SESSIONS_DIR, agent, localSessionId);
}

function legacySessionWorkspacePath(workdir: string, agent: Agent, localSessionId: string): string {
  return path.join(workdir, CODECLAW_LEGACY_WORKSPACES_DIR, agent, localSessionId);
}

function sessionWorkspacePath(workdir: string, agent: Agent, localSessionId: string): string {
  return path.join(sessionDirPath(workdir, agent, localSessionId), SESSION_WORKSPACE_DIR);
}

function sessionRootFromWorkspacePath(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  return path.basename(resolved) === SESSION_WORKSPACE_DIR ? path.dirname(resolved) : resolved;
}

function sessionManifestPath(workspacePath: string): string {
  return path.join(sessionRootFromWorkspacePath(workspacePath), SESSION_RETURN_MANIFEST);
}

function sessionMetaPath(workspacePath: string): string {
  return path.join(sessionRootFromWorkspacePath(workspacePath), SESSION_META_FILE);
}

function legacySessionMetaPath(workspacePath: string): string {
  return path.join(workspacePath, CODECLAW_DIR, SESSION_META_FILE);
}

function legacySessionManifestPath(workspacePath: string): string {
  return path.join(workspacePath, CODECLAW_DIR, SESSION_RETURN_MANIFEST);
}

function normalizeSessionRecord(raw: any, workdir: string): LocalSessionRecord | null {
  const localSessionId = typeof raw?.localSessionId === 'string' ? raw.localSessionId.trim() : '';
  const agent = raw?.agent === 'codex' ? 'codex' : raw?.agent === 'claude' ? 'claude' : null;
  if (!localSessionId || !agent) return null;

  const workspacePath = typeof raw?.workspacePath === 'string' && raw.workspacePath.trim()
    ? path.resolve(raw.workspacePath)
    : sessionWorkspacePath(workdir, agent, localSessionId);
  return {
    localSessionId,
    agent,
    workdir,
    engineSessionId: typeof raw?.engineSessionId === 'string' && raw.engineSessionId.trim() ? raw.engineSessionId.trim() : null,
    workspacePath,
    createdAt: typeof raw?.createdAt === 'string' && raw.createdAt.trim() ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw?.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt : new Date().toISOString(),
    title: typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim() : null,
    model: typeof raw?.model === 'string' && raw.model.trim() ? raw.model.trim() : null,
    stagedFiles: Array.isArray(raw?.stagedFiles) ? dedupeStrings(raw.stagedFiles.filter((v: unknown) => typeof v === 'string')) : [],
  };
}

function loadSessionIndex(workdir: string): SessionIndexData {
  const parsed = readJsonFile<any>(sessionIndexPath(workdir), { version: 1, sessions: [] });
  const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  return {
    version: 1,
    sessions: sessions
      .map((entry: any) => normalizeSessionRecord(entry, workdir))
      .filter((entry: LocalSessionRecord | null): entry is LocalSessionRecord => !!entry),
  };
}

function writeSessionMeta(record: LocalSessionRecord) {
  writeJsonFile(sessionMetaPath(record.workspacePath), {
    localSessionId: record.localSessionId,
    agent: record.agent,
    workdir: record.workdir,
    engineSessionId: record.engineSessionId,
    workspacePath: record.workspacePath,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    title: record.title,
    model: record.model,
    stagedFiles: record.stagedFiles,
    returnManifestPath: sessionManifestPath(record.workspacePath),
  });
}

function copyPath(sourcePath: string, targetPath: string) {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
    return;
  }
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function migrateSessionLayout(workdir: string, record: LocalSessionRecord): LocalSessionRecord {
  const targetSessionDir = sessionDirPath(workdir, record.agent, record.localSessionId);
  const targetWorkspacePath = sessionWorkspacePath(workdir, record.agent, record.localSessionId);
  const targetManifestPath = sessionManifestPath(targetWorkspacePath);
  const currentWorkspacePath = path.resolve(record.workspacePath || targetWorkspacePath);
  const legacyWorkspacePath = path.resolve(legacySessionWorkspacePath(workdir, record.agent, record.localSessionId));

  ensureDir(targetSessionDir);
  ensureDir(targetWorkspacePath);

  for (const sourceWorkspacePath of dedupeStrings([currentWorkspacePath, legacyWorkspacePath])) {
    if (sourceWorkspacePath === targetWorkspacePath || !fs.existsSync(sourceWorkspacePath)) continue;
    if (!fs.statSync(sourceWorkspacePath).isDirectory()) continue;

    for (const entry of fs.readdirSync(sourceWorkspacePath)) {
      if (entry === CODECLAW_DIR) continue;
      copyPath(
        path.join(sourceWorkspacePath, entry),
        path.join(targetWorkspacePath, entry),
      );
    }

    const sourceManifestPath = legacySessionManifestPath(sourceWorkspacePath);
    if (fs.existsSync(sourceManifestPath) && !fs.existsSync(targetManifestPath)) {
      copyPath(sourceManifestPath, targetManifestPath);
    }

    if (sourceWorkspacePath === legacyWorkspacePath) {
      fs.rmSync(sourceWorkspacePath, { recursive: true, force: true });
    }
  }

  const currentManifestPath = legacySessionManifestPath(currentWorkspacePath);
  if (fs.existsSync(currentManifestPath) && !fs.existsSync(targetManifestPath)) {
    copyPath(currentManifestPath, targetManifestPath);
  }

  record.workspacePath = path.resolve(targetWorkspacePath);
  return record;
}

function saveSessionRecord(workdir: string, record: LocalSessionRecord): LocalSessionRecord {
  record = migrateSessionLayout(workdir, record);
  ensureDir(sessionDirPath(workdir, record.agent, record.localSessionId));
  ensureDir(record.workspacePath);
  const index = loadSessionIndex(workdir);
  const now = new Date().toISOString();
  record.updatedAt = now;
  const pos = index.sessions.findIndex(entry => entry.localSessionId === record.localSessionId);
  if (pos >= 0) index.sessions[pos] = record;
  else index.sessions.unshift(record);
  index.sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  writeJsonFile(sessionIndexPath(workdir), { version: 1, sessions: index.sessions });
  writeSessionMeta(record);
  return record;
}

function nextLocalSessionId(): string {
  return `sess_${crypto.randomBytes(6).toString('hex')}`;
}

function summarizePromptTitle(prompt: string | null | undefined): string | null {
  const text = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length <= 120 ? text : `${text.slice(0, 117).trimEnd()}...`;
}

function safeWorkspaceFilename(filename: string): string {
  const base = path.basename(filename || 'file');
  const sanitized = base
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return sanitized || `file-${Date.now()}`;
}

function uniqueWorkspaceFilename(workspacePath: string, desiredName: string): string {
  const ext = path.extname(desiredName);
  const stem = ext ? desiredName.slice(0, -ext.length) : desiredName;
  let candidate = desiredName;
  let index = 2;
  while (fs.existsSync(path.join(workspacePath, candidate))) {
    candidate = `${stem}-${index}${ext}`;
    index++;
  }
  return candidate;
}

function importFilesIntoWorkspace(workspacePath: string, files: string[]): string[] {
  const imported: string[] = [];
  const realWorkspace = fs.realpathSync(workspacePath);
  for (const filePath of files) {
    const sourcePath = path.resolve(filePath);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) continue;

    let relPath = path.relative(realWorkspace, sourcePath);
    if (relPath && !relPath.startsWith('..') && !path.isAbsolute(relPath)) {
      imported.push(relPath.split(path.sep).join(path.posix.sep));
      continue;
    }

    const targetName = uniqueWorkspaceFilename(workspacePath, safeWorkspaceFilename(path.basename(sourcePath)));
    const targetPath = path.join(workspacePath, targetName);
    fs.copyFileSync(sourcePath, targetPath);
    imported.push(targetName);
  }
  return dedupeStrings(imported);
}

function ensureSessionWorkspace(opts: EnsureSessionWorkspaceOpts): SessionWorkspaceInfo {
  const workdir = path.resolve(opts.workdir);
  const index = loadSessionIndex(workdir);
  let record = index.sessions.find(entry => entry.agent === opts.agent && opts.localSessionId && entry.localSessionId === opts.localSessionId)
    || index.sessions.find(entry => entry.agent === opts.agent && opts.sessionId && entry.engineSessionId === opts.sessionId)
    || null;

  if (!record) {
    const localSessionId = opts.localSessionId?.trim() || nextLocalSessionId();
    record = {
      localSessionId,
      agent: opts.agent,
      workdir,
      engineSessionId: opts.sessionId?.trim() || null,
      workspacePath: sessionWorkspacePath(workdir, opts.agent, localSessionId),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: summarizePromptTitle(opts.title) || null,
      model: null,
      stagedFiles: [],
    };
  }

  if (!record.engineSessionId && opts.sessionId?.trim()) record.engineSessionId = opts.sessionId.trim();
  if (!record.title && opts.title) record.title = summarizePromptTitle(opts.title);
  record.workspacePath = path.resolve(record.workspacePath);
  saveSessionRecord(workdir, record);
  return {
    localSessionId: record.localSessionId,
    workspacePath: record.workspacePath,
    manifestPath: sessionManifestPath(record.workspacePath),
    record,
  };
}

function appendSystemPrompt(base: string | undefined, extra: string): string {
  const lhs = String(base || '').trim();
  const rhs = String(extra || '').trim();
  if (!lhs) return rhs;
  if (!rhs) return lhs;
  return `${lhs}\n\n${rhs}`;
}

function isPhotoFilename(filename: string): boolean {
  return ARTIFACT_PHOTO_EXTS.has(path.extname(filename).toLowerCase());
}

export function collectArtifacts(dirPath: string, manifestPath = sessionManifestPath(dirPath), log?: (msg: string) => void): BotArtifact[] {
  const _log = log || (() => {});
  if (!fs.existsSync(manifestPath)) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    _log(`artifact manifest parse error: ${e}`);
    return [];
  }

  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.files) ? parsed.files : [];
  if (!entries.length) return [];

  const realDir = fs.realpathSync(dirPath);
  const artifacts: BotArtifact[] = [];

  for (const entry of entries.slice(0, ARTIFACT_MAX_FILES)) {
    const rawPath = typeof entry?.path === 'string' ? entry.path
      : typeof entry?.name === 'string' ? entry.name
      : '';
    const relPath = rawPath.trim();
    if (!relPath || path.isAbsolute(relPath)) {
      _log(`artifact skipped: invalid path "${rawPath}"`);
      continue;
    }
    if (relPath === SESSION_RETURN_MANIFEST || relPath === SESSION_META_FILE || relPath.startsWith(`${CODECLAW_DIR}/`)) {
      _log(`artifact skipped: reserved path "${relPath}"`);
      continue;
    }

    const resolved = path.resolve(dirPath, relPath);
    const realResolved = path.resolve(resolved);
    const relative = path.relative(realDir, realResolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      _log(`artifact skipped: outside workspace "${relPath}"`);
      continue;
    }
    if (!fs.existsSync(resolved)) {
      _log(`artifact skipped: missing file "${relPath}"`);
      continue;
    }

    let realFile: string;
    try {
      realFile = fs.realpathSync(resolved);
    } catch (e) {
      _log(`artifact skipped: realpath failed "${relPath}" (${e})`);
      continue;
    }

    const realRelative = path.relative(realDir, realFile);
    if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      _log(`artifact skipped: symlink outside workspace "${relPath}"`);
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(realFile);
    } catch {
      _log(`artifact skipped: missing file "${relPath}"`);
      continue;
    }
    if (!stat.isFile()) {
      _log(`artifact skipped: not a file "${relPath}"`);
      continue;
    }
    if (stat.size > ARTIFACT_MAX_BYTES) {
      _log(`artifact skipped: too large "${relPath}" (${stat.size} bytes)`);
      continue;
    }

    const filename = path.basename(realFile);
    const requestedKind = typeof entry?.kind === 'string' ? entry.kind.toLowerCase()
      : typeof entry?.type === 'string' ? entry.type.toLowerCase()
      : '';
    let kind: ArtifactKind = requestedKind === 'document' ? 'document'
      : requestedKind === 'photo' ? 'photo'
      : isPhotoFilename(filename) ? 'photo' : 'document';
    if (kind === 'photo' && !isPhotoFilename(filename)) kind = 'document';
    const caption = typeof entry?.caption === 'string' ? entry.caption.trim().slice(0, 1024) || undefined : undefined;

    artifacts.push({ filePath: realFile, filename, kind, caption });
  }

  return artifacts;
}

export function buildArtifactSystemPrompt(workspacePath: string, manifestPath = sessionManifestPath(workspacePath)): string {
  return [
    '[Session Workspace]',
    'This session has a dedicated workspace directory:',
    workspacePath,
    'Put user-uploaded files here and write any generated user-facing files here unless the task clearly requires another location.',
    '',
    '[Artifact Return]',
    'If you want codeclaw to return files to the user, write this JSON manifest:',
    manifestPath,
    '',
    'Manifest format:',
    '{"files":[{"path":"report.md","kind":"document","caption":"optional caption"}]}',
    'Rules:',
    '- Use relative paths rooted at the session workspace.',
    '- Use "photo" for png/jpg/jpeg/webp images. Use "document" for everything else.',
    '- Do not point outside the workspace.',
    '- Omit the manifest entirely if there is nothing to return.',
  ].join('\n');
}

export function buildArtifactPrompt(prompt: string, workspacePath: string, manifestPath = sessionManifestPath(workspacePath)): string {
  const base = prompt.trim() || 'Please help with this request.';
  return `${base}\n\n${buildArtifactSystemPrompt(workspacePath, manifestPath)}`;
}

export function stageSessionFiles(opts: StageSessionFilesOpts): StageSessionFilesResult {
  const session = ensureSessionWorkspace({
    agent: opts.agent,
    workdir: opts.workdir,
    localSessionId: opts.localSessionId,
    sessionId: opts.sessionId,
    title: opts.title,
  });
  const importedFiles = importFilesIntoWorkspace(session.workspacePath, opts.files);
  if (importedFiles.length) {
    session.record.stagedFiles = dedupeStrings([...session.record.stagedFiles, ...importedFiles]);
    if (!session.record.title) session.record.title = importedFiles[0];
    saveSessionRecord(opts.workdir, session.record);
  }
  return {
    localSessionId: session.localSessionId,
    workspacePath: session.workspacePath,
    importedFiles,
  };
}

function computeContext(s: { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; cacheCreationInputTokens: number | null; contextWindow: number | null }) {
  // Context used = all input tokens (new + cached + cache-creation). Output tokens are separate.
  const total = (s.inputTokens ?? 0) + (s.cachedInputTokens ?? 0) + (s.cacheCreationInputTokens ?? 0);
  const used = total > 0 ? total : null;
  const pct = used != null && s.contextWindow
    ? Math.min(99.9, Math.round(used / s.contextWindow * 1000) / 10)
    : null;
  return { contextUsedTokens: used, contextPercent: pct };
}

function numberOrNull(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function buildCodexCumulativeUsage(raw: any): CodexCumulativeUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = numberOrNull(raw.inputTokens, raw.input_tokens);
  const output = numberOrNull(raw.outputTokens, raw.output_tokens);
  const cached = numberOrNull(raw.cachedInputTokens, raw.cached_input_tokens);
  if (input == null && output == null && cached == null) return null;
  return { input: input ?? 0, output: output ?? 0, cached: cached ?? 0 };
}

function buildStreamPreviewMeta(s: {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  contextWindow: number | null;
}): StreamPreviewMeta {
  return {
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cachedInputTokens: s.cachedInputTokens,
    contextPercent: computeContext(s).contextPercent,
  };
}

function applyCodexTokenUsage(
  s: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    cacheCreationInputTokens: number | null;
    contextWindow: number | null;
    codexCumulative: CodexCumulativeUsage | null;
  },
  rawUsage: any,
  prev?: CodexCumulativeUsage,
) {
  if (!rawUsage || typeof rawUsage !== 'object') return;

  const last = rawUsage.last;
  const lastInput = numberOrNull(last?.inputTokens, last?.input_tokens);
  const lastOutput = numberOrNull(last?.outputTokens, last?.output_tokens);
  const lastCached = numberOrNull(last?.cachedInputTokens, last?.cached_input_tokens);
  const lastCacheCreation = numberOrNull(last?.cacheCreationInputTokens, last?.cache_creation_input_tokens);

  if (lastInput != null) s.inputTokens = lastInput;
  if (lastOutput != null) s.outputTokens = lastOutput;
  if (lastCached != null) s.cachedInputTokens = lastCached;
  if (lastCacheCreation != null) s.cacheCreationInputTokens = lastCacheCreation;

  const total = buildCodexCumulativeUsage(rawUsage.total ?? rawUsage);
  if (total) {
    s.codexCumulative = total;
    if (lastInput == null) s.inputTokens = prev ? Math.max(0, total.input - prev.input) : total.input;
    if (lastOutput == null) s.outputTokens = prev ? Math.max(0, total.output - prev.output) : total.output;
    if (lastCached == null) s.cachedInputTokens = prev ? Math.max(0, total.cached - prev.cached) : total.cached;
  }

  const contextWindow = numberOrNull(rawUsage.modelContextWindow, rawUsage.model_context_window);
  if (contextWindow != null && contextWindow > 0) s.contextWindow = contextWindow;
}

async function run(cmd: string[], opts: StreamOpts, parseLine: (ev: any, s: any) => void): Promise<StreamResult> {
  const start = Date.now();
  const deadline = start + opts.timeout * 1000;
  let stderr = '';
  let lineCount = 0;
  let timedOut = false;
  const s = {
    sessionId: opts.sessionId, text: '', thinking: '', msgs: [] as string[], thinkParts: [] as string[],
    model: opts.model, thinkingEffort: opts.thinkingEffort, errors: null as string[] | null,
    inputTokens: null as number | null, outputTokens: null as number | null, cachedInputTokens: null as number | null,
    cacheCreationInputTokens: null as number | null, contextWindow: null as number | null,
    codexCumulative: null as CodexCumulativeUsage | null,
    stopReason: null as string | null,
    activity: '',
    recentActivity: [] as string[],
    claudeToolsById: new Map<string, { name: string; summary: string }>(),
    seenClaudeToolIds: new Set<string>(),
  };

  const shellCmd = cmd.map(Q).join(' ');
  agentLog(`[spawn] cmd: ${shellCmd}`);
  agentLog(`[spawn] cwd: ${opts.workdir} timeout: ${opts.timeout}s session: ${opts.sessionId || '(new)'}`);
  agentLog(`[spawn] prompt: "${opts.prompt.slice(0, 120)}"`);

  const proc = spawn(shellCmd, { cwd: opts.workdir, stdio: ['pipe', 'pipe', 'pipe'], shell: true });
  agentLog(`[spawn] pid=${proc.pid}`);
  try { proc.stdin!.write(opts._stdinOverride ?? opts.prompt); proc.stdin!.end(); } catch {}
  proc.stderr?.on('data', (c: Buffer) => {
    const chunk = c.toString();
    stderr += chunk;
    agentLog(`[stderr] ${chunk.trim().slice(0, 200)}`);
  });

  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  rl.on('line', raw => {
    if (Date.now() > deadline) {
      timedOut = true;
      s.stopReason = 'timeout';
      agentLog(`[timeout] deadline exceeded, killing process`);
      proc.kill('SIGKILL');
      return;
    }
    const line = raw.trim();
    if (!line || line[0] !== '{') return;
    lineCount++;
    try {
      const ev = JSON.parse(line);
      const evType = ev.type || '?';
      // Log key events (not every delta to avoid spam)
      if (evType === 'system' || evType === 'result' || evType === 'assistant' ||
          evType === 'thread.started' || evType === 'turn.completed' || evType === 'item.completed') {
        agentLog(`[event] type=${evType} session=${ev.session_id || s.sessionId || '?'} model=${ev.model || s.model || '?'}`);
      }
      if (evType === 'stream_event') {
        const inner = ev.event || {};
        if (inner.type === 'message_start' || inner.type === 'message_delta') {
          agentLog(`[event] stream_event/${inner.type} session=${ev.session_id || '?'}`);
        }
      }
      parseLine(ev, s);
      opts.onText(s.text, s.thinking, s.activity, buildStreamPreviewMeta(s), null);
    } catch {}
  });

  // Hard deadline timer: kill the process even if it produces no output (prevents infinite hang)
  const hardTimer = setTimeout(() => {
    timedOut = true;
    s.stopReason = 'timeout';
    agentLog(`[timeout] hard deadline reached (${opts.timeout}s), killing process pid=${proc.pid}`);
    try { proc.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
  }, opts.timeout * 1000 + 10_000); // 10s grace beyond the soft deadline

  const [procOk, code] = await new Promise<[boolean, number | null]>(resolve => {
    proc.on('close', code => { clearTimeout(hardTimer); agentLog(`[exit] code=${code} lines_parsed=${lineCount}`); resolve([code === 0, code]); });
    proc.on('error', e => { clearTimeout(hardTimer); agentLog(`[error] ${e.message}`); stderr += e.message; resolve([false, -1]); });
  });

  if (!s.text.trim() && s.msgs.length) s.text = s.msgs.join('\n\n');
  if (!s.thinking.trim() && s.thinkParts.length) s.thinking = s.thinkParts.join('\n\n');

  const ok = procOk && !s.errors && !timedOut;
  const error = s.errors?.map(e => e.trim()).filter(Boolean).join('; ').trim()
    || (timedOut ? `Timed out after ${opts.timeout}s before the agent reported completion.` : null)
    || (!procOk ? (stderr.trim() || `Failed (exit=${code}).`) : null);
  const incomplete = !ok || s.stopReason === 'max_tokens' || s.stopReason === 'timeout';
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  agentLog(`[result] ok=${ok && !s.errors} elapsed=${elapsed}s text=${s.text.length}chars thinking=${s.thinking.length}chars session=${s.sessionId || '?'}`);
  if (s.errors) agentLog(`[result] errors: ${s.errors.join('; ')}`);
  if (s.stopReason) agentLog(`[result] stop_reason=${s.stopReason}`);
  if (stderr.trim() && !procOk) agentLog(`[result] stderr: ${stderr.trim().slice(0, 300)}`);

  return {
    ok, localSessionId: opts.localSessionId ?? null, sessionId: s.sessionId, workspacePath: null, model: s.model, thinkingEffort: s.thinkingEffort,
    message: s.text.trim() || s.errors?.join('; ') || (procOk ? '(no textual response)' : `Failed (exit=${code}).\n\n${stderr.trim() || '(no output)'}`),
    thinking: s.thinking.trim() || null,
    elapsedS: (Date.now() - start) / 1000,
    inputTokens: s.inputTokens, outputTokens: s.outputTokens, cachedInputTokens: s.cachedInputTokens,
    cacheCreationInputTokens: s.cacheCreationInputTokens, contextWindow: s.contextWindow,
    ...computeContext(s),
    codexCumulative: s.codexCumulative,
    error,
    stopReason: s.stopReason,
    incomplete,
    activity: s.activity.trim() || null,
    artifacts: [],
  };
}

// ---------------------------------------------------------------------------
// Codex app-server JSON-RPC client (persistent connection)
// ---------------------------------------------------------------------------

const CODEX_APPSERVER_SPAWN_TIMEOUT_MS = 15_000;

type RpcCallback = (msg: any) => void;
type NotificationHandler = (method: string, params: any) => void;

class CodexAppServer {
  private proc: ReturnType<typeof spawn> | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, RpcCallback>();
  private notificationHandler: NotificationHandler | null = null;
  private ready = false;
  private startPromise: Promise<boolean> | null = null;
  private configOverrides: string[] = [];

  /** Launch app-server and send `initialize`. Resolves true if ready. */
  async ensureRunning(extraConfig?: string[]): Promise<boolean> {
    if (this.ready && this.proc && !this.proc.killed) return true;
    if (this.startPromise) return this.startPromise;
    this.configOverrides = extraConfig ?? [];
    this.startPromise = this._start();
    const ok = await this.startPromise;
    this.startPromise = null;
    return ok;
  }

  private _start(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { this.kill(); resolve(false); }, CODEX_APPSERVER_SPAWN_TIMEOUT_MS);

      const args = ['app-server'];
      for (const c of this.configOverrides) args.push('-c', c);
      agentLog(`[codex-rpc] spawning: codex ${args.join(' ')}`);
      const proc = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      this.buf = '';
      this.nextId = 1;
      this.pending.clear();
      this.ready = false;

      proc.stderr?.on('data', (c: Buffer) => {
        agentLog(`[codex-rpc][stderr] ${c.toString().trim().slice(0, 200)}`);
      });

      proc.stdout.on('data', (chunk: Buffer) => {
        this.buf += chunk.toString('utf-8');
        const lines = this.buf.split('\n');
        this.buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          // RPC response (has id)
          if (msg.id != null) {
            const cb = this.pending.get(msg.id);
            if (cb) { this.pending.delete(msg.id); cb(msg); }
          }
          // Notification (has method, no id)
          if (msg.method && msg.id == null) {
            this.notificationHandler?.(msg.method, msg.params ?? {});
          }
        }
      });

      proc.on('error', () => { clearTimeout(timer); this.ready = false; resolve(false); });
      proc.on('close', () => { this.ready = false; this.proc = null; });

      // Send initialize
      this.call('initialize', { clientInfo: { name: 'codeclaw', version: '0.2.0' } })
        .then(resp => {
          clearTimeout(timer);
          if (resp.error) { agentLog(`[codex-rpc] init error: ${resp.error.message}`); resolve(false); return; }
          this.ready = true;
          agentLog(`[codex-rpc] initialized`);
          resolve(true);
        })
        .catch(() => { clearTimeout(timer); resolve(false); });
    });
  }

  /** Send a JSON-RPC request and await its response. */
  call(method: string, params?: any): Promise<any> {
    return new Promise((resolve) => {
      if (!this.proc || this.proc.killed) { resolve({ error: { message: 'not connected' } }); return; }
      const id = this.nextId++;
      this.pending.set(id, resolve);
      const msg: any = { jsonrpc: '2.0', id, method };
      if (params !== undefined) msg.params = params;
      try { this.proc.stdin!.write(JSON.stringify(msg) + '\n'); } catch { resolve({ error: { message: 'write failed' } }); }
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: any): void {
    if (!this.proc || this.proc.killed) return;
    const msg: any = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    try { this.proc.stdin!.write(JSON.stringify(msg) + '\n'); } catch {}
  }

  /** Register a handler for server notifications. */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /** Remove notification handler. */
  offNotification(): void {
    this.notificationHandler = null;
  }

  kill(): void {
    try { this.proc?.kill(); } catch {}
    this.proc = null;
    this.ready = false;
    this.pending.clear();
  }

  get isRunning(): boolean {
    return this.ready && !!this.proc && !this.proc.killed;
  }
}

/** Singleton app-server instance, shared across all Codex operations. */
let _codexServer: CodexAppServer | null = null;

function getCodexServer(): CodexAppServer {
  if (!_codexServer) _codexServer = new CodexAppServer();
  return _codexServer;
}

/** Shut down the shared Codex app-server (call on process exit). */
export function shutdownCodexServer(): void {
  _codexServer?.kill();
  _codexServer = null;
}

// --- codex: effort mapping ---

const EFFORT_MAP: Record<string, string> = {
  low: 'low', medium: 'medium', high: 'high',
  min: 'minimal', max: 'xhigh',
};
function mapEffort(effort: string): string {
  return EFFORT_MAP[effort] ?? effort;
}

function compactLogLine(text: string, max = 120): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return '';
  if (line.length <= max) return line;
  return `${line.slice(0, max - 3)}...`;
}

function pushRecentActivity(lines: string[], line: string, maxLines = 12) {
  const cleaned = compactLogLine(line, 140);
  if (!cleaned) return;
  if (lines[lines.length - 1] === cleaned) return;
  lines.push(cleaned);
  if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
}

function firstNonEmptyLine(text: string): string {
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function shortValue(value: unknown, max = 90): string {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function summarizeClaudeToolUse(name: string, input: any): string {
  const tool = String(name || '').trim() || 'Tool';
  const description = shortValue(input?.description, 120);

  switch (tool) {
    case 'Read': {
      const target = shortValue(input?.file_path || input?.path, 140);
      return target ? `Read ${target}` : 'Read file';
    }
    case 'Edit': {
      const target = shortValue(input?.file_path || input?.path, 140);
      return target ? `Edit ${target}` : 'Edit file';
    }
    case 'Write': {
      const target = shortValue(input?.file_path || input?.path, 140);
      return target ? `Write ${target}` : 'Write file';
    }
    case 'Glob': {
      const pattern = shortValue(input?.pattern || input?.glob, 120);
      return pattern ? `List files: ${pattern}` : 'List files';
    }
    case 'Grep': {
      const pattern = shortValue(input?.pattern || input?.query, 120);
      return pattern ? `Search text: ${pattern}` : 'Search text';
    }
    case 'WebFetch': {
      const url = shortValue(input?.url, 120);
      return url ? `Fetch ${url}` : 'Fetch web page';
    }
    case 'WebSearch': {
      const query = shortValue(input?.query, 120);
      return query ? `Search web: ${query}` : 'Search web';
    }
    case 'TodoWrite':
      return 'Update plan';
    case 'Task': {
      const prompt = shortValue(input?.description || input?.prompt, 120);
      return prompt ? `Run task: ${prompt}` : 'Run task';
    }
    case 'Bash': {
      if (description) return `Run shell: ${description}`;
      const command = shortValue(input?.command, 120);
      return command ? `Run shell: ${command}` : 'Run shell command';
    }
    default: {
      if (description) return `${tool}: ${description}`;
      const detail = shortValue(
        input?.file_path || input?.path || input?.command || input?.query || input?.pattern || input?.url,
        120,
      );
      return detail ? `${tool}: ${detail}` : tool;
    }
  }
}

function summarizeClaudeToolResult(
  tool:
    | {
        name: string;
        summary: string;
      }
    | undefined,
  block: any,
  toolUseResult: any,
): string {
  const summary = tool?.summary || shortValue(tool?.name || 'Tool', 120) || 'Tool';
  const isError = !!block?.is_error;

  if (isError) {
    const detail = firstNonEmptyLine(
      toolUseResult?.stderr || toolUseResult?.stdout || block?.content || '',
    );
    return detail ? `${summary} failed: ${shortValue(detail, 120)}` : `${summary} failed`;
  }

  const toolName = tool?.name || '';
  if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write' || toolName === 'TodoWrite') {
    return `${summary} done`;
  }

  const detail = firstNonEmptyLine(
    toolUseResult?.stdout || block?.content || toolUseResult?.stderr || '',
  );
  if (!detail) return `${summary} done`;
  return `${summary} -> ${shortValue(detail, 120)}`;
}

interface CodexActiveToolCall {
  kind: string;
  summary: string;
}

function isCodexToolCallItem(item: any): boolean {
  return item?.type === 'dynamicToolCall'
    || item?.type === 'mcpToolCall'
    || item?.type === 'collabAgentToolCall';
}

function codexToolKind(name: unknown): string {
  const raw = typeof name === 'string' ? name.trim() : '';
  if (!raw) return 'tool';
  const parts = raw.split('.');
  return parts[parts.length - 1] || raw;
}

function compactPathTarget(value: unknown, max = 80): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const normalized = raw.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const compact = parts.length >= 2 ? parts.slice(-2).join('/') : normalized;
  if (compact.length <= max) return compact;
  return `...${compact.slice(-(max - 3))}`;
}

function summarizeCodexToolCall(item: any): CodexActiveToolCall | null {
  const kind = codexToolKind(item?.tool);
  switch (kind) {
    case 'apply_patch':
      return { kind, summary: 'Edit files' };
    case 'exec_command':
      return { kind, summary: 'Run shell command' };
    case 'update_plan':
      return { kind, summary: 'Update plan' };
    case 'request_user_input':
      return { kind, summary: 'Request user input' };
    case 'view_image':
      return { kind, summary: 'Inspect image' };
    case 'parallel':
      return { kind, summary: 'Run multiple tools' };
    default: {
      const label = shortValue(kind.replace(/_/g, ' '), 80);
      return label ? { kind, summary: `Use ${label}` } : null;
    }
  }
}

function summarizeCodexFileChange(item: any): string {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const paths = changes
    .map((change: any) => compactPathTarget(change?.path, 90))
    .filter(Boolean);
  if (paths.length === 1) return `Updated ${paths[0]}`;
  if (paths.length > 1) return `Updated ${paths.length} files`;
  return 'Updated files';
}

function isCodexToolCallFailure(item: any): boolean {
  if (!item || !isCodexToolCallItem(item)) return false;
  if (item.success === false) return true;
  if (item.error) return true;
  return item.status === 'failed' || item.status === 'error';
}

function buildCodexActivityPreview(s: {
  recentNarrative: string[];
  recentFailures: string[];
  commentaryByItem: Map<string, string>;
  activeCommands: Map<string, string>;
  activeToolCalls: Map<string, CodexActiveToolCall>;
  completedCommands: number;
}): string {
  const lines = [...s.recentNarrative];
  for (const text of s.commentaryByItem.values()) {
    const cleaned = compactLogLine(text, 140);
    if (cleaned && lines[lines.length - 1] !== cleaned) lines.push(cleaned);
  }
  for (const failure of s.recentFailures) {
    if (lines[lines.length - 1] !== failure) lines.push(failure);
  }
  if (s.completedCommands > 0) {
    lines.push(s.completedCommands === 1 ? 'Executed 1 command.' : `Executed ${s.completedCommands} commands.`);
  }
  if (s.activeCommands.size > 0) {
    lines.push(s.activeCommands.size === 1 ? 'Running 1 command...' : `Running ${s.activeCommands.size} commands...`);
  }
  for (const tool of s.activeToolCalls.values()) {
    const running = tool.summary.endsWith('...') ? tool.summary : `${tool.summary}...`;
    if (lines[lines.length - 1] !== running) lines.push(running);
  }
  return lines.join('\n');
}

export function buildCodexTurnInput(prompt: string, attachments: string[]): any[] {
  const input: any[] = [];
  for (const filePath of attachments) {
    const ext = path.extname(filePath).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      // Local images should use the dedicated app-server variant so Codex can
      // serialize them into an API-ready data URL.
      input.push({ type: 'localImage', path: filePath });
      continue;
    }
    input.push({ type: 'text', text: `[Attached file: ${filePath}]` });
  }
  input.push({ type: 'text', text: prompt });
  return input;
}

// --- codex: stream via app-server ---

export async function doCodexStream(opts: StreamOpts): Promise<StreamResult> {
  const start = Date.now();
  const srv = getCodexServer();
  let timedOut = false;

  // Build config overrides from opts
  const config: string[] = [];
  if (opts.codexExtraArgs?.length) {
    // Pass extra args as config overrides (best-effort: -c key=val pairs)
    for (let i = 0; i < opts.codexExtraArgs.length; i++) {
      if (opts.codexExtraArgs[i] === '-c' && opts.codexExtraArgs[i + 1]) {
        config.push(opts.codexExtraArgs[++i]);
      }
    }
  }

  if (!(await srv.ensureRunning(config))) {
    return {
      ok: false, message: 'Failed to start codex app-server.', thinking: null,
      localSessionId: opts.localSessionId ?? null,
      sessionId: opts.sessionId, workspacePath: null, model: opts.model, thinkingEffort: opts.thinkingEffort,
      elapsedS: (Date.now() - start) / 1000, inputTokens: null, outputTokens: null,
      cachedInputTokens: null, cacheCreationInputTokens: null, contextWindow: null, contextUsedTokens: null, contextPercent: null, error: 'Failed to start codex app-server.',
      codexCumulative: null, stopReason: null, incomplete: true, activity: null, artifacts: [],
    };
  }

  // Accumulator state
  const s = {
    sessionId: opts.sessionId as string | null,
    text: '', thinking: '', activity: '', msgs: [] as string[], thinkParts: [] as string[],
    model: opts.model as string | null,
    thinkingEffort: opts.thinkingEffort,
    inputTokens: null as number | null,
    outputTokens: null as number | null,
    cachedInputTokens: null as number | null,
    cacheCreationInputTokens: null as number | null,
    contextWindow: null as number | null,
    codexCumulative: null as CodexCumulativeUsage | null,
    turnId: null as string | null,
    turnStatus: null as string | null,
    turnError: null as string | null,
    messagePhases: new Map<string, string>(),
    commentaryByItem: new Map<string, string>(),
    activeCommands: new Map<string, string>(),
    activeToolCalls: new Map<string, CodexActiveToolCall>(),
    recentNarrative: [] as string[],
    recentFailures: [] as string[],
    completedCommands: 0,
    plan: null as StreamPreviewPlan | null,
  };

  // Step 1: thread/start or thread/resume
  let threadResp: any;
  if (opts.sessionId) {
    agentLog(`[codex-rpc] thread/resume id=${opts.sessionId}`);
    threadResp = await srv.call('thread/resume', {
      threadId: opts.sessionId,
      cwd: opts.workdir,
      model: opts.codexModel || null,
      approvalPolicy: opts.codexFullAccess ? 'never' : undefined,
      sandbox: opts.codexFullAccess ? 'danger-full-access' : undefined,
      developerInstructions: opts.codexDeveloperInstructions || undefined,
    });
  } else {
    agentLog(`[codex-rpc] thread/start cwd=${opts.workdir} model=${opts.codexModel || '(default)'}`);
    threadResp = await srv.call('thread/start', {
      cwd: opts.workdir,
      model: opts.codexModel || null,
      approvalPolicy: opts.codexFullAccess ? 'never' : undefined,
      sandbox: opts.codexFullAccess ? 'danger-full-access' : undefined,
      developerInstructions: opts.codexDeveloperInstructions || undefined,
    });
  }

  if (threadResp.error) {
    const errMsg = threadResp.error.message || 'thread/start failed';
    agentLog(`[codex-rpc] thread error: ${errMsg}`);
    return {
      ok: false, message: errMsg, thinking: null,
      localSessionId: opts.localSessionId ?? null,
      sessionId: opts.sessionId, workspacePath: null, model: opts.model, thinkingEffort: opts.thinkingEffort,
      elapsedS: (Date.now() - start) / 1000, inputTokens: null, outputTokens: null,
      cachedInputTokens: null, cacheCreationInputTokens: null, contextWindow: null, contextUsedTokens: null, contextPercent: null, error: errMsg,
      codexCumulative: null, stopReason: null, incomplete: true, activity: null, artifacts: [],
    };
  }

  const threadResult = threadResp.result;
  s.sessionId = threadResult.thread?.id ?? s.sessionId;
  s.model = threadResult.model ?? s.model;
  agentLog(`[codex-rpc] thread ready: id=${s.sessionId} model=${s.model}`);

  // Step 2: turn/start — send the prompt
  const input = buildCodexTurnInput(opts.prompt, opts.attachments || []);

  const turnDone = new Promise<void>((resolve) => {
    const deadline = start + opts.timeout * 1000;
    const hardTimer = setTimeout(() => {
      timedOut = true;
      agentLog(`[codex-rpc] timeout: interrupting turn`);
      if (s.turnId && s.sessionId) {
        srv.call('turn/interrupt', { threadId: s.sessionId, turnId: s.turnId }).catch(() => {});
      }
      resolve();
    }, opts.timeout * 1000 + 5_000);

    srv.onNotification((method, params) => {
      if (Date.now() > deadline) return;
      const emit = () => {
        s.activity = buildCodexActivityPreview(s);
        opts.onText(s.text, s.thinking, s.activity, buildStreamPreviewMeta(s), s.plan);
      };

      if (method === 'item/started' && params.threadId === s.sessionId) {
        const item = params.item || {};
        if (item.type === 'agentMessage' && item.id) {
          const phase = item.phase || 'final_answer';
          s.messagePhases.set(item.id, phase);
          if (phase !== 'final_answer') {
            s.commentaryByItem.set(item.id, item.text || '');
            emit();
          }
        }
        if (item.type === 'commandExecution' && item.id && item.command) {
          s.activeCommands.set(item.id, item.command);
          emit();
        }
        if (item.id && isCodexToolCallItem(item)) {
          const toolCall = summarizeCodexToolCall(item);
          if (toolCall) {
            s.activeToolCalls.set(item.id, toolCall);
            emit();
          }
        }
      }

      // Streaming text deltas
      if (method === 'item/agentMessage/delta' && params.threadId === s.sessionId) {
        const delta = params.delta || '';
        const phase = params.itemId ? (s.messagePhases.get(params.itemId) || 'final_answer') : 'final_answer';
        if (phase === 'final_answer') {
          s.text += delta;
        } else if (params.itemId) {
          const prev = s.commentaryByItem.get(params.itemId) || '';
          s.commentaryByItem.set(params.itemId, prev + delta);
        }
        emit();
      }

      // Reasoning deltas
      if ((method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') && params.threadId === s.sessionId) {
        s.thinking += params.delta || '';
        emit();
      }

      // Item completed — collect full agent messages and reasoning
      if (method === 'item/completed' && params.threadId === s.sessionId) {
        const item = params.item || {};
        if (item.type === 'agentMessage' && item.id) {
          const phase = item.phase || s.messagePhases.get(item.id) || 'final_answer';
          if (phase === 'final_answer') {
            if (item.text?.trim()) s.msgs.push(item.text.trim());
          } else {
            const commentary = item.text?.trim() || s.commentaryByItem.get(item.id)?.trim() || '';
            if (commentary) pushRecentActivity(s.recentNarrative, commentary);
            s.commentaryByItem.delete(item.id);
            emit();
          }
          s.messagePhases.delete(item.id);
        }
        if (item.type === 'reasoning') {
          const parts = [...(item.summary || []), ...(item.content || [])];
          const text = parts.join('\n').trim();
          if (text) {
            s.thinkParts.push(text);
            emit();
          }
        }
        if (item.type === 'commandExecution' && item.id) {
          const cmd = item.command || s.activeCommands.get(item.id) || '';
          s.activeCommands.delete(item.id);
          if (cmd) {
            const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null;
            if (exitCode != null && exitCode !== 0) {
              pushRecentActivity(s.recentFailures, `Command failed (${exitCode}): ${cmd}`, 4);
            } else {
              s.completedCommands++;
            }
          }
          emit();
        }
        if (item.id && isCodexToolCallItem(item)) {
          const toolCall = s.activeToolCalls.get(item.id) || summarizeCodexToolCall(item);
          s.activeToolCalls.delete(item.id);
          if (toolCall) {
            if (isCodexToolCallFailure(item)) {
              pushRecentActivity(s.recentFailures, `${toolCall.summary} failed`, 4);
            } else if (toolCall.kind !== 'apply_patch') {
              pushRecentActivity(s.recentNarrative, `${toolCall.summary} done`);
            }
          }
          emit();
        }
        if (item.type === 'fileChange') {
          pushRecentActivity(s.recentNarrative, summarizeCodexFileChange(item));
          emit();
        }
      }

      // Token usage updates
      if (method === 'thread/tokenUsage/updated' && params.threadId === s.sessionId) {
        applyCodexTokenUsage(s, params.tokenUsage, opts.codexPrevCumulative);
        emit();
      }

      if (method === 'turn/plan/updated' && params.threadId === s.sessionId) {
        const rawPlan = Array.isArray(params.plan) ? params.plan : [];
        s.plan = {
          explanation: typeof params.explanation === 'string' ? params.explanation : null,
          steps: rawPlan
            .map((entry: any) => ({
              step: typeof entry?.step === 'string' ? entry.step : '',
              status: entry?.status === 'completed' || entry?.status === 'pending' || entry?.status === 'inProgress'
                ? entry.status
                : 'pending',
            }))
            .filter((entry: StreamPreviewPlanStep) => entry.step.trim()),
        };
        emit();
      }

      // Turn completed
      if (method === 'turn/completed' && params.threadId === s.sessionId) {
        const turn = params.turn || {};
        applyCodexTokenUsage(s, params.tokenUsage || turn.tokenUsage || turn.usage, opts.codexPrevCumulative);
        s.turnStatus = turn.status ?? null;
        if (turn.error) s.turnError = turn.error.message || turn.error.code || JSON.stringify(turn.error);
        s.turnId = turn.id ?? s.turnId;
        clearTimeout(hardTimer);
        resolve();
      }

      // Turn started (capture turnId for interrupt)
      if (method === 'turn/started' && params.threadId === s.sessionId) {
        s.turnId = params.turn?.id ?? null;
      }

      // Model rerouted
      if (method === 'model/rerouted' && params.threadId === s.sessionId) {
        s.model = params.model ?? s.model;
      }
    });
  });

  agentLog(`[codex-rpc] turn/start prompt="${opts.prompt.slice(0, 120)}" effort=${mapEffort(opts.thinkingEffort)}`);
  const turnResp = await srv.call('turn/start', {
    threadId: s.sessionId,
    input,
    model: opts.codexModel || undefined,
    effort: mapEffort(opts.thinkingEffort),
  });

  if (turnResp.error) {
    srv.offNotification();
    const errMsg = turnResp.error.message || 'turn/start failed';
    agentLog(`[codex-rpc] turn/start error: ${errMsg}`);
    return {
      ok: false, message: errMsg, thinking: null,
      localSessionId: opts.localSessionId ?? null,
      sessionId: s.sessionId, workspacePath: null, model: s.model, thinkingEffort: s.thinkingEffort,
      elapsedS: (Date.now() - start) / 1000, inputTokens: null, outputTokens: null,
      cachedInputTokens: null, cacheCreationInputTokens: null, contextWindow: null, contextUsedTokens: null, contextPercent: null, error: errMsg,
      codexCumulative: null, stopReason: null, incomplete: true, activity: null, artifacts: [],
    };
  }

  s.turnId = turnResp.result?.turn?.id ?? null;

  // Wait for turn to complete (via notifications)
  await turnDone;
  srv.offNotification();

  // Build final text from accumulated parts
  if (!s.text.trim() && s.msgs.length) s.text = s.msgs.join('\n\n');
  if (!s.thinking.trim() && s.thinkParts.length) s.thinking = s.thinkParts.join('\n\n');

  const ok = s.turnStatus === 'completed' && !timedOut;
  const error = s.turnError
    || (timedOut ? `Timed out after ${opts.timeout}s waiting for turn completion.` : null)
    || (!ok ? `Turn ${s.turnStatus || 'unknown'}.` : null);
  const stopReason = timedOut ? 'timeout' : (s.turnStatus === 'interrupted' ? 'interrupted' : null);
  const incomplete = !ok;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  agentLog(`[codex-rpc] result: ok=${ok} elapsed=${elapsed}s text=${s.text.length}chars session=${s.sessionId} status=${s.turnStatus}`);

  return {
    ok,
    localSessionId: opts.localSessionId ?? null,
    sessionId: s.sessionId,
    workspacePath: null,
    model: s.model,
    thinkingEffort: s.thinkingEffort,
    message: s.text.trim() || error || '(no textual response)',
    thinking: s.thinking.trim() || null,
    elapsedS: (Date.now() - start) / 1000,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cachedInputTokens: s.cachedInputTokens,
    cacheCreationInputTokens: s.cacheCreationInputTokens,
    contextWindow: s.contextWindow,
    ...computeContext(s),
    codexCumulative: s.codexCumulative,
    error,
    stopReason,
    incomplete,
    activity: s.activity.trim() || null,
    artifacts: [],
  };
}

// --- claude ---

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function mimeForExt(ext: string): string {
  switch (ext) {
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}

/**
 * Build a stream-json stdin payload that includes images as base64 content
 * blocks alongside the text prompt.
 */
function buildClaudeMultimodalStdin(prompt: string, attachments: string[]): string {
  const content: any[] = [];
  for (const filePath of attachments) {
    const ext = path.extname(filePath).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      try {
        const data = fs.readFileSync(filePath);
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: mimeForExt(ext), data: data.toString('base64') },
        });
      } catch (e: any) {
        agentLog(`[attach] failed to read image ${filePath}: ${e.message}`);
      }
    } else {
      // For non-image files, tell Claude the path so it can Read it
      content.push({ type: 'text', text: `[Attached file: ${filePath}]` });
    }
  }
  content.push({ type: 'text', text: prompt });
  const msg = {
    type: 'user',
    message: { role: 'user', content },
  };
  return JSON.stringify(msg) + '\n';
}

function claudeCmd(o: StreamOpts): string[] {
  const args = ['claude', '-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages'];
  if (o.claudeModel) args.push('--model', o.claudeModel);
  if (o.claudePermissionMode) args.push('--permission-mode', o.claudePermissionMode);
  if (o.sessionId) args.push('--resume', o.sessionId);
  if (o.attachments?.length) {
    args.push('--input-format', 'stream-json');
    o._stdinOverride = buildClaudeMultimodalStdin(o.prompt, o.attachments);
  }
  if (o.claudeAppendSystemPrompt) args.push('--append-system-prompt', o.claudeAppendSystemPrompt);
  if (o.claudeExtraArgs?.length) args.push(...o.claudeExtraArgs);
  return args;
}

function claudeParse(ev: any, s: any) {
  const t = ev.type || '';
  if (t === 'system') { s.sessionId = ev.session_id ?? s.sessionId; s.model = ev.model ?? s.model; s.thinkingEffort = ev.thinking_level ?? s.thinkingEffort; }

  if (t === 'stream_event') {
    const inner = ev.event || {};
    // message_start: new API call (may follow auto-compact) — reset all token counters
    if (inner.type === 'message_start') {
      const u = inner.message?.usage;
      s.inputTokens = u?.input_tokens ?? null;
      s.cachedInputTokens = u?.cache_read_input_tokens ?? null;
      s.cacheCreationInputTokens = u?.cache_creation_input_tokens ?? null;
      s.outputTokens = null; // output comes later in message_delta
    }
    if (inner.type === 'content_block_delta') {
      const d = inner.delta || {};
      if (d.type === 'thinking_delta') s.thinking += d.thinking || '';
      else if (d.type === 'text_delta') s.text += d.text || '';
    }
    if (inner.type === 'message_delta') {
      const d = inner.delta || {};
      s.stopReason = d.stop_reason ?? s.stopReason;
      const u = inner.usage;
      if (u) {
        if (u.input_tokens != null) s.inputTokens = u.input_tokens;
        if (u.cache_read_input_tokens != null) s.cachedInputTokens = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens != null) s.cacheCreationInputTokens = u.cache_creation_input_tokens;
        if (u.output_tokens != null) s.outputTokens = u.output_tokens;
      }
    }
    s.sessionId = ev.session_id ?? s.sessionId;
    s.model = ev.model ?? s.model;
  }

  if (t === 'assistant') {
    const msg = ev.message || {};
    const contents = msg.content || [];
    const th = contents.filter((b: any) => b?.type === 'thinking').map((b: any) => b.thinking || '').join('');
    const tx = contents.filter((b: any) => b?.type === 'text').map((b: any) => b.text || '').join('');
    const toolUses = contents.filter((b: any) => b?.type === 'tool_use');
    if (th && !s.thinking.trim()) s.thinking = th;
    if (tx && !s.text.trim()) s.text = tx;
    for (const block of toolUses) {
      const toolId = String(block?.id || '').trim();
      if (!toolId || s.seenClaudeToolIds.has(toolId)) continue;
      const tool = {
        name: String(block?.name || 'Tool').trim() || 'Tool',
        summary: summarizeClaudeToolUse(block?.name, block?.input || {}),
      };
      s.seenClaudeToolIds.add(toolId);
      s.claudeToolsById.set(toolId, tool);
      pushRecentActivity(s.recentActivity, tool.summary);
    }
    s.activity = s.recentActivity.join('\n');
    s.stopReason = msg.stop_reason ?? s.stopReason;
  }

  if (t === 'user') {
    const msg = ev.message || {};
    const contents = Array.isArray(msg.content) ? msg.content : [];
    const toolResults = contents.filter((b: any) => b?.type === 'tool_result');
    for (const block of toolResults) {
      const toolId = String(block?.tool_use_id || '').trim();
      const tool = toolId ? s.claudeToolsById.get(toolId) : undefined;
      pushRecentActivity(s.recentActivity, summarizeClaudeToolResult(tool, block, ev.tool_use_result));
    }
    s.activity = s.recentActivity.join('\n');
  }

  if (t === 'result') {
    s.sessionId = ev.session_id ?? s.sessionId; s.model = ev.model ?? s.model;
    if (ev.is_error && ev.errors?.length) s.errors = ev.errors;
    if (ev.result && !s.text.trim()) s.text = ev.result;
    s.stopReason = ev.stop_reason ?? s.stopReason;
    const u = ev.usage;
    if (u) {
      // result event is authoritative — use direct assignment so post-compact values replace stale ones
      s.inputTokens = u.input_tokens ?? s.inputTokens;
      s.cachedInputTokens = (u.cache_read_input_tokens ?? u.cached_input_tokens) ?? s.cachedInputTokens;
      s.cacheCreationInputTokens = u.cache_creation_input_tokens ?? s.cacheCreationInputTokens;
      s.outputTokens = u.output_tokens ?? s.outputTokens;
    }
    // Extract contextWindow from modelUsage (Claude CLI reports this in result event)
    const mu = ev.modelUsage;
    if (mu && typeof mu === 'object') {
      for (const info of Object.values(mu) as any[]) {
        if (info?.contextWindow > 0) { s.contextWindow = info.contextWindow; break; }
      }
    }
  }
}

export async function doClaudeStream(opts: StreamOpts): Promise<StreamResult> {
  const result = await run(claudeCmd(opts), opts, claudeParse);
  // session not found → retry as new conversation
  const retryText = `${result.error || ''}\n${result.message}`;
  if (!result.ok && opts.sessionId && /no conversation found/i.test(retryText)) {
    return run(claudeCmd({ ...opts, sessionId: null }), { ...opts, sessionId: null }, claudeParse);
  }
  return result;
}

// --- unified entry ---

function listCodeclawSessions(workdir: string, agent: Agent, limit?: number): LocalSessionRecord[] {
  const records = loadSessionIndex(path.resolve(workdir)).sessions
    .filter(entry => entry.agent === agent)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return typeof limit === 'number' ? records.slice(0, limit) : records;
}

function findCodeclawSessionByLocalId(workdir: string, agent: Agent, localSessionId: string): LocalSessionRecord | null {
  return listCodeclawSessions(workdir, agent).find(entry => entry.localSessionId === localSessionId) || null;
}

function prepareStreamOpts(opts: StreamOpts): { prepared: StreamOpts; session: SessionWorkspaceInfo; attachments: string[] } {
  const session = ensureSessionWorkspace({
    agent: opts.agent,
    workdir: opts.workdir,
    localSessionId: opts.localSessionId,
    sessionId: opts.sessionId,
    title: opts.prompt,
  });
  const importedFiles = importFilesIntoWorkspace(session.workspacePath, opts.attachments || []);
  const attachmentRelPaths = dedupeStrings([...session.record.stagedFiles, ...importedFiles]);
  session.record.stagedFiles = [];
  if (!session.record.title) session.record.title = summarizePromptTitle(opts.prompt) || importedFiles[0] || null;
  saveSessionRecord(opts.workdir, session.record);
  removeFileIfExists(session.manifestPath);

  const attachmentPaths = attachmentRelPaths.map(relPath => path.join(session.workspacePath, relPath));
  const artifactSystemPrompt = buildArtifactSystemPrompt(session.workspacePath, session.manifestPath);
  const prompt = opts.agent === 'codex'
    ? buildArtifactPrompt(opts.prompt, session.workspacePath, session.manifestPath)
    : opts.prompt;

  return {
    session,
    attachments: attachmentPaths,
    prepared: {
      ...opts,
      localSessionId: session.localSessionId,
      prompt,
      attachments: attachmentPaths.length ? attachmentPaths : undefined,
      codexDeveloperInstructions: appendSystemPrompt(opts.codexDeveloperInstructions, artifactSystemPrompt),
      claudeAppendSystemPrompt: appendSystemPrompt(opts.claudeAppendSystemPrompt, artifactSystemPrompt),
    },
  };
}

function finalizeStreamResult(result: StreamResult, workdir: string, prompt: string, session: SessionWorkspaceInfo): StreamResult {
  session.record.engineSessionId = result.sessionId || session.record.engineSessionId;
  session.record.model = result.model || session.record.model;
  if (!session.record.title) session.record.title = summarizePromptTitle(prompt);
  saveSessionRecord(workdir, session.record);
  const artifacts = collectArtifacts(session.workspacePath, session.manifestPath, msg => agentLog(msg));
  return {
    ...result,
    localSessionId: session.localSessionId,
    workspacePath: session.workspacePath,
    artifacts,
  };
}

export async function doStream(opts: StreamOpts): Promise<StreamResult> {
  let session: SessionWorkspaceInfo;
  let prepared: StreamOpts;
  try {
    const prep = prepareStreamOpts(opts);
    session = prep.session;
    prepared = prep.prepared;
  } catch (e: any) {
    const message = e?.message || String(e);
    return {
      ok: false,
      message,
      thinking: null,
      localSessionId: opts.localSessionId ?? null,
      sessionId: opts.sessionId,
      workspacePath: null,
      model: opts.model,
      thinkingEffort: opts.thinkingEffort,
      elapsedS: 0,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheCreationInputTokens: null,
      contextWindow: null,
      contextUsedTokens: null,
      contextPercent: null,
      codexCumulative: null,
      error: message,
      stopReason: null,
      incomplete: true,
      activity: null,
      artifacts: [],
    };
  }

  const result = await (prepared.agent === 'codex' ? doCodexStream(prepared) : doClaudeStream(prepared));
  return finalizeStreamResult(result, opts.workdir, opts.prompt, session);
}

// ---------------------------------------------------------------------------
// Session listing
// ---------------------------------------------------------------------------

export interface SessionInfo {
  /** Engine-native session/thread ID when available */
  sessionId: string | null;
  /** Codeclaw-managed local session ID used for workspace lookup */
  localSessionId: string | null;
  engineSessionId: string | null;
  agent: Agent;
  workdir: string | null;
  workspacePath: string | null;
  model: string | null;
  createdAt: string | null;
  /** First user prompt (truncated), used as a display title */
  title: string | null;
  /** Whether the session file was modified in the last 60 seconds (likely running) */
  running: boolean;
}

export interface SessionListResult {
  ok: boolean;
  sessions: SessionInfo[];
  error: string | null;
}

export interface SessionListOpts {
  agent: Agent;
  /** Absolute workdir path — used to locate Claude project sessions and to filter Codex sessions */
  workdir: string;
  /** Max number of sessions to return (default 50) */
  limit?: number;
}

/**
 * Encode a workdir path to the Claude project directory name.
 * Claude replaces `/` with `-` and strips the leading `-`.
 */
function claudeProjectDirName(workdir: string): string {
  return workdir.replace(/\//g, '-');
}

function readLines(filePath: string, maxLines: number): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < maxLines; i++) {
      const nl = content.indexOf('\n', start);
      if (nl < 0) { if (start < content.length) lines.push(content.slice(start)); break; }
      lines.push(content.slice(start, nl));
      start = nl + 1;
    }
    return lines;
  } catch {
    return [];
  }
}

function parseClaudeSession(filePath: string, workdir: string): SessionInfo | null {
  const lines = readLines(filePath, 10);
  if (!lines.length) return null;
  try {
    const sessionId = path.basename(filePath, '.jsonl');
    const stat = fs.statSync(filePath);
    let model: string | null = null;
    let title: string | null = null;

    for (const raw of lines) {
      if (!raw || raw[0] !== '{') continue;
      try {
        const ev = JSON.parse(raw);
        if (ev.type === 'user' && !title) {
          const content = ev.message?.content;
          if (typeof content === 'string') {
            title = content.slice(0, 120);
          } else if (Array.isArray(content)) {
            const textBlock = content.find((b: any) => b?.type === 'text' && b.text && !b.text.startsWith('<'));
            if (textBlock) title = textBlock.text.slice(0, 120);
          }
        }
        if (ev.type === 'assistant' && !model) {
          model = ev.message?.model ?? null;
        }
      } catch { /* skip unparseable lines */ }
      if (model && title) break;
    }

    return {
      sessionId,
      localSessionId: null,
      engineSessionId: sessionId,
      agent: 'claude',
      workdir,
      workspacePath: null,
      model,
      createdAt: stat.birthtime?.toISOString() ?? stat.mtime?.toISOString() ?? null,
      title,
      running: false,
    };
  } catch {
    return null;
  }
}


/** Collect session IDs from running `claude --resume <id>` processes. */
function getRunningClaudeSessionIds(): Set<string> {
  try {
    const out = execSync('ps -eo args 2>/dev/null', { encoding: 'utf-8', timeout: 3000 });
    const ids = new Set<string>();
    for (const m of out.matchAll(/--resume\s+(\S+)/g)) ids.add(m[1]);
    return ids;
  } catch { return new Set(); }
}

function getClaudeSessions(opts: SessionListOpts): SessionListResult {
  const sessions = listCodeclawSessions(opts.workdir, 'claude', opts.limit).map(record => ({
    sessionId: record.engineSessionId,
    localSessionId: record.localSessionId,
    engineSessionId: record.engineSessionId,
    agent: 'claude' as Agent,
    workdir: record.workdir,
    workspacePath: record.workspacePath,
    model: record.model,
    createdAt: record.createdAt,
    title: record.title,
    running: Date.now() - Date.parse(record.updatedAt) < 10_000,
  }));
  return { ok: true, sessions, error: null };
}

async function getCodexSessions(opts: SessionListOpts): Promise<SessionListResult> {
  const sessions = listCodeclawSessions(opts.workdir, 'codex', opts.limit).map(record => ({
    sessionId: record.engineSessionId,
    localSessionId: record.localSessionId,
    engineSessionId: record.engineSessionId,
    agent: 'codex' as Agent,
    workdir: record.workdir,
    workspacePath: record.workspacePath,
    model: record.model,
    createdAt: record.createdAt,
    title: record.title,
    running: Date.now() - Date.parse(record.updatedAt) < 10_000,
  }));
  return { ok: true, sessions, error: null };
}

export function getSessions(opts: SessionListOpts): Promise<SessionListResult> {
  return opts.agent === 'codex' ? getCodexSessions(opts) : Promise.resolve(getClaudeSessions(opts));
}

// ---------------------------------------------------------------------------
// Session tail — last N conversation messages
// ---------------------------------------------------------------------------

export interface TailMessage {
  /** 'user' or 'assistant' */
  role: 'user' | 'assistant';
  /** Plain text content (tool calls / system prompts stripped) */
  text: string;
}

export interface SessionTailResult {
  ok: boolean;
  messages: TailMessage[];
  error: string | null;
}

export interface SessionTailOpts {
  agent: Agent;
  sessionId: string;
  /** Absolute workdir — needed to locate Claude session files */
  workdir: string;
  /** How many messages to return from the tail (default 4, i.e. last 2 turns) */
  limit?: number;
}

/**
 * Read the tail end of a JSONL file efficiently (read last N bytes).
 * Returns lines in order (oldest-first).
 */
/**
 * Strip codeclaw-injected system prompts from user messages.
 * These are appended after the actual user text (e.g. artifact return instructions).
 */
function stripInjectedPrompts(text: string): string {
  // Cut at known injection markers
  const markers = ['\n[Session Workspace]', '\n[Telegram Artifact Return]', '\n[Artifact Return]'];
  for (const m of markers) {
    const idx = text.indexOf(m);
    if (idx >= 0) return text.slice(0, idx).trim();
  }
  return text;
}

function readTailLines(filePath: string, maxBytes = 256 * 1024): string[] {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const readSize = Math.min(maxBytes, size);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    fs.closeSync(fd);
    return buf.toString('utf-8').split('\n').filter(l => l.trim());
  } catch {
    return [];
  }
}

/**
 * Extract text from a Claude message content field.
 * content can be a string or an array of content blocks.
 */
function extractClaudeText(content: any, skipSystemBlocks = false): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      if (skipSystemBlocks && block.text.startsWith('<')) continue;
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function getClaudeSessionTail(opts: SessionTailOpts): SessionTailResult {
  const limit = opts.limit ?? 4;
  const home = process.env.HOME || '';
  const projectDir = path.join(home, '.claude', 'projects', claudeProjectDirName(opts.workdir));
  const filePath = path.join(projectDir, `${opts.sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) {
    return { ok: false, messages: [], error: 'Session file not found' };
  }

  try {
    const lines = readTailLines(filePath);
    // Parse all user/assistant messages from the tail chunk
    const allMsgs: TailMessage[] = [];
    for (const raw of lines) {
      if (!raw || raw[0] !== '{') continue;
      try {
        const ev = JSON.parse(raw);
        if (ev.type === 'user') {
          const text = stripInjectedPrompts(extractClaudeText(ev.message?.content, true));
          if (text) allMsgs.push({ role: 'user', text });
        } else if (ev.type === 'assistant') {
          const text = extractClaudeText(ev.message?.content, true);
          if (text) allMsgs.push({ role: 'assistant', text });
        }
      } catch { /* skip */ }
    }
    return { ok: true, messages: allMsgs.slice(-limit), error: null };
  } catch (e: any) {
    return { ok: false, messages: [], error: e.message };
  }
}

async function getCodexSessionTail(opts: SessionTailOpts): Promise<SessionTailResult> {
  const limit = opts.limit ?? 4;
  const srv = getCodexServer();
  if (!(await srv.ensureRunning())) {
    return { ok: false, messages: [], error: 'Failed to start codex app-server.' };
  }

  const resp = await srv.call('thread/read', {
    threadId: opts.sessionId,
    includeTurns: true,
  });

  if (resp.error) {
    return { ok: false, messages: [], error: resp.error.message || 'thread/read failed' };
  }

  const thread = resp.result?.thread;
  if (!thread) {
    return { ok: false, messages: [], error: 'No thread data returned' };
  }

  // Extract messages from turns → items
  const allMsgs: TailMessage[] = [];
  const turns: any[] = thread.turns ?? [];
  for (const turn of turns) {
    for (const item of (turn.items ?? [])) {
      if (item.type === 'userMessage') {
        const parts: string[] = [];
        for (const c of (item.content ?? [])) {
          if (c.type === 'text' && c.text) parts.push(c.text);
        }
        if (parts.length) allMsgs.push({ role: 'user', text: stripInjectedPrompts(parts.join('\n')) });
      } else if (item.type === 'agentMessage') {
        if (item.text) allMsgs.push({ role: 'assistant', text: item.text });
      }
    }
  }

  return { ok: true, messages: allMsgs.slice(-limit), error: null };
}

export function getSessionTail(opts: SessionTailOpts): Promise<SessionTailResult> {
  const managed = findCodeclawSessionByLocalId(opts.workdir, opts.agent, opts.sessionId);
  if (managed) {
    if (!managed.engineSessionId) return Promise.resolve({ ok: true, messages: [], error: null });
    const resolvedOpts = { ...opts, sessionId: managed.engineSessionId };
    return opts.agent === 'codex'
      ? getCodexSessionTail(resolvedOpts)
      : Promise.resolve(getClaudeSessionTail(resolvedOpts));
  }
  return opts.agent === 'codex'
    ? getCodexSessionTail(opts)
    : Promise.resolve(getClaudeSessionTail(opts));
}

// ---------------------------------------------------------------------------
// Agent listing
// ---------------------------------------------------------------------------

export interface AgentInfo {
  agent: Agent;
  installed: boolean;
  path: string | null;
  version: string | null;
}

export interface AgentListResult {
  agents: AgentInfo[];
}

function detectAgent(cmd: string, agent: Agent): AgentInfo {
  let binPath: string | null = null;
  try { binPath = execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf-8' }).trim() || null; } catch { /* */ }
  let version: string | null = null;
  if (binPath) {
    try { version = execSync(`${cmd} --version 2>/dev/null`, { encoding: 'utf-8' }).trim().split('\n')[0] || null; } catch { /* */ }
  }
  return { agent, installed: !!binPath, path: binPath, version };
}

export function listAgents(): AgentListResult {
  return {
    agents: [
      detectAgent('claude', 'claude'),
      detectAgent('codex', 'codex'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Skill listing — project-defined custom skills (.claude/commands/ & .claude/skills/)
// ---------------------------------------------------------------------------

export interface SkillInfo {
  /** Skill name (directory name or filename without extension) */
  name: string;
  /** Short human-facing label for menus (from front-matter `label`, or first # heading) */
  label: string | null;
  /** Full description from front-matter (AI-facing, may be long) */
  description: string | null;
  /** 'commands' or 'skills' — where it was found */
  source: 'commands' | 'skills';
}

export interface SkillListResult {
  skills: SkillInfo[];
  workdir: string;
}

/** Parse front-matter fields and first heading from a markdown skill file. */
function parseSkillMeta(content: string): { label: string | null; description: string | null } {
  let label: string | null = null;
  let description: string | null = null;

  // Parse YAML front-matter
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fm) {
    const lm = fm[1].match(/^label:\s*(.+)/m);
    if (lm) label = lm[1].trim();
    const dm = fm[1].match(/^description:\s*(.+)/m);
    if (dm) description = dm[1].trim();
  }

  // Fallback: use first # heading as label
  if (!label) {
    const hm = content.match(/^#\s+(.+)$/m);
    if (hm) label = hm[1].trim();
  }

  return { label, description };
}

/**
 * List project-defined custom skills from the workdir's .claude/ directory.
 * Scans both `.claude/commands/` (single .md files) and `.claude/skills/` (dirs with SKILL.md).
 */
export function listSkills(workdir: string): SkillListResult {
  const skills: SkillInfo[] = [];
  const claudeDir = path.join(workdir, '.claude');

  // .claude/commands/*.md — each markdown file is a command
  const commandsDir = path.join(claudeDir, 'commands');
  try {
    for (const entry of fs.readdirSync(commandsDir)) {
      if (!entry.endsWith('.md')) continue;
      const name = entry.replace(/\.md$/, '');
      let meta = { label: null as string | null, description: null as string | null };
      try {
        meta = parseSkillMeta(fs.readFileSync(path.join(commandsDir, entry), 'utf-8'));
      } catch {}
      skills.push({ name, label: meta.label, description: meta.description, source: 'commands' });
    }
  } catch {}

  // .claude/skills/<name>/SKILL.md — each subdirectory with a SKILL.md
  const skillsDir = path.join(claudeDir, 'skills');
  try {
    for (const entry of fs.readdirSync(skillsDir)) {
      const skillFile = path.join(skillsDir, entry, 'SKILL.md');
      try {
        const stat = fs.statSync(path.join(skillsDir, entry));
        if (!stat.isDirectory()) continue;
      } catch { continue; }
      let meta = { label: null as string | null, description: null as string | null };
      try {
        meta = parseSkillMeta(fs.readFileSync(skillFile, 'utf-8'));
      } catch {}
      skills.push({ name: entry, label: meta.label, description: meta.description, source: 'skills' });
    }
  } catch {}

  return { skills, workdir };
}

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  /** Short alias (e.g. 'opus', 'sonnet') — null if the id IS the alias */
  alias: string | null;
}

export interface ModelListResult {
  agent: Agent;
  models: ModelInfo[];
  sources: string[];
  note: string | null;
}

export interface ModelListOpts {
  workdir?: string;
  currentModel?: string | null;
}

function pushModel(models: ModelInfo[], seen: Set<string>, id: string, alias: string | null) {
  const cleanId = id.trim();
  if (!cleanId || seen.has(cleanId)) return;
  seen.add(cleanId);
  models.push({ id: cleanId, alias: alias?.trim() || null });
}

/** Static Claude model list — kept in sync with Claude CLI's model picker. */
const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-6', alias: 'opus' },
  { id: 'claude-opus-4-6[1m]', alias: 'opus-1m' },
  { id: 'claude-sonnet-4-6', alias: 'sonnet' },
  { id: 'claude-sonnet-4-6[1m]', alias: 'sonnet-1m' },
  { id: 'claude-haiku-4-5-20251001', alias: 'haiku' },
];

function discoverClaudeModels(_opts: ModelListOpts): ModelListResult {
  return {
    agent: 'claude',
    models: [...CLAUDE_MODELS],
    sources: [],
    note: null,
  };
}

async function discoverCodexModels(opts: ModelListOpts): Promise<ModelListResult> {
  const srv = getCodexServer();
  if (!(await srv.ensureRunning())) {
    // Fallback: return empty with error
    return { agent: 'codex', models: [], sources: [], note: 'Failed to start codex app-server.' };
  }

  const resp = await srv.call('model/list', { includeHidden: false });
  if (resp.error) {
    return { agent: 'codex', models: [], sources: [], note: resp.error.message || 'model/list failed' };
  }

  const data: any[] = resp.result?.data ?? [];
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  // Place current model first if provided
  if (opts.currentModel?.trim()) {
    pushModel(models, seen, opts.currentModel.trim(), null);
  }

  for (const entry of data) {
    const id = entry.model || entry.id;
    if (!id || seen.has(id)) continue;
    const alias = entry.displayName && entry.displayName !== id ? entry.displayName : null;
    pushModel(models, seen, id, alias);
  }

  return {
    agent: 'codex',
    models,
    sources: ['app-server model/list'],
    note: null,
  };
}

export function listModels(agent: Agent, opts: ModelListOpts = {}): Promise<ModelListResult> {
  return agent === 'codex' ? discoverCodexModels(opts) : Promise.resolve(discoverClaudeModels(opts));
}

// ---------------------------------------------------------------------------
// Usage inspection
// ---------------------------------------------------------------------------

export interface UsageWindowInfo {
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  /**
   * Remaining seconds as reported when the usage snapshot was captured.
   * Combine with `capturedAt` to estimate the current remaining time.
   */
  resetAfterSeconds: number | null;
  status: string | null;
}

export interface UsageResult {
  ok: boolean;
  agent: Agent;
  source: string | null;
  capturedAt: string | null;
  status: string | null;
  windows: UsageWindowInfo[];
  error: string | null;
}

export interface UsageOpts {
  agent: Agent;
  model?: string | null;
}

function toIsoFromEpochSeconds(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function roundPercent(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function labelFromWindowMinutes(value: unknown, fallback: string): string {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes === 300) return '5h';
  if (minutes === 10080) return '7d';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function usageWindowFromRateLimit(fallback: string, limit: any): UsageWindowInfo | null {
  if (!limit || typeof limit !== 'object') return null;

  const usedPercent = roundPercent(limit.used_percent);
  const remainingPercent = usedPercent == null ? null : Math.max(0, Math.round((100 - usedPercent) * 10) / 10);
  const resetAt = toIsoFromEpochSeconds(limit.reset_at ?? limit.resets_at);

  let resetAfterSeconds: number | null = null;
  const directResetAfter = Number(limit.reset_after_seconds);
  if (Number.isFinite(directResetAfter) && directResetAfter >= 0) {
    resetAfterSeconds = Math.round(directResetAfter);
  } else if (resetAt) {
    const resetAtMs = Date.parse(resetAt);
    if (Number.isFinite(resetAtMs)) {
      resetAfterSeconds = Math.max(0, Math.round((resetAtMs - Date.now()) / 1000));
    }
  }

  return {
    label: labelFromWindowMinutes(limit.window_minutes, fallback),
    usedPercent,
    remainingPercent,
    resetAt,
    resetAfterSeconds,
    status: typeof limit.status === 'string' ? limit.status : null,
  };
}

function parseJsonTail(raw: string): any | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(raw.slice(start)); } catch { return null; }
}

function modelFamily(model: string | null | undefined): string | null {
  const lower = model?.toLowerCase() || '';
  if (!lower) return null;
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  return null;
}

function emptyUsage(agent: Agent, error: string): UsageResult {
  return {
    ok: false,
    agent,
    source: null,
    capturedAt: null,
    status: null,
    windows: [],
    error,
  };
}

function getCodexStateDbPath(home: string): string | null {
  const root = path.join(home, '.codex');
  if (!fs.existsSync(root)) return null;
  try {
    const files = fs.readdirSync(root)
      .filter(name => /^state.*\.sqlite$/i.test(name))
      .map(name => ({ name, full: path.join(root, name), mtime: fs.statSync(path.join(root, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.full || null;
  } catch {
    return null;
  }
}

function codexUsageFromRateLimits(rateLimits: any, capturedAt: string | null, source: string): UsageResult | null {
  if (!rateLimits || typeof rateLimits !== 'object') return null;

  const windows = [
    usageWindowFromRateLimit('Primary', rateLimits.primary),
    usageWindowFromRateLimit('Secondary', rateLimits.secondary),
  ].filter((v): v is UsageWindowInfo => !!v);

  if (!windows.length) return null;

  let status: string | null = null;
  if (rateLimits.limit_reached === true) status = 'limit_reached';
  else if (rateLimits.allowed === true) status = 'allowed';

  return {
    ok: true,
    agent: 'codex',
    source,
    capturedAt,
    status,
    windows,
    error: null,
  };
}

function getCodexUsageFromStateDb(home: string): UsageResult | null {
  const dbPath = getCodexStateDbPath(home);
  if (!dbPath) return null;

  try {
    const query = "SELECT ts || '|' || message FROM logs WHERE message LIKE '%codex.rate_limits%' ORDER BY ts DESC LIMIT 1;";
    const out = execSync(`sqlite3 -noheader ${Q(dbPath)} ${Q(query)}`, { encoding: 'utf-8', timeout: 3000 }).trim();
    if (!out) return null;

    const sep = out.indexOf('|');
    const rawTs = sep >= 0 ? out.slice(0, sep) : '';
    const rawMessage = sep >= 0 ? out.slice(sep + 1) : out;
    const payload = parseJsonTail(rawMessage);
    const capturedAt = toIsoFromEpochSeconds(rawTs);
    return codexUsageFromRateLimits(payload?.rate_limits, capturedAt, 'state-db');
  } catch {
    return null;
  }
}

function getCodexUsageFromSessions(home: string): UsageResult | null {
  const sessionsRoot = path.join(home, '.codex', 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;

  const all: { path: string; mtime: number }[] = [];
  try {
    for (const year of fs.readdirSync(sessionsRoot)) {
      const yp = path.join(sessionsRoot, year);
      if (!fs.statSync(yp).isDirectory()) continue;
      for (const month of fs.readdirSync(yp)) {
        const mp = path.join(yp, month);
        if (!fs.statSync(mp).isDirectory()) continue;
        for (const day of fs.readdirSync(mp)) {
          const dp = path.join(mp, day);
          if (!fs.statSync(dp).isDirectory()) continue;
          for (const f of fs.readdirSync(dp)) {
            if (!f.endsWith('.jsonl')) continue;
            const full = path.join(dp, f);
            all.push({ path: full, mtime: fs.statSync(full).mtimeMs });
          }
        }
      }
    }
  } catch {
    return null;
  }

  all.sort((a, b) => b.mtime - a.mtime);
  for (const entry of all.slice(0, 30)) {
    try {
      const lines = fs.readFileSync(entry.path, 'utf-8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 200; i--) {
        const raw = lines[i];
        if (!raw || raw[0] !== '{' || !raw.includes('rate_limits')) continue;
        let ev: any;
        try { ev = JSON.parse(raw); } catch { continue; }
        const result = codexUsageFromRateLimits(
          ev?.payload?.rate_limits,
          typeof ev?.timestamp === 'string' ? ev.timestamp : null,
          'session-history',
        );
        if (result) return result;
      }
    } catch {
      // ignore malformed or unreadable session files
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Claude usage from OAuth API (https://api.anthropic.com/api/oauth/usage)
// ---------------------------------------------------------------------------

function getClaudeOAuthToken(): string | null {
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
      encoding: 'utf-8', timeout: 3000,
    }).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

function getClaudeUsageFromOAuth(): UsageResult | null {
  const token = getClaudeOAuthToken();
  if (!token) return null;

  try {
    const raw = execSync(
      `curl -s --max-time 5 -H "Authorization: Bearer ${token}" -H "anthropic-beta: oauth-2025-04-20" -H "Content-Type: application/json" "https://api.anthropic.com/api/oauth/usage"`,
      { encoding: 'utf-8', timeout: 8000 },
    ).trim();
    if (!raw || raw[0] !== '{') return null;

    const data = JSON.parse(raw);
    const capturedAt = new Date().toISOString();

    const makeWindow = (label: string, entry: any): UsageWindowInfo | null => {
      if (!entry || typeof entry !== 'object') return null;
      const usedPercent = roundPercent(entry.utilization);
      if (usedPercent == null) return null;
      const remainingPercent = Math.max(0, Math.round((100 - usedPercent) * 10) / 10);
      const resetAt = typeof entry.resets_at === 'string' ? entry.resets_at : null;
      let resetAfterSeconds: number | null = null;
      if (resetAt) {
        const resetAtMs = Date.parse(resetAt);
        if (Number.isFinite(resetAtMs)) {
          resetAfterSeconds = Math.max(0, Math.round((resetAtMs - Date.now()) / 1000));
        }
      }
      return {
        label,
        usedPercent,
        remainingPercent,
        resetAt,
        resetAfterSeconds,
        status: usedPercent >= 100 ? 'limit_reached' : usedPercent >= 80 ? 'warning' : 'allowed',
      };
    };

    const windows: UsageWindowInfo[] = [];
    const w5h = makeWindow('5h', data.five_hour);
    if (w5h) windows.push(w5h);
    const w7d = makeWindow('7d', data.seven_day);
    if (w7d) windows.push(w7d);
    const w7dOpus = makeWindow('7d Opus', data.seven_day_opus);
    if (w7dOpus) windows.push(w7dOpus);
    const w7dSonnet = makeWindow('7d Sonnet', data.seven_day_sonnet);
    if (w7dSonnet) windows.push(w7dSonnet);
    const wExtra = makeWindow('Extra', data.extra_usage);
    if (wExtra) windows.push(wExtra);

    if (!windows.length) return null;

    const overallStatus = windows.some(w => w.status === 'limit_reached') ? 'limit_reached'
      : windows.some(w => w.status === 'warning') ? 'warning'
      : 'allowed';

    return {
      ok: true,
      agent: 'claude',
      source: 'oauth-api',
      capturedAt,
      status: overallStatus,
      windows,
      error: null,
    };
  } catch {
    return null;
  }
}

function getClaudeUsageFromTelemetry(home: string, model?: string | null): UsageResult | null {
  const telemetryRoot = path.join(home, '.claude', 'telemetry');
  if (!fs.existsSync(telemetryRoot)) return null;

  const preferredFamily = modelFamily(model);
  type ClaudeTelemetryCandidate = {
    capturedAtMs: number;
    capturedAt: string;
    status: string | null;
    hoursTillReset: number | null;
    model: string | null;
  };
  let bestAny: ClaudeTelemetryCandidate | null = null;
  let bestMatch: ClaudeTelemetryCandidate | null = null;

  try {
    const files = fs.readdirSync(telemetryRoot)
      .filter(name => name.endsWith('.json'))
      .map(name => ({ full: path.join(telemetryRoot, name), mtime: fs.statSync(path.join(telemetryRoot, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 50);

    for (const file of files) {
      const lines = fs.readFileSync(file.full, 'utf-8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const raw = lines[i];
        if (!raw || raw[0] !== '{' || !raw.includes('tengu_claudeai_limits_status_changed')) continue;

        let parsed: any;
        try { parsed = JSON.parse(raw); } catch { continue; }
        const data = parsed?.event_data;
        if (data?.event_name !== 'tengu_claudeai_limits_status_changed') continue;

        const capturedAtMs = Date.parse(data.client_timestamp || '');
        if (!Number.isFinite(capturedAtMs)) continue;

        let meta = data.additional_metadata;
        if (typeof meta === 'string') {
          try { meta = JSON.parse(meta); } catch { meta = null; }
        }

        const hoursTillReset = Number(meta?.hoursTillReset);
        const candidate = {
          capturedAtMs,
          capturedAt: new Date(capturedAtMs).toISOString(),
          status: typeof meta?.status === 'string' ? meta.status : null,
          hoursTillReset: Number.isFinite(hoursTillReset) ? hoursTillReset : null,
          model: typeof data.model === 'string' ? data.model : null,
        };

        if (!bestAny || candidate.capturedAtMs > bestAny.capturedAtMs) bestAny = candidate;
        if (preferredFamily && candidate.model?.toLowerCase().includes(preferredFamily)) {
          if (!bestMatch || candidate.capturedAtMs > bestMatch.capturedAtMs) bestMatch = candidate;
        }
      }
    }
  } catch {
    return null;
  }

  const chosen = bestMatch || bestAny;
  if (!chosen) return null;

  const resetAfterSeconds = chosen.hoursTillReset == null ? null : Math.max(0, Math.round(chosen.hoursTillReset * 3600));
  const resetAt = resetAfterSeconds == null ? null : new Date(chosen.capturedAtMs + resetAfterSeconds * 1000).toISOString();
  const windows: UsageWindowInfo[] = [{
    label: 'Current',
    usedPercent: null,
    remainingPercent: null,
    resetAt,
    resetAfterSeconds,
    status: chosen.status,
  }];

  return {
    ok: true,
    agent: 'claude',
    source: 'telemetry',
    capturedAt: chosen.capturedAt,
    status: chosen.status,
    windows,
    error: null,
  };
}

export function getUsage(opts: UsageOpts): UsageResult {
  const home = process.env.HOME || '';
  if (!home) return emptyUsage(opts.agent, 'HOME is not set.');

  if (opts.agent === 'codex') {
    return getCodexUsageFromStateDb(home)
      || getCodexUsageFromSessions(home)
      || emptyUsage('codex', 'No recent Codex usage data found.');
  }

  return getClaudeUsageFromOAuth()
    || getClaudeUsageFromTelemetry(home, opts.model)
    || emptyUsage('claude', 'No recent Claude usage data found.');
}

// ---------------------------------------------------------------------------
// Live Codex usage via shared app-server connection
// ---------------------------------------------------------------------------

function parseRateLimitWindow(label: string, rl: any): UsageWindowInfo | null {
  if (!rl || typeof rl !== 'object') return null;
  const usedPercent = roundPercent(rl.usedPercent);
  return {
    label: labelFromWindowMinutes(rl.windowDurationMins, label),
    usedPercent,
    remainingPercent: usedPercent == null ? null : Math.max(0, Math.round((100 - usedPercent) * 10) / 10),
    resetAt: toIsoFromEpochSeconds(rl.resetsAt),
    resetAfterSeconds: rl.resetsAt ? Math.max(0, Math.round(rl.resetsAt - Date.now() / 1000)) : null,
    status: null,
  };
}

export async function getCodexUsageLive(): Promise<UsageResult> {
  const home = process.env.HOME || '';
  const srv = getCodexServer();
  if (!(await srv.ensureRunning())) {
    return getCodexUsageFromStateDb(home) || emptyUsage('codex', 'Failed to start codex app-server.');
  }

  const resp = await srv.call('account/rateLimits/read');
  if (resp.error) {
    return getCodexUsageFromStateDb(home) || emptyUsage('codex', resp.error.message || 'account/rateLimits/read failed');
  }

  const rl = resp.result?.rateLimits;
  if (!rl) {
    return getCodexUsageFromStateDb(home) || emptyUsage('codex', 'No rate limits in response.');
  }

  const capturedAt = new Date().toISOString();
  const windows: UsageWindowInfo[] = [];
  const w1 = parseRateLimitWindow('Primary', rl.primary);
  if (w1) windows.push(w1);
  const w2 = parseRateLimitWindow('Secondary', rl.secondary);
  if (w2) windows.push(w2);

  return {
    ok: windows.length > 0,
    agent: 'codex',
    source: 'app-server-live',
    capturedAt,
    status: null,
    windows,
    error: windows.length > 0 ? null : 'No rate limit windows.',
  };
}

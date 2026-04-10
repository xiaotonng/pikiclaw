/**
 * Session workspace management, metadata persistence, classification, and export/import.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ManagedSessionRecord,
  SessionRunState,
  SessionClassification,
  SessionInfo,
  StreamResult,
  StreamPreviewPlan,
  Agent,
  SessionMessagesOpts,
  SessionMessagesResult,
  TailMessage,
  RichMessage,
  ExportSessionOpts,
  ExportSessionResult,
  ImportSessionOpts,
  ImportSessionResult,
  StreamOpts,
  EnsureManagedSessionOpts,
  StageSessionFilesOpts,
  StageSessionFilesResult,
  SessionListOpts,
  SessionListResult,
  SessionTailOpts,
  SessionTailResult,
  SessionMessagesWindow,
} from './types.js';
import {
  dedupeStrings,
  shortValue,
  firstNonEmptyLine,
  normalizeErrorMessage,
  normalizeStreamPreviewPlan,
  isPendingSessionId,
  agentLog,
} from './utils.js';
import { getDriver } from './driver.js';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }

function readJsonFile<T>(filePath: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T; } catch { return fallback; }
}

function writeJsonFile(filePath: string, value: unknown) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function removeFileIfExists(filePath: string) { try { fs.rmSync(filePath, { force: true }); } catch {} }

function trimSessionText(value: unknown, max = 24_000): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PIKICLAW_DIR = '.pikiclaw';
const PIKICLAW_SESSIONS_DIR = path.join(PIKICLAW_DIR, 'sessions');
const PIKICLAW_SESSION_INDEX = path.join(PIKICLAW_SESSIONS_DIR, 'index.json');
const PIKICLAW_LEGACY_WORKSPACES_DIR = path.join(PIKICLAW_DIR, 'workspaces');
const SESSION_WORKSPACE_DIR = 'workspace';
const SESSION_META_FILE = 'session.json';
// return.json and artifact constants removed — file return is now handled by MCP bridge

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function sessionIndexPath(workdir: string): string { return path.join(workdir, PIKICLAW_SESSION_INDEX); }
function sessionDirPath(workdir: string, agent: Agent, sessionId: string): string { return path.join(workdir, PIKICLAW_SESSIONS_DIR, agent, sessionId); }
function legacySessionWorkspacePath(workdir: string, agent: Agent, sessionId: string): string { return path.join(workdir, PIKICLAW_LEGACY_WORKSPACES_DIR, agent, sessionId); }
function sessionWorkspacePath(workdir: string, agent: Agent, sessionId: string): string { return path.join(sessionDirPath(workdir, agent, sessionId), SESSION_WORKSPACE_DIR); }
function sessionRootFromWorkspacePath(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  return path.basename(resolved) === SESSION_WORKSPACE_DIR ? path.dirname(resolved) : resolved;
}
function sessionMetaPath(workspacePath: string): string { return path.join(sessionRootFromWorkspacePath(workspacePath), SESSION_META_FILE); }
function legacySessionMetaPath(workspacePath: string): string { return path.join(workspacePath, PIKICLAW_DIR, SESSION_META_FILE); }

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

/** Generate a temporary session ID for new sessions before the agent assigns one. */
function nextPendingSessionId(): string { return `pending_${crypto.randomBytes(6).toString('hex')}`; }
function nextThreadId(): string { return `thread_${crypto.randomBytes(6).toString('hex')}`; }
function legacyThreadId(agent: Agent, sessionId: string): string { return `legacy:${agent}:${sessionId}`; }
function normalizeThreadId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// Run state helpers
// ---------------------------------------------------------------------------

function normalizeSessionRunState(rawState: unknown): SessionRunState {
  const state = typeof rawState === 'string' ? rawState.trim().toLowerCase() : '';
  if (state === 'completed' || state === 'incomplete' || state === 'running') return state;
  return 'completed';
}

function normalizeSessionRunDetail(_rawState: unknown, rawDetail: unknown): string | null {
  const detail = typeof rawDetail === 'string' ? rawDetail.trim() : '';
  if (detail) return shortValue(detail, 180);
  return null;
}

function normalizeSessionRunUpdatedAt(rawUpdatedAt: unknown, fallback: string): string {
  return typeof rawUpdatedAt === 'string' && rawUpdatedAt.trim() ? rawUpdatedAt : fallback;
}

export function setSessionRunState(record: ManagedSessionRecord, runState: SessionRunState, runDetail: string | null, runUpdatedAt?: string) {
  record.runState = runState;
  record.runDetail = runDetail ? shortValue(runDetail, 180) : null;
  record.runUpdatedAt = runUpdatedAt || new Date().toISOString();
}

function incompleteRunDetail(result: Pick<StreamResult, 'error' | 'stopReason' | 'message'>): string | null {
  if (result.stopReason === 'interrupted') return 'Interrupted by user.';
  if (result.stopReason === 'timeout') return 'Timed out before completion.';
  if (result.stopReason === 'max_tokens') return 'Stopped before completion: max tokens reached.';
  const error = normalizeErrorMessage(result.error);
  if (error) return shortValue(error, 180);
  const stopReason = normalizeErrorMessage(result.stopReason);
  if (stopReason) return `Stopped before completion: ${shortValue(stopReason, 120)}`;
  const message = firstNonEmptyLine(result.message || '');
  return message ? shortValue(message, 180) : 'Last run did not complete.';
}

export function applySessionRunResult(
  record: ManagedSessionRecord,
  result: Pick<StreamResult, 'ok' | 'incomplete' | 'error' | 'stopReason' | 'message'> & { activity?: string | null },
) {
  if (result.ok && !result.incomplete) {
    setSessionRunState(record, 'completed', null);
  } else {
    setSessionRunState(record, 'incomplete', incompleteRunDetail(result));
  }

  // Auto-classify the stream result
  const classification = classifySession({ ...result, activity: result.activity ?? null });
  record.classification = classification;
  // Only set userStatus if not manually overridden by the user
  if (!record.userStatus) {
    record.userStatus = deriveUserStatus(classification.outcome);
  }
}

// ---------------------------------------------------------------------------
// Record normalization
// ---------------------------------------------------------------------------

interface SessionIndexData {
  version: number;
  sessions: ManagedSessionRecord[];
}

interface EnsureSessionWorkspaceOpts {
  agent: Agent;
  workdir: string;
  sessionId?: string | null;
  title?: string | null;
  threadId?: string | null;
}

interface SessionWorkspaceInfo {
  sessionId: string;
  workspacePath: string;
  record: ManagedSessionRecord;
}

function normalizeSessionRecord(raw: any, workdir: string): ManagedSessionRecord | null {
  // Support both new format (sessionId) and legacy format (localSessionId + engineSessionId)
  const sessionId = typeof raw?.sessionId === 'string' ? raw.sessionId.trim()
    : typeof raw?.engineSessionId === 'string' && raw.engineSessionId.trim() ? raw.engineSessionId.trim()
    : typeof raw?.localSessionId === 'string' ? raw.localSessionId.trim()
    : '';
  const agent = typeof raw?.agent === 'string' ? raw.agent.trim() : null;
  if (!sessionId || !agent) return null;
  const workspacePath = typeof raw?.workspacePath === 'string' && raw.workspacePath.trim()
    ? path.resolve(raw.workspacePath)
    : sessionWorkspacePath(workdir, agent, sessionId);
  return {
    sessionId, agent, workdir,
    workspacePath,
    threadId: normalizeThreadId(raw?.threadId) || legacyThreadId(agent, sessionId),
    createdAt: typeof raw?.createdAt === 'string' && raw.createdAt.trim() ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw?.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt : new Date().toISOString(),
    title: typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim() : null,
    model: typeof raw?.model === 'string' && raw.model.trim() ? raw.model.trim() : null,
    stagedFiles: Array.isArray(raw?.stagedFiles) ? dedupeStrings(raw.stagedFiles.filter((v: unknown) => typeof v === 'string')) : [],
    runState: normalizeSessionRunState(raw?.runState),
    runDetail: normalizeSessionRunDetail(raw?.runState, raw?.runDetail),
    runUpdatedAt: normalizeSessionRunUpdatedAt(raw?.runUpdatedAt, typeof raw?.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt : new Date().toISOString()),
    classification: raw?.classification ?? null,
    userStatus: raw?.userStatus ?? null,
    userNote: typeof raw?.userNote === 'string' ? raw.userNote : null,
    lastQuestion: typeof raw?.lastQuestion === 'string' ? raw.lastQuestion : null,
    lastAnswer: typeof raw?.lastAnswer === 'string' ? raw.lastAnswer : null,
    lastMessageText: typeof raw?.lastMessageText === 'string' ? raw.lastMessageText : null,
    lastThinking: trimSessionText(raw?.lastThinking),
    lastPlan: normalizeStreamPreviewPlan(raw?.lastPlan),
    migratedFrom: raw?.migratedFrom ?? null,
    migratedTo: raw?.migratedTo ?? null,
    linkedSessions: Array.isArray(raw?.linkedSessions) ? raw.linkedSessions : [],
  };
}

// ---------------------------------------------------------------------------
// Index persistence
// ---------------------------------------------------------------------------

function loadSessionIndex(workdir: string): SessionIndexData {
  const parsed = readJsonFile<any>(sessionIndexPath(workdir), { version: 1, sessions: [] });
  const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  return {
    version: 1,
    sessions: sessions
      .map((entry: any) => normalizeSessionRecord(entry, workdir))
      .filter((entry: ManagedSessionRecord | null): entry is ManagedSessionRecord => !!entry)
      .filter((entry: ManagedSessionRecord) => !isPendingSessionId(entry.sessionId) || fs.existsSync(sessionRootFromWorkspacePath(entry.workspacePath))),
  };
}

function writeSessionIndex(workdir: string, sessions: ManagedSessionRecord[]) {
  writeJsonFile(sessionIndexPath(workdir), { version: 1, sessions });
}

function writeSessionMeta(record: ManagedSessionRecord) {
  writeJsonFile(sessionMetaPath(record.workspacePath), {
    sessionId: record.sessionId, agent: record.agent, workdir: record.workdir,
    workspacePath: record.workspacePath,
    threadId: record.threadId,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
    title: record.title, model: record.model, stagedFiles: record.stagedFiles,
    runState: record.runState, runDetail: record.runDetail, runUpdatedAt: record.runUpdatedAt,
    classification: record.classification,
    userStatus: record.userStatus,
    userNote: record.userNote,
    lastQuestion: record.lastQuestion,
    lastAnswer: record.lastAnswer,
    lastMessageText: record.lastMessageText,
    lastThinking: record.lastThinking,
    lastPlan: record.lastPlan,
    migratedFrom: record.migratedFrom,
    migratedTo: record.migratedTo,
    linkedSessions: record.linkedSessions,
  });
}

// ---------------------------------------------------------------------------
// File / directory helpers
// ---------------------------------------------------------------------------

function copyPath(sourcePath: string, targetPath: string) {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) { fs.cpSync(sourcePath, targetPath, { recursive: true, force: true }); return; }
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function createSessionDirAlias(aliasPath: string, targetPath: string) {
  if (fs.existsSync(aliasPath) || !fs.existsSync(targetPath)) return;
  try {
    ensureDir(path.dirname(aliasPath));
    const relativeTarget = path.relative(path.dirname(aliasPath), targetPath) || '.';
    fs.symlinkSync(relativeTarget, aliasPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {}
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

function migrateSessionLayout(workdir: string, record: ManagedSessionRecord): ManagedSessionRecord {
  const targetSessionDir = sessionDirPath(workdir, record.agent, record.sessionId);
  const targetWorkspacePath = sessionWorkspacePath(workdir, record.agent, record.sessionId);
  const currentWorkspacePath = path.resolve(record.workspacePath || targetWorkspacePath);
  const legacyWp = path.resolve(legacySessionWorkspacePath(workdir, record.agent, record.sessionId));

  ensureDir(targetSessionDir);
  ensureDir(targetWorkspacePath);

  for (const sourceWorkspacePath of dedupeStrings([currentWorkspacePath, legacyWp])) {
    if (sourceWorkspacePath === targetWorkspacePath || !fs.existsSync(sourceWorkspacePath)) continue;
    if (!fs.statSync(sourceWorkspacePath).isDirectory()) continue;
    for (const entry of fs.readdirSync(sourceWorkspacePath)) {
      if (entry === PIKICLAW_DIR) continue;
      copyPath(path.join(sourceWorkspacePath, entry), path.join(targetWorkspacePath, entry));
    }
    if (sourceWorkspacePath === legacyWp) fs.rmSync(sourceWorkspacePath, { recursive: true, force: true });
  }
  record.workspacePath = path.resolve(targetWorkspacePath);
  return record;
}

// ---------------------------------------------------------------------------
// Save / update
// ---------------------------------------------------------------------------

export function saveSessionRecord(workdir: string, record: ManagedSessionRecord): ManagedSessionRecord {
  record = migrateSessionLayout(workdir, record);
  ensureDir(sessionDirPath(workdir, record.agent, record.sessionId));
  ensureDir(record.workspacePath);
  const index = loadSessionIndex(workdir);
  record.threadId = normalizeThreadId(record.threadId) || legacyThreadId(record.agent, record.sessionId);
  record.updatedAt = new Date().toISOString();
  const pos = index.sessions.findIndex(entry => entry.agent === record.agent && entry.sessionId === record.sessionId);
  if (pos >= 0) index.sessions[pos] = record;
  else index.sessions.unshift(record);
  index.sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  writeSessionIndex(workdir, index.sessions);
  writeSessionMeta(record);
  return record;
}

/**
 * Update mutable session metadata (classification, userStatus, userNote, links, migration)
 * for an existing pikiclaw-managed session. Returns true if the record was found and updated.
 */
export function updateSessionMeta(
  workdir: string,
  agent: Agent,
  sessionId: string,
  patch: Partial<Pick<ManagedSessionRecord, 'userStatus' | 'userNote' | 'classification' | 'migratedFrom' | 'migratedTo'>> & {
    addLink?: { agent: Agent; sessionId: string };
  },
): boolean {
  const resolvedWorkdir = path.resolve(workdir);
  const index = loadSessionIndex(resolvedWorkdir);
  const record = index.sessions.find(s => s.sessionId === sessionId && s.agent === agent);
  if (!record) return false;

  if (patch.userStatus !== undefined) record.userStatus = patch.userStatus;
  if (patch.userNote !== undefined) record.userNote = patch.userNote;
  if (patch.classification !== undefined) record.classification = patch.classification;
  if (patch.migratedFrom !== undefined) record.migratedFrom = patch.migratedFrom;
  if (patch.migratedTo !== undefined) record.migratedTo = patch.migratedTo;
  if (patch.addLink) {
    if (!record.linkedSessions) record.linkedSessions = [];
    const exists = record.linkedSessions.some(
      l => l.agent === patch.addLink!.agent && l.sessionId === patch.addLink!.sessionId,
    );
    if (!exists) record.linkedSessions.push(patch.addLink);
  }

  record.updatedAt = new Date().toISOString();
  writeSessionIndex(resolvedWorkdir, index.sessions);
  writeSessionMeta(record);
  return true;
}

/**
 * Promote a pending session to a real session ID. Renames the workspace directory
 * and updates the index. Called after the first stream returns the agent's native ID.
 */
export function promoteSessionId(workdir: string, agent: Agent, pendingId: string, nativeId: string): void {
  if (!isPendingSessionId(pendingId) || !nativeId.trim()) return;
  const resolvedWorkdir = path.resolve(workdir);
  const index = loadSessionIndex(resolvedWorkdir);
  const record = index.sessions.find(entry => entry.sessionId === pendingId && entry.agent === agent);
  if (!record) return;

  const oldDir = sessionDirPath(resolvedWorkdir, agent, pendingId);
  const newDir = sessionDirPath(resolvedWorkdir, agent, nativeId);

  // Move workspace directory if it exists
  if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
    try { fs.renameSync(oldDir, newDir); } catch { /* cross-device: copy+delete */ try { fs.cpSync(oldDir, newDir, { recursive: true }); fs.rmSync(oldDir, { recursive: true, force: true }); } catch {} }
    createSessionDirAlias(oldDir, newDir);
  }

  writeSessionIndex(
    resolvedWorkdir,
    index.sessions.filter(entry => entry.agent !== agent || (entry.sessionId !== pendingId && entry.sessionId !== nativeId)),
  );
  record.sessionId = nativeId;
  record.workspacePath = sessionWorkspacePath(resolvedWorkdir, agent, nativeId);
  saveSessionRecord(resolvedWorkdir, record);
}

// ---------------------------------------------------------------------------
// Identity sync
// ---------------------------------------------------------------------------

export function syncManagedSessionIdentity(session: SessionWorkspaceInfo, workdir: string, nativeId: string): boolean {
  const resolvedId = nativeId.trim();
  if (!resolvedId || session.sessionId === resolvedId) return false;

  const resolvedWorkdir = path.resolve(workdir);
  const previousId = session.sessionId;
  if (isPendingSessionId(previousId)) {
    promoteSessionId(resolvedWorkdir, session.record.agent, previousId, resolvedId);
  }

  session.sessionId = resolvedId;
  session.workspacePath = sessionWorkspacePath(resolvedWorkdir, session.record.agent, resolvedId);
  session.record.sessionId = resolvedId;
  session.record.workspacePath = session.workspacePath;
  return true;
}

// ---------------------------------------------------------------------------
// Title / filename helpers
// ---------------------------------------------------------------------------

export function summarizePromptTitle(prompt: string | null | undefined): string | null {
  const raw = String(prompt || '').replace(/\r\n?/g, '\n');
  const text = firstNonEmptyLine(raw).replace(/\s+/g, ' ').trim()
    || raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length <= 120 ? text : `${text.slice(0, 117).trimEnd()}...`;
}

function safeWorkspaceFilename(filename: string): string {
  const base = path.basename(filename || 'file');
  const sanitized = base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim();
  return sanitized || `file-${Date.now()}`;
}

function uniqueWorkspaceFilename(workspacePath: string, desiredName: string): string {
  const ext = path.extname(desiredName);
  const stem = ext ? desiredName.slice(0, -ext.length) : desiredName;
  let candidate = desiredName;
  let index = 2;
  while (fs.existsSync(path.join(workspacePath, candidate))) { candidate = `${stem}-${index}${ext}`; index++; }
  return candidate;
}

// ---------------------------------------------------------------------------
// Workspace file import
// ---------------------------------------------------------------------------

export function importFilesIntoWorkspace(workspacePath: string, files: string[]): string[] {
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
    fs.copyFileSync(sourcePath, path.join(workspacePath, targetName));
    imported.push(targetName);
  }
  return dedupeStrings(imported);
}

// ---------------------------------------------------------------------------
// Ensure session workspace
// ---------------------------------------------------------------------------

export function ensureSessionWorkspace(opts: EnsureSessionWorkspaceOpts): SessionWorkspaceInfo {
  const workdir = path.resolve(opts.workdir);
  const index = loadSessionIndex(workdir);
  let record = index.sessions.find(entry => entry.agent === opts.agent && opts.sessionId && entry.sessionId === opts.sessionId)
    || null;
  if (!record) {
    const sessionId = opts.sessionId?.trim() || nextPendingSessionId();
    const threadId = normalizeThreadId(opts.threadId)
      || (opts.sessionId ? legacyThreadId(opts.agent, sessionId) : nextThreadId());
    record = {
      sessionId, agent: opts.agent, workdir,
      workspacePath: sessionWorkspacePath(workdir, opts.agent, sessionId),
      threadId,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      title: summarizePromptTitle(opts.title) || null, model: null, stagedFiles: [],
      runState: 'completed', runDetail: null, runUpdatedAt: new Date().toISOString(),
      classification: null, userStatus: null, userNote: null,
      lastQuestion: null, lastAnswer: null, lastMessageText: null,
      lastThinking: null, lastPlan: null,
      migratedFrom: null, migratedTo: null, linkedSessions: [],
    };
  }
  if (!record.threadId) record.threadId = normalizeThreadId(opts.threadId) || legacyThreadId(record.agent, record.sessionId);
  if (!record.title && opts.title) record.title = summarizePromptTitle(opts.title);
  record.workspacePath = path.resolve(record.workspacePath);
  saveSessionRecord(workdir, record);
  return { sessionId: record.sessionId, workspacePath: record.workspacePath, record };
}

// ---------------------------------------------------------------------------
// Record to SessionInfo
// ---------------------------------------------------------------------------

function managedRecordToSessionInfo(record: ManagedSessionRecord): SessionInfo {
  return {
    sessionId: record.sessionId,
    agent: record.agent,
    workdir: record.workdir,
    workspacePath: record.workspacePath,
    threadId: record.threadId,
    model: record.model,
    createdAt: record.createdAt,
    title: record.title,
    running: record.runState === 'running',
    runState: record.runState,
    runDetail: record.runDetail,
    runUpdatedAt: record.runUpdatedAt,
    classification: record.classification,
    userStatus: record.userStatus,
    userNote: record.userNote,
    lastQuestion: record.lastQuestion,
    lastAnswer: record.lastAnswer,
    lastMessageText: record.lastMessageText,
    migratedFrom: record.migratedFrom,
    migratedTo: record.migratedTo,
    linkedSessions: record.linkedSessions,
    numTurns: record.numTurns ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public session queries
// ---------------------------------------------------------------------------

// Exported for drivers
export function listPikiclawSessions(workdir: string, agent: Agent, limit?: number): ManagedSessionRecord[] {
  const records = loadSessionIndex(path.resolve(workdir)).sessions
    .filter(entry => entry.agent === agent)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return typeof limit === 'number' ? records.slice(0, limit) : records;
}

export function findPikiclawSession(workdir: string, agent: Agent, sessionId: string): ManagedSessionRecord | null {
  return listPikiclawSessions(workdir, agent).find(entry => entry.sessionId === sessionId) || null;
}

export function ensureManagedSession(opts: EnsureManagedSessionOpts): SessionInfo {
  const session = ensureSessionWorkspace({
    agent: opts.agent,
    workdir: opts.workdir,
    sessionId: opts.sessionId,
    title: opts.title,
    threadId: opts.threadId,
  });
  if (!session.record.title && opts.title) session.record.title = summarizePromptTitle(opts.title);
  if (!session.record.model && opts.model) session.record.model = opts.model.trim() || null;
  saveSessionRecord(opts.workdir, session.record);
  return managedRecordToSessionInfo(session.record);
}

export function findManagedThreadSession(workdir: string, threadId: string, agent: Agent): SessionInfo | null {
  const record = loadSessionIndex(path.resolve(workdir)).sessions
    .filter(entry => entry.threadId === threadId && entry.agent === agent)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] || null;
  return record ? managedRecordToSessionInfo(record) : null;
}

/**
 * Find the most recently updated session sharing a threadId but from a *different* agent.
 * Used to carry conversation context across agent switches.
 */
export function findThreadSessionAcrossAgents(workdir: string, threadId: string, excludeAgent: Agent): SessionInfo | null {
  const record = loadSessionIndex(path.resolve(workdir)).sessions
    .filter(entry => entry.threadId === threadId && entry.agent !== excludeAgent)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] || null;
  return record ? managedRecordToSessionInfo(record) : null;
}

export function stageSessionFiles(opts: StageSessionFilesOpts): StageSessionFilesResult {
  const session = ensureSessionWorkspace({
    agent: opts.agent,
    workdir: opts.workdir,
    sessionId: opts.sessionId,
    title: opts.title,
    threadId: opts.threadId,
  });
  const importedFiles = importFilesIntoWorkspace(session.workspacePath, opts.files);
  if (importedFiles.length) {
    session.record.stagedFiles = dedupeStrings([...session.record.stagedFiles, ...importedFiles]);
    /* title will be set when the first text prompt arrives */
    saveSessionRecord(opts.workdir, session.record);
  }
  return { sessionId: session.sessionId, workspacePath: session.workspacePath, threadId: session.record.threadId, importedFiles };
}

// ---------------------------------------------------------------------------
// Merge managed and native sessions
// ---------------------------------------------------------------------------

function sessionTimelineAt(session: Pick<SessionInfo, 'runUpdatedAt' | 'createdAt'>): number {
  const ts = Date.parse(session.runUpdatedAt || session.createdAt || '');
  return Number.isFinite(ts) ? ts : Number.NEGATIVE_INFINITY;
}

function preferNativeSessionTimeline(managed: SessionInfo, native: SessionInfo): boolean {
  const managedTs = sessionTimelineAt(managed);
  const nativeTs = sessionTimelineAt(native);
  return nativeTs > managedTs;
}

export function mergeManagedAndNativeSessions(managedSessions: SessionInfo[], nativeSessions: SessionInfo[]): SessionInfo[] {
  const managedById = new Map<string, SessionInfo>();
  const merged: SessionInfo[] = [];
  const seen = new Set<string>();

  for (const session of managedSessions) {
    if (!session.sessionId || isPendingSessionId(session.sessionId)) continue;
    managedById.set(session.sessionId, session);
  }

  for (const native of nativeSessions) {
    const sessionId = native.sessionId;
    if (sessionId) seen.add(sessionId);
    const managed = sessionId ? managedById.get(sessionId) : null;
    if (!managed) {
      merged.push(native);
      continue;
    }
    const useNativeTimeline = preferNativeSessionTimeline(managed, native);
    merged.push({
      ...managed,
      ...native,
      workdir: native.workdir || managed.workdir,
      workspacePath: managed.workspacePath || native.workspacePath,
      threadId: managed.threadId ?? native.threadId ?? null,
      running: managed.running || native.running,
      runState: managed.runState === 'running'
        ? managed.runState
        : (useNativeTimeline ? native.runState : managed.runState),
      runDetail: useNativeTimeline ? (native.runDetail ?? managed.runDetail) : (managed.runDetail ?? native.runDetail),
      runUpdatedAt: useNativeTimeline ? (native.runUpdatedAt ?? managed.runUpdatedAt) : (managed.runUpdatedAt ?? native.runUpdatedAt),
      title: native.title || managed.title,
      model: native.model || managed.model,
      createdAt: native.createdAt || managed.createdAt,
      classification: managed.classification ?? native.classification ?? null,
      userStatus: managed.userStatus ?? native.userStatus ?? null,
      userNote: managed.userNote ?? native.userNote ?? null,
      lastQuestion: useNativeTimeline
        ? (native.lastQuestion ?? managed.lastQuestion ?? null)
        : (managed.lastQuestion ?? native.lastQuestion ?? null),
      lastAnswer: useNativeTimeline
        ? (native.lastAnswer ?? managed.lastAnswer ?? null)
        : (managed.lastAnswer ?? native.lastAnswer ?? null),
      lastMessageText: useNativeTimeline
        ? (native.lastMessageText ?? managed.lastMessageText ?? native.lastAnswer ?? native.lastQuestion ?? managed.lastAnswer ?? managed.lastQuestion ?? null)
        : (managed.lastMessageText ?? native.lastMessageText ?? managed.lastAnswer ?? managed.lastQuestion ?? native.lastAnswer ?? native.lastQuestion ?? null),
      migratedFrom: managed.migratedFrom ?? native.migratedFrom ?? null,
      migratedTo: managed.migratedTo ?? native.migratedTo ?? null,
      linkedSessions: managed.linkedSessions?.length ? managed.linkedSessions : (native.linkedSessions ?? []),
      numTurns: useNativeTimeline ? (native.numTurns ?? managed.numTurns ?? null) : (managed.numTurns ?? native.numTurns ?? null),
    });
  }

  for (const managed of managedSessions) {
    if (!managed.sessionId || isPendingSessionId(managed.sessionId) || seen.has(managed.sessionId)) continue;
    merged.push(managed);
  }

  merged.sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));
  return merged;
}

// ---------------------------------------------------------------------------
// getSessions / getSessionTail / getSessionMessages
// ---------------------------------------------------------------------------

export function getSessions(opts: SessionListOpts): Promise<SessionListResult> {
  const workdir = path.resolve(opts.workdir);
  agentLog(`[sessions] request agent=${opts.agent} workdir=${workdir} limit=${opts.limit ?? 'all'}`);
  return getDriver(opts.agent).getSessions(workdir, opts.limit).then(result => {
    agentLog(`[sessions] result agent=${opts.agent} ok=${result.ok} count=${result.sessions.length} error=${result.error || '(none)'}`);
    return result;
  });
}

export function getSessionTail(opts: SessionTailOpts): Promise<SessionTailResult> {
  return getDriver(opts.agent).getSessionTail(opts);
}

export function getSessionMessages(opts: SessionMessagesOpts & { agent: Agent }): Promise<SessionMessagesResult> {
  return getDriver(opts.agent).getSessionMessages(opts);
}

// ---------------------------------------------------------------------------
// Turn windowing
// ---------------------------------------------------------------------------

function normalizeTurnWindowValue(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value == null) return fallback;
  return Math.max(0, Math.floor(value));
}

/** Slice messages by turn window and count total turns. Exported for drivers. */
export function applyTurnWindow(
  allMsgs: TailMessage[],
  opts: Pick<SessionMessagesOpts, 'lastNTurns' | 'turnOffset' | 'turnLimit'> = {},
  richMsgs?: RichMessage[],
): SessionMessagesResult {
  let totalTurns = 0;
  const turnStartIndexes: number[] = [];
  for (let i = 0; i < allMsgs.length; i++) {
    if (allMsgs[i].role === 'user') {
      turnStartIndexes.push(i);
      totalTurns++;
    }
  }

  // If no rich messages provided, synthesize from plain messages so the
  // API always returns a consistent richMessages array.
  const rich = richMsgs ?? allMsgs.map(m => ({ role: m.role, text: m.text, blocks: [{ type: 'text' as const, content: m.text }] }));

  if (totalTurns <= 0) {
    return {
      ok: true,
      messages: allMsgs,
      richMessages: rich,
      totalTurns,
      window: {
        offset: 0,
        limit: 0,
        returnedTurns: 0,
        totalTurns: 0,
        hasOlder: false,
        hasNewer: false,
        startTurn: 0,
        endTurn: 0,
      },
      error: null,
    };
  }

  const offset = normalizeTurnWindowValue(opts.turnOffset, 0);
  const availableTurns = Math.max(0, totalTurns - offset);
  const rawLimit = normalizeTurnWindowValue(opts.turnLimit ?? opts.lastNTurns, availableTurns);
  const limit = rawLimit > 0 ? Math.min(rawLimit, availableTurns) : availableTurns;

  if (limit <= 0 || availableTurns <= 0) {
    const emptyTurn = Math.max(0, totalTurns - offset);
    return {
      ok: true,
      messages: [],
      richMessages: [],
      totalTurns,
      window: {
        offset,
        limit,
        returnedTurns: 0,
        totalTurns,
        hasOlder: emptyTurn > 0,
        hasNewer: offset > 0,
        startTurn: emptyTurn,
        endTurn: emptyTurn,
      },
      error: null,
    };
  }

  const endTurn = Math.max(0, totalTurns - offset);
  const startTurn = Math.max(0, endTurn - limit);
  const startIdx = turnStartIndexes[startTurn] ?? 0;
  const endIdx = endTurn < totalTurns ? (turnStartIndexes[endTurn] ?? allMsgs.length) : allMsgs.length;

  return {
    ok: true,
    messages: allMsgs.slice(startIdx, endIdx),
    richMessages: rich.slice(startIdx, endIdx),
    totalTurns,
    window: {
      offset,
      limit,
      returnedTurns: endTurn - startTurn,
      totalTurns,
      hasOlder: startTurn > 0,
      hasNewer: endTurn < totalTurns,
      startTurn,
      endTurn,
    },
    error: null,
  };
}

/** Filter messages to last N turns and count total turns. Exported for drivers. */
export function applyTurnFilter(allMsgs: TailMessage[], lastNTurns?: number, richMsgs?: RichMessage[]): SessionMessagesResult {
  return applyTurnWindow(allMsgs, { lastNTurns }, richMsgs);
}

// ---------------------------------------------------------------------------
// Session classification
// ---------------------------------------------------------------------------

const PROPOSAL_PATTERNS = /方案|option[s ]?[A-C]|plan|approach|建议|recommend|alternatively|trade-?off|pros?\s+(and|&)\s+cons?|选择|比较/i;
const IMPLEMENTATION_PATTERNS = /已完成|committed|done|implemented|fixed|created|wrote|修复|完成|写入|提交|applied|updated|modified|refactored/i;
const BLOCKED_PATTERNS = /error|failed|permission denied|cannot|无法|失败|报错|blocked|timed?\s*out/i;

export function classifySession(
  result: Pick<StreamResult, 'ok' | 'incomplete' | 'error' | 'stopReason' | 'message' | 'activity'>,
): SessionClassification {
  const now = new Date().toISOString();
  const message = result.message || '';
  const firstLine = message.split('\n').find(l => l.trim())?.trim() || '';
  const summaryText = firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;

  // 1. Structural signals from StreamResult
  if (result.incomplete) {
    return {
      outcome: 'partial',
      suggestedNextAction: result.stopReason === 'interrupted' ? 'Resume or restart the interrupted task' : 'Continue the incomplete task',
      summary: summaryText || 'Task did not complete',
      classifiedAt: now,
    };
  }

  if (!result.ok) {
    const errorDetail = result.error || result.stopReason || 'unknown error';
    return {
      outcome: 'blocked',
      suggestedNextAction: `Resolve error: ${errorDetail.slice(0, 100)}`,
      summary: summaryText || `Failed: ${errorDetail.slice(0, 100)}`,
      classifiedAt: now,
    };
  }

  // 2. Activity signals (tool use indicates implementation)
  const activity = result.activity || '';
  if (/\b(Edit|Write|Bash)\b/.test(activity)) {
    return {
      outcome: 'implementation',
      suggestedNextAction: 'Verify the changes made',
      summary: summaryText,
      classifiedAt: now,
    };
  }

  // 3. Content-based classification
  if (BLOCKED_PATTERNS.test(message.slice(0, 500))) {
    return {
      outcome: 'blocked',
      suggestedNextAction: 'Review the error and provide guidance',
      summary: summaryText,
      classifiedAt: now,
    };
  }

  if (PROPOSAL_PATTERNS.test(message.slice(0, 1000))) {
    return {
      outcome: 'proposal',
      suggestedNextAction: 'Review the proposal and decide on next steps',
      summary: summaryText,
      classifiedAt: now,
    };
  }

  if (IMPLEMENTATION_PATTERNS.test(message.slice(0, 500))) {
    return {
      outcome: 'implementation',
      suggestedNextAction: 'Verify the changes made',
      summary: summaryText,
      classifiedAt: now,
    };
  }

  // 4. Default: informational answer
  return {
    outcome: 'answer',
    suggestedNextAction: null,
    summary: summaryText,
    classifiedAt: now,
  };
}

/** Derive a default userStatus from classification outcome */
export function deriveUserStatus(outcome: SessionClassification['outcome']): 'review' | 'done' | 'active' {
  switch (outcome) {
    case 'answer': return 'done';
    case 'partial': return 'active';
    default: return 'review';
  }
}

// ---------------------------------------------------------------------------
// Session export/import
// ---------------------------------------------------------------------------

export async function exportSession(opts: ExportSessionOpts): Promise<ExportSessionResult> {
  try {
    const result = await getSessionMessages({ ...opts, agent: opts.agent });
    if (!result.ok) return { ok: false, content: '', filename: '', error: result.error };

    const messages = result.messages;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let content: string;
    let ext: string;

    switch (opts.format) {
      case 'json':
        content = JSON.stringify({ agent: opts.agent, sessionId: opts.sessionId, exportedAt: new Date().toISOString(), messages }, null, 2);
        ext = 'json';
        break;
      case 'text':
        content = messages.map(m => `[${m.role}]\n${m.text}`).join('\n\n---\n\n');
        ext = 'txt';
        break;
      case 'markdown':
      default:
        content = `# Session Export (${opts.agent}, ${timestamp})\n\n` +
          messages.map(m => `## ${m.role === 'user' ? 'User' : 'Assistant'}\n\n${m.text}`).join('\n\n---\n\n');
        ext = 'md';
        break;
    }

    const filename = `session-${opts.agent}-${opts.sessionId.slice(0, 8)}-${timestamp}.${ext}`;
    return { ok: true, content, filename, error: null };
  } catch (e: any) {
    return { ok: false, content: '', filename: '', error: e.message };
  }
}

export function importSession(opts: ImportSessionOpts): ImportSessionResult {
  try {
    const format = opts.format || detectImportFormat(opts.content);
    let messages: TailMessage[];

    switch (format) {
      case 'json': {
        const parsed = JSON.parse(opts.content);
        messages = Array.isArray(parsed.messages) ? parsed.messages : Array.isArray(parsed) ? parsed : [];
        break;
      }
      case 'markdown': {
        messages = parseMarkdownConversation(opts.content);
        break;
      }
      case 'text':
      default: {
        messages = parseTextConversation(opts.content);
        break;
      }
    }

    return { ok: true, messages, error: null };
  } catch (e: any) {
    return { ok: false, messages: [], error: e.message };
  }
}

function detectImportFormat(content: string): 'json' | 'markdown' | 'text' {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (trimmed.startsWith('#')) return 'markdown';
  return 'text';
}

function parseMarkdownConversation(content: string): TailMessage[] {
  const messages: TailMessage[] = [];
  const sections = content.split(/^## /m).slice(1);
  for (const section of sections) {
    const firstLine = section.split('\n')[0].trim().toLowerCase();
    const role: 'user' | 'assistant' = firstLine.includes('user') ? 'user' : 'assistant';
    const text = section.split('\n').slice(1).join('\n').replace(/^---\s*$/m, '').trim();
    if (text) messages.push({ role, text });
  }
  return messages;
}

function parseTextConversation(content: string): TailMessage[] {
  const messages: TailMessage[] = [];
  const blocks = content.split(/\n---\n/).map(b => b.trim()).filter(Boolean);
  for (const block of blocks) {
    const match = block.match(/^\[(user|assistant)\]\n([\s\S]+)$/i);
    if (match) {
      messages.push({ role: match[1].toLowerCase() as 'user' | 'assistant', text: match[2].trim() });
    }
  }
  return messages;
}

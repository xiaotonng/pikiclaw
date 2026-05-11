/**
 * Project skill discovery from .pikiclaw/skills and .claude/commands.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SkillScope = 'global' | 'project';

export interface SkillInfo {
  name: string;
  label: string | null;
  description: string | null;
  source: 'skills';
  /** Whether this skill is global (all workspaces) or project-scoped. */
  scope: SkillScope;
  /** MCP server packages required by this skill. */
  mcpRequires?: string[];
}

export interface SkillListResult {
  skills: SkillInfo[];
  workdir: string;
}

export interface ProjectSkillPaths {
  sharedSkillFile: string | null;
  claudeSkillFile: string | null;
  agentsSkillFile: string | null;
}

interface ProjectSkillRoots {
  canonicalRoot: string;
  claudeRoot: string;
  agentsRoot: string;
}

function resolveProjectSkillRoots(workdir: string): ProjectSkillRoots {
  return {
    canonicalRoot: path.join(workdir, '.pikiclaw', 'skills'),
    claudeRoot: path.join(workdir, '.claude', 'skills'),
    agentsRoot: path.join(workdir, '.agents', 'skills'),
  };
}

function resolveSkillFile(root: string, skillName: string): string {
  return path.join(root, skillName, 'SKILL.md');
}

function parseSkillMeta(content: string): { label: string | null; description: string | null; mcpRequires?: string[] } {
  let label: string | null = null;
  let description: string | null = null;
  let mcpRequires: string[] | undefined;
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fm) {
    const lm = fm[1].match(/^label:\s*(.+)/m);
    if (lm) label = lm[1].trim();
    const dm = fm[1].match(/^description:\s*(.+)/m);
    if (dm) description = dm[1].trim();
    // Parse mcp_requires as YAML list
    const mr = fm[1].match(/^mcp_requires:\s*\n((?:\s+-\s+.+\n?)+)/m);
    if (mr) {
      mcpRequires = mr[1]
        .split('\n')
        .map(l => l.replace(/^\s*-\s*/, '').replace(/["']/g, '').trim())
        .filter(Boolean);
    }
  }
  if (!label) {
    const hm = content.match(/^#\s+(.+)$/m);
    if (hm) label = hm[1].trim();
  }
  return { label, description, mcpRequires };
}

function hasFile(filePath: string): boolean {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function hasDir(dirPath: string): boolean {
  try { return fs.statSync(dirPath).isDirectory(); } catch { return false; }
}

function readSortedDir(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  } catch {
    return [];
  }
}

function listRelativeFiles(dirPath: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readSortedDir(dirPath)) {
    const abs = path.join(dirPath, entry);
    const rel = prefix ? path.join(prefix, entry) : entry;
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.isDirectory()) files.push(...listRelativeFiles(abs, rel));
    else if (stat.isFile()) files.push(rel);
  }
  return files;
}

function realPathOrNull(filePath: string): string | null {
  try { return fs.realpathSync(filePath); } catch { return null; }
}

function ensureDirSymlink(linkPath: string, targetDir: string) {
  const desiredTarget = path.relative(path.dirname(linkPath), targetDir) || '.';
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(linkPath);
      const currentReal = realPathOrNull(path.resolve(path.dirname(linkPath), currentTarget));
      const desiredReal = realPathOrNull(targetDir);
      if (currentTarget === desiredTarget || (currentReal && desiredReal && currentReal === desiredReal)) return;
    }
    fs.rmSync(linkPath, { recursive: true, force: true });
  } catch {}
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(desiredTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function copyMergedTree(
  sourceRoot: string,
  targetRoot: string,
  opts: { log?: (message: string) => void } = {},
) {
  for (const relPath of listRelativeFiles(sourceRoot)) {
    const sourcePath = path.join(sourceRoot, relPath);
    const targetPath = path.join(targetRoot, relPath);
    if (hasFile(targetPath)) {
      opts.log?.(`skills merge skipped existing file: ${relPath}`);
      continue;
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}

export function initializeProjectSkills(workdir: string, opts: { log?: (message: string) => void } = {}): void {
  const { canonicalRoot, claudeRoot, agentsRoot } = resolveProjectSkillRoots(workdir);
  fs.mkdirSync(canonicalRoot, { recursive: true });
  const canonicalReal = realPathOrNull(canonicalRoot);

  for (const legacyRoot of [claudeRoot, agentsRoot]) {
    if (!hasDir(legacyRoot)) continue;
    const legacyReal = realPathOrNull(legacyRoot);
    if (legacyReal && canonicalReal && legacyReal === canonicalReal) continue;
    copyMergedTree(legacyRoot, canonicalRoot, opts);
  }

  for (const linkRoot of [claudeRoot, agentsRoot]) {
    ensureDirSymlink(linkRoot, canonicalRoot);
  }
  opts.log?.(`skills merged into .pikiclaw/skills and linked to .claude/.agents workdir=${workdir}`);
}

export function getProjectSkillPaths(workdir: string, skillName: string): ProjectSkillPaths {
  const { canonicalRoot, claudeRoot, agentsRoot } = resolveProjectSkillRoots(workdir);
  const sharedSkillFile = resolveSkillFile(canonicalRoot, skillName);
  const agentsSkillFile = resolveSkillFile(agentsRoot, skillName);
  const claudeSkillFile = resolveSkillFile(claudeRoot, skillName);
  return {
    sharedSkillFile: hasFile(sharedSkillFile) ? sharedSkillFile : null,
    agentsSkillFile: hasFile(agentsSkillFile) ? agentsSkillFile : null,
    claudeSkillFile: hasFile(claudeSkillFile) ? claudeSkillFile : null,
  };
}

// Matches the canonical prompt produced by `resolveSkillPrompt` (bot/commands)
// and `resolveSkillFromPrompt` (dashboard/session-control). Both build the same
// shape: `[Project directory: <wd>]\n\nRead the skill definition at \`<path>\`
// and execute the instructions defined there.[ Additional context: <args>]`.
//
// Whitespace between the segments is tolerant (`\s+`) so the regex still
// matches after the claude driver collapses interior `\s+` to single spaces
// when surfacing user text in `getClaudeSessionMessages`.
const SKILL_PROMPT_RE = /^\[Project directory: [^\]\n]+?\]\s+Read the skill definition at `([^`\n]+)` and execute the instructions defined there\.(?:\s+Additional context:\s+([\s\S]+?))?\s*$/;

/**
 * Inverse of `resolveSkillPrompt`. When a stored user message matches the
 * canonical skill-execution expansion, return the original `/skillname [args]`
 * shorthand for display. Returns null when the text isn't a recognized skill
 * prompt — callers should fall back to the raw text.
 *
 * The expanded form is what the agent CLI actually consumed and what gets
 * persisted to its session log; this collapse exists purely so the dashboard
 * (and other display surfaces) can render the slash command the user typed.
 */
export function collapseSkillPrompt(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = SKILL_PROMPT_RE.exec(text);
  if (!m) return null;
  // Skill files are always at `<root>/<skillName>/SKILL.md`. Split on both
  // `/` and `\` so Windows-generated paths (path.join) resolve correctly.
  const segments = m[1].split(/[/\\]/).filter(Boolean);
  if (segments.length < 2 || segments[segments.length - 1] !== 'SKILL.md') return null;
  const name = segments[segments.length - 2];
  if (!name) return null;
  const args = (m[2] || '').trim();
  return args ? `/${name} ${args}` : `/${name}`;
}

const GLOBAL_SKILLS_ROOT = path.join(os.homedir(), '.pikiclaw', 'skills');

function discoverSkillsFromDir(
  dir: string,
  scope: SkillScope,
  seen: Set<string>,
): SkillInfo[] {
  const skills: SkillInfo[] = [];
  for (const entry of readSortedDir(dir)) {
    if (!entry || seen.has(entry)) continue;
    const skillDir = path.join(dir, entry);
    const skillFile = resolveSkillFile(dir, entry);
    try { if (!fs.statSync(skillDir).isDirectory()) continue; } catch { continue; }
    if (!hasFile(skillFile)) continue;
    let meta: ReturnType<typeof parseSkillMeta> = { label: null, description: null };
    try { meta = parseSkillMeta(fs.readFileSync(skillFile, 'utf-8')); } catch {}
    skills.push({
      name: entry,
      label: meta.label,
      description: meta.description,
      source: 'skills',
      scope,
      mcpRequires: meta.mcpRequires,
    });
    seen.add(entry);
  }
  return skills;
}

/**
 * List all skills — project-scoped (workdir) first, then global (~/.pikiclaw/skills/).
 * Project skills with the same name shadow global ones.
 */
export function listSkills(workdir: string): SkillListResult {
  const seen = new Set<string>();
  const { canonicalRoot } = resolveProjectSkillRoots(workdir);

  // Project skills take precedence
  const projectSkills = discoverSkillsFromDir(canonicalRoot, 'project', seen);
  // Global skills fill in the rest
  const globalSkills = discoverSkillsFromDir(GLOBAL_SKILLS_ROOT, 'global', seen);

  return { skills: [...projectSkills, ...globalSkills], workdir };
}

/** Return the global skills root directory path. */
export function getGlobalSkillsRoot(): string {
  return GLOBAL_SKILLS_ROOT;
}

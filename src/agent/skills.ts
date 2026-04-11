/**
 * Project skill discovery from .pikiclaw/skills and .claude/commands.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface SkillInfo {
  name: string;
  label: string | null;
  description: string | null;
  source: 'skills';
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

function parseSkillMeta(content: string): { label: string | null; description: string | null } {
  let label: string | null = null;
  let description: string | null = null;
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fm) {
    const lm = fm[1].match(/^label:\s*(.+)/m);
    if (lm) label = lm[1].trim();
    const dm = fm[1].match(/^description:\s*(.+)/m);
    if (dm) description = dm[1].trim();
  }
  if (!label) {
    const hm = content.match(/^#\s+(.+)$/m);
    if (hm) label = hm[1].trim();
  }
  return { label, description };
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

export function listSkills(workdir: string): SkillListResult {
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();
  const { canonicalRoot } = resolveProjectSkillRoots(workdir);

  for (const entry of readSortedDir(canonicalRoot)) {
    if (!entry || seen.has(entry)) continue;
    const skillDir = path.join(canonicalRoot, entry);
    const skillFile = resolveSkillFile(canonicalRoot, entry);
    try { if (!fs.statSync(skillDir).isDirectory()) continue; } catch { continue; }
    if (!hasFile(skillFile)) continue;
    let meta = { label: null as string | null, description: null as string | null };
    try { meta = parseSkillMeta(fs.readFileSync(skillFile, 'utf-8')); } catch {}
    skills.push({ name: entry, label: meta.label, description: meta.description, source: 'skills' });
    seen.add(entry);
  }

  return { skills, workdir };
}

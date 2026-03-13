import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bot } from '../src/bot.ts';
import { initializeProjectSkills, listSkills } from '../src/code-agent.ts';
import { getSkillsListData, resolveSkillPrompt } from '../src/bot-commands.ts';
import { captureEnv, makeTmpDir, restoreEnv } from './support/env.ts';

const envSnapshot = captureEnv(['CODECLAW_CONFIG', 'CODECLAW_WORKDIR']);

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeSkill(root: string, name: string, body: string) {
  writeFile(path.join(root, name, 'SKILL.md'), body);
}

beforeEach(() => {
  restoreEnv(envSnapshot);
  process.env.CODECLAW_CONFIG = path.join(makeTmpDir('codeclaw-config-'), 'setting.json');
});

afterEach(() => {
  restoreEnv(envSnapshot);
});

describe('project skills', () => {
  it('lists canonical project skills plus legacy command skills without duplicates', () => {
    const workdir = makeTmpDir('codeclaw-skills-');
    writeSkill(path.join(workdir, '.codeclaw', 'skills'), 'ship', '---\nlabel: Shared Ship\ndescription: shared\n---\n');
    writeSkill(path.join(workdir, '.agents', 'skills'), 'ship', '---\nlabel: Agents Ship\ndescription: agents\n---\n');
    writeSkill(path.join(workdir, '.claude', 'skills'), 'review', '---\nlabel: Claude Review\ndescription: claude\n---\n');
    writeFile(path.join(workdir, '.claude', 'commands', 'deploy.md'), '---\nlabel: Deploy Cmd\ndescription: legacy\n---\n');

    const result = listSkills(workdir);

    expect(result.skills).toEqual([
      { name: 'deploy', label: 'Deploy Cmd', description: 'legacy', source: 'commands' },
      { name: 'ship', label: 'Shared Ship', description: 'shared', source: 'skills' },
    ]);
  });

  it('builds a stable skills view and prefers claude native skill execution when available', () => {
    const workdir = makeTmpDir('codeclaw-claude-skill-');
    writeSkill(path.join(workdir, '.codeclaw', 'skills'), 'install', '---\nlabel: Install\ndescription: shared\n---\n');
    writeSkill(path.join(workdir, '.claude', 'skills'), 'install', '---\nlabel: Install\ndescription: claude\n---\n');

    const bot = new Bot();
    bot.switchWorkdir(workdir, { persist: false });
    bot.chat(1).agent = 'claude';

    const skillsView = getSkillsListData(bot, 1);
    expect(skillsView.skills).toEqual([
      {
        name: 'install',
        label: 'Install',
        description: 'shared',
        command: 'sk_install',
        source: 'skills',
      },
    ]);

    const resolved = resolveSkillPrompt(bot, 1, 'sk_install', 'ship it');
    expect(resolved).toEqual({
      prompt: 'Please execute the /install skill defined in this project. Additional context: ship it',
      skillName: 'install',
    });
  });

  it('routes codex skills to project skill files instead of hard-coding .claude paths', () => {
    const workdir = makeTmpDir('codeclaw-codex-skill-');
    writeSkill(path.join(workdir, '.codeclaw', 'skills'), 'fixup', '---\nlabel: Fixup\ndescription: shared\n---\n');
    writeSkill(path.join(workdir, '.agents', 'skills'), 'fixup', '---\nlabel: Fixup\ndescription: agents\n---\n');

    const bot = new Bot();
    bot.switchWorkdir(workdir, { persist: false });
    bot.chat(2).agent = 'codex';

    const resolved = resolveSkillPrompt(bot, 2, 'sk_fixup', '');
    expect(resolved).toEqual({
      prompt: 'In this project, the fixup skill is defined in `.codeclaw/skills/fixup/SKILL.md`. Please read that SKILL.md file and execute the instructions.',
      skillName: 'fixup',
    });
  });

  it('migrates project skills into .codeclaw/skills and links claude/agents roots to it', () => {
    const workdir = makeTmpDir('codeclaw-migrate-skill-');
    writeSkill(path.join(workdir, '.codeclaw', 'skills'), 'ship', '---\nlabel: Ship\ndescription: canonical\n---\n');
    writeSkill(path.join(workdir, '.claude', 'skills'), 'ship', '---\nlabel: Ship\ndescription: claude\n---\n');
    writeFile(path.join(workdir, '.claude', 'skills', 'ship', 'references', 'claude.txt'), 'ignored because canonical wins\n');
    writeSkill(path.join(workdir, '.agents', 'skills'), 'package', '---\nlabel: Package\ndescription: agents\n---\n');

    initializeProjectSkills(workdir);

    expect(fs.readFileSync(path.join(workdir, '.codeclaw', 'skills', 'ship', 'SKILL.md'), 'utf8')).toContain('description: canonical');
    expect(fs.existsSync(path.join(workdir, '.codeclaw', 'skills', 'ship', 'references', 'claude.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(workdir, '.codeclaw', 'skills', 'package', 'SKILL.md'), 'utf8')).toContain('description: agents');
    expect(fs.lstatSync(path.join(workdir, '.claude', 'skills')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(workdir, '.agents', 'skills')).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(workdir, '.claude', 'skills'))).toBe(fs.realpathSync(path.join(workdir, '.codeclaw', 'skills')));
    expect(fs.realpathSync(path.join(workdir, '.agents', 'skills'))).toBe(fs.realpathSync(path.join(workdir, '.codeclaw', 'skills')));
    expect(fs.readFileSync(path.join(workdir, '.agents', 'skills', 'ship', 'SKILL.md'), 'utf8')).toContain('description: canonical');
  });
});

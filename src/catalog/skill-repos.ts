/**
 * Skill repository catalog — single source of truth for what the Dashboard
 * shows under Extensions → Skills.
 *
 * ─── How this plugs into the rest of the stack ───────────────────────────────
 *
 *   Dashboard → GET /api/extensions/skills/catalog
 *     → dashboard/routes/extensions.ts
 *       → agent/mcp/registry.ts              (types + re-exports this array)
 *       → agent/skills.ts                    (locally-installed discovery)
 *       → agent/skill-installer.ts           (`npx skills add …` runner)
 *         ← src/catalog/skill-repos.ts       ← YOU ARE HERE
 *
 * ─── Curation policy ─────────────────────────────────────────────────────────
 *
 * Every entry below is a real, public GitHub repo. Authority signal is GitHub
 * stars — the dashboard fetches `stars` / `pushedAt` at load time and sorts the
 * cards by star count, so "more popular = appears higher". Don't add fictional
 * placeholder entries; if a repo isn't real and starred, users hit a 404 the
 * moment they click Install.
 *
 * ─── How to add a skill pack ─────────────────────────────────────────────────
 *
 *   Append a `RecommendedSkillRepo` entry with `source` set to an `owner/repo`
 *   GitHub slug (or full URL). The install flow runs `npx skills add <source>`
 *   and drops the skill into `~/.pikiclaw/skills/` for global installs, or
 *   `<workdir>/.pikiclaw/skills/` for project installs.
 */

import type { RecommendedSkillRepo } from '../agent/mcp/registry.js';

export const SKILL_REPOS: RecommendedSkillRepo[] = [
  // ── Official / first-party ────────────────────────────────────────────────
  {
    id: 'anthropics-skills',
    name: 'Anthropic Skills',
    description: 'Official skill collection from Anthropic',
    descriptionZh: 'Anthropic 官方技能集',
    source: 'anthropics/skills',
    category: 'general',
    recommendedScope: 'global',
    homepage: 'https://github.com/anthropics/skills',
  },
  {
    id: 'vercel-agent-skills',
    name: 'Vercel Agent Skills',
    description: 'Next.js, deployment, and TypeScript workflows',
    descriptionZh: 'Next.js、部署、TypeScript 工作流',
    source: 'vercel-labs/agent-skills',
    category: 'dev',
    recommendedScope: 'both',
    homepage: 'https://github.com/vercel-labs/agent-skills',
  },

  // ── High-signal community collections (awesome-lists / megapacks) ─────────
  {
    id: 'obra-superpowers',
    name: 'Obra Superpowers',
    description: 'Opinionated productivity skills — focus, writing, research',
    descriptionZh: '精选生产力技能 — 专注、写作、调研',
    source: 'obra/superpowers',
    category: 'productivity',
    recommendedScope: 'global',
    homepage: 'https://github.com/obra/superpowers',
  },
  {
    id: 'antigravity-awesome-skills',
    name: 'Antigravity Awesome Skills',
    description: 'Installable library of 1,400+ agentic skills',
    descriptionZh: '可安装的 1,400+ 智能体技能合集',
    source: 'sickn33/antigravity-awesome-skills',
    category: 'general',
    recommendedScope: 'global',
    homepage: 'https://github.com/sickn33/antigravity-awesome-skills',
  },
  {
    id: 'wshobson-agents',
    name: 'wshobson Agents',
    description: 'Multi-agent orchestration and automation for Claude Code',
    descriptionZh: 'Claude Code 的多智能体编排与自动化',
    source: 'wshobson/agents',
    category: 'dev',
    recommendedScope: 'global',
    homepage: 'https://github.com/wshobson/agents',
  },
  {
    id: 'voltagent-awesome',
    name: 'Awesome Agent Skills',
    description: 'Curated 1,000+ agent skills from official teams and community',
    descriptionZh: '官方与社区的 1000+ 智能体技能精选合集',
    source: 'VoltAgent/awesome-agent-skills',
    category: 'general',
    recommendedScope: 'global',
    homepage: 'https://github.com/VoltAgent/awesome-agent-skills',
  },
  {
    id: 'alirezarezvani-claude-skills',
    name: 'Claude Skills 232+',
    description: '232+ Claude Code skills & plugins for Claude/Codex/Gemini',
    descriptionZh: '232+ Claude Code 技能与插件，覆盖 Claude/Codex/Gemini',
    source: 'alirezarezvani/claude-skills',
    category: 'general',
    recommendedScope: 'global',
    homepage: 'https://github.com/alirezarezvani/claude-skills',
  },

  // ── Domain-specific high-quality skills ───────────────────────────────────
  {
    id: 'planning-with-files',
    name: 'Planning with Files',
    description: 'Manus-style persistent markdown planning workflow',
    descriptionZh: 'Manus 风格的 Markdown 持久化规划工作流',
    source: 'OthmanAdi/planning-with-files',
    category: 'productivity',
    recommendedScope: 'both',
    homepage: 'https://github.com/OthmanAdi/planning-with-files',
  },
  {
    id: 'scientific-agent-skills',
    name: 'Scientific Agent Skills',
    description: 'Research, science, engineering, and analysis skills',
    descriptionZh: '科研、工程、分析方向的智能体技能集',
    source: 'K-Dense-AI/scientific-agent-skills',
    category: 'productivity',
    recommendedScope: 'global',
    homepage: 'https://github.com/K-Dense-AI/scientific-agent-skills',
  },
  {
    id: 'frontend-slides',
    name: 'Frontend Slides',
    description: 'Generate beautiful web-based slides with frontend skills',
    descriptionZh: '用前端技能生成精美的网页幻灯片',
    source: 'zarazhangrui/frontend-slides',
    category: 'productivity',
    recommendedScope: 'both',
    homepage: 'https://github.com/zarazhangrui/frontend-slides',
  },
  {
    id: 'design-extract',
    name: 'Design Extract',
    description: 'Extract a website\'s complete design system in one command',
    descriptionZh: '一条命令提取任意网站的完整设计系统',
    source: 'Manavarya09/design-extract',
    category: 'dev',
    recommendedScope: 'both',
    homepage: 'https://github.com/Manavarya09/design-extract',
  },
  {
    id: 'rocketsim-skills',
    name: 'RocketSim',
    description: '30+ tools for Xcode iOS Simulator — testing, debugging',
    descriptionZh: 'Xcode iOS 模拟器的 30+ 工具：测试、调试、网络',
    source: 'AvdLee/RocketSimApp',
    category: 'dev',
    recommendedScope: 'both',
    homepage: 'https://github.com/AvdLee/RocketSimApp',
  },
  {
    id: 'nopua',
    name: 'Nopua',
    description: 'A skill that unlocks AI potential through respect and care',
    descriptionZh: '用爱解放 AI 潜能的技能 — 尊重、关怀',
    source: 'wuji-labs/nopua',
    category: 'productivity',
    recommendedScope: 'global',
    homepage: 'https://github.com/wuji-labs/nopua',
  },
];

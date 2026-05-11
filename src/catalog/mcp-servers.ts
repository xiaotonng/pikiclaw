/**
 * MCP server catalog — single source of truth for what the Dashboard shows
 * under Extensions → MCP.
 *
 * ─── How this plugs into the rest of the stack ───────────────────────────────
 *
 *   Dashboard → GET /api/extensions/mcp/catalog
 *     → dashboard/routes/extensions.ts
 *       → agent/mcp/extensions.ts      (merge + state computation)
 *         → agent/mcp/registry.ts      (types + re-exports this array)
 *           ← src/catalog/mcp-servers.ts ← YOU ARE HERE
 *
 * The registry module owns types and helper functions (install / OAuth / health).
 * This file owns only the *data*. To add a new MCP server, append an entry here
 * and the whole pipeline picks it up. To hide an entry, remove/comment it out —
 * users who already installed it keep their setup; we only stop recommending.
 *
 * ─── recommendedScope ────────────────────────────────────────────────────────
 *
 *   'global'    — account-level SaaS (GitHub, Atlassian, …). Shown in the
 *                 Extensions tab; hidden from the Workspace modal.
 *   'workspace' — tools that depend on project context (Filesystem, SQLite,
 *                 Postgres). Shown in the Workspace modal; hidden globally.
 *   'both'      — useful in either place (rarely needed; avoid unless obvious).
 *
 * Generic protocol-demo servers (time / fetch / memory from @modelcontextprotocol)
 * were intentionally removed — they don't carry a product identity and added
 * clutter rather than value.
 */

import type { RecommendedMcpServer } from '../agent/mcp/registry.js';

export const MCP_SERVERS: RecommendedMcpServer[] = [
  // ── Built-in (pikiclaw-managed) ────────────────────────────────────────────
  {
    id: 'pikiclaw-browser',
    name: 'Browser Automation',
    description: 'Optimized Playwright MCP — managed Chrome with shared profile, CDP attach, and supervisor lifecycle.',
    descriptionZh: '基于 Playwright MCP 的定制版浏览器自动化：受管 Chrome、共享 profile、CDP 附着、进程级 supervisor。',
    category: 'utility',
    recommendedScope: 'global',
    transport: { type: 'stdio', command: '@playwright/mcp', args: ['(managed by pikiclaw)'] },
    auth: { type: 'none' },
    iconSlug: 'playwright',
    homepage: 'https://github.com/microsoft/playwright-mcp',
    isBuiltin: true,
  },
  {
    id: 'peekaboo',
    name: 'Peekaboo',
    description: 'Native macOS GUI control via Accessibility API + ScreenCaptureKit (click, type, scroll, windows, menus, Dock). Requires Screen Recording + Accessibility permissions. macOS only.',
    descriptionZh: '通过 macOS Accessibility 与 ScreenCaptureKit 实现原生 GUI 控制（点击、输入、滚动、窗口、菜单、Dock）。需要"屏幕录制"与"辅助功能"两项系统权限，仅支持 macOS。',
    category: 'utility',
    recommendedScope: 'global',
    transport: { type: 'stdio', command: 'npx', args: ['-y', '-p', '@steipete/peekaboo', 'peekaboo-mcp'] },
    auth: { type: 'none' },
    iconSlug: 'apple',
    homepage: 'https://peekaboo.sh/',
    isBuiltin: true,
  },

  // ── Local filesystems / databases (workspace scope) ────────────────────────
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, write, and search files on the local machine',
    descriptionZh: '读写和搜索本机文件',
    category: 'utility',
    recommendedScope: 'workspace',
    transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${WORKDIR}'] },
    auth: { type: 'none' },
    iconSlug: 'filesystem',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and manage local SQLite databases',
    descriptionZh: '查询和管理本地 SQLite 数据库',
    category: 'data',
    recommendedScope: 'workspace',
    transport: { type: 'stdio', command: 'uvx', args: ['mcp-server-sqlite', '--db-path', '${WORKDIR}/data.db'] },
    auth: { type: 'none' },
    iconSlug: 'sqlite',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Query and manage PostgreSQL databases',
    descriptionZh: '查询和管理 PostgreSQL 数据库',
    category: 'data',
    recommendedScope: 'workspace',
    transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', '${POSTGRES_CONNECTION_STRING}'] },
    auth: {
      type: 'credentials',
      fields: [{
        key: 'POSTGRES_CONNECTION_STRING',
        label: 'Connection string',
        labelZh: '连接串',
        required: true,
        placeholder: 'postgresql://user:pass@host:5432/db',
      }],
    },
    iconSlug: 'postgres',
  },

  // ── Global-scope SaaS with MCP-OAuth ───────────────────────────────────────
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repositories, pull requests, issues, code search',
    descriptionZh: '仓库、PR、Issue、代码搜索',
    category: 'dev',
    recommendedScope: 'global',
    transport: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
    auth: { type: 'mcp-oauth', scopes: ['repo', 'read:org'] },
    iconSlug: 'github',
    homepage: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    description: 'Jira issues, Confluence pages, sprint planning',
    descriptionZh: 'Jira 工单、Confluence 文档、Sprint 管理',
    category: 'productivity',
    recommendedScope: 'global',
    transport: { type: 'http', url: 'https://mcp.atlassian.com/v1/sse' },
    auth: { type: 'mcp-oauth' },
    iconSlug: 'atlassian',
    homepage: 'https://www.atlassian.com/platform/remote-mcp-server',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Read, write, and search Notion pages and databases',
    descriptionZh: '读写和搜索 Notion 页面与数据库',
    category: 'productivity',
    recommendedScope: 'global',
    transport: { type: 'http', url: 'https://mcp.notion.com/mcp' },
    auth: { type: 'mcp-oauth' },
    iconSlug: 'notion',
    homepage: 'https://developers.notion.com/docs/mcp',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Issues, projects, cycles, and team workflows',
    descriptionZh: 'Issue、项目、周期和团队协作',
    category: 'productivity',
    recommendedScope: 'global',
    transport: { type: 'http', url: 'https://mcp.linear.app/sse' },
    auth: { type: 'mcp-oauth' },
    iconSlug: 'linear',
    homepage: 'https://linear.app/docs/mcp',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Error tracking — search issues, view stack traces',
    descriptionZh: '错误追踪 — 查询 Issue、查看堆栈',
    category: 'dev',
    recommendedScope: 'global',
    transport: { type: 'http', url: 'https://mcp.sentry.dev/mcp' },
    auth: { type: 'mcp-oauth' },
    iconSlug: 'sentry',
    homepage: 'https://docs.sentry.io/product/sentry-mcp/',
  },

  // ── Cloudflare trio (control plane / observability / docs) ─────────────────
  {
    id: 'cloudflare-bindings',
    name: 'Cloudflare',
    description: 'Manage Workers, Pages, R2, D1, KV — the full control plane',
    descriptionZh: '管理 Workers / Pages / R2 / D1 / KV — 完整控制面',
    category: 'dev',
    recommendedScope: 'global',
    transport: { type: 'http', url: 'https://bindings.mcp.cloudflare.com/sse' },
    auth: { type: 'mcp-oauth' },
    iconSlug: 'cloudflare',
    homepage: 'https://developers.cloudflare.com/agents/model-context-protocol/',
  },
  {
    id: 'cloudflare-observability',
    name: 'Cloudflare Observability',
    description: 'Workers logs, analytics, and traces',
    descriptionZh: 'Workers 日志、分析与追踪',
    category: 'dev',
    recommendedScope: 'global',
    transport: { type: 'http', url: 'https://observability.mcp.cloudflare.com/sse' },
    auth: { type: 'mcp-oauth' },
    iconSlug: 'cloudflare',
    homepage: 'https://developers.cloudflare.com/agents/model-context-protocol/',
  },
  {
    id: 'cloudflare-docs',
    name: 'Cloudflare Docs',
    description: 'Search and query Cloudflare documentation',
    descriptionZh: '搜索和查询 Cloudflare 文档',
    category: 'dev',
    recommendedScope: 'global',
    transport: { type: 'http', url: 'https://docs.mcp.cloudflare.com/sse' },
    auth: { type: 'mcp-oauth' },
    iconSlug: 'cloudflare',
    homepage: 'https://developers.cloudflare.com/agents/model-context-protocol/',
  },

  // ── More SaaS integrations ─────────────────────────────────────────────────
  {
    id: 'gamma',
    name: 'Gamma',
    description: 'Generate AI-powered presentations and documents',
    descriptionZh: '生成 AI 驱动的演示文稿和文档',
    category: 'productivity',
    recommendedScope: 'global',
    transport: { type: 'http', url: 'https://mcp.gamma.app/mcp' },
    auth: { type: 'mcp-oauth' },
    iconSlug: 'gamma',
    homepage: 'https://gamma.app/docs/mcp',
  },
  {
    id: 'hugging-face',
    name: 'Hugging Face',
    description: 'Models, datasets, spaces, and inference',
    descriptionZh: '模型、数据集、Spaces 和推理',
    category: 'dev',
    recommendedScope: 'global',
    transport: { type: 'http', url: 'https://huggingface.co/mcp' },
    auth: { type: 'mcp-oauth' },
    iconSlug: 'huggingface',
    homepage: 'https://huggingface.co/docs/hub/mcp',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read channels, summarize threads, send messages',
    descriptionZh: '读取频道、总结对话、发送消息',
    category: 'communication',
    recommendedScope: 'global',
    transport: { type: 'http', url: 'https://slack.com/api/mcp' },
    auth: { type: 'mcp-oauth' },
    iconSlug: 'slack',
    homepage: 'https://api.slack.com/apis/mcp',
  },
  {
    id: 'lark',
    name: '飞书 / Lark',
    description: 'Feishu docs, messages, tasks, bitable',
    descriptionZh: '飞书文档、消息、任务、多维表格',
    category: 'communication',
    recommendedScope: 'global',
    transport: { type: 'http', url: 'https://open.feishu.cn/mcp' },
    auth: { type: 'mcp-oauth' },
    iconSlug: 'lark',
    homepage: 'https://open.feishu.cn/document/mcp',
  },

  // ── Remote + API key ───────────────────────────────────────────────────────
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Payments, customers, subscriptions, invoices',
    descriptionZh: '支付、客户、订阅、账单',
    category: 'data',
    recommendedScope: 'global',
    transport: { type: 'http', url: 'https://mcp.stripe.com/v1/mcp' },
    auth: {
      type: 'credentials',
      fields: [{
        key: 'STRIPE_API_KEY',
        label: 'Secret key',
        labelZh: 'Secret key',
        secret: true,
        required: true,
        placeholder: 'sk_live_... or sk_test_...',
        helpUrl: 'https://dashboard.stripe.com/apikeys',
      }],
    },
    iconSlug: 'stripe',
    homepage: 'https://docs.stripe.com/mcp',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web and local search via Brave Search API',
    descriptionZh: '通过 Brave Search API 进行网页搜索',
    category: 'search',
    recommendedScope: 'global',
    transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'] },
    auth: {
      type: 'credentials',
      fields: [{
        key: 'BRAVE_API_KEY',
        label: 'API key',
        labelZh: 'API 密钥',
        secret: true,
        required: true,
        helpUrl: 'https://api.search.brave.com/app/keys',
      }],
    },
    iconSlug: 'brave',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    description: 'Answer engine with real-time web search',
    descriptionZh: '带实时网页检索的问答引擎',
    category: 'search',
    recommendedScope: 'global',
    transport: { type: 'http', url: 'https://api.perplexity.ai/mcp' },
    auth: {
      type: 'credentials',
      fields: [{
        key: 'PERPLEXITY_API_KEY',
        label: 'API key',
        labelZh: 'API 密钥',
        secret: true,
        required: true,
        helpUrl: 'https://www.perplexity.ai/settings/api',
      }],
    },
    iconSlug: 'perplexity',
  },
];

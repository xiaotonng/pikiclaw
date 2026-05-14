/**
 * CLI tool catalog — single source of truth for what the Dashboard shows under
 * Extensions → CLI.
 *
 * ─── How this plugs into the rest of the stack ───────────────────────────────
 *
 *   Dashboard → GET /api/extensions/cli/catalog
 *     → dashboard/routes/cli.ts
 *       → agent/cli/catalog.ts    (merge + live detection)
 *         → agent/cli/registry.ts (types + re-exports this array)
 *           ← src/catalog/cli-tools.ts ← YOU ARE HERE
 *
 * The registry module defines the `RecommendedCli` type and other helpers; the
 * detector spawns `which <binary>` + the status command, and the auth runner
 * streams the login sub-process. This file owns only the *data*.
 *
 * ─── How to add a CLI ────────────────────────────────────────────────────────
 *
 *   1. Append an entry to `CLI_TOOLS`.
 *   2. Pick an `auth.type`:
 *        - 'oauth-web' if the CLI has a first-party `<cli> ... login --web`
 *          flavor (gh, wrangler, vercel, …). The runner spawns that command,
 *          streams stdout/stderr to the UI, and polls `statusArgv` until it
 *          reports authed.
 *        - 'token' if the user pastes an API key. Implement the write-path in
 *          `agent/cli/auth.ts` → `applyCliToken` for that id (keeps secret
 *          handling explicit per CLI).
 *        - 'none' for CLIs that don't need sign-in (docker, pnpm).
 *   3. Fill `install.{darwin,linux,win}` with canonical commands. The UI shows
 *      the current OS's list and always renders a "Copy" button. We deliberately
 *      do NOT auto-run installers — package managers often need sudo or
 *      interactive confirmation and we'd rather keep the user in charge.
 */

import type { RecommendedCli } from '../agent/cli/registry.js';

export const CLI_TOOLS: RecommendedCli[] = [
  // ── Dev: source control & platforms ────────────────────────────────────────
  {
    id: 'gh',
    binary: 'gh',
    name: 'GitHub CLI',
    description: 'Manage pull requests, issues, and Actions from the terminal',
    descriptionZh: '终端直管 PR、Issue 和 Actions',
    category: 'dev',
    iconSlug: 'github',
    homepage: 'https://cli.github.com/',
    recommendedScope: 'global',
    versionArgv: ['gh', '--version'],
    install: {
      docs: 'https://github.com/cli/cli#installation',
      darwin: [{ label: 'Homebrew', cmd: 'brew install gh' }],
      linux:  [
        { label: 'apt (Debian/Ubuntu)', cmd: 'sudo apt install gh' },
        { label: 'dnf (Fedora)',         cmd: 'sudo dnf install gh' },
      ],
      win:    [{ label: 'winget', cmd: 'winget install GitHub.cli' }],
    },
    auth: {
      type: 'oauth-web',
      statusArgv: ['gh', 'auth', 'status'],
      loginArgv:  ['gh', 'auth', 'login', '--web', '--git-protocol', 'https'],
      logoutArgv: ['gh', 'auth', 'logout', '--hostname', 'github.com'],
      loginHint:   'Opens a browser for GitHub OAuth.',
      loginHintZh: '将打开浏览器完成 GitHub OAuth 授权。',
    },
  },

  // ── Cloud platforms ────────────────────────────────────────────────────────
  {
    id: 'wrangler',
    binary: 'wrangler',
    name: 'Cloudflare Wrangler',
    description: 'Build and deploy Cloudflare Workers, Pages, and D1',
    descriptionZh: '构建并部署 Workers / Pages / D1',
    category: 'cloud',
    iconSlug: 'cloudflare',
    homepage: 'https://developers.cloudflare.com/workers/wrangler/',
    recommendedScope: 'global',
    versionArgv: ['wrangler', '--version'],
    install: {
      docs: 'https://developers.cloudflare.com/workers/wrangler/install-and-update/',
      darwin: [{ label: 'npm', cmd: 'npm i -g wrangler' }],
      linux:  [{ label: 'npm', cmd: 'npm i -g wrangler' }],
      win:    [{ label: 'npm', cmd: 'npm i -g wrangler' }],
    },
    auth: {
      type: 'oauth-web',
      statusArgv: ['wrangler', 'whoami'],
      loginArgv:  ['wrangler', 'login'],
      logoutArgv: ['wrangler', 'logout'],
      loginHint:   'Opens a browser for Cloudflare OAuth.',
      loginHintZh: '将打开浏览器完成 Cloudflare OAuth 授权。',
    },
  },
  {
    id: 'vercel',
    binary: 'vercel',
    name: 'Vercel CLI',
    description: 'Deploy Next.js / frontend projects to Vercel',
    descriptionZh: '将 Next.js / 前端项目部署到 Vercel',
    category: 'cloud',
    iconSlug: 'vercel',
    homepage: 'https://vercel.com/docs/cli',
    recommendedScope: 'global',
    versionArgv: ['vercel', '--version'],
    install: {
      docs: 'https://vercel.com/docs/cli#installing-vercel-cli',
      darwin: [{ label: 'npm', cmd: 'npm i -g vercel' }],
      linux:  [{ label: 'npm', cmd: 'npm i -g vercel' }],
      win:    [{ label: 'npm', cmd: 'npm i -g vercel' }],
    },
    auth: {
      type: 'oauth-web',
      statusArgv: ['vercel', 'whoami'],
      loginArgv:  ['vercel', 'login'],
      logoutArgv: ['vercel', 'logout'],
      loginHint:   'Opens a browser for Vercel OAuth.',
      loginHintZh: '将打开浏览器完成 Vercel OAuth 授权。',
    },
  },
  {
    id: 'netlify',
    binary: 'netlify',
    name: 'Netlify CLI',
    description: 'Deploy and manage Netlify sites, Functions, and Edge',
    descriptionZh: '部署并管理 Netlify 站点、Functions、Edge',
    category: 'cloud',
    iconSlug: 'netlify',
    homepage: 'https://docs.netlify.com/cli/get-started/',
    recommendedScope: 'global',
    versionArgv: ['netlify', '--version'],
    install: {
      docs: 'https://docs.netlify.com/cli/get-started/#installation',
      darwin: [{ label: 'npm', cmd: 'npm i -g netlify-cli' }],
      linux:  [{ label: 'npm', cmd: 'npm i -g netlify-cli' }],
      win:    [{ label: 'npm', cmd: 'npm i -g netlify-cli' }],
    },
    auth: {
      type: 'oauth-web',
      statusArgv: ['netlify', 'status'],
      loginArgv:  ['netlify', 'login'],
      logoutArgv: ['netlify', 'logout'],
      loginHint:   'Opens a browser for Netlify OAuth.',
      loginHintZh: '将打开浏览器完成 Netlify OAuth 授权。',
    },
  },
  {
    id: 'supabase',
    binary: 'supabase',
    name: 'Supabase CLI',
    description: 'Manage Supabase projects, Postgres, and Edge Functions',
    descriptionZh: '管理 Supabase 项目、Postgres 与 Edge Functions',
    category: 'data',
    iconSlug: 'supabase',
    homepage: 'https://supabase.com/docs/guides/cli',
    recommendedScope: 'global',
    versionArgv: ['supabase', '--version'],
    install: {
      docs: 'https://supabase.com/docs/guides/cli/getting-started',
      darwin: [{ label: 'Homebrew', cmd: 'brew install supabase/tap/supabase' }],
      linux:  [{ label: 'Script',   cmd: 'curl -sL https://supabase.com/install.sh | sh' }],
      win:    [{ label: 'scoop',    cmd: 'scoop bucket add supabase https://github.com/supabase/scoop-bucket.git && scoop install supabase' }],
    },
    auth: {
      type: 'oauth-web',
      statusArgv: ['supabase', 'projects', 'list'],
      loginArgv:  ['supabase', 'login'],
      logoutArgv: ['supabase', 'logout'],
      loginHint:   'Opens a browser for Supabase OAuth.',
      loginHintZh: '将打开浏览器完成 Supabase OAuth 授权。',
    },
  },
  {
    id: 'heroku',
    binary: 'heroku',
    name: 'Heroku CLI',
    description: 'Create and manage Heroku apps and dynos',
    descriptionZh: '创建与管理 Heroku 应用和 dyno',
    category: 'cloud',
    iconSlug: 'heroku',
    homepage: 'https://devcenter.heroku.com/articles/heroku-cli',
    recommendedScope: 'global',
    versionArgv: ['heroku', '--version'],
    install: {
      docs: 'https://devcenter.heroku.com/articles/heroku-cli#install-the-heroku-cli',
      darwin: [{ label: 'Homebrew', cmd: 'brew tap heroku/brew && brew install heroku' }],
      linux:  [{ label: 'Snap',     cmd: 'sudo snap install --classic heroku' }],
      win:    [{ label: 'Installer', cmd: 'winget install --id=Heroku.HerokuCLI' }],
    },
    auth: {
      type: 'oauth-web',
      statusArgv: ['heroku', 'whoami'],
      loginArgv:  ['heroku', 'login'],
      logoutArgv: ['heroku', 'logout'],
      loginHint:   'Opens a browser for Heroku OAuth.',
      loginHintZh: '将打开浏览器完成 Heroku OAuth 授权。',
    },
  },

  // ── Commerce & payments ────────────────────────────────────────────────────
  {
    id: 'stripe',
    binary: 'stripe',
    name: 'Stripe CLI',
    description: 'Test webhooks, trigger events, inspect API logs',
    descriptionZh: '调试 Webhook、触发事件、查看 API 日志',
    category: 'commerce',
    iconSlug: 'stripe',
    homepage: 'https://stripe.com/docs/stripe-cli',
    recommendedScope: 'global',
    versionArgv: ['stripe', '--version'],
    install: {
      docs: 'https://docs.stripe.com/stripe-cli#install',
      darwin: [{ label: 'Homebrew', cmd: 'brew install stripe/stripe-cli/stripe' }],
      linux:  [{ label: 'apt',      cmd: "curl -s https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public | gpg --dearmor | sudo tee /usr/share/keyrings/stripe.gpg >/dev/null && echo 'deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main' | sudo tee /etc/apt/sources.list.d/stripe.list && sudo apt update && sudo apt install stripe" }],
      win:    [{ label: 'scoop',    cmd: 'scoop bucket add stripe https://github.com/stripe/scoop-stripe-cli.git && scoop install stripe' }],
    },
    auth: {
      type: 'oauth-web',
      statusArgv: ['stripe', 'config', '--list'],
      loginArgv:  ['stripe', 'login'],
      logoutArgv: ['stripe', 'logout'],
      loginHint:   'Opens a browser and writes credentials to ~/.config/stripe/.',
      loginHintZh: '打开浏览器完成授权，凭据写入 ~/.config/stripe/。',
    },
  },

  // ── Cloud giants (token-based profile flows) ───────────────────────────────
  {
    id: 'aws',
    binary: 'aws',
    name: 'AWS CLI',
    description: 'Interact with AWS services (S3, Lambda, IAM, …)',
    descriptionZh: '访问 AWS 的 S3 / Lambda / IAM 等服务',
    category: 'cloud',
    iconSlug: 'aws',
    homepage: 'https://aws.amazon.com/cli/',
    recommendedScope: 'global',
    versionArgv: ['aws', '--version'],
    install: {
      docs: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
      darwin: [{ label: 'Homebrew', cmd: 'brew install awscli' }],
      linux:  [{ label: 'Bundled installer', cmd: 'curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscli.zip && unzip awscli.zip && sudo ./aws/install' }],
      win:    [{ label: 'MSI', cmd: 'msiexec.exe /i https://awscli.amazonaws.com/AWSCLIV2.msi' }],
    },
    auth: {
      type: 'token',
      statusArgv: ['aws', 'sts', 'get-caller-identity'],
      tokenFields: [
        { key: 'AWS_ACCESS_KEY_ID',     label: 'Access key ID', labelZh: 'Access Key ID', required: true },
        { key: 'AWS_SECRET_ACCESS_KEY', label: 'Secret key',    labelZh: 'Secret Access Key', secret: true, required: true },
        { key: 'AWS_DEFAULT_REGION',    label: 'Region',        labelZh: '默认区域', placeholder: 'us-east-1' },
      ],
      loginHint:   'Writes credentials to ~/.aws/credentials under [default].',
      loginHintZh: '凭据会写入 ~/.aws/credentials 的 [default] 下。',
    },
  },
  {
    id: 'gcloud',
    binary: 'gcloud',
    name: 'Google Cloud CLI',
    description: 'Manage GCP projects, compute, storage, and IAM',
    descriptionZh: '管理 GCP 项目、计算、存储与 IAM',
    category: 'cloud',
    iconSlug: 'google-cloud',
    homepage: 'https://cloud.google.com/sdk/gcloud',
    recommendedScope: 'global',
    versionArgv: ['gcloud', '--version'],
    install: {
      docs: 'https://cloud.google.com/sdk/docs/install',
      darwin: [{ label: 'Homebrew Cask', cmd: 'brew install --cask google-cloud-sdk' }],
      linux:  [{ label: 'Bundled installer', cmd: 'curl https://sdk.cloud.google.com | bash' }],
      win:    [{ label: 'Installer', cmd: 'winget install Google.CloudSDK' }],
    },
    auth: {
      type: 'oauth-web',
      statusArgv: ['gcloud', 'auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'],
      loginArgv:  ['gcloud', 'auth', 'login'],
      logoutArgv: ['gcloud', 'auth', 'revoke'],
      loginHint:   'Opens a browser for Google OAuth.',
      loginHintZh: '将打开浏览器完成 Google OAuth 授权。',
    },
  },

  // ── Social & messaging ─────────────────────────────────────────────────────
  {
    id: 'lark-cli',
    binary: 'lark-cli',
    name: 'Lark CLI',
    description: 'Official Lark/Feishu CLI — Messenger, Docs, Base, Calendar, Tasks (200+ commands, Agent-native)',
    descriptionZh: '飞书官方 CLI — 消息、文档、多维表格、日历、任务等 200+ 命令，专为 Agent 设计',
    category: 'social',
    iconSlug: 'lark',
    homepage: 'https://github.com/larksuite/cli',
    recommendedScope: 'global',
    versionArgv: ['lark-cli', '--version'],
    install: {
      docs: 'https://github.com/larksuite/cli#installation--quick-start',
      darwin: [{ label: 'npm', cmd: 'npm i -g @larksuite/cli' }],
      linux:  [{ label: 'npm', cmd: 'npm i -g @larksuite/cli' }],
      win:    [{ label: 'npm', cmd: 'npm i -g @larksuite/cli' }],
    },
    auth: {
      type: 'oauth-web',
      statusArgv: ['lark-cli', 'auth', 'status'],
      loginArgv:  ['lark-cli', 'auth', 'login', '--recommend'],
      logoutArgv: ['lark-cli', 'auth', 'logout'],
      loginHint:   'First run `lark-cli config init` in a terminal to register your Feishu app, then click below to sign in via OAuth.',
      loginHintZh: '首次使用先在终端运行 `lark-cli config init` 注册飞书应用，再点这里走 OAuth 浏览器登录。建议同步安装配套 Skills：`npx skills add larksuite/cli -y -g`。',
    },
  },

  // ── Content & creation ─────────────────────────────────────────────────────
  {
    id: 'mocli',
    binary: 'mocli',
    name: 'Mowen CLI',
    description: 'Talk to 墨问 (Mowen) — query notes, search users, view activity from your agent',
    descriptionZh: '墨问官方 CLI — 查我的笔记、搜用户、看动态，给 Agent 一手接入墨问内容',
    category: 'content',
    iconUrl: 'https://pub-sdn-001.mowen.cn/fe/assets/mowen-note.svg',
    homepage: 'https://github.com/mowenxd/cli',
    recommendedScope: 'global',
    versionArgv: ['mocli', '--version'],
    install: {
      docs: 'https://github.com/mowenxd/cli#安装与快速开始',
      darwin: [{ label: 'npm', cmd: 'npm i -g @mowenxd/cli' }],
      linux:  [{ label: 'npm', cmd: 'npm i -g @mowenxd/cli' }],
      win:    [{ label: 'npm', cmd: 'npm i -g @mowenxd/cli' }],
    },
    auth: {
      type: 'token',
      statusArgv: ['mocli', 'auth', 'info'],
      logoutArgv: ['mocli', 'auth', 'logout'],
      tokenFields: [
        { key: 'MOWEN_API_KEY', label: 'Mowen API Key', labelZh: '墨问 API Key', secret: true, required: true },
      ],
      loginHint:   'Get your API Key in the Mowen mini-program → 我的 → 开发者 → 我的 API Key.',
      loginHintZh: '在墨问小程序里：右下角「我的」→「开发者」→「我的 API Key」，复制粘贴到这里。装完后建议再跑 `npx skills add mowenxd/cli -y -g` 安装配套 Skills。',
    },
  },

  // ── No-auth utilities (detect only) ────────────────────────────────────────
  {
    id: 'opencli',
    binary: 'opencli',
    name: 'OpenCLI',
    description: 'Universal CLI hub — call 100+ websites and local binaries as agent-friendly commands via a browser bridge',
    descriptionZh: '通用 CLI Hub — 借助浏览器桥接，把 100+ 网站与本地二进制变成 Agent 可调用的命令',
    category: 'dev',
    iconUrl: 'https://github.com/jackwener.png?size=80',
    homepage: 'https://github.com/jackwener/opencli',
    recommendedScope: 'global',
    versionArgv: ['opencli', '--version'],
    install: {
      docs: 'https://github.com/jackwener/opencli#installation',
      darwin: [{ label: 'npm', cmd: 'npm i -g @jackwener/opencli' }],
      linux:  [{ label: 'npm', cmd: 'npm i -g @jackwener/opencli' }],
      win:    [{ label: 'npm', cmd: 'npm i -g @jackwener/opencli' }],
    },
    auth: { type: 'none' },
  },
  {
    id: 'docker',
    binary: 'docker',
    name: 'Docker',
    description: 'Build, run, and ship containers',
    descriptionZh: '构建、运行和分发容器',
    category: 'dev',
    iconSlug: 'docker',
    homepage: 'https://docs.docker.com/engine/install/',
    recommendedScope: 'global',
    versionArgv: ['docker', '--version'],
    install: {
      docs: 'https://docs.docker.com/engine/install/',
      darwin: [{ label: 'Docker Desktop', cmd: 'brew install --cask docker' }],
      linux:  [{ label: 'Script', cmd: 'curl -fsSL https://get.docker.com | sh' }],
      win:    [{ label: 'Docker Desktop', cmd: 'winget install Docker.DockerDesktop' }],
    },
    auth: { type: 'none' },
  },
  {
    id: 'pnpm',
    binary: 'pnpm',
    name: 'pnpm',
    description: 'Fast, disk-efficient Node package manager',
    descriptionZh: '更快、更节省磁盘的 Node 包管理器',
    category: 'dev',
    iconSlug: 'pnpm',
    homepage: 'https://pnpm.io/',
    recommendedScope: 'global',
    versionArgv: ['pnpm', '--version'],
    install: {
      docs: 'https://pnpm.io/installation',
      darwin: [{ label: 'npm', cmd: 'npm i -g pnpm' }, { label: 'Homebrew', cmd: 'brew install pnpm' }],
      linux:  [{ label: 'npm', cmd: 'npm i -g pnpm' }],
      win:    [{ label: 'npm', cmd: 'npm i -g pnpm' }],
    },
    auth: { type: 'none' },
  },
];

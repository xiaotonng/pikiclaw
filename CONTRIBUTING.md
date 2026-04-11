# Contributing to pikiclaw

Thanks for your interest in contributing! This guide will help you get started.

## Getting Started

### Prerequisites

- Node.js 18+
- At least one agent CLI installed and authenticated: [`claude`](https://docs.anthropic.com/en/docs/claude-code), [`codex`](https://github.com/openai/codex), or [`gemini`](https://github.com/google-gemini/gemini-cli)
- A bot token for testing (Telegram, Feishu, or WeChat)

### Setup

```bash
git clone https://github.com/xiaotonng/pikiclaw.git
cd pikiclaw
npm install
npm run build
npm test
```

### Local development

```bash
npm run dev    # starts pikiclaw in --no-daemon mode, logs to ~/.pikiclaw/dev/dev.log
```

This gives you a live-reloading development server with the dashboard at `http://localhost:3939`.

### Running tests

```bash
npm test                                    # all unit tests
npx vitest run test/some-file.unit.test.ts  # single test file
npm run test:watch                          # watch mode
```

## Architecture

Dependencies flow strictly downward:

```
cli/  →  dashboard/  →  channels/*  →  bot/  →  agent/  →  core/
```

- **core/** — zero business-logic dependencies (constants, logging, config)
- **agent/** — agent abstraction layer (drivers, sessions, streaming, MCP)
- **bot/** — channel-agnostic bot orchestration
- **channels/** — physically isolated IM implementations (Telegram, Feishu, WeChat)
- **dashboard/** — Hono HTTP server + React SPA
- **cli/** — entry points

Each channel in `channels/*/` is fully isolated — modifying Telegram code never requires touching Feishu code.

For more detail see [ARCHITECTURE.md](ARCHITECTURE.md).

## Making Changes

### Branch naming

Use descriptive branch names:

- `fix/windows-path-quoting`
- `feat/slack-channel`
- `docs/contributing-guide`

### Commit messages

Use conventional-style prefixes:

- `fix:` — bug fix
- `feat:` — new feature
- `docs:` — documentation only
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `test:` — adding or updating tests
- `chore:` — build, CI, or tooling changes

Example: `fix: use double quotes for Windows path quoting in Q()`

### Before submitting a PR

1. Make sure your changes build: `npm run build`
2. Make sure tests pass: `npm test`
3. Test manually if your change affects runtime behavior
4. Keep PRs focused — one concern per PR

### PR process

1. Fork the repo and create your branch from `main`
2. Make your changes
3. Open a PR against `main` — the [PR template](.github/pull_request_template.md) will guide you
4. CI will run build and tests automatically
5. Address any review feedback

PRs are typically reviewed within a few days. For larger changes, consider opening an issue first to discuss the approach.

## Where to Contribute

### Good first issues

Look for issues labeled [`good first issue`](https://github.com/xiaotonng/pikiclaw/labels/good%20first%20issue) — these are scoped to be approachable for newcomers.

### Help wanted

Issues labeled [`help wanted`](https://github.com/xiaotonng/pikiclaw/labels/help%20wanted) are areas where community contributions are especially welcome.

### Quick reference: where to look

| Task | Key files |
|---|---|
| Add a new agent driver | `src/agent/driver.ts`, `src/agent/drivers/*.ts` |
| Add a new IM channel | `src/channels/base.ts`, any `src/channels/*/` as example |
| Modify session management | `src/agent/session.ts`, `src/agent/types.ts` |
| Add a dashboard API route | `src/dashboard/routes/*.ts` |
| Change MCP tool behavior | `src/agent/mcp/tools/*.ts` |

## Reporting Bugs

Use the [bug report template](https://github.com/xiaotonng/pikiclaw/issues/new?template=bug_report.yml). Include your OS, pikiclaw version, channel, and agent — this helps us reproduce quickly.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

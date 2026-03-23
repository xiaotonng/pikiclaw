---
name: dev
description: This skill should be used when the user asks to start, restart, keep alive, or inspect the local pikiclaw development service, including `npm run dev`, local debug bot startup, dashboard verification, and dev log checks.
version: 1.0.0
---

# Start Local Dev Service

## 1. Stay on the local source chain

Use the checked-out repo only. Do not switch to or modify the production/self-bootstrap `npx pikiclaw@latest` path.

## 2. Use the repo wrapper script

Use the repo wrapper instead of retyping inline shell/Python snippets:

```bash
bash scripts/dev-service.sh <command>
```

The script defaults to unsetting `FEISHU_ALLOWED_CHAT_IDS` unless `--keep-feishu-allowlist` is passed. A stale allowlist can block incoming Feishu messages in dev mode.

## 3. Common commands

- Foreground local run:

```bash
bash scripts/dev-service.sh foreground
```

- Detached start for persistent help across agent turns:

```bash
bash scripts/dev-service.sh start
```

- Restart the local source-tree dev chain after code changes:

```bash
bash scripts/dev-service.sh restart
```

- Inspect current PID/listener/log tail:

```bash
bash scripts/dev-service.sh status
```

- Stop the local source-tree dev chain:

```bash
bash scripts/dev-service.sh stop
```

## 4. Verify startup

`start`, `restart`, and `status` already print `dev.pid`, the current listener on `3940`, and tails from both `~/.pikiclaw/dev/dev.log` and `~/.pikiclaw/dev/detached.out`.

Healthy startup usually shows:

- `dashboard: http://localhost:3940`
- `bot: 测试机器人`
- `✓ Feishu connected, WebSocket listening — ready to receive messages`

## 5. Useful paths

- Dev config: `~/.pikiclaw/dev/setting.json`
- Dev app log: `~/.pikiclaw/dev/dev.log`
- Detached outer log: `~/.pikiclaw/dev/detached.out`
- Detached PID file: `~/.pikiclaw/dev/dev.pid`

## Notes

- `npm run dev` already rebuilds the dashboard and runs `tsx src/cli.ts --no-daemon`.
- `bash scripts/dev-service.sh foreground` still stays on the checked-out repo and ultimately runs the same local `scripts/dev.sh` / `tsx src/cli.ts --no-daemon` chain.
- If the user reports Feishu messages not arriving, check whether `FEISHU_ALLOWED_CHAT_IDS` is set in the launch environment before debugging anything else.
- For code changes that should affect the running dev bot, use `bash scripts/dev-service.sh restart` so the detached dev process picks up the new code.

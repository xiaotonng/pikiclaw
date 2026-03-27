---
name: dev
description: This skill should be used when the user asks to start, restart, keep alive, or inspect the local pikiclaw development service, including `npm run dev`, local debug bot startup, dashboard verification, and dev log checks.
version: 2.0.0
---

# Start Local Dev Service

Run the following command to start (or restart) the local dev service:

```bash
npm run dev
```

This rebuilds the dashboard and runs `tsx src/cli.ts --no-daemon` in the foreground.

## Notes

- Stay on the checked-out repo only. Do not switch to or modify the production/self-bootstrap `npx pikiclaw@latest` path.
- Dev app log: `~/.pikiclaw/dev/dev.log`
- Dev config: `~/.pikiclaw/dev/setting.json`

---
name: promote
description: This skill should be used to search GitHub for relevant issues, filter them, draft replies to promote pikiclaw using a sub-agent, and publish those replies while tracking already replied issues to avoid duplicates.
version: 2.0.0
---

# GitHub Promotion Workflow

This skill automates searching for GitHub issues where `pikiclaw` can be promoted as a helpful solution, generating contextual replies, and posting them, while maintaining a history to prevent duplicate replies.

## 1. Context Check (Anti-Duplication)

Before doing anything, ALWAYS read the registry of already replied issues to ensure we do not spam or reply to the same issue twice.

- **Registry Path:** `.pikiclaw/skills/promote/replied_issues.txt`
- **Action:** Read this file and keep the URLs in context.

## 2. Search for Potential Issues

Use `gh search issues` (via shell) to find recent, open issues related to our domain.

### Search Queries

Run multiple queries in parallel to maximize coverage:

**Core IM + Agent queries:**
- `"claude code mobile" --state open`
- `"claude code telegram" --state open`
- `"claude code wechat" --state open`
- `"claude code feishu" --state open`
- `"gemini cli telegram" --state open`
- `"gemini cli mobile" --state open`
- `"codex cli telegram" --state open`
- `"codex cli mobile" --state open`

**Remote/mobile control queries:**
- `"coding agent phone" --state open`
- `"coding agent mobile" --state open`
- `"ai agent remote control" --state open`
- `"ai coding assistant mobile" --state open`

**Desktop/browser automation queries:**
- `"agent browser automation" --state open`
- `"agent desktop automation mac" --state open`
- `"playwright mcp" --state open`

**Chinese queries:**
- `"claude code 手机" --state open`
- `"claude code 远程" --state open`
- `"ai agent 手机控制" --state open`
- `"coding agent 微信" --state open`
- `"coding agent 飞书" --state open`

Example command (filters out aggregator/bot repos and our own repo):
```bash
gh search issues "claude code telegram" --state open --limit 30 --json url,title,repository | jq -r '[.[] | select(.repository.name | test("trending|news|weekly|github-daily|awesome|digest|bulletin|pikiclaw"; "i") | not) | select(.repository.nameWithOwner | test("xiaotonng/") | not)] | .[] | "\(.url) | \(.title) | \(.repository.nameWithOwner)"'
```

## 3. Filter and Select the Best Issues

Filter out any URLs that are already present in `replied_issues.txt`.
For the remaining candidate issues, use `gh issue view <url>` to read the context.

Select issues that express a pain point pikiclaw explicitly solves. Target pain points include:

**IM & Remote Control:**
- Needing remote or mobile control for local coding agents
- Wanting to use Telegram, Feishu, or WeChat to interact with agents
- Issues with official web UIs or SSH on mobile
- Wanting async notifications when long-running agent tasks complete

**Agent Runtime:**
- Long-running agent tasks dying, sleeping, or disconnecting
- Needing session persistence, resume, or multi-turn conversation support
- Wanting to switch agents (Claude/Codex/Gemini) mid-workflow
- Codex needing human-in-the-loop input remotely (Human Loop)

**GUI & Automation:**
- Wanting an agent to control a browser (login-persistent, managed Chrome profile)
- macOS desktop automation (open apps, click, type, screenshot) via agent
- Needing MCP tools for file sharing between agent and IM

**Setup & Management:**
- Wanting a web dashboard to configure agents, channels, and permissions
- Needing a watchdog / auto-restart for agent processes
- Working directory management across multiple projects

Pick 1-5 most relevant issues.

## 4. Draft the Replies using a Sub-Agent

Delegate the drafting process to a sub-agent for high-quality, focused output.

**Prompt for the sub-agent:**

> Draft short, highly grounded, non-spammy GitHub issue replies to promote 'pikiclaw'.
>
> **What pikiclaw is:**
> A Node.js CLI (`npx pikiclaw@latest`) that bridges local Claude Code, Codex CLI, and Gemini CLI to Telegram, Feishu, or WeChat. It runs on your own machine — your files, your tools, your environment — and lets you control everything from your phone.
>
> **Key capabilities to draw from (use only what's relevant to the issue):**
> - Three IM channels: Telegram, Feishu, WeChat — run one or all simultaneously
> - Three agent backends: Claude Code, Codex CLI, Gemini CLI — switch mid-session
> - Streaming preview with continuous message updates
> - Session switching, resume, and multi-turn conversations
> - Codex Human Loop — when Codex asks a question mid-task, it surfaces in your IM as an interactive prompt
> - MCP bridge per stream: `im_list_files`, `im_send_file` for real-time file exchange
> - Browser automation — managed Chrome profile via Playwright MCP (log in once, reuse across tasks)
> - macOS desktop automation — Appium Mac2 (`desktop_open_app`, `desktop_snapshot`, `desktop_click`, `desktop_type`, `desktop_screenshot`)
> - Web Dashboard at localhost:3939 for channel setup, agent config, permissions, extensions, session monitoring
> - Long-task sleep prevention, watchdog, and auto-restart
> - Project-level skills system (`.pikiclaw/skills/`)
> - Working directory browsing and switching from IM
> - File attachments automatically enter the session workspace
> - Long text auto-splitting; images and files sent back to IM directly
>
> **Reply formula:**
> 1. One sentence acknowledging the specific pain point in the issue
> 2. One sentence explaining the relevant architectural solution (be specific — e.g., "watchdog + auto-restart", "MCP bridge for file exchange", "Human Loop for Codex prompts", "managed Chrome profile for persistent logins")
> 3. Direct call to action: `npx pikiclaw@latest`
> 4. End with project link: `GitHub: https://github.com/xiaotonng/pikiclaw`
>
> **Rules:**
> - Match the language of the original issue (Chinese, Japanese, English, etc.)
> - Only mention features that are directly relevant to the issue — do NOT list everything
> - Sound like a developer sharing a tool, not a marketer pushing a product
> - Keep replies under 5 sentences (the extra sentence is for the project link)
>
> Provide only the drafted replies.

Review the drafts. Ensure they are NOT generic ads but provide real technical insight relevant to the specific issue.

## 5. Post the Replies

Use `gh` to post the drafted comments:

```bash
gh issue comment <URL> --body "<Drafted Reply>"
```

## 6. Update the Registry

After successfully posting replies, ALWAYS append the new issue URLs to the registry:

```bash
echo "<URL>" >> .pikiclaw/skills/promote/replied_issues.txt
```

Never skip this step — it prevents duplicate replies in future runs.

---
name: promote
description: This skill should be used to search GitHub for relevant issues, filter them, draft replies to promote pikiclaw using a sub-agent, and publish those replies while tracking already replied issues to avoid duplicates.
version: 5.0.0
---

# GitHub Promotion Workflow

This skill targets the open issues of **same-space projects** (local coding agent ↔ IM / mobile / remote console) — that's where users have already self-identified as needing this category of tool. We share pikiclaw as another option that may help; we do not position against the host project.

## 1. Context Check (Anti-Duplication)

Before doing anything, ALWAYS read the registry of already replied issues to ensure we do not spam or reply to the same issue twice.

- **Registry Path:** `.pikiclaw/skills/promote/replied_issues.txt`
- **Action:** Read this file and keep the URLs in context.

## 2. Primary Path — Same-Space Project Issues

This is the main targeting strategy. Walk the issue trackers of the peer projects below — their users already feel the pain pikiclaw addresses. Bucket A repos are pikiclaw's same channels (Telegram / Feishu / WeChat); Bucket B repos are different channels (Discord / Slack / DingTalk) — replies in Bucket B are only valid for **channel-agnostic** topics (MCP bridge, session management, dashboard, multi-agent, watchdog) where pikiclaw's general capabilities apply regardless of frontend.

### Bucket A — Same-channel peers (highest fit)

```bash
# Telegram cluster
gh issue list --repo chenhg5/cc-connect --state open --limit 50
gh issue list --repo RichardAtCT/claude-code-telegram --state open --limit 50
gh issue list --repo a5c-ai/claude-code-telegram-bot --state open --limit 30
gh issue list --repo seedprod/claude-code-telegram --state open --limit 30
gh issue list --repo cutevisor/return-by-death --state open --limit 30
gh issue list --repo JohannOosthuizen/Gemini-CLI-Telegram-Bot --state open --limit 30
gh issue list --repo ada720725-star/claude-code-telegram --state open --limit 30
gh issue list --repo gohyperdev/hdcd-telegram --state open --limit 30

# Feishu cluster
gh issue list --repo laborany/laborany --state open --limit 30
gh issue list --repo MidnightV1/Claude-Code-Feishu --state open --limit 30
gh issue list --repo whobot-ai/claude-code-feishu-channel --state open --limit 30
gh issue list --repo m1heng/clawdbot-feishu --state open --limit 30
gh issue list --repo CherryLover/claude-code-feishu --state open --limit 30
gh issue list --repo AwadYoo/claude-code-feishu-channel --state open --limit 30
gh issue list --repo czm15053/claude-code-feishu-channel --state open --limit 30
gh issue list --repo AkaiZheng/ClaudeCode-Feishu-Channel --state open --limit 30

# WeChat cluster
gh issue list --repo Johnixr/claude-code-wechat-channel --state open --limit 30
gh issue list --repo Wechat-ggGitHub/wechat-claude-code --state open --limit 30
gh issue list --repo m1heng/claude-plugin-weixin --state open --limit 30
```

### Bucket B — Different-channel peers (channel-agnostic topics only)

```bash
# Discord cluster (190★ + 70★ + 41★)
gh issue list --repo zebbern/claude-code-discord --state open --limit 30
gh issue list --repo timoconnellaus/claude-code-discord-bot --state open --limit 30
gh issue list --repo ebibibi/claude-code-discord-bridge --state open --limit 30
gh issue list --repo BrunoJurkovic/claude-code-discord-status --state open --limit 30
gh issue list --repo jubalm/claude-code-discord --state open --limit 30

# Slack cluster (157★)
gh issue list --repo mpociot/claude-code-slack-bot --state open --limit 30
gh issue list --repo jeremylongshore/claude-code-slack-channel --state open --limit 30
gh issue list --repo 41fred/claude-code-slack --state open --limit 30
gh issue list --repo AnandChowdhary/claude-code-slack-bot --state open --limit 30

# DingTalk
gh issue list --repo sfyyy/claude-code-dingtalk-mcp --state open --limit 30
```

### Bucket C — Mobile / remote / dashboard cluster

```bash
gh issue list --repo 9cat/claude-code-app --state open --limit 30
gh issue list --repo ahmed3elshaer/everything-claude-code-mobile --state open --limit 30
gh issue list --repo aiya000/claude-code-mobile-ssh --state open --limit 30
gh issue list --repo qingpingwang/remote-claude-code --state open --limit 30
gh issue list --repo BMeyn/claude_code_mobile --state open --limit 30
```

Run within a bucket in parallel. Sort by recency and ignore anything older than 90 days unless thread is still active.

**Refresh the list periodically** — popularity in this space moves quickly. Before a run, re-check across all channel keywords:

```bash
for kw in "claude code telegram" "claude code feishu" "claude code wechat" "claude code discord" "claude code slack" "claude code dingtalk" "claude code mobile" "codex telegram" "codex feishu"; do
  gh search repos "$kw" --limit 15 --json fullName,stargazersCount,description,pushedAt \
    --jq 'sort_by(-.stargazersCount) | .[] | "\(.stargazersCount)★ \(.fullName) — \(.description // "")"'
done
```

If a repo with >10★ pushed within the last 90 days isn't in the list above, add it (Bucket A if same channel as pikiclaw; Bucket B if different channel; Bucket C if mobile/remote/dashboard).

## 3. Secondary Path — Keyword Search

After working through the same-space repos, fall back to broad keyword searches for stragglers. Only run these if the primary path produces fewer than 5 candidates.

```bash
# Examples — run with --json url,title,repository and filter aggregator/awesome repos
gh search issues "claude code mobile" --state open --limit 30
gh search issues "claude code telegram" --state open --limit 30
gh search issues "coding agent remote" --state open --limit 30
gh search issues "claude code 飞书" --state open --limit 30
gh search issues "claude code 微信" --state open --limit 30
gh search issues "agent web dashboard" --state open --limit 30
```

Filter command (drops aggregator/news repos and our own):
```bash
gh search issues "<query>" --state open --limit 30 --json url,title,repository \
  | jq -r '[.[]
      | select(.repository.name | test("trending|news|weekly|github-daily|awesome|digest|bulletin|pikiclaw"; "i") | not)
      | select(.repository.nameWithOwner | test("xiaotonng/") | not)]
      | .[] | "\(.url) | \(.title) | \(.repository.nameWithOwner)"'
```

## 4. Filter and Select

Drop any URL already in `replied_issues.txt`. For the remaining candidates, run `gh issue view <url>` to read the full thread before judging.

**The target sub-segment in peer trackers is FEATURE-REQUEST issues, not bug reports.** Why: a user asking "can you add X" is an open question — sharing that another tool already has X is legitimate peer information. A bug report specific to the host project's implementation is closed scope — sharing pikiclaw there reads as critique.

**Pick issues where ALL hold:**
- Issue is a `[Feature]` / feature-request OR a generic user-question (not a `[Bug]` specific to host implementation)
- The asked-for capability is something pikiclaw **actually has today** (do not stretch — readers will check)
- Thread is alive (recent activity, not closed/wontfix/duplicate-locked)
- Author is the user, not the maintainer doing roadmap planning out loud

**Skip when ANY holds:**
- It's a bug report tied to the host project's specific code paths
- Maintainer has already committed to a fix or there's an in-flight PR
- The thread is a community announcement / pinned design discussion
- Pikiclaw doesn't actually have the asked-for feature, or only has something tangentially related
- The conversation is heated / political — promotion lands as opportunism

**Pain points pikiclaw genuinely solves (use only when relevant):**

*Channels & Agents:*
- Need to drive a local agent from Telegram, Feishu, WeChat
- Want one tool that supports multiple IM channels simultaneously
- Want to switch between Claude Code / Codex / Gemini mid-workflow

*Web Console:*
- Web dashboard at localhost:3939 for full agent control from a browser
- Real-time streaming with tool-use, thinking traces, plan progress
- Image and file attachments, conversation history, draft persistence
- Context window usage display per turn
- Centralized config: agents, channels, models, permissions, extensions

*Runtime & Orchestration:*
- Long-running tasks dying / sleeping / disconnecting (watchdog, auto-restart)
- Session resume, multi-turn, switch agents mid-session
- Task queue with **Steer** — interrupt and re-prioritize a busy agent
- Codex Human Loop — Codex's prompts surface in IM as interactive replies

*MCP & GUI Automation:*
- `im_list_files` / `im_send_file` MCP tools for file exchange with the agent
- Managed Chrome profile via Playwright MCP (login persists across sessions)
- macOS desktop automation via Peekaboo MCP (Accessibility API + ScreenCaptureKit)

*Skills & Extensibility:*
- `.pikiclaw/skills/` reusable workflows triggered from IM
- Compatible with `.claude/commands/*.md` skill format

Pick **3–6** of the strongest candidates for a single run.

## 5. Draft Replies via Sub-Agent

Delegate drafting to a sub-agent so the main thread stays focused on selection.

**Prompt for the sub-agent:**

> Draft short, grounded GitHub issue replies that share `pikiclaw` as another tool the issue author may find useful.
>
> **What pikiclaw is:**
> Node.js CLI (`npx pikiclaw@latest`) — a local agent orchestrator. Bridges Claude Code, Codex CLI, and Gemini CLI to Telegram, Feishu, and WeChat, and serves a full web dashboard at localhost:3939 as a standalone agent console. Runs on the user's own machine — their files, tools, environment.
>
> **Capabilities (use only what's relevant to the specific issue):**
>
> *Channels & Agents:*
> - Telegram, Feishu, WeChat — run any subset simultaneously
> - Claude Code, Codex CLI, Gemini CLI — switch mid-session; per-agent model selection
>
> *Dashboard as Agent Console:*
> - Web dashboard at localhost:3939 — full interactive console in the browser
> - Tool-use activity, thinking traces, plan progress, real-time WebSocket streaming
> - Image / file attachments, file previews, draft persistence across session switches
> - Context window usage per turn, token tracking, usage status per agent
> - Channel/agent/model/permission/extension config in one place
>
> *Runtime & Orchestration:*
> - Streaming preview with continuous IM message updates
> - Session switching, resume, multi-turn
> - Task queue with **Steer** — send follow-up while agent is busy; interrupt and re-prioritize
> - Codex Human Loop — Codex's mid-task questions surface as IM prompts
> - Long-task sleep prevention, watchdog, auto-restart
>
> *MCP & GUI Automation:*
> - Per-stream MCP bridge: `im_list_files`, `im_send_file`
> - Managed Chrome profile via Playwright MCP — log in once, reuse
> - macOS desktop automation via Peekaboo MCP — Accessibility API + ScreenCaptureKit (`see` / `click` / `type` / `window` / `menu` / `app` / `dock`)
>
> *Skills & Extensibility:*
> - `.pikiclaw/skills/` project-level workflows triggered via `/skills` and `/sk_<name>`
> - Compatible with `.claude/commands/*.md` skill format
>
> *Other:*
> - Workspace browsing & switching from IM
> - File attachments enter the session workspace automatically
> - i18n: Chinese / English; light & dark theme
>
> **Language rule (HARD):**
> - Reply in the **language of the issue body**, NOT the repo's default language. A Chinese issue in an English-default repo gets a Chinese reply.
> - Chinese issue → 中文回复（自然书面语，不要翻译腔）。Japanese → 日本語. Other → English.
> - Code identifiers, file paths, and CLI commands stay in their native form regardless of language.
>
> **Tone rules (HARD CONSTRAINTS):**
> - Voice = **humble peer-builder sharing implementation notes**. Frame: "I hit the same thing; here's how I handled it, in case any of it is useful." The reader decides whether to look further. Never "use mine instead", never "X doesn't do Y so try Z".
> - Do NOT address the maintainer (no "供作者参考", "供大佬参考", "@maintainer", "thanks @owner for considering this", etc.). The reply is for the issue author and lurkers — talking to the maintainer reads as either flattery or confrontation, both bad.
> - Do NOT critique the host project. Do NOT use "switch from X", "X doesn't support", "while waiting for X to fix this", "if you find X limiting", "X 还没做" — even neutral-sounding versions of these telegraph competitive intent.
> - Do NOT boast: avoid "我做了一遍" (boastful) — prefer "我自己卡过同样的问题, 后来这样处理" / "I hit the same thing in a side project, ended up doing X" (matter-of-fact).
> - Mention only 1–3 capabilities directly relevant to this exact issue — DO NOT enumerate features.
> - Lead with **implementation specifics** (file paths, function names, data structures, protocol details) over feature names. That's what signals real building, not marketing.
> - Keep replies under 5 sentences.
>
> **Humble closes (use one, vary across drafts):**
> - 中文: "希望对你有帮助。" / "权当一个参考。" / "如果思路不对就忽略。" / "在你的场景下不一定合适, 给个参考。" / "一个参考思路。"
> - English: "Sharing in case the shape is useful." / "One reference shape — feel free to ignore if it doesn't fit." / "In case any of that helps."
> - Japanese: "ご参考まで。" / "もしご参考になれば。"
> - Never: "供作者参考" / "供大佬参考" / "@author what do you think" / "looking forward to your thoughts".
>
> **Reply skeleton:**
> 1. **Peer-position + one-line orienter** (REQUIRED — assume the reader has never heard of pikiclaw and is reading this from a notification).
>    - 中文模板: "我自己也卡过同样的问题。我在做一个类似的工具叫 `pikiclaw`——把 Claude Code / Codex / Gemini 接到 Telegram / 飞书 / 微信 + 本地 dashboard。"
>    - English template: "I'm building a similar tool (`pikiclaw`) that bridges Claude Code / Codex / Gemini to Telegram / Feishu / WeChat plus a localhost dashboard — hit the same thing."
>    - The orienter is **always one compact line**, never a feature paragraph. Vary surface form across drafts so it doesn't read as a copy-paste signature, but always include "Claude Code / Codex / Gemini" and "Telegram / Feishu / WeChat + dashboard" — those are the load-bearing identifiers.
> 2. **Out-of-box claim — the headline message** (REQUIRED). The reader's actual question is "if I install your thing, do I get this without setup?" — answer that *first*, before any implementation detail.
>    - The claim must be specific to the issue's exact pain point. Not "pikiclaw has lots of features" but "this exact capability is available the moment you run `npx pikiclaw@latest`, with no config edits / no env vars / no patches".
>    - 中文常用句型: "这个能力装好就有" / "开箱即用，不用写配置" / "`npx pikiclaw@latest` 起来就能直接 X"
>    - English: "this works out of the box" / "no env vars or config edits needed" / "drop in and run — `npx pikiclaw@latest` and the X is there"
>    - This is the load-bearing sentence in the entire reply. Everything else exists to support it.
> 3. **One sentence of implementation evidence** — file/function/data-structure level detail. This is the credibility anchor proving the out-of-box claim isn't marketing fluff. NOT the main message — keep it to a single sentence; the goal is "they actually built this", not "let me teach you how it works".
> 4. Trial line: `npx pikiclaw@latest`
> 5. Project link: `https://github.com/xiaotonng/pikiclaw`
> 6. Optional: humble close on its own line, before the trial line, when the issue is heated or the author has done deep root-cause analysis themselves.
>
> **Skeleton anti-patterns — reject the draft if any apply:**
> - Reply opens with implementation detail before the reader knows what pikiclaw is. Implementation in a vacuum is incomprehensible to a notification-arrival reader.
> - Reply leads with implementation BEFORE the out-of-box claim. The reader's question is "do I get this for free?" — answer that first; the implementation evidence is a footnote in service of that claim.
> - Out-of-box claim is generic ("pikiclaw is easy to use", "everything works") instead of pinned to the specific capability the issue is asking about.
> - "pikiclaw is X" or "pikiclaw can do X" — vendor voice. Use "I'm building / 我在做" instead.
> - Orienter expanded into a feature list (more than the bridges + dashboard line). That's promo, not orientation.
> - Implementation paragraph dominates the reply — more than one sentence on file/function/data-structure level. That's a tutorial, not a peer note.
> - Orienter in a separate paragraph before the "I hit the same thing" — feels like an ad header. Fold orienter and peer-position into the same opener.
>
> **Contributor-flavored variant — use only when the issue author is clearly a developer and the issue is technical:**
> Replace step 2 with one line of implementation specifics that signals "we hit and solved this" — e.g., per-stream MCP bridge spawn order, watchdog re-attach strategy, Playwright managed-profile lifecycle. Keep it grounded; do not embellish.
>
> Provide only the drafted replies, one per issue, with the issue URL above each draft.

Review the drafts. Reject any that:
- Read like marketing copy
- Compare pikiclaw to the host project
- List >3 features
- Exceed 5 sentences
- Don't engage with the specific pain point in the issue

If a draft fails review, send it back to the sub-agent for a single revision pass. After two failed passes, drop that issue from the run.

## 6. Review Gate Before Posting

Posting to other people's issues is hard-to-reverse — once the comment is up, deletion is visible.

**Always present the final draft set to the user for explicit approval before step 7.** Format:

```
ISSUE 1: <url>
TITLE: <title>
REPO: <owner/repo>
PAIN POINT: <one-line summary>
DRAFT:
<draft text>

ISSUE 2: ...
```

The user replies with "post all" / "post 1, 3" / "skip" / specific edits. Do not post until approval lands.

## 7. Post Approved Replies

```bash
gh issue comment <URL> --body "<Drafted Reply>"
```

If a post fails (rate limit, blocked, etc.), report it and continue with the rest.

## 8. Update the Registry

For every successfully posted reply:

```bash
echo "<URL>" >> .pikiclaw/skills/promote/replied_issues.txt
```

Never skip this step — duplicate replies are the worst possible outcome of this skill.

## 9. Report Back

End the run with:
- Count of issues searched / candidates filtered / posted / skipped
- Any blocked posts and why
- Recommended next-run focus (e.g., "Feishu cluster has 4 fresh open issues; revisit in 7 days")

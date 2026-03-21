<div align="center">

# pikiclaw

**Put the world's smartest AI agents in your pocket. Command local Claude, Codex & Gemini via best IM.**

*让最好用的 IM 变成你电脑上的顶级 Agent 控制台*

> npx pikiclaw@latest

<img src="docs/promo-install.gif" alt="Quick install" width="700">

<p align="center">
<a href="https://www.npmjs.com/package/pikiclaw"><img src="https://img.shields.io/npm/v/pikiclaw" alt="npm"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
<a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-18+-green.svg" alt="Node.js 18+"></a>
</p>

</div>

---

## Why pikiclaw?

很多“IM 接 Agent”的方案，本质上还是在绕路：

- 要么自己造 Agent，效果不如官方 CLI
- 要么跑在远端沙盒里，不是你的环境
- 要么只能短对话，不适合长任务

pikiclaw 的目标很直接：

- 用官方 Agent CLI，而不是重新发明一套
- 用你自己的电脑，而不是陌生沙盒
- 用你已经在用的 IM，而不是再学一套远程控制方式

```
  你（Telegram / 飞书）
          │
          ▼
       pikiclaw
          │
          ▼
  Claude Code / Codex / Gemini
          │
          ▼
       你的电脑
```

它适合的不是”演示一次 AI”，而是你离开电脑以后，Agent 还能继续在本机把事做完。

### 在 Telegram 里长这样

<table>
<tr>
<td align=”center”><b>命令与 Agent 切换</b><br><img src=”docs/promo-tg-commands.png” alt=”Commands” width=”320”></td>
<td align=”center”><b>代码审查</b><br><img src=”docs/promo-tg-task.png” alt=”Code review” width=”320”></td>
</tr>
<tr>
<td align=”center”><b>多轮编码 + 文件回传</b><br><img src=”docs/promo-tg-complex.png” alt=”Complex task” width=”320”></td>
<td align=”center”><b>状态监控 + 会话管理</b><br><img src=”docs/promo-tg-sessions.png” alt=”Sessions” width=”320”></td>
</tr>
</table>

---

## Quick Start

### 准备

- Node.js 18+
- 本机已安装并登录任意一个 Agent CLI
  - [`claude`](https://docs.anthropic.com/en/docs/claude-code)
  - [`codex`](https://github.com/openai/codex)
  - [`gemini`](https://github.com/google-gemini/gemini-cli)
- Telegram Bot Token 或飞书应用凭证

### 启动

```bash
cd your-workspace
npx pikiclaw@latest
```

默认会打开 Web Dashboard：`http://localhost:3939`

你可以在 Dashboard 里完成：

- 渠道配置
- 默认 Agent / 模型设置
- 工作目录切换
- 会话和运行状态查看

<details>
<summary>Dashboard 截图</summary>

**配置管理** — IM 接入、AI Agent、系统权限

<img src="docs/promo-dashboard-config.png" alt="Config" width="700">

**会话管理** — 按 Agent 分组的会话泳道

<img src="docs/promo-dashboard-sessions.png" alt="Sessions" width="700">

</details>

如果你更喜欢终端向导：

```bash
npx pikiclaw@latest --setup
```

如果只是检查环境：

```bash
npx pikiclaw@latest --doctor
```

---

## Current Capabilities

### Channels And Agents

- Telegram、飞书都可用，也可以同时启动
- Claude Code、Codex CLI、Gemini CLI 都已接入
- agent 通过统一 driver registry 管理，模型列表、session 列表、usage 展示走同一套接口

### Runtime

- 流式预览和持续消息更新
- 会话切换、恢复和多轮续聊
- 工作目录浏览与切换
- 文件附件自动进入 session workspace
- 长任务防休眠、watchdog 守护和自动重启
- 长文本自动拆分，图片和文件可直接回传到 IM
- Dashboard 可查看运行状态、sessions、usage、主机状态和 macOS 权限状态

### Skills

- 项目级 skills 以 `.pikiclaw/skills/*/SKILL.md` 为 canonical 入口
- 兼容 `.claude/commands/*.md`
- 兼容 legacy `.claude/skills` / `.agents/skills`，并可合并回 `.pikiclaw/skills`
- IM 内可通过 `/skills` 和 `/sk_<name>` 触发

### Codex Human Loop

当 Codex 在运行过程中请求额外用户输入时，pikiclaw 会把问题转成 Telegram / 飞书里的交互提示，用户回复后再继续当前任务。

### MCP And GUI Automation

每次 Agent stream 都会启动一个会话级 MCP bridge，把本地工具按本次任务注入给 Agent。

当前内置工具：

- `im_list_files`：列出 session workspace 文件
- `im_send_file`：把文件实时发回 IM

可选 GUI 能力：

- 浏览器自动化：通过 `@playwright/mcp` 管理一个专用的持久化 Chrome profile；第一次使用时在这个自动化浏览器里登录需要的网站，后续任务会复用同一个 profile
- macOS 桌面自动化：通过 Appium Mac2 提供 `desktop_open_app`、`desktop_snapshot`、`desktop_click`、`desktop_type`、`desktop_screenshot` 等工具

---

## Commands

| 命令 | 说明 |
|---|---|
| `/start` | 显示入口信息、当前 Agent、工作目录 |
| `/sessions` | 查看、切换或新建会话 |
| `/agents` | 切换 Agent |
| `/models` | 查看并切换模型 / reasoning effort |
| `/switch` | 浏览并切换工作目录 |
| `/status` | 查看运行状态、tokens、usage、会话信息 |
| `/host` | 查看主机 CPU / 内存 / 磁盘 / 电量 |
| `/skills` | 浏览项目 skills |
| `/restart` | 重启并重新拉起 bot |
| `/sk_<name>` | 运行项目 skill |

普通文本消息会直接转给当前 Agent。

<details>
<summary>Telegram 命令效果预览</summary>

<img src="docs/promo-tg-commands.png" alt="Commands in Telegram" width="360">

</details>

---

## Config And Setup Notes

- 持久化配置在 `~/.pikiclaw/setting.json`
- Dashboard 是主配置入口，其他运行时配置仍然可用
- 桌面 GUI 相关常用变量：
  - `PIKICLAW_DESKTOP_GUI`
  - `PIKICLAW_DESKTOP_APPIUM_URL`

浏览器自动化由 dashboard 和本地运行时共同管理，会自动创建并复用专用的 Chrome profile 目录。你只需要在这个专用浏览器里登录需要自动化的网站账号一次。

如果要启用 macOS 桌面自动化，需要先准备 Appium Mac2：

```bash
npm install -g appium
appium driver install mac2
appium
```

然后给运行 `pikiclaw` 的终端应用授予 macOS 的辅助功能权限。

---

## Roadmap

- 把当前会话级 MCP bridge 继续扩展成更完整的顶级工具接入层
- 继续完善 GUI 自动化能力，尤其是浏览器与桌面工具的协同链路
- 增加更多 IM 渠道，WhatsApp 仍在规划中

---

## Development

```bash
git clone https://github.com/xiaotonng/pikiclaw.git
cd pikiclaw
npm install
npm run build
npm test
```

常用命令：

```bash
npm run dev
npm run build
npm test
npm run test:e2e
npx vitest run test/channel-feishu.unit.test.ts
npx pikiclaw@latest --doctor
```

`npm run dev` 只跑本地源码链路，会固定使用 `--no-daemon`，避免跳转到生产/自举用的 `npx pikiclaw@latest`。
同时会把本次启动的全部日志写到 `~/.pikiclaw/dev/dev.log`，并在每次启动时先清空旧日志。

更多实现细节见：

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [INTEGRATION.md](INTEGRATION.md)
- [TESTING.md](TESTING.md)

---

## License

[MIT](LICENSE)

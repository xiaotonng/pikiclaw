<div align="center">

# pikiclaw

## 把全世界最聪明的 AI Agent 装进你的口袋。

##### *面向"创作者不再需要读代码"时代的开放式 Agent 编排器。*

*任意 Agent（Claude · Codex · Gemini · Hermes · …）、任意模型（Claude · GPT · Gemini · DeepSeek · 豆包 · MiMo · MiniMax · OpenRouter · 任意第三方代理）、任意工具（Skills · MCP · CLI）随意插拔。从任意终端驱动它们 —— IM、Web，或未来还会加入的形态。pikiclaw 本身就是用 pikiclaw 构建的。*

```bash
npx pikiclaw@latest
```

<p>
<a href="https://www.npmjs.com/package/pikiclaw"><img src="https://img.shields.io/npm/v/pikiclaw?label=npm&color=cb3837" alt="npm"></a>
<a href="https://www.npmjs.com/package/pikiclaw"><img src="https://img.shields.io/npm/dm/pikiclaw?label=downloads&color=success" alt="npm downloads"></a>
<a href="https://github.com/xiaotonng/pikiclaw/stargazers"><img src="https://img.shields.io/github/stars/xiaotonng/pikiclaw?style=flat&color=yellow" alt="GitHub stars"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
<a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A520-green.svg" alt="Node 20+"></a>
</p>

<p>
<a href="README.md">English</a> | <b>简体中文</b>
</p>

<img src="docs/workspace.png" alt="工作区" width="780">

</div>

---

## pikiclaw 是什么？

**绝大多数"AI 开发工具"项目只切一个面 —— 一种 IDE、一种 Agent、一家模型厂商，然后就止步了。** pikiclaw 押的是另一条赛道：下一阶段的"建造"不会发生在某个编辑器内部，而是发生在一个**编排器**里 —— 让创作者一边坐在控制台前，一边并行地驱动一群 Agent，跑在最好的模型上，通过最顺手的那个终端推进。整个过程不需要打开任何代码文件。

产品就是这个编排器，其它所有东西都是可插拔的层。**而且这个编排器是用它自己构建出来的** —— 我们就是用 pikiclaw 来开发 pikiclaw。

```
   终端层    Telegram · 飞书 · 微信 · Slack · Discord · 钉钉 · 企业微信 · Web Dashboard
                              \__________________________|__________________________/
                                                         v
                                          ┌──────────────────────────────┐
                                          │     pikiclaw 编排器           │
                                          └──────────────────────────────┘
                                                         |
                ┌────────────────────────────────────────┼────────────────────────────────────────┐
                v                                        v                                        v
           Agent 层                                  模型层                                    工具层
   Claude Code · Codex · Gemini · Hermes      Claude · GPT · Gemini · DeepSeek            Skills · MCP · CLI
   （driver registry · ACP · 任意 Agent）      豆包 · MiMo · MiniMax · OpenRouter         （全局 × 工作区）
                                              · 任意 OpenAI 兼容代理 · …
                                                         |
                                                         v
                                                  你的电脑
```

- **终端层** —— Telegram、飞书、微信、Slack、Discord、钉钉、企业微信和 Web Dashboard 是地位对等的入口。新终端从这里插入。
- **Agent 层** —— 直接拿官方的 Claude Code / Codex / Gemini / Hermes CLI 当 driver。Hermes 走 ACP（Agent Client Protocol）；driver registry 可以接入任何 Agent。
- **模型层** —— Claude / GPT / Gemini、国产系列（DeepSeek、豆包、MiMo、MiniMax），加上 OpenRouter 和任意 OpenAI 兼容代理。Providers + Profiles 是一等公民层，自带凭据库、models.dev 目录和按 Agent 注入的能力。
- **工具层** —— Skills、MCP server、CLI 工具，按全局和工作区两个 scope 合并后注入到每个会话。

---

## 自我构建

> 衡量一个 Agent 编排器是否可信，最硬核的标准是它能不能构建自己。pikiclaw 可以。我们用 pikiclaw 开发、测试、发布、运维 pikiclaw —— 每一次提交、每一次发版。

在 pikiclaw 里，典型的一天是这样的：

- 窗口 1 的 Claude Code 会话在实现一条新的 dashboard 路由。
- 窗口 2 的 Codex 会话在同一个工作区里写对应的单元测试。
- 窗口 3 的 Gemini 会话在 review diff 并起草 changelog。
- 第四个线程里，`/sk_promote` 技能在 GitHub 上扫相关 issue 并自动回复。
- 四路流并行；一个人坐在咖啡馆里，从手机上掌控全部。

编排器就是产品。它也恰好是这个编排器自己的开发环境。

---

## 默认就是 Swarm

绝大多数"AI 开发工具"假设：一个用户、一个 Agent、一次一件事。pikiclaw 假设的是反面：**N 个 Agent、N 个窗口、一个操作者、一套工具集。**

- **N 路并行会话** —— Dashboard 的每个 pane 就是一条独立的 Agent 流，对应一个独立的会话工作区；IM 线程还能在上面再叠加。
- **Agent 自由组合** —— pane 1 跑 Claude Code，pane 2 跑 Codex，pane 3 跑 Gemini，分别在不同的仓库 / 工作区上工作。
- **统一工具集** —— 全局 Skills、全局 MCP server、按工作区覆写，规则一致。配置一次，每个会话都继承。
- **随时接管** —— 中断任何运行中的流，排进一条新消息，把控制权交给下一个 Agent。
- **群组模式** —— 把编排器丢进一个飞书 / Slack / Discord / 企业微信群，整个团队共享同一个 swarm。

真正重要的形态是：一个创作者，指尖上是一群 Agent。

---

## 实际效果

> **真实任务** —— 让 pikiclaw 收集并总结今天的 AI 新闻；Agent 读、写、然后把结果通过 Telegram 推回来，整个过程在你手机上完成。

<p align="center"><img src="docs/promo-demo.gif" alt="演示：从 Telegram 发起任务，Agent 在本地执行，结果回到聊天" width="780"></p>

> **Web Dashboard** —— 多 pane 工作区，包含会话列表、对话内容、工具调用轨迹和输入区（1 / 2 / 3 / 6 pane 布局）。

<p align="center"><img src="docs/promo-dashboard-workspace.png" alt="Web Dashboard 工作区" width="780"></p>

<details>
<summary><b>更多：基础操作 · IM 接入 · Agent · 模型 · 扩展 · 权限 · 系统信息</b></summary>

> 发一条消息，看 Agent 流式输出，把文件收回来。

<img src="docs/promo-basic-ops.gif" alt="基础操作" width="780">

> **IM 接入** —— Telegram、飞书、微信、Slack、Discord、钉钉、企业微信的状态与配置

<img src="docs/promo-dashboard-im.png" alt="IM 接入" width="780">

> **Agent** —— 已安装的 Agent CLI、默认 Agent、按 Agent 的模型 / 推理强度

<img src="docs/promo-dashboard-agents.png" alt="Agent" width="780">

> **模型** —— Providers + Profiles 凭据库（Claude、GPT、Gemini、DeepSeek、豆包、MiMo、MiniMax、OpenRouter 以及任意 OpenAI 兼容代理），用 models.dev 目录校验后按 Agent 注入

> **扩展** —— 全局 MCP server、社区 Skills、托管浏览器 + macOS 桌面（Peekaboo）自动化

<img src="docs/promo-dashboard-extensions.png" alt="扩展" width="780">

> **系统权限** —— macOS 辅助功能、屏幕录制、磁盘访问

<img src="docs/promo-dashboard-permissions.png" alt="权限" width="780">

> **系统信息** —— 工作目录、CPU / 内存 / 磁盘监控

<img src="docs/promo-dashboard-system.png" alt="系统信息" width="780">

</details>

---

## 快速开始

**前置要求：** Node.js 20+，并且至少登录一个官方 Agent CLI：

- [`claude`](https://docs.anthropic.com/en/docs/claude-code)（Claude Code）
- [`codex`](https://github.com/openai/codex)（Codex CLI）
- [`gemini`](https://github.com/google-gemini/gemini-cli)（Gemini CLI）
- `hermes`（Hermes —— 通过 ACP / Agent Client Protocol）

**启动：**

```bash
cd your-workspace
npx pikiclaw@latest
```

<p align="center"><img src="docs/promo-install.gif" alt="一行命令安装" width="780"></p>

它会在 `http://localhost:3939` 打开 **Web Dashboard** —— 你可以在浏览器里驱动会话、接 IM 渠道、配置 Agent 与模型、安装 MCP server 与 Skills、管理系统权限。其余一切都是一键之内。

<details>
<summary><b>偏好终端？有个向导。</b></summary>

```bash
npx pikiclaw@latest --setup    # 交互式终端向导
npx pikiclaw@latest --doctor   # 仅做环境检查
```

</details>

---

## 大家都用它来做什么

- **并行跑一个 swarm** —— 在 Dashboard 里开 N 个 pane（或 N 条 IM 线程），每个 pane 是一个不同的 Agent，盯着不同的工作区同时工作。一个人，多个 Agent，一个驾驶舱。随时切到任意一个进去接管。
- **自托管的开发回路** —— pikiclaw 本身就是用 pikiclaw 构建的。开发流程**就是**产品本身：从手机驱动编排器，写代码，发版本，再迭代。
- **走开式编程** —— 启动一个大重构，合上电脑，从手机通过 Telegram 继续操控。Agent 在本地一直跑，结果实时推回聊天。
- **同一工作区上的多 Agent** —— 让 Claude Code 写初版实现，切到 Codex review，再切到 Gemini 换个视角。同一份代码，同一份会话历史。
- **国产模型路由** —— 当延迟、成本、合规约束需要非前沿模型时，通过 wrapper driver 让 Claude Code 跑在 DeepSeek 或豆包上。
- **群里的 Agent** —— 把 pikiclaw 拉进飞书 / Slack / Discord / 企业微信工作群；整个团队共享一个编排器、一个工作区、一套 Skills。
- **由你掌控的 Computer Use** —— 打开托管 Chrome（Playwright）和 macOS 桌面（Peekaboo，基于 Accessibility + ScreenCaptureKit），Agent 就能 `see` 屏幕、点击、输入、管理窗口 / 菜单 / Dock —— 而你从手机上指挥它。订会议、抓 dashboard、跑端到端测试，或者直接驱动任意原生 macOS 应用。
- **以 Skill 为中心的工作流** —— 一次性安装社区 Skill（`promote`、`snipe`、`review`、`security-review` …），之后在任意终端用 `/sk_<name>` 触发。

---

## 功能特性

### 终端层

- **七条 IM 渠道** —— Telegram、飞书、微信（个人号）、Slack、Discord、钉钉、企业微信。开一条、几条、或者全开都行。每条渠道在代码上是物理隔离的；新增一条（WhatsApp、移动端、…）不需要动其他渠道。
- **Web Dashboard** —— 直接在浏览器里驱动会话，拥有和 IM 完全一致的对话、工具调用、流式输出体验。多 pane 工作区（1 / 2 / 3 / 6 pane）、浅色 / 深色主题、EN / 中文 i18n。
- **实时流预览** —— 消息随着 Agent 思考原地刷新；长文本自动分段；图片和文件实时回传。

### Agent 层

- **官方 CLI 即 driver** —— Claude Code、Codex CLI、Gemini CLI、Hermes（走 ACP）。不重写 Agent 内核 —— 直接吃官方上游的能力，Day-0 跟随升级。
- **ACP 原生** —— Hermes 通过 [Agent Client Protocol](https://agentclientprotocol.com) 集成，以 `hermes acp` 启动并走 JSON-RPC stdio。未来任何 ACP 兼容的 Agent 都以同样方式插入。
- **可插拔注册表** —— 唯一契约是 `src/agent/driver.ts`。新的 CLI 或 ACP Agent 可以和现有四个内建 driver 并排接入。
- **按会话切换 Agent** —— 同一个工作区，换个"脑子"。
- **接管** —— 中断当前任务，把一条排队消息提到队首。
- **Codex Human-in-the-Loop** —— Codex 暂停提问时，问题会变成 IM 里的交互式 prompt。在那边回复，任务就继续。
- **持久化目标** —— `/goal` 给每个会话设一个长期目标，带 token 预算和暂停 / 恢复；Agent 完成自审后会自动终止。

### 模型层

- **前沿 + 国产 + 代理** —— Claude（4 系列）、GPT-5 / Codex、Gemini、DeepSeek、豆包（Doubao）、MiMo、MiniMax、OpenRouter，以及任意 OpenAI 兼容的模型代理。
- **Providers + Profiles 凭据库** —— 一等公民数据模型，凭据落在 `~/.pikiclaw/setting.json` 自己的存储区。可以浏览只读的 models.dev 目录，用真实 provider probe 校验 key，再把一个 profile 绑到 Agent 上，启动时自动注入 env。
- **按会话选模型 + 推理强度** —— 在 Dashboard、`/models` 或 `/mode` 里挑。
- **按 Agent 注入** —— `resolveAgentInjection(agentId)` 在启动时把当前 profile 的 env 变量注入进去，所以 Claude Code 可以直接跑在 DeepSeek 或豆包上，而不用改上游客户端配置。

### 工具层

- **Skills** —— 项目级 Skill 放在 `.pikiclaw/skills/*/SKILL.md`，兼容 `.claude/commands/*.md`。从 GitHub 仓库（`owner/repo`）一键安装，或浏览推荐合集（Anthropic Official、Vercel Agent Skills、…）。用 `/skills` 和 `/sk_<name>` 触发。
- **MCP server** —— 浏览 [MCP Registry](https://registry.modelcontextprotocol.io)、自建 stdio / HTTP server、用真实 handshake 做健康检查、OAuth 2.1 + 动态客户端注册、按 scope 启停。推荐目录覆盖 GitHub、Atlassian、Notion、Linear、Sentry、Cloudflare、Slack、飞书 / Lark、Stripe、Hugging Face、Gamma、Brave Search、Perplexity、Filesystem、SQLite、PostgreSQL —— 此外还有两个内建的 computer-use server（`pikiclaw-browser` 走 Playwright 操控 Chrome，`pikiclaw-desktop` 走 Peekaboo 操控 macOS GUI）。
- **CLI 工具** —— 自动探测版本与登录状态，浏览器登录类 CLI 支持 OAuth-web 会话，所有 CLI 都通过 Agent 自身的工具调用面访问。
- **会话级 MCP bridge** —— `im_list_files`、`im_send_file`、`im_ask_user`，加上托管浏览器工具和 macOS 桌面工具（启用时），会被自动注入每个会话。
- **两层合并** —— `global < workspace < built-in`，自动应用到每个会话。

<p align="center"><img src="docs/promo-dashboard-extensions-add.png" alt="添加 MCP server" width="780"></p>

### 运行时 & 开发体验

- **会话工作区** —— 每个会话独占一个目录；附件直接落到那里。
- **恢复、切换、归类** —— 多轮会话、会话分类（answer / proposal / implementation / blocked / …）。
- **会话级 MCP 工具** —— `im_list_files`、`im_send_file`、`im_ask_user` 以及目标管理工具自动注入到每条流。
- **Computer-use（浏览器）** —— 内建 `pikiclaw-browser` MCP 在 `@playwright/mcp` 之上包了一份共享 Chrome profile 和一个进程级 supervisor；登录一次，跨任务复用凭证。
- **Computer-use（macOS 桌面）** —— 内建 `pikiclaw-desktop` MCP 通过 Accessibility + ScreenCaptureKit 跑 [Peekaboo](https://peekaboo.sh/)，暴露 `see`、`click`、`type`、`scroll`、`window`、`menu`、`app`、`dock`。需要在扩展里手动开启；要求"辅助功能"和"屏幕录制"两项权限；仅 macOS。
- **长任务加固** —— 防休眠、watchdog、自动重启、daemon 模式、渠道 supervisor。

---

## 这和其他东西有什么不一样？

| | pikiclaw | IDE 类助手<br>(Cursor / Windsurf / Aider) | 云端 Agent<br>(Devin / web Claude) | 单 Agent IM 机器人 |
|---|---|---|---|---|
| **终端** | 7 条 IM + Web + 后续插件 | 只有 IDE | Web 应用 | 一条 IM、一个 bot |
| **Agent 在哪运行** | 你的机器 | 你的机器 | 厂商沙箱 | 通常在厂商侧 |
| **Agent 选择** | Claude Code · Codex · Gemini · Hermes（ACP）· … | 绑定 | 单一 | 单一 |
| **模型选择** | 前沿 + 国产 + 任意 OpenAI 兼容 | 厂商控制 | 厂商控制 | 单一 |
| **并行 Agent** | **N 个 Agent × N 个窗口 × N 个工作区** | 每个 IDE 一个 | 串行 | 一个 |
| **文件 / 工具** | 你的文件、你的 MCP、你的 CLI | 你的文件 | 沙箱 | 无 / 受限 |
| **接入新终端** | 加一个 `Channel` 类 | n/a | n/a | Fork |
| **接入新 Agent** | 加一个 `AgentDriver`（CLI 或 ACP） | n/a | n/a | Fork |
| **能否自举** | **能 —— 用自己构建自己** | 不能 | 不能 | 不能 |

真正重要的形态是：**你不离开自己的环境，你保留自己的大脑选择权，你并行驱动一个 swarm，而这个编排器就是我们用来构建这个编排器的同一个东西。**

---

## 指令一览

| 指令 | 说明 |
|---|---|
| `/start` | 入口信息、当前 Agent、工作目录 |
| `/sessions` | 查看、切换或新建会话 |
| `/agents` | 切换 Agent（Claude · Codex · Gemini · Hermes） |
| `/models` | 查看与切换模型 / 推理强度 |
| `/mode` | 切换 plan 模式（推理强度） |
| `/switch` | 浏览并切换工作目录 |
| `/workspaces` | 从 Dashboard 的快捷工作区列表挑一个 |
| `/goal` | 设置或查看会话级长期目标（自终止） |
| `/stop` | 停止当前会话 |
| `/status` | 运行状态、token、用量、会话信息 |
| `/host` | 主机 CPU / 内存 / 磁盘 / 电量 |
| `/skills` | 浏览项目 Skill |
| `/ext` | 扩展总览 |
| `/restart` | 重启 bot |
| `/sk_<name>` | 跑一个项目 Skill |

纯文本会被直接转给当前 Agent。

---

## 配置

- 持久化配置文件：`~/.pikiclaw/setting.json` —— 渠道、Agent、Providers/Profiles、工作区、MCP 扩展
- Dashboard 是主要配置入口；终端向导（`--setup`）和 `--doctor` 留给无 UI 场景
- 全局 MCP 扩展放在 setting 文件的 `extensions.mcp` 下
- 工作区 MCP 扩展：项目根目录里的标准 `.mcp.json`
- 项目 Skill：`.pikiclaw/skills/*/SKILL.md`（同时也会识别 `.claude/commands/*.md`）

**Computer-use** 由扩展页面里两个开关控制：

- `browserEnabled` —— 托管 Chrome（Playwright）。Agent 第一次需要 Chrome 时，pikiclaw 会在 `~/.pikiclaw` 下创建一个专用 profile，并在后续会话中复用。常用网站登录一次，往后每次会话都自带凭证。
- `desktopEnabled` —— macOS 桌面（Peekaboo）。开启后（仅 macOS），pikiclaw 会启动 `@steipete/peekaboo` 的 `peekaboo-mcp` 二进制并注入其工具。打开开关前，请先在 *系统设置 → 隐私与安全性* 里给父终端授予 **辅助功能** 与 **屏幕录制** 权限。

---

## Roadmap

已交付：Hermes driver · ACP（Agent Client Protocol） · Provider/Profile 模型凭据库 · 七条 IM 渠道 · Computer-use（Playwright 浏览器 + Peekaboo macOS 桌面）。

- **更多 ACP Agent** —— 任何新的 ACP 兼容 Agent 都应该不用写手工 driver 就能接入
- **更多终端** —— WhatsApp、专用移动端、语音
- **更深的模型层** —— 为更多国产系列做 agent-on-arbitrary-model wrapper
- **更好的工具生态** —— 推荐 MCP 合集、Skill 模板、市场
- **跨平台 Computer-use** —— 在 macOS Peekaboo 之外，再补 Windows / Linux 桌面 driver

协议层细节见 [ACP 迁移方案](docs/acp-migration.md)。

---

## 本地开发

```bash
git clone https://github.com/xiaotonng/pikiclaw.git
cd pikiclaw
npm install
npm run build
npm test
```

```bash
npm run dev                       # 本地开发（--no-daemon，日志写到 ~/.pikiclaw/dev/dev.log）
npm run build                     # 生产构建（dashboard + tsc）
npm test                          # vitest run
npx pikiclaw@latest --doctor      # 环境检查
```

架构与集成深入文档：[ARCHITECTURE.md](ARCHITECTURE.md) · [INTEGRATION.md](INTEGRATION.md) · [TESTING.md](TESTING.md)

---

## 贡献

这个项目的每一层都是*被设计成*可扩展的。新终端、新 Agent、新模型 wrapper、新 MCP 工具 —— 都是一等公民级别的贡献。

- 先读 **[贡献指南](CONTRIBUTING.md)**
- 看一下 [`good first issue`](https://github.com/xiaotonng/pikiclaw/labels/good%20first%20issue) 和 [`help wanted`](https://github.com/xiaotonng/pikiclaw/labels/help%20wanted)
- 较大改动请先开 issue 对齐方案

| 入口 | 你可能要加的东西 |
|---|---|
| `src/agent/driver.ts`、`src/agent/drivers/*.ts`、`src/agent/acp-client.ts` | 一个新的 Agent driver（CLI 或 ACP） |
| `src/channels/base.ts`、`src/channels/*/` | 一个新的终端 / IM 渠道 |
| `src/model/`、`src/model/injector.ts` | 一个新的模型 provider 或按 Agent 注入规则 |
| `src/dashboard/routes/*.ts` | 一个新的 Dashboard API |
| `src/agent/mcp/tools/*.ts`、`src/agent/mcp/bridge.ts` | 新的会话级 MCP 工具 |
| `src/catalog/*.ts` | 一个推荐的 MCP server / CLI 工具 / Skill 仓库 |

---

## Star 历史

<a href="https://www.star-history.com/#xiaotonng/pikiclaw&Date">
  <img src="https://api.star-history.com/svg?repos=xiaotonng/pikiclaw&type=Date" alt="Star history" width="640">
</a>

---

## License

[MIT](LICENSE) —— 开放构建。用它、fork 它、再往上加你自己的那一层。

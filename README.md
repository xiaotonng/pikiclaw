<div align="center">

# codeclaw 🦞

**为您组合最顶级的工具，将长程自动化的体验推向极致。**

*一切在本地运行。将全球最好的 IM 入口（Telegram / 飞书）与全球最强的本地执行引擎（Claude Code / Codex / Gemini CLI）完美连接。不需要云端，不需要沙盒，你的电脑就是最强的 Agent 平台。*

```bash
npx codeclaw@latest
```

[![npm](https://img.shields.io/npm/v/codeclaw)](https://www.npmjs.com/package/codeclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org)

<!-- TODO: 替换为实际 demo GIF -->
<!-- ![demo](docs/assets/demo.gif) -->
`📹 GIF 占位：手机 Telegram 发送任务 → 电脑执行 → 流式进度 → 收到结果文件`

</div>

---

## 🚀 快速开始

### 1. 准备

- Node.js 18+
- 本机已安装并登录 [`claude`](https://docs.anthropic.com/en/docs/claude-code)、[`codex`](https://github.com/openai/codex) 或 [`gemini`](https://github.com/google-gemini/gemini-cli) 中的任意一个
- 一个 [Telegram Bot Token](https://t.me/BotFather) 或一个[飞书应用](https://open.feishu.cn)凭证

### 2. 一行启动

```bash
cd your-workspace/
npx codeclaw@latest
```

启动后自动打开 **Web 配置面板**（默认端口 3939），在浏览器中引导你完成全部配置。如果渠道 Token 和 Agent 已就绪，Bot 会自动开始运行。

你也可以在终端里进入交互式 Setup Wizard：

```bash
npx codeclaw@latest@latest --setup
```

引导流程包括：

- Node.js 版本检查（18+）
- 选择并检查本机 `claude`、`codex` 或 `gemini`
- 引导登录，必要时提供安装命令
- 校验 Telegram Bot Token 或飞书应用凭证
- 可选保存到本机配置，下次启动自动复用

<!-- TODO: 替换为实际截图 -->
`📸 截图占位：终端显示 "Bot is ready"，Telegram 收到欢迎消息`

### 3. 开始派活

在 Telegram 或飞书给你的 bot 发消息：

> "把 docs/ 目录下所有零散文档整理汇总，提取核心指标，输出一份报告。"

**就这样。你的电脑现在是一个随时待命的远程执行中枢。**

---

## ⚡ 核心能力

### 三大 Agent 引擎

| Agent | 特点 |
|-------|------|
| **Claude Code** | Anthropic 官方 CLI，支持 Thinking 展示、多模态输入、缓存优化 |
| **Codex CLI** | OpenAI 官方 CLI，支持 Reasoning 展示、计划步骤追踪、实时用量监控 |
| **Gemini CLI** | Google 官方 CLI，支持工具调用、流式输出 |

随时通过 `/agents` 命令切换引擎，通过 `/models` 切换模型。

### 双渠道 IM 支持

| 渠道 | 消息编辑 | 文件上传 | 回调按钮 | 表情回应 | 消息线程 |
|------|---------|---------|---------|---------|---------|
| **Telegram** | ✅ | ✅ | ✅ | — | — |
| **飞书** | ✅ | ✅ | ✅ | ✅ | ✅ |

两个渠道可以**同时启动**，在配置中设置 `channels: ['telegram', 'feishu']` 即可。

### 功能亮点

- **实时流式输出** — Agent 工作时消息持续更新，不用干等
- **Thinking / Reasoning 展示** — 实时查看 Agent 的思考过程和推理步骤
- **Token 用量追踪** — 每次请求和累计的输入/输出/缓存 Token 统计，上下文使用率实时显示
- **产物回传** — 截图、日志、生成文件自动发回聊天
- **长程防休眠** — 自动阻止系统休眠，小时级任务不中断
- **守护进程模式** — 崩溃自动重启，指数退避（3s → 60s），默认开启
- **长文本处理** — 超长输出自动拆分或打包为 `.md` 文件
- **多会话管理** — 随时切换、恢复历史会话
- **图片 / 文件输入** — 发截图、PDF、文档给 Agent 处理
- **自定义 Skills** — 执行 `.codeclaw/skills/` 中定义的项目技能，并兼容已有 `.claude/commands/`
  启动时会自动把现有 `.agents/skills/`、`.claude/skills/` 迁移到 `.codeclaw/skills/`，并把 `.agents/skills/`、`.claude/skills/` 链接到这里
- **安全模式** — 危险操作推送确认卡片到手机，白名单限制访问
- **Web Dashboard** — 可视化配置、会话浏览、主机监控
- **i18n 国际化** — 支持中文和英文界面

---

## 🖥️ Web Dashboard

启动 codeclaw 后自动打开 Web 配置面板（默认 `http://localhost:3939`）：

- **配置页** — IM 渠道凭证校验、Agent 检测与安装状态、模型选择、Thinking 模式调节、macOS 系统权限引导（辅助功能 / 屏幕录制 / 磁盘访问）
- **会话页** — 主机状态（CPU / 内存 / 磁盘 / 电量）、会话列表与消息详情、运行中任务指示
- **侧边栏** — 快速切换工作目录、重启进程、查看运行时长和活跃任务数

使用 `--no-dashboard` 跳过，`--dashboard-port` 指定端口。

---

## 🔥 长程任务实战场景

codeclaw 专为那些 **"要跑很久、中间可能出错、你不想一直盯着"** 的任务设计。

### 🛒 电商页面复刻与自动装修

> **你（在咖啡厅）：** "去看看竞品网站的新版落地页，分析布局和配色，然后把我们本地的页面改成类似风格。改完截图发我。"

Agent 联网分析竞品、阅读本地项目、重写样式、截图回传。你只管喝咖啡等结果。

### 🏗️ 长程工程重构

> **你（睡前）：** "把整个项目从 JavaScript 迁移到 TypeScript，解决所有类型错误，一直跑测试直到全部通过。搞定告诉我。"

Agent 连续工作数小时，自动循环"改代码 → 跑测试 → 读报错 → 再改"，第二天早上向你汇报结果。

### 📚 学术研究与文献综述

> **你（睡前）：** "下载这 5 篇论文的 PDF，逐篇阅读并提取核心观点，写一份 3000 字的综述报告。"

Agent 下载、解析、处理数万字上下文。第二天早上你收到结构化的 `.md` 综述文件。

### 📊 海量文件批处理

> **你（通勤路上）：** "把 data/ 下所有旧版财务报表转换成新格式，汇总成一份报表，确认数据条数。"

Agent 逐个处理、遇到异常自动重试。20 分钟后你收到完整报表。

### 🔧 自动化巡检与故障自愈

> **你：** "跑一下数据同步任务，把所有报错自动修好，直到全部通过。"

Agent 进入"执行 → 读报错 → 分析 → 修复 → 重跑"的自动循环，直到你收到全部通过的通知。

---

## 💡 为什么选择 codeclaw

当你想 **"把活交出去、人走开"**，你的选择：

```
          在你的环境里执行
               │
    终端 CLI   │   codeclaw
    (人要守着)  │   (人可以走)
               │
  ─────────────┼─────────────
    不方便控制  │  随时随地控制
               │
    SSH+tmux   │   云端 Agent
    (手机上很痛苦) │ (不是你的环境)
               │
          在沙盒/远端执行
```

| | 终端直接跑 | SSH + tmux | 云端 Agent | **codeclaw** |
|---|---|---|---|---|
| 执行环境 | ✅ 本地 | ✅ 本地 | ❌ 沙盒 | ✅ 本地 |
| 走开后还能跑 | ❌ 合盖就断 | ⚠️ 要配 tmux | ✅ | ✅ 自动防休眠 + 守护进程 |
| 手机可控 | ❌ | ⚠️ 打字痛苦 | ✅ | ✅ IM 原生 |
| 实时看进度 | ✅ 终端 | ⚠️ 得连上去看 | ❌ 多数是黑盒 | ✅ 流式推到聊天 |
| 结果自动回传 | ❌ | ❌ | ⚠️ 看平台 | ✅ 截图/文件/长文本 |
| 配置门槛 | 无 | SSH/穿透/tmux | 注册/付费 | `npx` 一行 |

**codeclaw 是唯一同时满足 "本地执行 + 随时控制 + 长程保活 + 产物回传" 的方案。**

### ⚔️ 竞品对比

| 特性 | **codeclaw** 🦞 | OpenClaw | cc-connect |
|---|---|---|---|
| **核心定位** | **专为长程任务优化的本地执行中枢** | 开源自主 AI 智能体生态 | 多渠道多端 Agent 连接器 |
| **执行引擎** | Claude Code / Codex / Gemini CLI | 内置 Agent (自接模型) | 多种本地 CLI / Agent |
| **IM 渠道** | Telegram + 飞书（可同时） | Web / 移动端 | Slack / Discord / LINE 等 |
| **长程任务护航** | ✅ **系统级防休眠、守护进程、异常自愈** | ❌ 偏向即时/轻量级任务 | ❌ 偏向常规指令与短对话 |
| **产物与长文本** | ✅ **原生支持截图、文件、超长输出打包** | ⚠️ 依赖画布或客户端支持 | ⚠️ 基础附件支持 |
| **流式体验** | ✅ **极致平滑的 IM 实时流式进度** | ✅ 支持 | ⚠️ 依赖底层桥接能力 |
| **可视化管理** | ✅ **Web Dashboard 配置与监控** | ✅ Canvas 等 | ⚠️ CLI 配置 |
| **上手配置** | **极简：一行 `npx`，零额外配置** | 较重：需部署完整后端/配置 | 中等：需安装对应服务端 |

---

## 🛠️ 聊天命令

| 命令 | 说明 |
|------|------|
| `/start` | 显示菜单、当前 Agent 和工作目录 |
| `/agents` | 切换 Claude Code / Codex / Gemini（检测到多个 Agent 时显示） |
| `/models` | 查看并切换当前 Agent 的模型 |
| `/sessions` | 查看并切换历史会话（分页浏览） |
| `/switch` | 浏览并切换工作目录 |
| `/status` | 状态、会话信息、Token 用量统计 |
| `/host` | 主机 CPU、内存、磁盘、电量、进程 |
| `/skills` | 浏览当前项目可用的 skills，并查看对应 `/sk_<name>` 命令 |
| `/restart` | 拉取最新版本并重启 |
| `/sk_<name>` | 执行 `.codeclaw/skills/` 中定义的项目技能，或兼容已有 `.claude/commands/` |

> 私聊中，普通文本直接发给当前 Agent。未识别的 `/命令` 也会被当作指令转发。

---

## ⚙️ 启动配置

### 常见用法

```bash
# 自动检测已配置的渠道，打开 Dashboard
npx codeclaw@latest

# 指定 Agent（默认 codex）
npx codeclaw@latest -a claude
npx codeclaw@latest -a gemini

# 指定工作目录
npx codeclaw@latest -w ~/workspace/my-task

# 指定模型
npx codeclaw@latest -m claude-sonnet-4-6

# 安全模式：危险操作需要手机确认
npx codeclaw@latest --safe-mode

# 白名单：只允许你的账号控制
npx codeclaw@latest --allowed-ids YOUR_ID

# 也可以直接传 Token（跳过 Dashboard 配置）
npx codeclaw@latest -t $TELEGRAM_BOT_TOKEN

# 检查环境是否就绪
npx codeclaw@latest --doctor
```

### 完整 CLI 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-t, --token` | — | Bot Token |
| `-a, --agent` | `codex` | 默认 Agent：`claude`、`codex` 或 `gemini` |
| `-m, --model` | Agent 默认 | 覆盖模型 |
| `-w, --workdir` | 已保存目录或当前目录 | 工作目录 |
| `--safe-mode` | `false` | 使用 Agent 自身的权限模型（非 bypass） |
| `--full-access` | `true` | 允许 Agent 无确认执行 |
| `--allowed-ids` | — | 限制 chat/user ID（逗号分隔） |
| `--timeout` | `1800` | 单次请求最大秒数 |
| `--no-daemon` | — | 禁用守护进程（默认启用，崩溃自动重启） |
| `--no-dashboard` | — | 不启动 Web Dashboard |
| `--dashboard-port` | `3939` | Dashboard 端口 |
| `--doctor` | — | 检查环境配置并退出 |
| `--setup` | — | 进入交互式 Setup Wizard |

<details>
<summary>环境变量</summary>

**通用：**

| 变量 | 说明 |
|------|------|
| `DEFAULT_AGENT` | 默认 Agent |
| `CODECLAW_WORKDIR` | 默认工作目录 |
| `CODECLAW_TIMEOUT` | 请求超时（秒） |
| `CODECLAW_ALLOWED_IDS` | 白名单（逗号分隔） |
| `CODECLAW_FULL_ACCESS` | 完全访问模式 |
| `CODECLAW_RESTART_CMD` | 自定义重启命令 |

**Telegram：**

| 变量 | 说明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | Bot Token（替代 `-t`） |
| `TELEGRAM_ALLOWED_CHAT_IDS` | 白名单 |

**飞书：**

| 变量 | 说明 |
|------|------|
| `FEISHU_APP_ID` | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret |
| `FEISHU_DOMAIN` | API 域名（默认 `https://open.feishu.cn`） |
| `FEISHU_ALLOWED_CHAT_IDS` | 白名单 |

**Claude Agent：**

| 变量 | 说明 |
|------|------|
| `CLAUDE_MODEL` | 模型覆盖 |
| `CLAUDE_PERMISSION_MODE` | 权限模式（`bypassPermissions` / `default`） |
| `CLAUDE_EXTRA_ARGS` | 额外 CLI 参数 |

**Codex Agent：**

| 变量 | 说明 |
|------|------|
| `CODEX_MODEL` | 模型覆盖 |
| `CODEX_REASONING_EFFORT` | 推理强度（`low` / `medium` / `high` / `xhigh`） |
| `CODEX_FULL_ACCESS` | 完全访问模式 |
| `CODEX_EXTRA_ARGS` | 额外 CLI 参数 |

**Gemini Agent：**

| 变量 | 说明 |
|------|------|
| `GEMINI_MODEL` | 模型覆盖 |
| `GEMINI_EXTRA_ARGS` | 额外 CLI 参数 |

</details>

---

## 📦 当前状态

| 维度 | 状态 |
|------|------|
| IM 渠道 | Telegram ✅ · 飞书 ✅ · WhatsApp（规划中） |
| Agent | Claude Code ✅ · Codex CLI ✅ · Gemini CLI ✅ |
| 管理面板 | Web Dashboard ✅ |
| 国际化 | 中文 ✅ · English ✅ |
| 平台 | macOS ✅ · Linux ✅ |

---

## 👨‍💻 本地开发

```bash
git clone https://github.com/nicepkg/codeclaw.git
cd codeclaw
npm install
echo "TELEGRAM_BOT_TOKEN=your_token" > .env
set -a && source .env && npx tsx src/cli.ts
npm test
```

架构详情参见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## License

[MIT](LICENSE)

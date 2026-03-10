<div align="center">

# codeclaw 🦞

**为您组合最顶级的工具，将长程自动化的体验推向极致。**

*一切在本地运行。将全球最好的 IM 入口（Telegram / 飞书）与全球最强的本地执行引擎（Claude Code / Codex）完美连接。不需要云端，不需要沙盒，你的电脑就是最强的 Agent 平台。*

```bash
npx codeclaw -t YOUR_BOT_TOKEN
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
- 本机已安装并登录 [`claude`](https://docs.anthropic.com/en/docs/claude-code) 或 [`codex`](https://github.com/openai/codex)
- 一个 [Telegram Bot Token](https://t.me/BotFather)（飞书即将支持）

### 2. 一行启动

```bash
cd your-workspace/
npx codeclaw -t YOUR_BOT_TOKEN
```

<!-- TODO: 替换为实际截图 -->
`📸 截图占位：终端显示 "Bot is ready"，Telegram 收到欢迎消息`

### 3. 开始派活

在 Telegram 给你的 bot 发消息：

> "把 docs/ 目录下所有零散文档整理汇总，提取核心指标，输出一份报告。"

**就这样。你的电脑现在是一个随时待命的远程执行中枢。**

---

## 🔥 长程任务实战场景

codeclaw 专为那些 **"要跑很久、中间可能出错、你不想一直盯着"** 的任务设计。

### 🛒 电商页面复刻与自动装修

> **你（在咖啡厅）：** "去看看竞品网站的新版落地页，分析布局和配色，然后把我们本地的页面改成类似风格。改完截图发我。"

Agent 联网分析竞品、阅读本地项目、重写样式、截图回传。你只管喝咖啡等结果。

<!-- TODO: 替换为实际截图 -->
`📸 截图占位：Telegram 中收到的页面截图对比（修改前 vs 修改后）`

### 📱 社媒运营与舆情监控

> **你：** "监控 Twitter 和 Hacker News 上关于我们产品的讨论，分析情感倾向，生成一份舆情周报。"

Agent 采集数据、分类分析、生成带图表的报告文件回传。

### 📚 学术研究与文献综述

> **你（睡前）：** "下载这 5 篇论文的 PDF，逐篇阅读并提取核心观点，写一份 3000 字的综述报告。"

Agent 下载、解析、处理数万字上下文。第二天早上你收到结构化的 `.md` 综述文件。

### 🏗️ 长程工程重构

> **你（睡前）：** "把整个项目从 JavaScript 迁移到 TypeScript，解决所有类型错误，一直跑测试直到全部通过。搞定告诉我。"

Agent 连续工作数小时，自动循环"改代码 → 跑测试 → 读报错 → 再改"，第二天早上向你汇报结果。

<!-- TODO: 替换为实际截图 -->
`📸 截图占位：流式输出的重构进度 + 最终"全部通过"的通知`

### 📊 海量文件批处理

> **你（通勤路上）：** "把 data/ 下所有旧版财务报表转换成新格式，汇总成一份报表，确认数据条数。"

Agent 逐个处理、遇到异常自动重试。20 分钟后你收到完整报表。

### 🔧 自动化巡检与故障自愈

> **你：** "跑一下数据同步任务，把所有报错自动修好，直到全部通过。"

Agent 进入"执行 → 读报错 → 分析 → 修复 → 重跑"的自动循环，直到你收到全部通过的通知。

### 📑 合同/文档审阅与比对

> **你：** "把新旧两版合同逐条比对，标出所有修改点，按风险等级分类输出审阅意见。"

Agent 解析文档、逐条对比、生成审阅报告回传。

### 🎬 视频/音频素材批量加工

> **你：** "把 20 个会议录音转成文字稿，按发言人分段，每份生成摘要，最后输出一份总结。"

Agent 调用本地工具链转写、分段、摘要，全程流式汇报进度。

### 🌐 多语言内容本地化

> **你：** "把所有英文翻译文件翻译成日语、韩语、法语三个版本，保持格式不变。"

Agent 逐文件翻译、校验、写入目标目录，完成后汇报处理结果。

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
| 走开后还能跑 | ❌ 合盖就断 | ⚠️ 要配 tmux | ✅ | ✅ 自动防休眠 |
| 手机可控 | ❌ | ⚠️ 打字痛苦 | ✅ | ✅ IM 原生 |
| 实时看进度 | ✅ 终端 | ⚠️ 得连上去看 | ❌ 多数是黑盒 | ✅ 流式推到聊天 |
| 结果自动回传 | ❌ | ❌ | ⚠️ 看平台 | ✅ 截图/文件/长文本 |
| 配置门槛 | 无 | SSH/穿透/tmux | 注册/付费 | `npx` 一行 |

**codeclaw 是唯一同时满足 "本地执行 + 随时控制 + 长程保活 + 产物回传" 的方案。**

### ⚔️ 竞品对比

市面上也有一些优秀的开源方案，它们的侧重点各有不同：

| 特性 | **codeclaw** 🦞 | OpenClaw | cc-connect |
|---|---|---|---|
| **核心定位** | **专为长程任务优化的本地执行中枢** | 开源自主 AI 智能体生态 | 多渠道多端 Agent 连接器 |
| **执行引擎** | 本地极强 CLI (Claude Code / Codex) | 内置 Agent (自接模型) | 多种本地 CLI / Agent |
| **长程任务护航** | ✅ **深度定制：系统级防休眠、异常自愈** | ❌ 偏向即时/轻量级任务 | ❌ 偏向常规指令与短对话 |
| **产物与长文本** | ✅ **原生支持截图、文件、超长输出打包** | ⚠️ 依赖画布或客户端支持 | ⚠️ 基础附件支持 |
| **流式体验** | ✅ **极致平滑的 IM 实时流式进度** | ✅ 支持 | ⚠️ 依赖底层桥接能力 |
| **上手配置** | **极简：一行 `npx`，零额外配置** | 较重：需部署完整后端/配置 | 中等：需安装对应服务端 |

> **总结：**
> - 如果你需要一个**独立开源的完整 Agent 平台**（自带 Canvas 和多模态交互），推荐尝试 **OpenClaw**。
> - 如果你需要将本地 Agent 接入尽可能多的平台（如 Slack、Discord、LINE），推荐使用 **cc-connect**。
> - 但如果你重度依赖 Claude Code / Codex，并且核心诉求是 **"把一个复杂/耗时的任务扔给电脑跑几小时，自己能在手机上随时看流式进度、收产物文件，且保证任务不断线"**，那么 **codeclaw** 是目前体验最极致的选择。

---

## ⚡ 核心能力

- **实时流式输出** — Agent 工作时消息持续更新，不用干等
- **产物回传** — 截图、日志、生成文件自动发回聊天
- **长程防休眠** — 自动阻止系统休眠，小时级任务不中断
- **长文本处理** — 超长输出自动拆分或附 `.md` 文件
- **Reasoning 展示** — 实时查看 Agent 的思考过程
- **多 Agent / 模型 / 会话** — 随时切换引擎、模型，在同一会话上继续推进
- **图片/文件输入** — 发截图、PDF、文档给 Agent 处理
- **安全模式** — 危险操作推送确认卡片到手机，白名单限制访问

---

## 🛠️ 聊天命令

| 命令 | 说明 |
|------|------|
| `/start` | 显示菜单、当前 Agent 和工作目录 |
| `/agents` | 切换 Claude Code / Codex |
| `/models` | 查看并切换模型 |
| `/sessions` | 查看并切换历史会话 |
| `/switch` | 浏览并切换工作目录 |
| `/status` | 状态、会话信息、Token 统计 |
| `/host` | 主机 CPU、内存、磁盘、电量、进程 |
| `/restart` | 拉取最新版本并重启 |
| `/sk_<name>` | 执行 `.claude/` 中定义的项目技能 |

> 私聊中，普通文本直接发给当前 Agent。未识别的 `/命令` 也会被当作指令转发。

---

## ⚙️ 启动配置

### 常见用法

```bash
# 默认使用 Claude Code
npx codeclaw -t $BOT_TOKEN

# 使用 Codex CLI
npx codeclaw -t $BOT_TOKEN -a codex

# 安全模式：危险操作需要手机确认
npx codeclaw -t $BOT_TOKEN --safe-mode

# 白名单：只允许你的账号控制
npx codeclaw -t $BOT_TOKEN --allowed-ids YOUR_ID

# 指定工作目录
npx codeclaw -t $BOT_TOKEN -w ~/workspace/my-task

# 指定模型
npx codeclaw -t $BOT_TOKEN -m claude-sonnet-4-6
```

### 完整 CLI 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-t, --token` | — | Bot Token（必填） |
| `-a, --agent` | `claude` | 默认 Agent：`claude` 或 `codex` |
| `-m, --model` | Agent 默认 | 覆盖模型 |
| `-w, --workdir` | 当前目录 | 工作目录 |
| `-c, --channel` | `telegram` | IM 渠道 |
| `--safe-mode` | `false` | 危险操作前要求确认 |
| `--full-access` | `true` | 允许 Agent 无确认执行 |
| `--allowed-ids` | — | 限制 chat/user ID |
| `--timeout` | `1800` | 单次请求最大秒数 |

<details>
<summary>环境变量</summary>

| 变量 | 说明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | Bot Token（替代 `-t`） |
| `TELEGRAM_ALLOWED_CHAT_IDS` | 白名单 |
| `DEFAULT_AGENT` | 默认 Agent |
| `CODECLAW_WORKDIR` | 默认工作目录 |
| `CODECLAW_TIMEOUT` | 请求超时（秒） |
| `CLAUDE_MODEL` / `CODEX_MODEL` | 模型覆盖 |
| `CLAUDE_EXTRA_ARGS` / `CODEX_EXTRA_ARGS` | 额外 CLI 参数 |
| `CLAUDE_PERMISSION_MODE` | Claude 权限模式 |
| `CODEX_REASONING_EFFORT` | Codex 推理强度 |
| `CODEX_FULL_ACCESS` | Codex 完全访问模式 |

</details>

---

## 📦 当前状态

| 维度 | 状态 |
|------|------|
| IM 渠道 | Telegram ✅ · 飞书 / WhatsApp（规划中） |
| Agent | Claude Code ✅ · Codex CLI ✅ |
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

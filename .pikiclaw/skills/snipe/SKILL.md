---
name: snipe
description: Search Twitter for trending promotional posts about coding/AI agent tools, generate reply drafts with pikiclaw GitHub card, and push results to Feishu doc + bot notification. Does NOT auto-post to Twitter.
user-invocable: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Agent, WebFetch, mcp__pikiclaw-browser__browser_navigate, mcp__pikiclaw-browser__browser_take_screenshot, mcp__pikiclaw-browser__browser_snapshot, mcp__pikiclaw-browser__browser_press_key, mcp__pikiclaw-browser__browser_click, mcp__pikiclaw-browser__browser_evaluate, mcp__pikiclaw-browser__browser_type, mcp__pikiclaw-browser__browser_run_code, mcp__pikiclaw-browser__browser_fill_form
argument-hint: "[keywords] or blank for default"
---

# Snipe: Twitter 热帖截流

在 coding agent / AI 开发工具领域的高流量推广帖下回复 pikiclaw，截取流量拿 star。
本 skill 只生成回复草稿推送到飞书，**不自动发推**（避免封号）。

## 核心策略

用户验证过的高效打法：
- 在 **同领域产品** 的推广帖下回复（流量越大越好）
- **一句话差异化** + `npx pikiclaw@latest` + GitHub 链接
- pikiclaw 的核心差异点（按重要性）：**多 agent 会话并行管理**（dashboard 里同时操控 Claude/Codex/Gemini）、**丝滑的本地体验**（一行 npx 启动，零配置）、**实用的 skill/MCP 插件生态**（社区沉淀的 skill 和 MCP 开箱即用）、**IM 接入**（Telegram/飞书/微信随时接管同一个会话）、**完全开源 + 本地运行**
- **IM 不是头条卖点，而是"体验"的一部分** — 头条永远是多会话管理 + 流畅度 + 插件生态

历史案例参考：
- 某远程 agent 管理工具推广帖下回复 → 7,792 views, 31 likes（原帖 14 万）
- 某 macOS agent 管理工具推广帖下回复 → 1,258 views（原帖 5.4 万）
- 规律：原帖与 pikiclaw 功能越接近，回复转化率越高

## 工作流

### Step 1: 读取已回复记录

读取 `.pikiclaw/skills/snipe/sniped_posts.txt`，避免重复推荐。

### Step 2: 搜索高流量推广帖

使用浏览器工具在 Twitter 搜索近期热门推广帖。

**如果用户传入了关键词参数**，直接用该关键词搜索。
**否则**，按以下策略动态搜索。不要死记某个产品名，而是用场景关键词捕获整个领域的推广帖：

**搜索关键词（从通用到具体，搜 3-5 组即可）：**

```
coding agent tool
AI coding assistant 推荐
claude code 工具
coding agent 开源
remote coding agent
AI agent dashboard
vibe coding 工具
coding agent mobile
AI dev tool launch
```

**搜索操作步骤：**

对每个关键词：
1. 导航到 `https://x.com/search?q={keyword}&src=typed_query&f=top`
2. 等待页面加载完成（确认看到推文内容）
3. 读取 `.pikiclaw/skills/snipe/scripts/extract_tweets.js` 文件内容
4. 通过 `browser_evaluate` 注入执行该 JS，获取返回的 JSON 字符串
5. 解析 JSON 得到推文数组
6. 如果结果不够多，按 End 键滚动一次，再次执行 JS 提取
7. 合并所有关键词的结果，按 `text[:80] + url` 去重

**重要**：如果某个关键词搜索结果很少或没有推广帖，跳过即可，不要在无效关键词上浪费时间。

### Step 3: 筛选候选帖

从所有提取的推文中，识别 **正在推广具体产品/工具** 的帖子。

**识别推广帖的信号：**
- 帖子内容提到具体产品名、功能介绍、安装命令
- has_product_signal 为 true（包含 GitHub 链接、npm/pip 安装命令、产品域名）
- 外部链接指向产品官网或 GitHub
- 语气是介绍/推荐/发布（而非纯讨论或提问）

**必须满足：**
- views > 5,000（流量池太小不值得）
- 最近 48 小时内发布
- 推广的产品/工具与 pikiclaw 有功能交集（coding agent 管理、远程控制、多 agent 切换、IM 接入等）
- 不在 `sniped_posts.txt` 中

**优先级排序（高到低）：**
1. 功能与 pikiclaw 高度重叠的产品推广帖（截流效果最好）
2. 同赛道但切入点不同的产品推广帖（可以打差异化）
3. 泛 AI 工具推广帖（曝光有但转化低）

**排除：**
- 自己 (@sthnavy) 的帖子
- 纯新闻/资讯/讨论帖（没有推广具体产品）
- 已经是 pikiclaw 用户/转发者的帖子
- 政治/争议/无关话题

选出 Top 3-5 条候选帖。对每条候选帖，简要分析它推广的产品与 pikiclaw 的功能交集和差异点。

### Step 4: 生成回复草稿

对每条候选帖，生成回复草稿。

**核心原则：读懂原帖在推什么，找到 pikiclaw 相比它最锋利的一个差异点，用最短的文字打穿。**

**回复格式（极简优先）：**

```
{一句差异化，直击原帖产品的短板或 pikiclaw 的独特优势}
npx pikiclaw@latest

GitHub: https://github.com/xiaotonng/pikiclaw
```

**差异化切入角度（从上到下是推荐优先级，挑与原帖产品最对得上的一个）：**
- 对方只管单 agent / 单会话 → "Dashboard 里并行管理 Claude/Codex/Gemini 多会话，随时切换"
- 对方体验粗糙 / 配置复杂 → "一行 npx 启动，dashboard 开箱即用，零配置"
- 对方生态封闭 / 没有插件 → "开放的 skill/MCP 插件体系，社区沉淀的实用工具开箱即用"
- 对方是闭源 / SaaS → "完全开源，会话和代码全部留在本机"
- 对方只有 CLI → "自带 web dashboard，浏览器里完整控制多会话"
- 对方只能在桌前使用 → "Telegram/飞书/微信直连，手机随时接管同一个会话"
- 对方只支持英文 / 单平台 → "中英双语，macOS 桌面自动化 + Playwright 浏览器控制"

**回复规则：**
- 语言跟随原帖（中文帖用中文，英文帖用英文）
- 保持极简，**1-2 句话最佳**，绝不超过 3 句
- 必须包含 `npx pikiclaw@latest` 和 GitHub 链接
- 用建设者/开发者的语气，不用"推荐""安利"等推销词
- 不要贬低原帖产品，只强调 pikiclaw 的不同

### Step 5: 生成报告 Markdown

将候选帖和回复草稿整理为 Markdown 报告：

```markdown
# Snipe 候选 — {YYYY-MM-DD}

共发现 {n} 条高流量推广帖，以下按推荐优先级排列。

---

## 候选 1: {原帖内容摘要，不超过 20 字}
- **作者**: @{handle}（{name}）
- **链接**: {tweet_url}
- **数据**: {views} views / {likes} likes / {retweets} RT
- **推广产品**: {product_name} — {一句话描述这个产品做什么}
- **与 pikiclaw 的交集**: {功能重叠点}
- **pikiclaw 的差异优势**: {最锋利的差异点}

### 推荐回复
> {draft}

---

## 候选 2: ...
...

---

## 操作指南
1. 优先回复候选 1（流量最大 / 功能最近），依次往下
2. 在 Twitter 发回复时粘贴 GitHub 链接，Twitter 会自动生成卡片
3. 发完后将推文 URL 追加到 `.pikiclaw/skills/snipe/sniped_posts.txt`
```

### Step 6: 推送到飞书

1. 将 Step 5 生成的 Markdown 报告写入 `/tmp/snipe_report.md`
2. 执行飞书推送脚本：

```bash
cd /Users/admin/Desktop/project/pikiclaw && python3 .pikiclaw/skills/snipe/scripts/push_feishu.py --report-file /tmp/snipe_report.md
```

3. 检查脚本输出：
   - `OK:` 开头 → 成功，报告文档 URL 和通知都已发送
   - `PARTIAL:` → 文档创建成功但通知未发（缺 FEISHU_RECEIVE_ID）
   - `ERROR:` → 失败，在对话中直接展示报告内容作为兜底

### Step 7: 更新记录

将本次所有候选帖 URL 追加到 `.pikiclaw/skills/snipe/sniped_posts.txt`。

## 注意事项

- **绝不自动发推** — 所有回复草稿仅推送到飞书供人工审核
- **质量 > 数量** — 每次 3-5 条候选即可
- **不要固定搜某个产品名** — 用场景关键词动态发现，这个领域每天都有新工具出现
- 飞书凭证从项目根目录 `.env` 读取（需要 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_CHAT_ID`）

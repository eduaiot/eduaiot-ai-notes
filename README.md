# EduAIoT AI Notes

[中文说明](#中文说明)

用自己的笔记库：问答带出处、按意思搜索、回顾周报、技能、整理。模型用你自己的 API Key 或本机模型。

## Features

| Feature | What it does |
| --- | --- |
| Ask your notes | Answers from your vault only; cites sources; @ notes/folders; screenshots with a vision model |
| Selection tools | Select text → ask AI / related notes / idea card |
| Search by meaning | Keyword + semantic search; related notes sidebar |
| Daily review | Spaced review of older notes |
| Skills | Prompt templates as notes; more packs from the skill market |
| Weekly report / profile | Auto weekly report; profile items you confirm |
| Topic graph | Auto topics + interactive graph; manual assign via right-click |
| Organize notes | Diagnose issues → content suggestions → folder plan → preview; nothing changes until you confirm |
| Models | Agnes / DeepSeek / Qwen / Zhipu / Kimi / SiliconFlow / Ollama / OpenAI-compatible |
| Desktop app | Optional: use EduAIoT desktop model and shared search index |

## Requirements

| Item | Notes |
| --- | --- |
| Obsidian | Desktop 1.7.2+ |
| Account | Not required for plugin features |
| Model | Your API key, Ollama, or EduAIoT desktop app |
| Embedding (optional) | e.g. Ollama `bge-m3` for search by meaning |

## Getting started

| Step | Action |
| --- | --- |
| 1 | Install and enable |
| 2 | Settings → Chat models → provider + API key → Test |
| 3 | (Optional) Search by meaning → embedding service |
| 4 | Ribbon: Today / Search / Ask / Related |

## Privacy

Notes, index, chats and logs stay in your vault. Network only when:

| Destination | When |
| --- | --- |
| Your model provider | AI features (excerpts + question) |
| EduAIoT server | Skill market only (no notes uploaded) |
| Desktop app (`127.0.0.1`) | If installed and enabled; local token |

API keys stay in vault plugin settings. No telemetry, no ads.

## Contact

https://wechat-obsidian.eduaiot.com

| Mini program | WeChat |
| --- | --- |
| <img src="assets/miniprogram.jpg" width="180" alt="易度随手存 mini program"> | <img src="assets/wechat.png" width="180" alt="WeChat"> |

## Install / License

Manual: download `main.js`, `manifest.json`, `styles.css` from [latest release](../../releases/latest) → `<vault>/.obsidian/plugins/eduaiot-ai-notes/` → enable.

[MIT](LICENSE)

---

## 中文说明

易度助手：用自己的笔记问答、搜索、回顾、技能、整理。模型用你的 API Key 或本机模型。

### 功能

| 功能 | 做什么 |
| --- | --- |
| 问我的笔记 | 只据笔记回答并标出处；@ 指定范围；可贴截图 |
| 选中文字 | 选中后问 AI / 找相关 / 灵感卡 |
| 按意思搜 | 关键词 + 语义；侧栏相关笔记 |
| 每日回顾 | 按记忆曲线重温旧笔记 |
| 技能 | 提示词模板（笔记）；市场可装更多包 |
| 周报 / 画像 | 自动周报；画像逐条确认 |
| 主题图谱 | 自动分组 + 关系图；可右键归主题 |
| 整理笔记 | 诊断 → 内容建议 → 分类方案 → 预览；确认前不改库 |
| 多模型 | Agnes / DeepSeek / 通义 / 智谱 / Kimi / 硅基 / Ollama 等 |
| 桌面版 | 可选：共用桌面版模型与搜索索引 |

### 前提

| 项 | 说明 |
| --- | --- |
| Obsidian | 电脑版 1.7.2+ |
| 账号 | 插件功能不需要；会员技能包另计 |
| 模型 | API Key / Ollama / 桌面版 |
| 按意思搜（可选） | 如 Ollama `bge-m3` |

### 开始使用

| 步骤 | 操作 |
| --- | --- |
| 1 | 安装并启用 |
| 2 | 设置 → 对话模型 → 填 Key → 测试 |
| 3 | （可选）按意思搜索 → 选嵌入服务 |
| 4 | 左侧栏：今日 / 搜索 / 问答 / 相关 |

### 隐私

笔记与索引在本地。联网仅：

| 去向 | 何时 |
| --- | --- |
| 你配置的模型 | 用 AI 时 |
| 易度服务器 | 仅技能市场（不上传笔记） |
| 本机桌面版 | 启用时，本地令牌 |

无统计、无广告。

### 联系 / 安装 / 许可

官网：https://wechat-obsidian.eduaiot.com

| 小程序 | 个人微信 |
| --- | --- |
| <img src="assets/miniprogram.jpg" width="180" alt="易度随手存小程序码"> | <img src="assets/wechat.png" width="180" alt="个人微信"> |

手动安装：从 [最新版本](../../releases/latest) 下载三文件到 `笔记库/.obsidian/plugins/eduaiot-ai-notes/` 后启用。

[MIT](LICENSE)

# EduAIoT AI Notes

[中文说明](#中文说明)

## Features

- **Ask your notes**: answers are based only on your notes. Every sentence cites its source, quoted original text is checked against the note (click a verified quote to jump to that line), and anything the AI adds on its own is labelled as inference. Mention notes or folders with @, and paste screenshots for a vision model. Conversations are saved and can be continued.
- **Ask about a selection**: select text in a note to ask AI, search related notes or create an idea card right there.
- **Search by meaning**: hybrid keyword and semantic search. Related notes for the current note are listed in a side panel.
- **Daily review**: a few older notes every day, with spaced repetition.
- **Skills**: editable prompt templates stored as notes — weekly review, viral patterns, topic ideas, merge notes into a draft, idea cards. More skill packs can be installed from the built-in skill market.
- **Weekly report and profile**: an automatic weekly report, and a profile of your interests that you confirm item by item.
- **Topic graph**: notes are grouped into topics automatically and shown as an interactive graph, with cross-topic links for new ideas. You can also right-click a note to put it into a topic manually.
- **Organize notes**: a vault health check (untagged, orphan, empty and duplicate notes), AI suggestions for summary, tags, folder, title and related links, a folder plan and a preview map. Nothing is changed until you confirm, and note bodies are never rewritten.
- **Multiple models**: Agnes (free), DeepSeek, Qwen, Zhipu GLM, Kimi, SiliconFlow, Ollama or any OpenAI-compatible API. Pick model names from the provider's list, set defaults for chat and batch tasks, and switch models in the chat box.
- **Works with the EduAIoT desktop app**: when the desktop app is running, the plugin can use its model and its shared search index, and the desktop chat can search your notes too.

Put your notes to work. Ask questions with sources from your own vault, find notes by meaning, get daily reviews and weekly reports, run AI skills such as viral-video breakdowns and topic ideas, and tidy up your vault — using the LLM you choose, with your own API key or a local model.

## Requirements

- Desktop Obsidian 1.7.2 or later.
- **No account or payment is required for any plugin feature.** The skill market also lists some members-only skill packs, which require a paid EduAIoT membership (bought on the website); free packs and all built-in skills need no account.
- AI features need a model: an API key from a model provider you choose, or a local model via Ollama. Search by meaning optionally uses an embedding model (for example `bge-m3` in Ollama, or an online one). If the EduAIoT desktop app is installed and running, its model can be used instead and no API key is needed.

## Getting started

1. Install and enable the plugin.
2. In the settings, choose a provider under **对话模型 (Chat models)**, paste your API key and click **测试 (Test)**.
3. Optional: under **按意思搜索 (Search by meaning)**, choose a service such as Ollama `bge-m3` or SiliconFlow.
4. Use the ribbon icons: Today, Search by meaning, AI Q&A and Related notes.

## Network use and privacy

The plugin works locally. Your notes, the search index, conversations and logs stay in your vault. It connects to remote services only in these cases:

1. **The model providers you configure** (for example DeepSeek, Qwen, Zhipu, Agnes). When you use an AI feature, the relevant note excerpts and your question are sent to that provider. Their privacy policies apply. With Ollama everything stays on your computer.
2. **The EduAIoT server** (`https://wechat-obsidian.eduaiot.com` by default), only when you open the skill market: the plugin downloads the skill pack list and the packs you choose to install. No notes are uploaded.
3. **The EduAIoT desktop app**, only if it is installed and running on the same computer. The connection is local (`127.0.0.1`) and protected by a token. It is on by default (setting **运行方式 → 用哪里的模型 → 自动**); choose **只用插件里的模型 (plugin models only)** to turn it off.
   - To find the app, the plugin reads one file outside your vault: `~/.dsh-eduaiot/edu-obsidian-bridge.json` (or the path you set), which contains the local port and access token written by the desktop app. Nothing else outside the vault is read.
   - When connected, the plugin sends the desktop app: the vault path, the plugin folder path, the excluded folders, and your **按意思搜索** model settings including its API key. The desktop app keeps these on this computer (`~/.dsh-eduaiot/`) so it can find the vault again.
   - The desktop app then reads the notes in your vault directly to build the search index, and saves the search results to this plugin's `index` folder, shared with the plugin. It does not change your notes.
   - AI requests (your question and the relevant note excerpts) go to the desktop app and are answered by the model selected in the desktop app, so that model provider's privacy policy applies. Screenshots are never sent to the desktop app; they go to the vision model you configured in the plugin.

Your API keys are stored in this vault's plugin settings. The plugin contains no telemetry and no ads.

## Contact

Website: https://wechat-obsidian.eduaiot.com

| Mini program | WeChat |
| --- | --- |
| <img src="assets/miniprogram.jpg" width="180" alt="易度随手存 mini program"> | <img src="assets/wechat.png" width="180" alt="WeChat"> |

## Manual installation

Download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest), copy them into `<your vault>/.obsidian/plugins/eduaiot-ai-notes/`, then enable the plugin in **Settings → Community plugins**.

## License

[MIT](LICENSE)

---

## 中文说明

### 功能

- **问我的笔记**：只根据你的笔记回答，每句标来源；引用的原话会回原文核对，点绿色原话直接跳到那一行；AI 自己补充的内容标「AI 推断」。可以用 @ 指定笔记或文件夹，也能粘贴截图给看图模型。会话自动保存，可以接着问。
- **选中文字问 AI**：在笔记里选中一段文字，旁边就能问 AI、找相关笔记、生成灵感卡。
- **按意思搜笔记**：关键词和语义一起找；侧栏自动列出和当前笔记相关的旧笔记。
- **每日回顾**：每天挑几篇旧笔记给你重温，按记忆曲线安排复习。
- **技能**：可以直接修改的提示词模板，存成笔记。预置每周回顾、爆款规律、选题生成、多篇合稿、灵感卡；在「技能市场」里还能安装更多技能包。
- **周报和画像**：每周自动生成周报；AI 从笔记里总结你的画像，逐条由你确认。
- **主题图谱**：按内容把笔记自动分组，画成可以拖动、缩放的关系图，找出跨领域的连接。也可以右键把笔记手动放进某个主题。
- **整理笔记**：笔记体检（没标签、孤立、空笔记、重复笔记等）；AI 给出摘要、标签、文件夹、标题、相关笔记建议，可以设计分类方案、预览整理后的笔记地图。确认之前不改任何东西，正文不会被改写。
- **多个模型**：Agnes（免费）、DeepSeek、通义千问、智谱、Kimi、硅基流动、Ollama，以及其他兼容 OpenAI 接口的服务。模型名称可以从服务商的列表里选；问答和批量任务分别设默认模型，对话时在输入框旁边就能切换。
- **和 EduAIoT 桌面版一起用**：桌面版开着时，插件可以直接用桌面版的模型和共用的搜索索引；在桌面版对话里也能搜你的笔记。

易度助手：把记过的笔记真正用起来。只根据你自己的笔记回答问题并标出处，按意思找笔记，每天回顾、每周周报，用技能拆解爆款、生成选题，还能一键体检和整理笔记。AI 用你自己选的模型：自己的 API Key，或者本机的模型。

### 使用前提

- 电脑版 Obsidian 1.7.2 及以上。
- **插件的全部功能都不需要账号，不收费。** 技能市场里另有部分会员专属技能包，需要在官网开通付费的易度会员；免费技能包和预置技能不需要账号。
- AI 功能需要一个模型：自己申请的 API Key，或者本机 Ollama 里的模型。按意思搜索可以另外选一个服务，例如 Ollama 的 `bge-m3` 或在线服务。装了 EduAIoT 桌面版并开着时，可以直接用桌面版的模型，不用填 API Key。

### 开始使用

1. 安装并启用插件。
2. 打开插件设置，在「对话模型」里选一家服务商，填入 API Key，点「测试」。
3. 可选：在「按意思搜索」里选一个服务，例如 Ollama 的 `bge-m3` 或硅基流动，就能按意思找笔记。
4. 左侧栏的图标分别是：今日笔记、按意思搜笔记、AI 问答、相关笔记。

### 网络使用与隐私

插件在本地运行，笔记、搜索索引、会话和整理记录都保存在你的笔记库里。只有下面几种情况会联网：

1. **你配置的模型服务商**（例如 DeepSeek、通义千问、智谱、Agnes）：使用 AI 功能时，会把和这次任务相关的笔记片段和你的问题发给它，按它们的隐私政策处理。用本机 Ollama 时，数据不出你的电脑。
2. **易度服务器**（默认 `https://wechat-obsidian.eduaiot.com`）：只在打开「技能市场」时，下载技能包目录和你选择安装的技能包，不会上传笔记。
3. **本机的 EduAIoT 桌面版**：只有电脑上装了桌面版并且开着时才会连接，走本机内部连接（`127.0.0.1`），需要令牌。默认打开（设置「运行方式 → 用哪里的模型 → 自动」），选「只用插件里的模型」就不连接。
   - 为了找到桌面版，插件会读取笔记库外的一个文件：`~/.dsh-eduaiot/edu-obsidian-bridge.json`（或你在设置里指定的路径），里面是桌面版写入的本机端口和访问令牌。除此之外不读取笔记库外的任何文件。
   - 连上后，插件会把这些发给桌面版：笔记库路径、插件文件夹路径、不读取的文件夹，以及「按意思搜索」的服务设置（含它的 API Key）。桌面版把它们保存在本机（`~/.dsh-eduaiot/`），方便下次找到这个笔记库。
   - 桌面版会直接读取笔记库里的笔记来建立搜索索引，把结果存进本插件的 `index` 文件夹，和插件共用，不会修改你的笔记。
   - AI 请求（你的问题和相关笔记片段）会发给桌面版，由桌面版里选的模型回答，按那家模型服务商的隐私政策处理。截图不会发给桌面版，而是发给你在插件里配置的看图模型。

API Key 只保存在当前笔记库的插件设置里。插件没有任何统计、埋点或广告。

### 联系我们

官网：https://wechat-obsidian.eduaiot.com

| 小程序 | 个人微信 |
| --- | --- |
| <img src="assets/miniprogram.jpg" width="180" alt="易度随手存小程序码"> | <img src="assets/wechat.png" width="180" alt="个人微信"> |

### 手动安装

从 [最新版本](../../releases/latest) 下载 `main.js`、`manifest.json` 和 `styles.css`，放进 `你的笔记库/.obsidian/plugins/eduaiot-ai-notes/`，然后在「设置 → 第三方插件」里启用。

### 许可证

[MIT](LICENSE)

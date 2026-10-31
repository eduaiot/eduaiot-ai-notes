import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { chat, provider, PROVIDERS, type ModelConfig } from './core';
import type AiNotesPlugin from './main';
import { aiRoot, DEFAULT_ROOT, skillFolder } from './store';

export type Mode = 'auto' | 'local' | 'desktop';

export interface ModelSetting {
  provider: string;
  baseUrl: string;
  model: string;
}

export interface ModelEntry extends ModelSetting {
  id: string;
}

export type ModelUse = 'chat' | 'task';

export interface Settings {
  mode: Mode;
  models: ModelEntry[];
  chatModel: string;
  taskModel: string;
  embed: ModelSetting;
  keys: Record<string, string>;
  exclude: string;
  bridgeFile: string;
  weekly: boolean;
  weeklyDay: number;
  autoProfile: boolean;
  welcomed: boolean;
  organizeFolder: string;
  cutStart: string;
  cutEnd: string;
  cutHeading: boolean;
  cutScope: string;
  root: string;
  rootChecked: boolean;
  selectionTools: boolean;
  serverUrl: string;
}

export const NO_EMBED = 'none';

export const DEFAULT_SETTINGS: Settings = {
  mode: 'auto',
  models: [{ id: 'm1', provider: 'deepseek', baseUrl: provider('deepseek').baseUrl, model: provider('deepseek').chat }],
  chatModel: 'm1',
  taskModel: 'm1',
  embed: { provider: NO_EMBED, baseUrl: '', model: '' },
  keys: {},
  exclude: '',
  bridgeFile: '',
  weekly: true,
  weeklyDay: 1,
  autoProfile: true,
  welcomed: false,
  organizeFolder: '',
  cutStart: '',
  cutEnd: '',
  cutHeading: true,
  cutScope: '*',
  root: DEFAULT_ROOT,
  rootChecked: false,
  selectionTools: true,
  serverUrl: ''
};

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function loadSettings(raw: any): Settings {
  const legacy = { ...DEFAULT_SETTINGS.models[0], ...raw?.chat, id: 'm1' };
  const models: ModelEntry[] = Array.isArray(raw?.models) && raw.models.length
    ? raw.models.filter((item: any) => item && typeof item.id === 'string')
    : [legacy];
  const pick = (id: unknown) => (models.some((item) => item.id === id) ? (id as string) : models[0].id);
  const { chat: _chat, ...rest } = raw ?? {};
  void _chat;
  return {
    ...DEFAULT_SETTINGS,
    ...rest,
    models,
    chatModel: pick(raw?.chatModel),
    taskModel: pick(raw?.taskModel),
    embed: { ...DEFAULT_SETTINGS.embed, ...raw?.embed },
    keys: { ...raw?.keys }
  };
}

export function newModelId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export function modelLabel(entry: ModelSetting): string {
  return `${provider(entry.provider).name.replace(/（.*?）/g, '')} · ${entry.model || '未填模型'}`;
}

export function resolveModel(settings: Settings, use: ModelUse | string): ModelEntry {
  const id = use === 'chat' ? settings.chatModel : use === 'task' ? settings.taskModel : use;
  return settings.models.find((item) => item.id === id) ?? settings.models[0];
}

export function modelConfig(settings: Settings, entry: ModelSetting): ModelConfig {
  return { baseUrl: entry.baseUrl, model: entry.model, apiKey: settings.keys[entry.provider] ?? '' };
}

export function modelReady(settings: Settings, entry: ModelSetting | undefined): boolean {
  if (!entry || !entry.model.trim() || !entry.baseUrl.trim()) return false;
  return !provider(entry.provider).needsKey || !!settings.keys[entry.provider]?.trim();
}

export function embedConfig(settings: Settings): ModelConfig | null {
  const { embed } = settings;
  if (embed.provider === NO_EMBED || !embed.baseUrl.trim() || !embed.model.trim()) return null;
  const preset = provider(embed.provider);
  return {
    baseUrl: embed.baseUrl,
    model: embed.model,
    apiKey: settings.keys[embed.provider] ?? '',
    ...(preset.dimensions ? { dimensions: preset.dimensions } : {})
  };
}

export function embedId(settings: Settings): string {
  const config = embedConfig(settings);
  return config ? `${config.baseUrl.trim()}|${config.model.trim()}|${config.dimensions ?? ''}` : '';
}

const MODES: Record<Mode, string> = {
  auto: '自动：桌面版开着就连桌面版，否则自己运行',
  local: '只用本插件（用下面填的模型）',
  desktop: '只连 EduAIoT 桌面版'
};

export class SettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: AiNotesPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    const { settings } = this.plugin;
    containerEl.empty();

    new Setting(containerEl).setName('运行方式').setHeading();
    const state = containerEl.createEl('p', { cls: 'eai-hint', text: this.plugin.statusText() });
    new Setting(containerEl)
      .setName('连接方式')
      .setDesc('连桌面版时，用的是 EduAIoT 对话框里选的模型；自己运行时，用下面填的模型和 API Key。')
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(MODES)) dropdown.addOption(value, label);
        dropdown.setValue(settings.mode).onChange(async (value) => {
          settings.mode = value as Mode;
          await this.plugin.saveSettings();
          state.setText(this.plugin.statusText());
        });
      });

    new Setting(containerEl).setName('对话模型').setDesc('可以添加多个模型。问答和批量任务分别选默认用哪个；在 AI 问答和选中文字的对话框里，也能临时换别的模型。').setHeading();
    this.modelsSection(containerEl);

    new Setting(containerEl).setName('向量模型').setDesc('用来按意思找笔记，不填也能用，只按关键词找。DeepSeek 和 Kimi 没有向量模型，可以选通义千问、智谱、硅基流动或本机 Ollama。').setHeading();
    this.modelSection(containerEl, 'embed');

    new Setting(containerEl).setName('笔记范围').setHeading();
    new Setting(containerEl)
      .setName('不读取的文件夹')
      .setDesc('每行一个，比如「模板」「附件」。AI 生成的笔记（属性里有 source: ai）默认不读取。')
      .addTextArea((text) => text
        .setPlaceholder('模板\n附件')
        .setValue(settings.exclude)
        .onChange(async (value) => {
          settings.exclude = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName('插件文件夹').setHeading();
    let next = settings.root;
    new Setting(containerEl)
      .setName('文件夹名称')
      .setDesc(`技能、画像、周报、问答、整理记录等插件生成的内容都放在这里。现在是「${aiRoot()}」。改名会把整个文件夹移到新名字下，链接会自动更新。`)
      .addText((text) => text.setValue(settings.root).onChange((value) => {
        next = value.trim();
      }))
      .addButton((button) => button.setButtonText('改名').onClick(async () => {
        try {
          await this.plugin.renameRoot(next);
          this.display();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        }
      }));

    new Setting(containerEl).setName('选中文字').setHeading();
    new Setting(containerEl)
      .setName('选中文字时显示 AI 小工具')
      .setDesc('在笔记里选中一段文字，旁边会出现「问 AI」「找相关」「灵感卡」。')
      .addToggle((toggle) => toggle.setValue(settings.selectionTools).onChange(async (value) => {
        settings.selectionTools = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName('把笔记用起来').setHeading();
    new Setting(containerEl)
      .setName('自动周报')
      .setDesc('每周到了这一天，打开 Obsidian 时自动回顾最近 7 天的笔记，生成周报放在插件文件夹的「周报」里。这一周笔记少于 3 篇时不生成。')
      .addToggle((toggle) => toggle.setValue(settings.weekly).onChange(async (value) => {
        settings.weekly = value;
        await this.plugin.saveSettings();
      }))
      .addDropdown((dropdown) => {
        WEEKDAYS.forEach((label, i) => dropdown.addOption(String(i + 1), label));
        dropdown.setValue(String(settings.weeklyDay)).onChange(async (value) => {
          settings.weeklyDay = Number(value);
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName('自动更新画像')
      .setDesc('每周从笔记里找一次关于你的新信息，加到插件文件夹的「我的画像」里等你确认。只有你确认过的条目，才会在问答和技能里使用。')
      .addToggle((toggle) => toggle.setValue(settings.autoProfile).onChange(async (value) => {
        settings.autoProfile = value;
        await this.plugin.saveSettings();
      }))
      .addButton((button) => button.setButtonText('打开画像').onClick(() => this.plugin.profile.open()));
    new Setting(containerEl)
      .setName('技能')
      .setDesc('技能是插件文件夹里「技能」子文件夹中的笔记，可以直接修改提示词，也可以复制一篇改成自己的技能。改坏了可以恢复预置技能，你自己新建的技能不受影响。')
      .addButton((button) => button.setButtonText('打开技能文件夹').onClick(async () => {
        await this.plugin.skills.list();
        const first = this.app.vault.getMarkdownFiles().find((file) => file.path.startsWith(`${skillFolder()}/`));
        if (first) await this.app.workspace.getLeaf(true).openFile(first);
      }))
      .addButton((button) => button.setButtonText('技能市场').setCta().onClick(() => this.plugin.openMarket()))
      .addButton((button) => button.setButtonText('恢复预置技能').onClick(async () => {
        new Notice(`已恢复 ${await this.plugin.skills.installPresets(true)} 个预置技能`);
      }));

    new Setting(containerEl).setName('易度服务').setHeading();
    new Setting(containerEl)
      .setName('服务器地址')
      .setDesc('技能市场从这里下载技能包，一般不用改。留空就用官方服务器。')
      .addText((text) => text.setPlaceholder('https://wechat-obsidian.eduaiot.com').setValue(settings.serverUrl).onChange(async (value) => {
        settings.serverUrl = value.trim();
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName('桌面版').setHeading();
    new Setting(containerEl)
      .setName('连接文件')
      .setDesc(`EduAIoT 启动时写入的连接信息，一般不用改。默认：${this.plugin.desktop.defaultFile()}`)
      .addText((text) => text
        .setPlaceholder(this.plugin.desktop.defaultFile())
        .setValue(settings.bridgeFile)
        .onChange(async (value) => {
          settings.bridgeFile = value.trim();
          await this.plugin.saveSettings();
        }));
  }

  private modelsSection(containerEl: HTMLElement) {
    const { settings } = this.plugin;
    const box = containerEl.createDiv();
    const render = () => {
      box.empty();
      settings.models.forEach((entry, index) => {
        const card = box.createDiv({ cls: 'eai-model-card' });
        const head = new Setting(card).setName(`模型 ${index + 1}：${modelLabel(entry)}`);
        if (settings.models.length > 1) {
          head.addButton((button) => button.setButtonText('删除').setWarning().onClick(async () => {
            settings.models.splice(index, 1);
            if (!settings.models.some((item) => item.id === settings.chatModel)) settings.chatModel = settings.models[0].id;
            if (!settings.models.some((item) => item.id === settings.taskModel)) settings.taskModel = settings.models[0].id;
            await this.plugin.saveSettings();
            render();
          }));
        }
        this.modelFields(card, entry, () => render());
      });
      new Setting(box).addButton((button) => button.setButtonText('添加一个模型').onClick(async () => {
        const preset = provider('qwen');
        settings.models.push({ id: newModelId(), provider: preset.id, baseUrl: preset.baseUrl, model: preset.chat });
        await this.plugin.saveSettings();
        render();
      }));
      const choose = (name: string, desc: string, key: 'chatModel' | 'taskModel') => new Setting(box)
        .setName(name)
        .setDesc(desc)
        .addDropdown((dropdown) => {
          for (const item of settings.models) dropdown.addOption(item.id, `${modelLabel(item)}${modelReady(settings, item) ? '' : '（还没设置好）'}`);
          dropdown.setValue(settings[key]).onChange(async (value) => {
            settings[key] = value;
            await this.plugin.saveSettings();
          });
        });
      choose('问答默认用', 'AI 问答、选中文字问 AI。', 'chatModel');
      choose('批量任务默认用', '技能、周报、画像、整理笔记、主题命名等。这类任务用量大，可以选便宜的模型。', 'taskModel');
    };
    render();
  }

  private modelFields(box: HTMLElement, entry: ModelEntry, changed: () => void) {
    const { settings } = this.plugin;
    new Setting(box)
      .setName('服务商')
      .addDropdown((dropdown) => {
        for (const item of PROVIDERS) dropdown.addOption(item.id, item.name);
        dropdown.setValue(entry.provider).onChange(async (value) => {
          const preset = provider(value);
          entry.provider = value;
          entry.baseUrl = preset.baseUrl;
          entry.model = preset.chat;
          await this.plugin.saveSettings();
          changed();
        });
      });
    const preset = provider(entry.provider);
    if (preset.needsKey || preset.id === 'custom') {
      const key = new Setting(box)
        .setName('API Key')
        .setDesc('同一家服务商的模型共用一个 Key，只保存在本机这个笔记库的插件设置里。')
        .addText((text) => {
          text.inputEl.type = 'password';
          text.setPlaceholder('sk-...').setValue(settings.keys[entry.provider] ?? '').onChange(async (value) => {
            settings.keys[entry.provider] = value.trim();
            await this.plugin.saveSettings();
          });
        });
      if (preset.keyUrl) key.descEl.createEl('a', { text: ' 去申请', href: preset.keyUrl });
    }
    new Setting(box)
      .setName('接口地址')
      .addText((text) => text.setPlaceholder('https://.../v1').setValue(entry.baseUrl).onChange(async (value) => {
        entry.baseUrl = value.trim();
        await this.plugin.saveSettings();
      }));
    const result = box.createEl('p', { cls: 'eai-hint' });
    new Setting(box)
      .setName('模型名称')
      .addText((text) => text.setValue(entry.model).onChange(async (value) => {
        entry.model = value.trim();
        await this.plugin.saveSettings();
      }))
      .addButton((button) => button.setButtonText('测试').onClick(async () => {
        result.setText('正在测试…');
        try {
          const reply = await chat(this.plugin.http, modelConfig(settings, entry), [{ role: 'user', content: '只回复两个字：可以' }], 20);
          result.setText(`可以用，模型回复：${reply.slice(0, 40)}`);
        } catch (error) {
          result.setText(error instanceof Error ? error.message : String(error));
        }
      }));
    box.appendChild(result);
  }

  private modelSection(containerEl: HTMLElement, kind: 'embed') {
    const { settings } = this.plugin;
    const current = settings[kind];
    const box = containerEl.createDiv();
    const render = () => {
      box.empty();
      new Setting(box)
        .setName('服务商')
        .addDropdown((dropdown) => {
          dropdown.addOption(NO_EMBED, '不用（只按关键词找）');
          for (const item of PROVIDERS) {
            if (!item.embed && item.id !== 'custom') continue;
            dropdown.addOption(item.id, item.name);
          }
          dropdown.setValue(current.provider).onChange(async (value) => {
            const preset = provider(value);
            current.provider = value;
            current.baseUrl = value === NO_EMBED ? '' : preset.baseUrl;
            current.model = value === NO_EMBED ? '' : preset.embed;
            await this.plugin.saveSettings();
            render();
          });
        });
      if (current.provider === NO_EMBED) return;
      const preset = provider(current.provider);
      if (preset.needsKey || preset.id === 'custom') {
        const key = new Setting(box)
          .setName('API Key')
          .setDesc(settings.models.some((item) => item.provider === current.provider) ? '和对话模型是同一家，共用一个 Key。' : '只保存在本机这个笔记库的插件设置里。')
          .addText((text) => {
            text.inputEl.type = 'password';
            text.setPlaceholder('sk-...').setValue(settings.keys[current.provider] ?? '').onChange(async (value) => {
              settings.keys[current.provider] = value.trim();
              await this.plugin.saveSettings();
            });
          });
        if (preset.keyUrl) key.descEl.createEl('a', { text: ' 去申请', href: preset.keyUrl });
      }
      new Setting(box)
        .setName('接口地址')
        .addText((text) => text.setPlaceholder('https://.../v1').setValue(current.baseUrl).onChange(async (value) => {
          current.baseUrl = value.trim();
          await this.plugin.saveSettings();
        }));
      const model = new Setting(box)
        .setName('模型名称')
        .addText((text) => text.setValue(current.model).onChange(async (value) => {
          current.model = value.trim();
          await this.plugin.saveSettings();
        }));

      const progress = box.createEl('p', { cls: 'eai-hint', text: this.plugin.local.embedProgress() });
      model.addButton((button) => button.setButtonText('重新计算').onClick(async () => {
        await this.plugin.local.rebuildVectors();
        progress.setText(this.plugin.local.embedProgress());
      }));
    };
    render();
  }
}

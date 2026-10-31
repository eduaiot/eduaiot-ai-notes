import { App, Modal, normalizePath, Notice, requestUrl, TFile, TFolder } from 'obsidian';
import { message } from './backend';
import { hash } from './core';
import type AiNotesPlugin from './main';
import { ensureFolder, readState, safeName, skillFolder, today, writeState } from './store';

export const OFFICIAL_SERVER = 'https://wechat-obsidian.eduaiot.com';

export interface PackInfo {
  id: string;
  name: string;
  description: string;
  audience: string;
  access: 'free' | 'member';
  version: string;
  skills: { file: string; name: string; description: string }[];
  downloads: number;
}

interface Installed {
  version: string;
  folder: string;
  files: Record<string, string>;
}

interface MarketState {
  packs: Record<string, Installed>;
}

function newer(a: string, b: string) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

function tag(text: string, id: string, version: string) {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return text;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0) return text;
  const head = lines.slice(1, end).filter((line) => !/^(pack|pack_version):/.test(line));
  return ['---', ...head, `pack: ${id}`, `pack_version: ${version}`, ...lines.slice(end)].join('\n');
}

export class SkillMarket {
  constructor(private readonly plugin: AiNotesPlugin) {}

  private get app() {
    return this.plugin.app;
  }

  private async trash(file: TFile) {
    const manager = this.app.fileManager as unknown as { trashFile?: (file: TFile) => Promise<void> };
    if (manager.trashFile) await manager.trashFile(file);
    else await this.app.vault.trash(file, true);
  }

  server() {
    return (this.plugin.settings.serverUrl.trim() || OFFICIAL_SERVER).replace(/\/+$/, '');
  }

  private async call<T>(path: string): Promise<T> {
    let res;
    try {
      res = await requestUrl({ url: `${this.server()}${path}`, method: 'GET', throw: false });
    } catch {
      throw new Error('连不上易度服务器，请检查网络');
    }
    let body: any = null;
    try {
      body = res.json;
    } catch {
      body = null;
    }
    if (res.status !== 200 || body?.retcode !== 200) throw new Error(body?.msg || `请求失败（${res.status}）`);
    return body.data as T;
  }

  catalog() {
    return this.call<PackInfo[]>('/api/skills');
  }

  async installed(): Promise<MarketState> {
    return readState<MarketState>(this.app, 'skill-packs', { packs: {} });
  }

  async install(pack: PackInfo): Promise<{ files: number; backups: number }> {
    const data = await this.call<PackInfo & { files: { name: string; text: string }[] }>(`/api/skills/${encodeURIComponent(pack.id)}`);
    const state = await this.installed();
    const before = state.packs[pack.id];
    const folder = before?.folder ?? normalizePath(`${skillFolder()}/${safeName(data.name, pack.id)}`);
    await ensureFolder(this.app, folder);
    const vault = this.app.vault;
    const record: Installed = { version: data.version, folder, files: {} };
    let backups = 0;
    const backup = async (file: TFile, text: string) => {
      const dir = normalizePath(`${folder}/旧版备份`);
      await ensureFolder(this.app, dir);
      let path = normalizePath(`${dir}/${file.basename}（我改过的 ${today()}）.md`);
      for (let i = 2; vault.getAbstractFileByPath(path); i++) path = normalizePath(`${dir}/${file.basename}（我改过的 ${today()}）-${i}.md`);
      await vault.create(path, text.replace(/^type:\s*ai-skill\s*$/m, 'type: ai-skill-backup'));
      backups++;
    };
    for (const file of data.files) {
      const text = tag(file.text, data.id, data.version);
      const path = normalizePath(`${folder}/${file.name}`);
      const existing = vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        const current = await vault.read(existing);
        const known = before?.files[file.name];
        if (known && hash(current) !== known && current !== text) await backup(existing, current);
        await vault.modify(existing, text);
      } else {
        await vault.create(path, text);
      }
      record.files[file.name] = hash(text);
    }
    for (const [name, known] of Object.entries(before?.files ?? {})) {
      if (record.files[name]) continue;
      const old = vault.getAbstractFileByPath(normalizePath(`${folder}/${name}`));
      if (!(old instanceof TFile)) continue;
      const current = await vault.read(old);
      if (hash(current) !== known) await backup(old, current);
      await this.trash(old);
    }
    state.packs[pack.id] = record;
    await writeState(this.app, 'skill-packs', state);
    return { files: data.files.length, backups };
  }

  async uninstall(id: string) {
    const state = await this.installed();
    const record = state.packs[id];
    if (!record) return;
    for (const name of Object.keys(record.files)) {
      const file = this.app.vault.getAbstractFileByPath(normalizePath(`${record.folder}/${name}`));
      if (file instanceof TFile) await this.trash(file);
    }
    const folder = this.app.vault.getAbstractFileByPath(record.folder);
    if (folder instanceof TFolder && !folder.children.length) await this.app.vault.delete(folder, true);
    delete state.packs[id];
    await writeState(this.app, 'skill-packs', state);
  }
}

export class MarketModal extends Modal {
  constructor(app: App, private readonly plugin: AiNotesPlugin) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText('技能市场');
    this.contentEl.addClass('eai-market');
    void this.render();
  }

  private async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', { cls: 'eai-hint', text: '技能包会装到插件文件夹的「技能」里，装好后在「运行技能」里就能用。你改过的技能，更新时会先在「旧版备份」里另存一份。' });
    const list = contentEl.createDiv();
    list.createEl('p', { cls: 'eai-hint', text: '正在加载…' });
    const market = this.plugin.market;
    let packs: PackInfo[];
    let state: MarketState;
    try {
      [packs, state] = await Promise.all([market.catalog(), market.installed()]);
    } catch (error) {
      list.empty();
      list.createEl('p', { cls: 'eai-error', text: message(error) });
      return;
    }
    list.empty();
    if (!packs.length) list.createEl('p', { cls: 'eai-hint', text: '还没有上架的技能包。' });
    for (const pack of packs) {
      const mine = state.packs[pack.id];
      const card = list.createDiv({ cls: 'eai-card' });
      const head = card.createDiv({ cls: 'eai-head' });
      head.createSpan({ cls: 'eai-link', text: `${pack.name} · v${pack.version}` });
      head.createSpan({ cls: `eai-badge${pack.access === 'free' ? ' is-new' : ' is-change'}`, text: pack.access === 'free' ? '免费' : '会员' });
      if (pack.description) card.createDiv({ text: pack.description });
      if (pack.audience) card.createDiv({ cls: 'eai-meta', text: `适合：${pack.audience}` });
      card.createDiv({ cls: 'eai-meta', text: `包含 ${pack.skills.length} 个技能：${pack.skills.map((skill) => skill.name).join('、')}` });
      const actions = card.createDiv({ cls: 'eai-actions' });
      const run = async (button: HTMLButtonElement, label: string, job: () => Promise<void>) => {
        button.disabled = true;
        button.setText(label);
        try {
          await job();
        } catch (error) {
          new Notice(message(error), 8000);
        }
        await this.render();
      };
      if (pack.access === 'member' && !mine) {
        actions.createEl('button', { text: '开通会员后可安装' }).onclick = () => window.open(`${market.server()}/pricing.html`);
        continue;
      }
      if (!mine || newer(pack.version, mine.version)) {
        const button = actions.createEl('button', { cls: 'mod-cta', text: mine ? `更新到 v${pack.version}` : '安装' });
        button.onclick = () => run(button, '正在安装…', async () => {
          const result = await market.install(pack);
          new Notice(`已安装「${pack.name}」${result.files} 个技能${result.backups ? `，${result.backups} 个你改过的技能已备份到「旧版备份」` : ''}`);
        });
      } else {
        actions.createSpan({ cls: 'eai-meta', text: `已安装 v${mine.version}` });
      }
      if (mine) {
        const remove = actions.createEl('button', { text: '卸载' });
        remove.onclick = () => run(remove, '正在卸载…', async () => {
          await market.uninstall(pack.id);
          new Notice(`已卸载「${pack.name}」`);
        });
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

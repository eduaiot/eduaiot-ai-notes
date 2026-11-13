import { Component, MarkdownRenderer, Menu, Notice, requestUrl, setIcon, TFile } from 'obsidian';
import { applyEdit, citedNumbers, INFER, locateQuote, NOT_FOUND, splitEdits, verifyAnswer, type NoteEdit, type Source } from './core';
import type AiNotesPlugin from './main';
import { DESKTOP_MODEL, modelLabel, modelReady } from './settings';

export interface AnswerData {
  a: string;
  sources: Source[];
  texts: Map<number, string>;
  applied?: number[];
}

const links = new Map<string, Promise<boolean | null>>();
const undo = new Map<string, { before: string; after: string }>();

function reachable(url: string): Promise<boolean | null> {
  let check = links.get(url);
  if (!check) {
    check = (async () => {
      try {
        let response = await requestUrl({ url, method: 'HEAD', throw: false });
        if (response.status === 405 || response.status === 403) response = await requestUrl({ url, method: 'GET', throw: false });
        return response.status < 400;
      } catch {
        return null;
      }
    })();
    links.set(url, check);
  }
  return check;
}

export function answerText(answer: string): string {
  return splitEdits(answer).text;
}

function escape(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function shownSources(data: AnswerData): Source[] {
  const numbers = citedNumbers(data.a);
  const cited = data.sources.filter((source) => numbers.has(source.n));
  if (cited.length || data.a.includes(NOT_FOUND)) return cited;
  return data.sources;
}

export async function jumpToQuote(plugin: AiNotesPlugin, sources: Source[], quote: string, cite: string) {
  const numbers = new Set([...cite.matchAll(/\d+/g)].map((match) => Number(match[0])));
  const pool = numbers.size ? sources.filter((source) => numbers.has(source.n)) : sources;
  for (const source of pool) {
    const file = plugin.app.vault.getAbstractFileByPath(source.path);
    if (!(file instanceof TFile)) continue;
    const line = locateQuote(await plugin.app.vault.cachedRead(file), quote);
    if (line >= 0) {
      await plugin.openNote(source.path, '', line);
      return;
    }
  }
  if (pool[0]) await plugin.openNote(pool[0].path, pool[0].heading, pool[0].line ?? -1);
}

export function openSettings(plugin: AiNotesPlugin) {
  const setting = (plugin.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
  setting?.open();
  setting?.openTabById(plugin.manifest.id);
}

export function modelPicker(plugin: AiNotesPlugin, parent: HTMLElement, value: string, onChange: (id: string) => void) {
  const settings = plugin.settings;
  const valid = (id: string) => (id === DESKTOP_MODEL ? plugin.desktopOn : settings.models.some((entry) => entry.id === id));
  let current = valid(value) ? value : plugin.defaultChat();
  const button = parent.createEl('button', { cls: 'eai-model-button' });
  const label = button.createSpan({ cls: 'eai-model-name' });
  setIcon(button.createSpan({ cls: 'eai-model-caret' }), 'chevron-up');
  const show = () => {
    if (current === DESKTOP_MODEL) {
      label.setText(plugin.modeLabel());
      button.title = '用 EduAIoT 桌面版对话框里选的模型，点击换一个模型（只影响这次对话）';
      button.toggleClass('is-broken', !plugin.desktop.model);
      return;
    }
    const entry = settings.models.find((item) => item.id === current) ?? settings.models[0]!;
    label.setText(entry.model || modelLabel(entry));
    button.title = `${modelLabel(entry)}，点击换一个模型（只影响这次对话）`;
    button.toggleClass('is-broken', !modelReady(settings, entry));
  };
  show();
  const choose = (id: string) => {
    current = id;
    show();
    onChange(id);
  };
  button.onclick = (event) => {
    const menu = new Menu();
    if (plugin.desktopOn) {
      menu.addItem((item) => item.setTitle(plugin.modeLabel()).setChecked(current === DESKTOP_MODEL).onClick(() => choose(DESKTOP_MODEL)));
    }
    for (const entry of settings.models) {
      menu.addItem((item) => item
        .setTitle(`${modelLabel(entry)}${modelReady(settings, entry) ? '' : '（未设置好）'}`)
        .setChecked(entry.id === current)
        .onClick(() => choose(entry.id)));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle('管理模型…').setIcon('settings').onClick(() => openSettings(plugin)));
    menu.showAtMouseEvent(event);
  };
}

export function retryButtons(plugin: AiNotesPlugin, parent: HTMLElement, used: string, retry: (id: string) => void) {
  const settings = plugin.settings;
  const others: { id: string; label: string }[] = [];
  if (plugin.desktopOn && used !== DESKTOP_MODEL) others.push({ id: DESKTOP_MODEL, label: plugin.modeLabel() });
  for (const entry of settings.models) {
    if (entry.id !== used && modelReady(settings, entry)) others.push({ id: entry.id, label: modelLabel(entry) });
  }
  if (!others.length) return;
  const box = parent.createDiv({ cls: 'eai-actions' });
  for (const item of others.slice(0, 3)) box.createEl('button', { text: `改用 ${item.label} 重试` }).onclick = () => retry(item.id);
}

export function renderAnswer(plugin: AiNotesPlugin, parent: HTMLElement, data: AnswerData, component: Component, onApplied?: (applied: number[]) => void) {
  const quotes: { quote: string; cite: string; ok: boolean }[] = [];
  const { text, edits } = splitEdits(data.a);
  const checked = verifyAnswer(text, data.texts, (quote, ok, cite) => {
    quotes.push({ quote, cite, ok });
    return `<span class="${ok ? 'eai-quote' : 'eai-unverified'}">「${escape(quote)}」</span>${cite}`;
  });
  const markdown = checked.text.split(INFER).join('<span class="eai-infer">AI 推断</span> ');
  const body = parent.createDiv();
  void MarkdownRenderer.render(plugin.app, markdown, body, '', component).then(() => {
    body.querySelectorAll('.eai-quote, .eai-unverified').forEach((el, i) => {
      const item = quotes[i];
      if (!item?.ok || !el.instanceOf(HTMLElement)) return;
      el.addClass('is-clickable');
      el.title = '点击跳到原文这一行';
      el.onclick = () => jumpToQuote(plugin, data.sources, item.quote, item.cite);
    });
    const known = [...data.texts.values()].join('\n');
    body.querySelectorAll('a.external-link').forEach((el) => {
      const url = el.getAttribute('href') ?? '';
      if (!/^https?:\/\//i.test(url) || known.includes(url)) return;
      const badge = el.insertAdjacentElement('afterend', activeDocument.createElement('span'));
      if (!badge) return;
      badge.addClass('eai-link-check');
      badge.setText(' 检查中…');
      void reachable(url).then((ok) => {
        badge.setText(ok === true ? ' ✅ 能打开' : ok === false ? ' ❌ 打不开，可能是 AI 记错了' : ' ⚠️ 没能检查，请自己点开确认');
        badge.toggleClass('is-bad', ok === false);
      });
    });
  });
  edits.forEach((edit, i) => renderEdit(plugin, parent, data, edit, i, onApplied));
  if (checked.quotes) {
    const ok = checked.quotes - checked.failed;
    parent.createDiv({
      cls: checked.failed ? 'eai-warn' : 'eai-meta',
      text: checked.failed ? `有 ${checked.failed} 句引用在原文里没找到，请以原笔记为准` : `${ok} 句原话都已在笔记里核对，点绿色原话可以跳到原文`
    });
  }
  const sources = shownSources(data);
  if (!sources.length) return;
  const box = parent.createDiv({ cls: 'eai-sources' });
  box.createDiv({ cls: 'eai-meta', text: '来源' });
  for (const source of sources) {
    const row = box.createDiv();
    row.createSpan({ cls: 'eai-meta', text: `[${source.n}] ` });
    const link = row.createEl('a', { cls: 'eai-link', text: source.title, href: '#' });
    link.onclick = (event) => {
      event.preventDefault();
      void plugin.openNote(source.path, source.heading, source.line ?? -1);
    };
  }
}

function renderEdit(plugin: AiNotesPlugin, parent: HTMLElement, data: AnswerData, edit: NoteEdit, index: number, onApplied?: (applied: number[]) => void) {
  const source = data.sources.find((item) => item.n === edit.n);
  const card = parent.createDiv({ cls: 'eai-edit' });
  const head = card.createDiv({ cls: 'eai-edit-head' });
  head.createSpan({ text: '修改建议 · ' });
  const title = head.createEl('a', { cls: 'eai-link', text: source ? `《${source.title}》` : `笔记 [${edit.n}]`, href: '#' });
  title.onclick = (event) => {
    event.preventDefault();
    if (source) void plugin.openNote(source.path, '', -1);
  };
  if (edit.search.trim()) card.createEl('pre', { cls: 'eai-edit-old', text: edit.search.trim() });
  else card.createDiv({ cls: 'eai-meta', text: '追加到笔记末尾：' });
  card.createEl('pre', { cls: 'eai-edit-new', text: edit.replace.trim() });
  const actions = card.createDiv({ cls: 'eai-actions' });
  const key = source ? `${source.path}#${data.a.length}#${index}` : '';
  const render = () => {
    actions.empty();
    const done = data.applied?.includes(index) ?? false;
    if (!source) {
      actions.createSpan({ cls: 'eai-warn', text: '找不到要改的笔记' });
      return;
    }
    if (!done) {
      actions.createEl('button', { cls: 'mod-cta', text: '应用到笔记' }).onclick = () => void apply();
      return;
    }
    actions.createSpan({ cls: 'eai-meta', text: '已写入笔记' });
    if (undo.has(key)) actions.createEl('button', { text: '撤销' }).onclick = () => void revert();
  };
  const file = () => (source ? plugin.app.vault.getFileByPath(source.path) : null);
  const apply = async () => {
    const target = file();
    if (!target) {
      new Notice('找不到这篇笔记，可能已经删除或改名');
      return;
    }
    let before = '';
    let after = '';
    try {
      await plugin.app.vault.process(target, (content) => {
        const next = applyEdit(content, edit);
        if (next === null) throw new Error('mismatch');
        before = content;
        after = next;
        return next;
      });
    } catch {
      new Notice('笔记里没找到要替换的原文，可能已经改过了，这次没有修改');
      return;
    }
    undo.set(key, { before, after });
    data.applied = [...(data.applied ?? []), index];
    onApplied?.(data.applied);
    new Notice(`已写入《${target.basename}》`);
    render();
  };
  const revert = async () => {
    const target = file();
    const saved = undo.get(key);
    if (!target || !saved) return;
    let ok = false;
    await plugin.app.vault.process(target, (content) => {
      ok = content === saved.after;
      return ok ? saved.before : content;
    });
    if (!ok) {
      new Notice('这篇笔记之后又改过了，不能撤销');
      return;
    }
    undo.delete(key);
    data.applied = (data.applied ?? []).filter((item) => item !== index);
    onApplied?.(data.applied);
    new Notice('已撤销');
    render();
  };
  render();
}

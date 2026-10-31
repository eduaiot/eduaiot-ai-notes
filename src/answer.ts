import { Component, MarkdownRenderer, Menu, setIcon, TFile } from 'obsidian';
import { citedNumbers, INFER, locateQuote, NOT_FOUND, verifyAnswer, type Source } from './core';
import type AiNotesPlugin from './main';
import { modelLabel, modelReady } from './settings';

export interface AnswerData {
  a: string;
  sources: Source[];
  texts: Map<number, string>;
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
  if (plugin.backend.kind === 'desktop') {
    parent.createSpan({ cls: 'eai-hint eai-model-button', text: plugin.modeLabel() });
    return;
  }
  const settings = plugin.settings;
  let current = settings.models.some((entry) => entry.id === value) ? value : settings.chatModel;
  const button = parent.createEl('button', { cls: 'eai-model-button' });
  const label = button.createSpan({ cls: 'eai-model-name' });
  setIcon(button.createSpan({ cls: 'eai-model-caret' }), 'chevron-up');
  const show = () => {
    const entry = settings.models.find((item) => item.id === current) ?? settings.models[0];
    label.setText(entry.model || modelLabel(entry));
    button.title = `${modelLabel(entry)}，点击换一个模型（只影响这次对话）`;
    button.toggleClass('is-broken', !modelReady(settings, entry));
  };
  show();
  button.onclick = (event) => {
    const menu = new Menu();
    for (const entry of settings.models) {
      menu.addItem((item) => item
        .setTitle(`${modelLabel(entry)}${modelReady(settings, entry) ? '' : '（未设置好）'}`)
        .setChecked(entry.id === current)
        .onClick(() => {
          current = entry.id;
          show();
          onChange(entry.id);
        }));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle('管理模型…').setIcon('settings').onClick(() => openSettings(plugin)));
    menu.showAtMouseEvent(event);
  };
}

export function retryButtons(plugin: AiNotesPlugin, parent: HTMLElement, used: string, retry: (id: string) => void) {
  if (plugin.backend.kind === 'desktop') return;
  const settings = plugin.settings;
  const others = settings.models.filter((entry) => entry.id !== used && modelReady(settings, entry)).slice(0, 3);
  if (!others.length) return;
  const box = parent.createDiv({ cls: 'eai-actions' });
  for (const entry of others) box.createEl('button', { text: `改用 ${modelLabel(entry)} 重试` }).onclick = () => retry(entry.id);
}

export function renderAnswer(plugin: AiNotesPlugin, parent: HTMLElement, data: AnswerData, component: Component) {
  const quotes: { quote: string; cite: string; ok: boolean }[] = [];
  const checked = verifyAnswer(data.a, data.texts, (quote, ok, cite) => {
    quotes.push({ quote, cite, ok });
    return `<span class="${ok ? 'eai-quote' : 'eai-unverified'}">「${escape(quote)}」</span>${cite}`;
  });
  const markdown = checked.text.split(INFER).join('<span class="eai-infer">AI 推断</span> ');
  const body = parent.createDiv();
  void MarkdownRenderer.render(plugin.app, markdown, body, '', component).then(() => {
    body.querySelectorAll('.eai-quote, .eai-unverified').forEach((el, i) => {
      const item = quotes[i];
      if (!item?.ok || !(el instanceof HTMLElement)) return;
      el.addClass('is-clickable');
      el.title = '点击跳到原文这一行';
      el.onclick = () => jumpToQuote(plugin, data.sources, item.quote, item.cite);
    });
  });
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

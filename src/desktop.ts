import { requestUrl } from 'obsidian';
import { hasRefs, type AskResult, type Backend, type Refs } from './backend';
import type { Hit, PinnedNote, Turn } from './core';

export const OFFLINE = '没有连接到 EduAIoT 桌面版，请先打开它，或在设置里改成「只用本插件」';
const PROBE_MS = 1500;

interface Bridge {
  port: number;
  token: string;
}

interface DesktopHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
}

interface NodeModules {
  path: { join(...parts: string[]): string };
  os: { homedir(): string };
  fs: { readFileSync(file: string, encoding: 'utf8'): string };
}

function node<K extends keyof NodeModules>(name: K): NodeModules[K] {
  return (window as unknown as { require(id: string): NodeModules[K] }).require(name);
}

function env(name: string): string | undefined {
  return (window as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

function hit(item: DesktopHit): Hit {
  return { path: item.path, title: item.title, heading: '', line: -1, snippet: item.snippet ?? '', score: item.score ?? 0 };
}

export class DesktopBackend implements Backend {
  readonly kind = 'desktop';
  model: string | null = null;

  constructor(private readonly vault: () => string, private readonly file: () => string) {}

  defaultFile(): string {
    const path = node('path');
    const home = env('EDUAIOT_HOME') || path.join(node('os').homedir(), '.dsh-eduaiot');
    return path.join(home, 'edu-obsidian-bridge.json');
  }

  private bridge(): Bridge {
    try {
      const value = JSON.parse(node('fs').readFileSync(this.file() || this.defaultFile(), 'utf8')) as Partial<Bridge> | null;
      if (typeof value?.port === 'number' && typeof value?.token === 'string') return { port: value.port, token: value.token };
    } catch {
      throw new Error(OFFLINE);
    }
    throw new Error(OFFLINE);
  }

  async probe(): Promise<boolean> {
    try {
      const status = await Promise.race([
        this.call<{ model: string | null }>('status'),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error(OFFLINE)), PROBE_MS))
      ]);
      this.model = status.model;
      return true;
    } catch {
      this.model = null;
      return false;
    }
  }

  async search(query: string, limit: number): Promise<Hit[]> {
    const result = await this.call<{ results: DesktopHit[] }>('search', { query });
    return result.results.slice(0, limit).map(hit);
  }

  async related(path: string, limit: number): Promise<Hit[]> {
    const result = await this.call<{ related: DesktopHit[] }>('note', { path });
    return result.related.slice(0, limit).map(hit);
  }

  async ask(question: string, history: Turn[], pin: PinnedNote | null, _model?: string, images: string[] = [], refs?: Refs): Promise<AskResult> {
    if (images.length || hasRefs(refs)) throw new Error('连接桌面版时还不能发图片或用 @ 指定笔记，请在插件设置里把运行方式改成「只用本插件」');
    const result = await this.call<{ answer: string; sources: { n: number; path: string; title: string }[] }>('ask', { question, history, path: pin?.path ?? '' });
    return { answer: result.answer, sources: result.sources.map((source) => ({ ...source, heading: '' })), model: this.model ? `桌面版 · ${this.model}` : '桌面版' };
  }

  private async call<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
    const bridge = this.bridge();
    let response;
    try {
      response = await requestUrl({
        url: `http://127.0.0.1:${bridge.port}/v1/${action}`,
        method: 'POST',
        contentType: 'application/json',
        headers: { Authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ ...body, vault: this.vault() }),
        throw: false
      });
    } catch {
      throw new Error(OFFLINE);
    }
    let json: unknown = null;
    try {
      json = response.json;
    } catch {
      json = null;
    }
    if (response.status !== 200) throw new Error((json as { error?: string } | null)?.error || `请求失败（${response.status}）`);
    return json as T;
  }
}

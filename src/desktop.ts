import { requestUrl } from 'obsidian';
import { ModelError, type ContextGroup, type Hit, type Message, type PinnedNote } from './core';

export const OFFLINE = '没有连接到 EduAIoT 桌面版，请先打开它，或在设置里改成「只用下面填的模型」';
const OUTDATED = 'EduAIoT 桌面版版本太旧，还不能给插件提供模型，请先更新桌面版';
const PROBE_MS = 1500;

interface Bridge {
  port: number;
  token: string;
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

export interface DesktopNotes {
  vault: string | null;
  notes: number;
  chunks: number;
  embedded: number;
  embedding: boolean;
  error: string;
  ready: boolean;
}

export interface DesktopHello {
  vault: string;
  configDir: string;
  pluginDir: string;
  exclude: string[];
  embed: { id: string; baseUrl: string; model: string; apiKey: string; dimensions?: number } | null;
}

export class DesktopModel {
  model: string | null = null;
  notes: DesktopNotes | null = null;

  async hello(info: DesktopHello): Promise<DesktopNotes | null> {
    try {
      this.notes = await this.call<DesktopNotes>('hello', { ...info });
    } catch {
      this.notes = null;
    }
    return this.notes;
  }

  get indexing(): boolean {
    const own = this.vault().replace(/[\\/]+$/, '');
    const theirs = (this.notes?.vault ?? '').replace(/[\\/]+$/, '');
    return this.notes !== null && theirs.toLowerCase() === own.toLowerCase();
  }

  async search(query: string, limit: number): Promise<Hit[]> {
    return (await this.call<{ results: Hit[] }>('search', { query, limit })).results;
  }

  async related(path: string, limit: number): Promise<Hit[]> {
    return (await this.call<{ results: Hit[] }>('related', { path, limit })).results;
  }

  async context(query: string, pin: PinnedNote | null, files: string[], folders: string[]): Promise<ContextGroup[]> {
    return (await this.call<{ groups: ContextGroup[] }>('context', { query, pin, files, folders })).groups;
  }

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
        this.call<{ model: string | null; notes?: DesktopNotes }>('status'),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error(OFFLINE)), PROBE_MS))
      ]);
      this.model = status.model;
      if (!status.notes) this.notes = null;
      else if (this.notes) this.notes = status.notes;
      return true;
    } catch {
      this.model = null;
      this.notes = null;
      return false;
    }
  }

  async complete(messages: Message[], maxTokens: number): Promise<string> {
    if (messages.some((item) => typeof item.content !== 'string')) throw new ModelError('桌面版的模型还不能看图片，请在插件设置里加一个能看图的模型');
    const result = await this.call<{ text: string; model: string | null }>('complete', { messages, maxTokens });
    if (result.model) this.model = result.model;
    if (typeof result.text !== 'string' || !result.text.trim()) throw new ModelError('模型没有返回内容');
    return result.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
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
    if (response.status === 404) throw new ModelError(OUTDATED);
    if (response.status !== 200) throw new ModelError((json as { error?: string } | null)?.error || `桌面版请求失败（${response.status}）`);
    return json as T;
  }
}

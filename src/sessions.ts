import { normalizePath } from 'obsidian';
import type { Source } from './core';
import type AiNotesPlugin from './main';

const LIMIT = 50;

export interface SavedEntry {
  q: string;
  a: string;
  current: string;
  sources: Source[];
  error: string;
  model?: string;
  modelId?: string;
}

export interface Session {
  id: string;
  title: string;
  updated: number;
  entries: SavedEntry[];
  model?: string;
}

export class SessionStore {
  private list: Session[] = [];
  private loaded: Promise<void> | null = null;

  constructor(private readonly plugin: AiNotesPlugin) {}

  private get path() {
    return normalizePath(`${this.plugin.manifest.dir}/sessions.json`);
  }

  load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          const adapter = this.plugin.app.vault.adapter;
          if (await adapter.exists(this.path)) {
            const value = JSON.parse(await adapter.read(this.path));
            if (Array.isArray(value)) this.list = value.filter((item) => item && typeof item.id === 'string' && Array.isArray(item.entries));
          }
        } catch {
          this.list = [];
        }
      })();
    }
    return this.loaded;
  }

  all(): Session[] {
    return [...this.list].sort((a, b) => b.updated - a.updated);
  }

  get(id: string): Session | undefined {
    return this.list.find((item) => item.id === id);
  }

  async put(session: Session) {
    await this.load();
    this.list = [session, ...this.list.filter((item) => item.id !== session.id)]
      .sort((a, b) => b.updated - a.updated)
      .slice(0, LIMIT);
    await this.save();
  }

  async remove(id: string) {
    await this.load();
    this.list = this.list.filter((item) => item.id !== id);
    await this.save();
  }

  private async save() {
    try {
      await this.plugin.app.vault.adapter.write(this.path, JSON.stringify(this.list));
    } catch {
      return;
    }
  }
}

export function newSession(): Session {
  return { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: '', updated: Date.now(), entries: [] };
}

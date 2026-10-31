import type { Hit, PinnedNote, Source, Turn } from './core';

export interface AskResult {
  answer: string;
  sources: Source[];
  model?: string;
}

export interface Backend {
  readonly kind: 'local' | 'desktop';
  search(query: string, limit: number): Promise<Hit[]>;
  related(path: string, limit: number): Promise<Hit[]>;
  ask(question: string, history: Turn[], pin: PinnedNote | null, model?: string): Promise<AskResult>;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

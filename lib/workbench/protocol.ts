import type { Comparison } from './diff.ts';
import type { DocumentData, Preview, Source } from './document.ts';
import type { Match } from './search.ts';

export type Transform = 'format' | 'minify' | 'escape' | 'unescape';

export interface Position {
  index: number;
  match: Match;
  preview: Preview;
}

export interface SearchResult {
  total: number;
  position?: Position;
}

export interface Failure {
  message: string;
  offset?: number;
  line?: number;
  column?: number;
  side?: 'left' | 'right';
}

interface Commands {
  import: { request: { source: Source; offset?: number; maxBytes?: number }; result: DocumentData };
  transform: { request: { operation: Transform; source: Source }; result: DocumentData };
  compare: { request: { left: Source; right: Source }; result: Comparison };
  preview: { request: { source: Source; offset: number; center?: boolean }; result: Preview };
  read: { request: { source: Source }; result: string };
  export: { request: { source: Source }; result: Blob };
  search: { request: { source: Source; query: string; caseSensitive: boolean; regex: boolean }; result: SearchResult };
  position: { request: { index: number }; result: Position };
}

export type Command = keyof Commands;
export type Payload<K extends Command> = Commands[K]['request'];
export type Result<K extends Command> = Commands[K]['result'];
export type Request = { [K in Command]: Payload<K> & { type: K; id: number } }[Command];
export type Response = { id: number } & ({ result: Result<Command> } | { error: Failure });

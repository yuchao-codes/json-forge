export const MIB = 1024 * 1024;
export const MAX_INPUT_BYTES = 64 * MIB;
export const MAX_OUTPUT_BYTES = 96 * MIB;
export const MAX_INLINE_PASTE = 128 * 1024;
const MAX_UNWRAPPED_LINE = 4096;
const MAX_WRAPPED_ROWS = 1_000_000;
const UTF16_TEXT = 'text/plain;charset=utf-16le';

export type Source = string | Blob;

export interface DocumentData {
  source: Source;
  wrapColumns: number;
}

export function wrapColumnsFor(lineLength: number): number {
  // A single wrapped line must fit within the browser's maximum element height.
  return lineLength > MAX_UNWRAPPED_LINE ? Math.ceil(lineLength / MAX_WRAPPED_ROWS) : 0;
}

export function documentWrapColumns(text: string): number {
  let start = 0;
  let end = text.indexOf('\n');
  let longest = 0;
  while (end !== -1) {
    longest = Math.max(longest, end - start);
    start = end + 1;
    end = text.indexOf('\n', start);
  }
  return wrapColumnsFor(Math.max(longest, text.length - start));
}

export class WorkbenchError extends Error {
  readonly offset?: number;
  readonly line?: number;
  readonly column?: number;
  readonly side?: 'left' | 'right';

  constructor(message: string, offset?: number, line?: number, column?: number, side?: 'left' | 'right') {
    super(message);
    this.offset = offset;
    this.line = line;
    this.column = column;
    this.side = side;
  }
}

export async function readSource(source: Source, maxBytes = MAX_INPUT_BYTES): Promise<string> {
  const bytes = typeof source === 'string' ? new Blob([source]).size : source.size;
  if (bytes > maxBytes) throw sizeError(maxBytes);
  if (typeof source === 'string') return source;
  const data = await source.arrayBuffer();
  if (hasIsolatedSurrogates(source)) {
    const view = new DataView(data);
    const fragments: string[] = [];
    for (let offset = 2; offset < data.byteLength; offset += 16384) {
      const codes = new Uint16Array(Math.min(8192, (data.byteLength - offset) / 2));
      for (let index = 0; index < codes.length; index++) {
        codes[index] = view.getUint16(offset + index * 2, true);
      }
      fragments.push(String.fromCharCode(...codes));
    }
    return fragments.join('');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: !(source instanceof File) }).decode(data);
  } catch {
    throw new WorkbenchError('无法读取文件。请选择有效的 UTF-8 文本。');
  }
}

function sizeError(maxBytes: number): WorkbenchError {
  return new WorkbenchError('文档超过 ' + (maxBytes / MIB) + ' MiB 的处理上限。');
}

export function makeDocument(text: string, type = 'text/plain'): DocumentData {
  const wrapColumns = documentWrapColumns(text);
  if (!text.isWellFormed()) {
    if ((text.length + 1) * 2 > MAX_OUTPUT_BYTES) throw new WorkbenchError('输出超过 96 MiB 的处理上限。');
    return { source: downloadBlob(text), wrapColumns };
  }
  const blob = new Blob([text], { type });
  if (blob.size > MAX_OUTPUT_BYTES) throw new WorkbenchError('输出超过 96 MiB 的处理上限。');
  return { source: text.length <= MAX_INLINE_PASTE ? text : blob, wrapColumns };
}

export function hasIsolatedSurrogates(source: Blob): boolean {
  return !(source instanceof File) && source.type === UTF16_TEXT;
}

export function downloadBlob(source: Source): Blob {
  if (typeof source !== 'string') return source;
  if (source.isWellFormed()) return new Blob([source], { type: 'text/plain;charset=utf-8' });
  // An isolated UTF-16 surrogate has no UTF-8 representation.
  const bytes = new DataView(new ArrayBuffer((source.length + 1) * 2));
  bytes.setUint16(0, 0xfeff, true);
  for (let index = 0; index < source.length; index++) {
    bytes.setUint16((index + 1) * 2, source.charCodeAt(index), true);
  }
  return new Blob([bytes], { type: UTF16_TEXT });
}

export function positionError(text: string, offset: number, message: string): WorkbenchError {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index++) {
    if (text[index] === '\r') {
      if (text[index + 1] === '\n' && index + 1 < offset) index++;
      line++;
      lineStart = index + 1;
    } else if (text[index] === '\n') {
      line++;
      lineStart = index + 1;
    }
  }
  return new WorkbenchError(message, offset, line, offset - lineStart + 1);
}

export const MIB = 1024 * 1024;
export const MAX_INPUT_BYTES = 64 * MIB;
export const MAX_OUTPUT_BYTES = 96 * MIB;
export const PREVIEW_LENGTH = 16 * 1024;
export const EDITOR_LENGTH = 128 * 1024;
export const MAX_EDITOR_LINE = 4096;
const MAX_EDITOR_LINES = 10000;
const UTF16_TEXT = 'text/plain;charset=utf-16le';

export type PlainSource = string | Blob;
type Piece = string | { from: number; to: number };

export interface EditedSource {
  base: PlainSource;
  pieces: Piece[];
  length: number;
}

export type Source = PlainSource | EditedSource;

export interface Preview {
  text: string;
  start: number;
  total: number;
  line: number;
}

export interface DocumentData {
  source: Source;
  preview: Preview;
}

export function fullPreview(text: string): Preview {
  return { text, start: 0, total: text.length, line: 1 };
}

export const emptyDocument: DocumentData = { source: '', preview: fullPreview('') };

export function isEditedSource(source: Source): source is EditedSource {
  return typeof source !== 'string' && 'pieces' in source;
}

function slicePiece(piece: Piece, from: number, to: number): Piece {
  return typeof piece === 'string' ? piece.slice(from, to) : { from: piece.from + from, to: piece.from + to };
}

export function replacePreview(source: Source, preview: Preview, text: string): DocumentData {
  const { start, total } = preview;
  const end = start + preview.text.length;
  if (start === 0 && end === total) return { source: text, preview: fullPreview(text) };

  const edited = isEditedSource(source) ? source : {
    base: source, pieces: [{ from: 0, to: total }], length: total,
  };
  const before: Piece[] = [];
  const after: Piece[] = [];
  let offset = 0;
  for (const piece of edited.pieces) {
    const length = typeof piece === 'string' ? piece.length : piece.to - piece.from;
    if (offset < start) before.push(slicePiece(piece, 0, Math.min(length, start - offset)));
    if (offset + length > end) after.push(slicePiece(piece, Math.max(0, end - offset), length));
    offset += length;
  }
  const length = total - preview.text.length + text.length;
  if (text) before.push(text);
  return {
    source: { base: edited.base, pieces: before.concat(after), length },
    preview: { ...preview, text, total: length },
  };
}

export function canShowFull(text: string): boolean {
  if (text.length <= PREVIEW_LENGTH) return true;
  if (text.length > EDITOR_LENGTH) return false;
  let start = 0;
  let end = text.indexOf('\n');
  let line = 1;
  while (end !== -1) {
    if (end - start > MAX_EDITOR_LINE || ++line > MAX_EDITOR_LINES) return false;
    start = end + 1;
    end = text.indexOf('\n', start);
  }
  return text.length - start <= MAX_EDITOR_LINE;
}

function startsWithLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

export function makePreview(text: string, offset = 0, center = false): Preview {
  if (canShowFull(text)) return fullPreview(text);
  let start = Math.max(0, Math.min(offset - (center ? PREVIEW_LENGTH / 3 | 0 : 0), text.length - PREVIEW_LENGTH));
  if (startsWithLowSurrogate(text, start)) start = Math.max(0, start - 1);
  let end = Math.min(start + PREVIEW_LENGTH, text.length);
  if (startsWithLowSurrogate(text, end)) end++;
  let line = 1;
  for (let index = text.indexOf('\n'); index !== -1 && index < start; index = text.indexOf('\n', index + 1)) {
    line++;
  }
  return { text: text.slice(start, end), start, total: text.length, line };
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
  if (isEditedSource(source)) {
    if (source.length > maxBytes) throw sizeError(maxBytes);
    const base = await readSource(source.base, MAX_OUTPUT_BYTES);
    const text = source.pieces.map((piece) => typeof piece === 'string' ? piece : base.slice(piece.from, piece.to)).join('');
    if (new Blob([text]).size > maxBytes) throw sizeError(maxBytes);
    return text;
  }
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
  const preview = makePreview(text);
  if (!text.isWellFormed()) {
    if ((text.length + 1) * 2 > MAX_OUTPUT_BYTES) throw new WorkbenchError('输出超过 96 MiB 的处理上限。');
    return { source: downloadBlob(text), preview };
  }
  const blob = new Blob([text], { type });
  if (blob.size > MAX_OUTPUT_BYTES) throw new WorkbenchError('输出超过 96 MiB 的处理上限。');
  return { source: preview.text === text ? text : blob, preview };
}

export function hasIsolatedSurrogates(source: Blob): boolean {
  return !(source instanceof File) && source.type === UTF16_TEXT;
}

export function downloadBlob(source: PlainSource): Blob {
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

import { MAX_OUTPUT_BYTES, WorkbenchError, positionError } from './document.ts';

type State =
  | 'root' | 'done'
  | 'keyOrClose' | 'key' | 'colon' | 'propertyValue' | 'objectNext'
  | 'valueOrClose' | 'arrayValue' | 'arrayNext';

const MAX_DEPTH = 4096;
const numberAt = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const stringSpecial = /["\\\x00-\x1f]/g;
const unicodeEscape = /[a-fA-F0-9]{4}/y;

// Return a raw string's end offset. The decoded value is never needed by the formatter.
function stringEnd(text: string, start: number): number {
  stringSpecial.lastIndex = start + 1;
  for (let match = stringSpecial.exec(text); match; match = stringSpecial.exec(text)) {
    if (match[0] === '"') return match.index + 1;
    if (match[0] !== '\\') throw positionError(text, match.index, '字符串中存在未转义的控制字符。');
    const escapeIndex = match.index + 1;
    const escape = text[escapeIndex];
    if (escape === 'u') {
      unicodeEscape.lastIndex = escapeIndex + 1;
      if (!unicodeEscape.test(text)) throw positionError(text, escapeIndex, '无效的 Unicode 转义。');
      stringSpecial.lastIndex = unicodeEscape.lastIndex;
    } else {
      if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
        throw positionError(text, escapeIndex, '无效的字符串转义。');
      }
      stringSpecial.lastIndex = escapeIndex + 1;
    }
  }
  throw positionError(text, text.length, '字符串缺少结束引号。');
}

export function rewriteJson(text: string, pretty: boolean): string {
  const stack: State[] = ['root'];
  const indents = ['\n'];
  const chunks: string[] = [];
  let buffer = '';
  let size = 0;
  let offset = 0;

  function append(value: string) {
    size += value.length;
    if (size > MAX_OUTPUT_BYTES) throw new WorkbenchError('输出超过 96 MiB 的处理上限。');
    if (value.length >= 65536) {
      if (buffer) chunks.push(buffer);
      chunks.push(value);
      buffer = '';
    } else {
      buffer += value;
      if (buffer.length >= 65536) {
        chunks.push(buffer);
        buffer = '';
      }
    }
  }

  function indent(depth: number) {
    if (!pretty) return;
    indents[depth] ??= '\n' + '  '.repeat(depth);
    append(indents[depth]);
  }

  function fail(message: string): never {
    throw positionError(text, offset, message);
  }

  function value() {
    const char = text[offset];
    if (char === '{' || char === '[') {
      if (stack.length > MAX_DEPTH) throw new WorkbenchError('JSON 嵌套深度超过 ' + MAX_DEPTH + ' 层。');
      stack.push(char === '{' ? 'keyOrClose' : 'valueOrClose');
      append(char);
      offset++;
      return;
    }
    const start = offset;
    if (char === '"') {
      offset = stringEnd(text, offset);
    } else if (char === 't' && text.startsWith('true', offset)) {
      offset += 4;
    } else if (char === 'f' && text.startsWith('false', offset)) {
      offset += 5;
    } else if (char === 'n' && text.startsWith('null', offset)) {
      offset += 4;
    } else {
      numberAt.lastIndex = offset;
      if (!numberAt.test(text)) fail('此处需要有效的 JSON 值。');
      offset = numberAt.lastIndex;
    }
    append(text.slice(start, offset));
  }

  while (offset < text.length) {
    const char = text[offset];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      offset++;
      continue;
    }
    const depth = stack.length - 1;
    const state = stack[depth];
    if ((state === 'keyOrClose' || state === 'objectNext') && char === '}'
      || (state === 'valueOrClose' || state === 'arrayNext') && char === ']') {
      if (state === 'objectNext' || state === 'arrayNext') indent(depth - 1);
      append(char);
      stack.pop();
      offset++;
      continue;
    }

    switch (state) {
      case 'root':
        stack[depth] = 'done';
        value();
        break;
      case 'keyOrClose':
      case 'key': {
        if (char !== '"') fail('此处需要双引号包裹的对象键。');
        indent(depth);
        const end = stringEnd(text, offset);
        append(text.slice(offset, end));
        offset = end;
        stack[depth] = 'colon';
        break;
      }
      case 'colon':
        if (char !== ':') fail('对象键后缺少冒号。');
        append(pretty ? ': ' : ':');
        offset++;
        stack[depth] = 'propertyValue';
        break;
      case 'propertyValue':
        stack[depth] = 'objectNext';
        value();
        break;
      case 'valueOrClose':
      case 'arrayValue':
        indent(depth);
        stack[depth] = 'arrayNext';
        value();
        break;
      case 'objectNext':
      case 'arrayNext':
        if (char !== ',') fail('此处需要逗号或闭合符号。');
        append(',');
        offset++;
        stack[depth] = state === 'objectNext' ? 'key' : 'arrayValue';
        break;
      case 'done':
        fail('JSON 只能包含一个顶层值。');
    }
  }
  if (stack.length !== 1 || stack[0] !== 'done') fail('JSON 输入不完整。');
  chunks.push(buffer);
  return chunks.join('');
}

export function unescapeText(text: string): string {
  if (/^[\x20\t\r\n]*"/.test(text)) {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === 'string') return value;
    } catch {
      // Report malformed literals and non-string input with the same guidance.
    }
  }
  throw new WorkbenchError('请输入带双引号的合法 JSON 字符串。');
}

export function escapeText(text: string): string {
  if (text.length < 1024 * 1024) return JSON.stringify(text);
  const fragments = ['"'];
  const encoder = new TextEncoder();
  const bytes = new Uint8Array(6 * 65537);
  let size = 2;
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 65536, text.length);
    const boundary = text.charCodeAt(end);
    if (boundary >= 0xdc00 && boundary <= 0xdfff) end++;
    const fragment = JSON.stringify(text.slice(offset, end)).slice(1, -1);
    size += encoder.encodeInto(fragment, bytes).written;
    if (size > MAX_OUTPUT_BYTES) throw new WorkbenchError('输出超过 96 MiB 的处理上限。');
    fragments.push(fragment);
    offset = end;
  }
  fragments.push('"');
  return fragments.join('');
}

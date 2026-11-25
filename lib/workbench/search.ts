import { WorkbenchError } from './document.ts';

const SCAN_LENGTH = 256 * 1024;
const CHECKPOINT_INTERVAL = 1024;
const YIELD_MATCHES = 32768;

export interface Match {
  from: number;
  to: number;
}

export class TextSearch {
  readonly text: string;
  readonly query: string;
  readonly #matcher: RegExp | undefined;
  readonly #regex: RegExp | undefined;
  readonly #checkpoints: number[] = [];
  total = 0;

  constructor(text: string, query: string, caseSensitive: boolean, regex = false) {
    if (!query || query.length > 1024) throw new WorkbenchError('搜索词须为 1 到 1024 个字符。');
    this.text = text;
    this.query = query;
    if (regex) {
      try {
        this.#regex = new RegExp(query, caseSensitive ? 'gmu' : 'gimu');
      } catch (error) {
        if (error instanceof SyntaxError) throw new WorkbenchError('正则表达式无效。');
        throw error;
      }
    } else if (!caseSensitive) {
      const literal = query.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
      this.#matcher = new RegExp(literal, 'giu');
    }
  }

  *#scanRegex(matcher: RegExp, start: number): Generator<Match> {
    let next = start;
    while (next <= this.text.length) {
      matcher.lastIndex = next;
      const match = matcher.exec(this.text);
      if (!match) return;
      const from = match.index;
      const to = from + match[0].length;
      yield { from, to };
      // RegExp.exec doesn't advance past empty matches. Step by a full Unicode code point.
      next = to > from ? to : to + ((this.text.codePointAt(to) ?? 0) > 0xffff ? 2 : 1);
    }
  }

  // A boundary marks the last *start* position in a window. Keep enough
  // lookahead for matches that start in this window and end in the next.
  *#scanLiteral(start: number): Generator<Match | null> {
    let next = start;
    const { text, query } = this;
    while (next < text.length) {
      let boundary = Math.min(next + SCAN_LENGTH, text.length);
      const boundaryCode = text.charCodeAt(boundary);
      if (boundaryCode >= 0xdc00 && boundaryCode <= 0xdfff) boundary++;
      const window = text.slice(next, boundary + query.length * 2);
      const base = next;
      let cursor = 0;
      while (base + cursor < boundary) {
        let found: number;
        let length = query.length;
        if (this.#matcher) {
          this.#matcher.lastIndex = cursor;
          const match = this.#matcher.exec(window);
          if (!match) break;
          found = match.index;
          length = match[0].length;
        } else {
          found = window.indexOf(query, cursor);
          if (found === -1) break;
        }
        if (base + found >= boundary) break;
        cursor = found + length;
        yield { from: base + found, to: base + cursor };
      }
      next = Math.max(boundary, base + cursor);
      yield null;
    }
  }

  #scan(start: number): Generator<Match | null> {
    // Regexes can match across a window boundary and inspect text on either side of a match.
    return this.#regex ? this.#scanRegex(this.#regex, start) : this.#scanLiteral(start);
  }

  async build(active: () => boolean): Promise<boolean> {
    let matchesSinceYield = 0;
    for (const match of this.#scan(0)) {
      if (match) {
        if (this.total % CHECKPOINT_INTERVAL === 0) this.#checkpoints.push(match.from);
        this.total++;
        matchesSinceYield++;
      }
      if (!match || matchesSinceYield >= YIELD_MATCHES) {
        matchesSinceYield = 0;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (!active()) return false;
      }
    }
    return active();
  }

  at(index: number): Match | undefined {
    if (index < 0 || index >= this.total) return undefined;
    const block = Math.floor(index / CHECKPOINT_INTERVAL);
    let remaining = index % CHECKPOINT_INTERVAL;
    for (const match of this.#scan(this.#checkpoints[block]!)) {
      if (match && remaining-- === 0) return match;
    }
  }
}

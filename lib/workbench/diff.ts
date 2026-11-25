import { formatPatch, structuredPatch } from 'diff';
import type { StructuredPatchHunk } from 'diff';
import { MIB, WorkbenchError, makeDocument, readSource } from './document.ts';
import type { DocumentData, Source } from './document.ts';
import { rewriteJson } from './json-text.ts';
import type { Match } from './search.ts';

export interface Difference {
  left: Match;
  right: Match;
}

export interface Comparison {
  left: DocumentData;
  right: DocumentData;
  differences: Difference[];
  patch?: Blob;
}

function toRanges(text: string, hunks: StructuredPatchHunk[], side: 'left' | 'right'): Match[] {
  let currentLine = 1;
  let offset = 0;
  function offsetAt(line: number) {
    while (currentLine < line && offset < text.length) {
      const next = text.indexOf('\n', offset);
      offset = next === -1 ? text.length : next + 1;
      currentLine++;
    }
    return offset;
  }
  return hunks.map((hunk) => {
    const start = side === 'left' ? hunk.oldStart : hunk.newStart;
    const length = side === 'left' ? hunk.oldLines : hunk.newLines;
    return { from: offsetAt(start), to: offsetAt(start + length) };
  });
}

async function normalize(source: Source, side: 'left' | 'right') {
  try {
    return rewriteJson(await readSource(source), true);
  } catch (error) {
    if (error instanceof WorkbenchError) {
      throw new WorkbenchError(error.message, error.offset, error.line, error.column, side);
    }
    throw error;
  }
}

export async function compareJson(leftSource: Source, rightSource: Source,
  limits = { timeout: 3000, maxEditLength: 1600 }): Promise<Comparison> {
  // The combined budget bounds line tokenization before jsdiff's limits take effect.
  const left = await normalize(leftSource, 'left');
  const right = await normalize(rightSource, 'right');
  if (left.length + right.length > 64 * MIB) {
    throw new WorkbenchError('对比未完成，两侧格式化后的文本超过本次处理预算。');
  }
  const patch = left === right ? undefined : structuredPatch('left.json', 'right.json', left, right,
    undefined, undefined, { ...limits, context: 0 });
  if (!patch && left !== right) {
    throw new WorkbenchError('对比未完成，已达到时间或差异数量上限。');
  }
  const hunks = patch?.hunks ?? [];
  const leftRanges = toRanges(left, hunks, 'left');
  const rightRanges = toRanges(right, hunks, 'right');
  return {
    left: makeDocument(left, 'application/json'),
    right: makeDocument(right, 'application/json'),
    differences: leftRanges.map((range, index) => ({ left: range, right: rightRanges[index]! })),
    patch: patch && new Blob([formatPatch(patch)], { type: 'text/x-diff' }),
  };
}

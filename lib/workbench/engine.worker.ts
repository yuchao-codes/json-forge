import { compareJson } from './diff.ts';
import { documentWrapColumns, downloadBlob, MAX_OUTPUT_BYTES, WorkbenchError, makeDocument, readSource } from './document.ts';
import { escapeText, rewriteJson, unescapeText } from './json-text.ts';
import type { Failure, Position, Request, Result, Command, Response } from './protocol.ts';
import { TextSearch } from './search.ts';

let search: TextSearch | undefined;
let generation = 0;

function locate(index: number): Position | undefined {
  const match = search?.at(index);
  if (!match) return;
  return { index, match };
}

async function dispatch(request: Request): Promise<Result<Command> | undefined> {
  switch (request.type) {
    case 'import': {
      const text = await readSource(request.source, request.maxBytes);
      if (request.source instanceof File) return { source: request.source, wrapColumns: documentWrapColumns(text) };
      return makeDocument(text);
    }
    case 'transform': {
      const text = await readSource(request.source);
      switch (request.operation) {
        case 'format': return makeDocument(rewriteJson(text, true), 'application/json');
        case 'minify': return makeDocument(rewriteJson(text, false), 'application/json');
        case 'escape': return makeDocument(escapeText(text));
        case 'unescape': return makeDocument(unescapeText(text));
      }
      break;
    }
    case 'compare':
      return compareJson(request.left, request.right);
    case 'export':
      return downloadBlob(await readSource(request.source, MAX_OUTPUT_BYTES));
    case 'search': {
      const current = ++generation;
      search = undefined;
      const text = await readSource(request.source, MAX_OUTPUT_BYTES);
      if (current !== generation) return;
      const index = new TextSearch(text, request.query, request.caseSensitive, request.regex);
      if (!await index.build(() => current === generation)) return;
      search = index;
      return { total: index.total, position: locate(0) };
    }
    case 'position': {
      const position = locate(request.index);
      if (!position) throw new WorkbenchError('该匹配已失效，请重新搜索。');
      return position;
    }
  }
}

export function startWorkbenchWorker() {
  const worker = self as unknown as {
    onmessage: ((event: MessageEvent<Request>) => void) | null;
    postMessage(message: Response): void;
  };

  worker.onmessage = async ({ data }) => {
    try {
      const result = await dispatch(data);
      if (result !== undefined) worker.postMessage({ id: data.id, result });
    } catch (error) {
      const failure: Failure = { message: error instanceof Error ? error.message : '处理文档时出错。' };
      if (error instanceof WorkbenchError) {
        Object.assign(failure, { offset: error.offset, line: error.line, column: error.column, side: error.side });
      }
      worker.postMessage({ id: data.id, error: failure });
    }
  };
}

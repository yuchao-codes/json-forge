import { codeFolding, foldEffect, foldedRanges, syntaxTree, unfoldEffect } from '@codemirror/language';
import type { EditorState, Range, StateEffect, Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import type { Match } from './search.ts';

function foldAt(state: EditorState, start: number): Match | undefined {
  let range: Match | undefined;
  foldedRanges(state).between(start, start, (from, to) => {
    if (from === start) range = { from, to };
  });
  return range;
}

export function revealFoldedRange(state: EditorState, range: Match) {
  const start = Math.min(range.from, state.doc.length);
  const end = Math.min(range.to, state.doc.length);
  const effects: StateEffect<Match>[] = [];
  foldedRanges(state).between(start, end, (from, to) => {
    if (from < end && to > start || start === end && from <= start && start < to) {
      effects.push(unfoldEffect.of({ from, to }));
    }
  });
  return effects;
}

// The viewport parser may stop before a large container's closing delimiter.
async function findClosingBracket(doc: Text, open: number, current: () => boolean) {
  const expected: (']' | '}')[] = [];
  let inString = false;
  let escaped = false;
  const chunkSize = 128 * 1024;
  for (let offset = open; offset < doc.length && current(); offset += chunkSize) {
    const chunk = doc.sliceString(offset, Math.min(doc.length, offset + chunkSize));
    for (let index = 0; index < chunk.length; index++) {
      const char = chunk[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (char === '{' || char === '[') {
        expected.push(char === '{' ? '}' : ']');
      } else if (char === '}' || char === ']') {
        if (expected.pop() !== char) return;
        if (!expected.length) return offset + index;
      }
    }
    if (offset + chunkSize < doc.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function foldButton(view: EditorView, array: boolean, expanded: boolean, action: (button: HTMLButtonElement) => void) {
  const button = view.dom.ownerDocument.createElement('button');
  const label = (expanded ? '折叠' : '展开') + (array ? '数组' : '对象');
  button.type = 'button';
  button.className = expanded ? 'json-fold-button' : 'json-fold-button json-fold-placeholder';
  button.textContent = expanded ? '▾' : '…';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', String(expanded));
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    if (view.dom.ownerDocument.activeElement === button) view.focus();
    action(button);
  });
  return button;
}

class CollapseControl extends WidgetType {
  readonly array: boolean;
  readonly close: number | undefined;

  constructor(array: boolean, close: number | undefined) {
    super();
    this.array = array;
    this.close = close;
  }

  override eq(other: CollapseControl) {
    return this.array === other.array && this.close === other.close;
  }

  toDOM(view: EditorView) {
    return foldButton(view, this.array, true, (button) => {
      const open = view.posAtDOM(button);
      const { doc } = view.state;
      const fold = (to: number) => {
        const from = open + 1;
        if (to <= from) return;
        const { head } = view.state.selection.main;
        view.dispatch({
          effects: foldEffect.of({ from, to }),
          selection: from <= head && head < to ? { anchor: open } : undefined,
        });
      };
      if (this.close !== undefined) {
        fold(this.close);
        return;
      }
      const current = () => view.state.doc === doc && view.dom.isConnected;
      button.disabled = true;
      void findClosingBracket(doc, open, current).then((close) => {
        button.disabled = false;
        if (close !== undefined && current()) fold(close);
      });
    });
  }
}

function collapseControls(view: EditorView) {
  const { state } = view;
  const tree = syntaxTree(state);
  const controls: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter(node) {
        const array = node.name === 'Array';
        if ((!array && node.name !== 'Object') || node.from < from || node.from >= to) return;
        const close = node.node.lastChild;
        const complete = close?.name === (array ? ']' : '}');
        if (complete ? close.from <= node.from + 1 : tree.length >= state.doc.length) return;
        if (foldAt(state, node.from + 1)) return;
        controls.push(Decoration.widget({
          widget: new CollapseControl(array, complete ? close.from : undefined),
          side: 1,
        }).range(node.from));
      },
    });
  }
  return Decoration.set(controls, true);
}

export const jsonFolding = [
  codeFolding({
    preparePlaceholder: (state, { from }) => state.doc.sliceString(from - 1, from) === '[',
    placeholderDOM(view, _onclick, array: boolean) {
      return foldButton(view, array, false, (element) => {
        const range = foldAt(view.state, view.posAtDOM(element));
        if (range) view.dispatch({ effects: unfoldEffect.of(range) });
      });
    },
  }),
  ViewPlugin.fromClass(class {
    decorations;

    constructor(view: EditorView) {
      this.decorations = collapseControls(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState) ||
        foldedRanges(update.state) !== foldedRanges(update.startState)) {
        this.decorations = collapseControls(update.view);
      }
    }
  }, { decorations: (plugin) => plugin.decorations }),
];

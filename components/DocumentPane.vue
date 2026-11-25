<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import type { Extension, Text } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { MAX_INLINE_PASTE, wrapColumnsFor } from '@/lib/workbench/document';
import { jsonFolding, revealFoldedRange } from '@/lib/workbench/folding';
import type { Match } from '@/lib/workbench/search';

const props = defineProps<{
  title: string;
  text: Text;
  wrapColumns: number;
  fileName?: string;
  allowFile?: boolean;
  changes?: readonly Match[];
  changeKind?: 'added' | 'removed';
  focusRange?: Match;
  focusKind?: 'search' | 'error' | 'difference';
}>();

const emit = defineEmits<{
  edit: [text: Text, wrapColumns: number];
  largePaste: [from: number, to: number, text: string];
  clear: [];
  importSource: [value: File];
  activate: [];
}>();

const host = ref<HTMLDivElement>();
const chooseFile = ref<HTMLInputElement>();
const wrapping = new Compartment();
const noWrapping: Extension = [];
const marksEffect = StateEffect.define<DecorationSet>();
const searchCaret = new class extends WidgetType {
  toDOM(view: EditorView) {
    const marker = view.dom.ownerDocument.createElement('span');
    marker.className = 'mark-search-caret';
    marker.setAttribute('aria-hidden', 'true');
    return marker;
  }
}();
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    const effect = transaction.effects.find((entry) => entry.is(marksEffect));
    return effect ? effect.value : value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});
const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: '#8bc6ff' },
  { tag: tags.string, color: '#9fe0b1' },
  { tag: tags.number, color: '#f5bf86' },
  { tag: [tags.bool, tags.null], color: '#cbaaff' },
]);
let view: EditorView | undefined;

function decorations() {
  const length = props.text.length;
  function mark(range: Match, kind: string) {
    const from = Math.max(0, range.from);
    const to = Math.min(length, range.to);
    return from < to ? [Decoration.mark({ class: 'mark-' + kind }).range(from, to)] : [];
  }
  const ranges = (props.changes ?? []).flatMap((range) => mark(range, props.changeKind ?? 'added'));
  const { focusRange, focusKind } = props;
  if (focusRange && focusKind !== 'difference') {
    if (focusKind === 'search' && focusRange.from === focusRange.to) {
      if (focusRange.from <= length) {
        ranges.push(Decoration.widget({ widget: searchCaret }).range(focusRange.from));
      }
    } else {
      ranges.push(...mark(focusRange, focusKind ?? 'search'));
    }
  }
  return Decoration.set(ranges, true);
}

function synchronize(previousFocus?: Match) {
  if (!view) return;
  const { text, focusRange } = props;
  const replaced = view.state.doc !== text;
  if (replaced) {
    view.setState(createState());
    view.scrollDOM.scrollTop = 0;
    view.scrollDOM.scrollLeft = 0;
  }
  const wrap = props.wrapColumns > 0 ? EditorView.lineWrapping : noWrapping;
  view.dispatch({
    effects: [
      ...(wrapping.get(view.state) !== wrap ? [wrapping.reconfigure(wrap)] : []),
      marksEffect.of(decorations()),
      ...(focusRange && (replaced || focusRange !== previousFocus)
        ? [...revealFoldedRange(view.state, focusRange),
          EditorView.scrollIntoView(Math.min(text.length, focusRange.from), { y: 'center', x: 'center' })]
        : []),
    ],
    annotations: Transaction.addToHistory.of(false),
  });
}

function createState() {
  return EditorState.create({
    doc: props.text,
    extensions: [
      EditorState.lineSeparator.of('\n'),
      EditorView.contentAttributes.of({ 'aria-label': props.title, spellcheck: 'false', tabindex: '0' }),
      lineNumbers(),
      wrapping.of(props.wrapColumns > 0 ? EditorView.lineWrapping : noWrapping),
      marksField,
      json(),
      jsonFolding,
      syntaxHighlighting(highlight),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const { doc } = update.state;
        let wrapColumns = Math.min(props.wrapColumns, wrapColumnsFor(doc.length));
        update.changes.iterChangedRanges((_from, _to, from, to) => {
          while (from <= to) {
            const line = doc.lineAt(from);
            wrapColumns = Math.max(wrapColumns, wrapColumnsFor(line.length));
            from = line.to + 1;
          }
        });
        emit('edit', doc, wrapColumns);
      }),
      EditorView.domEventHandlers({
        focus: () => { emit('activate'); },
        paste: (event, editor) => {
          const paste = event.clipboardData?.getData('text/plain');
          if (paste === undefined) return false;
          const selection = editor.state.selection.main;
          event.preventDefault();
          if (paste.length > MAX_INLINE_PASTE) {
            emit('largePaste', selection.from, selection.to, paste);
          } else {
            editor.dispatch({
              changes: { from: selection.from, to: selection.to, insert: paste },
              selection: { anchor: selection.from + paste.length },
              scrollIntoView: true,
              userEvent: 'input.paste',
            });
          }
          return true;
        },
      }),
    ],
  });
}

onMounted(() => {
  view = new EditorView({ parent: host.value, state: createState() });
  synchronize();
});

watch(() => [props.text, props.wrapColumns, props.focusRange, props.focusKind, props.changes] as const,
  (_values, previous) => synchronize(previous[2]));
onUnmounted(() => view?.destroy());

function onFile(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (file) emit('importSource', file);
  input.value = '';
}
</script>

<template>
  <section class="document-pane" :aria-label="title">
    <header class="pane-header">
      <div class="pane-title">
        <h2>{{ title }}</h2>
        <span v-if="fileName" class="file-name" :title="fileName">{{ fileName }}</span>
      </div>
      <div v-if="allowFile || text.length" class="pane-actions">
        <input v-if="allowFile" ref="chooseFile" class="visually-hidden" tabindex="-1" type="file"
          :aria-label="'打开文件 · ' + title" @change="onFile">
        <button v-if="allowFile" class="text-button" type="button" @click="chooseFile?.click()">打开文件</button>
        <button v-if="text.length" class="text-button" type="button" @click="emit('clear')">清空</button>
      </div>
    </header>
    <div ref="host" class="editor-host" :style="{ '--editor-wrap-width': wrapColumns + 'ch' }"></div>
    <footer class="pane-footer">
      <span>{{ text.length.toLocaleString() }} 字符</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { canShowFull, PREVIEW_LENGTH } from '@/lib/workbench/document';
import type { Preview } from '@/lib/workbench/document';
import type { Match } from '@/lib/workbench/search';

const props = defineProps<{
  title: string;
  preview: Preview;
  fileName?: string;
  allowFile?: boolean;
  changes?: readonly Match[];
  changeKind?: 'added' | 'removed';
  focusRange?: Match;
  focusKind?: 'search' | 'error' | 'difference';
}>();

const emit = defineEmits<{
  edit: [text: string];
  clear: [];
  importSource: [value: File];
  page: [offset: number];
  activate: [];
}>();

const host = ref<HTMLDivElement>();
const chooseFile = ref<HTMLInputElement>();
const partial = computed(() => props.preview.text.length < props.preview.total);
const gutterConfig = new Compartment();
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
let updating = false;

function decorations() {
  const { start, text } = props.preview;
  function local(range: Match, kind: string) {
    const from = Math.max(0, range.from - start);
    const to = Math.min(text.length, range.to - start);
    return from < to ? [Decoration.mark({ class: 'mark-' + kind }).range(from, to)] : [];
  }
  const ranges = (props.changes ?? []).flatMap((range) => local(range, props.changeKind ?? 'added'));
  const { focusRange, focusKind } = props;
  if (focusRange && focusKind !== 'difference') {
    if (focusKind === 'search' && focusRange.from === focusRange.to) {
      const offset = focusRange.from - start;
      if (offset >= 0 && offset <= text.length) {
        ranges.push(Decoration.widget({ widget: searchCaret }).range(offset));
      }
    } else {
      ranges.push(...local(focusRange, focusKind ?? 'search'));
    }
  }
  return Decoration.set(ranges, true);
}

function synchronize() {
  if (!view) return;
  const { preview, focusRange } = props;
  const changed = view.state.doc.toString() !== preview.text;
  updating = true;
  try {
    view.dispatch({
      changes: changed ? { from: 0, to: view.state.doc.length, insert: preview.text } : undefined,
      effects: [
        gutterConfig.reconfigure(lineNumbers({ formatNumber: (line) => String(line + preview.line - 1) })),
        marksEffect.of(decorations()),
        ...(focusRange
          ? [EditorView.scrollIntoView(Math.max(0, Math.min(preview.text.length, focusRange.from - preview.start)),
            { y: 'center', x: 'center' })]
          : changed ? [EditorView.scrollIntoView(0)] : []),
      ],
      selection: changed ? { anchor: 0 } : undefined,
      annotations: Transaction.addToHistory.of(false),
    });
    if (changed) view.scrollDOM.scrollLeft = 0;
  } finally {
    updating = false;
  }
}

onMounted(() => {
  view = new EditorView({
    parent: host.value,
    doc: props.preview.text,
    extensions: [
      EditorState.lineSeparator.of('\n'),
      EditorView.contentAttributes.of({ 'aria-label': props.title, spellcheck: 'false', tabindex: '0' }),
      gutterConfig.of(lineNumbers()),
      marksField,
      json(),
      syntaxHighlighting(highlight),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || updating) return;
        emit('edit', update.state.doc.toString());
      }),
      EditorView.domEventHandlers({
        focus: () => { emit('activate'); },
        paste: (event, editor) => {
          const paste = event.clipboardData?.getData('text/plain');
          if (paste === undefined) return false;
          const selection = editor.state.selection.main;
          const text = editor.state.sliceDoc(0, selection.from) + paste + editor.state.sliceDoc(selection.to);
          event.preventDefault();
          if (partial.value ? text.length <= 2 * PREVIEW_LENGTH : canShowFull(text)) {
            editor.dispatch({
              changes: { from: selection.from, to: selection.to, insert: paste },
              selection: { anchor: selection.from + paste.length },
              scrollIntoView: true,
              userEvent: 'input.paste',
            });
          } else {
            emit('edit', text);
          }
          return true;
        },
      }),
    ],
  });
  synchronize();
});

watch(() => [props.preview, props.focusRange, props.focusKind, props.changes], synchronize);
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
      <div v-if="allowFile || preview.total" class="pane-actions">
        <input v-if="allowFile" ref="chooseFile" class="visually-hidden" tabindex="-1" type="file"
          :aria-label="'打开文件 · ' + title" @change="onFile">
        <button v-if="allowFile" class="text-button" type="button" @click="chooseFile?.click()">打开文件</button>
        <button v-if="preview.total" class="text-button" type="button" @click="emit('clear')">清空</button>
      </div>
    </header>
    <div ref="host" class="editor-host"></div>
    <footer class="pane-footer">
      <span v-if="partial">
        当前编辑片段 · {{ (preview.start + (preview.text.length ? 1 : 0)).toLocaleString() }}–{{ (preview.start + preview.text.length).toLocaleString() }}
        / {{ preview.total.toLocaleString() }}
      </span>
      <span v-else>{{ preview.total.toLocaleString() }} 字符</span>
      <div v-if="partial" class="pane-actions">
        <button class="text-button" type="button" :disabled="preview.start === 0"
          @click="emit('page', Math.max(0, preview.start - PREVIEW_LENGTH))">上一段</button>
        <button class="text-button" type="button" :disabled="preview.start + preview.text.length >= preview.total"
          @click="emit('page', preview.start + preview.text.length)">下一段</button>
      </div>
    </footer>
  </section>
</template>

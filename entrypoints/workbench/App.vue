<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowReactive, shallowRef, watch } from 'vue';
import DocumentPane from '@/components/DocumentPane.vue';
import {
  canShowFull, downloadBlob, emptyDocument, hasIsolatedSurrogates, isEditedSource,
  MAX_OUTPUT_BYTES, PREVIEW_LENGTH, replacePreview,
} from '@/lib/workbench/document';
import type { DocumentData, PlainSource, Preview, Source } from '@/lib/workbench/document';
import type { Comparison } from '@/lib/workbench/diff';
import type { Failure, Position, Transform } from '@/lib/workbench/protocol';
import type { Match } from '@/lib/workbench/search';
import { JobFailure, wasCancelled, WorkerClient } from '@/lib/workbench/worker-client';

type Mode = 'transform' | 'compare';
type Slot = 'input' | 'output' | 'left' | 'right';
type FocusKind = 'search' | 'difference' | 'error';

interface Document {
  data: DocumentData;
  name?: string;
}

interface ViewPosition {
  preview?: Preview;
  range?: Match;
  kind?: FocusKind;
}

const titles: Record<Slot, string> = { input: '原始输入', output: '转换结果', left: '左侧 JSON', right: '右侧 JSON' };
const actions: { key: Transform; label: string }[] = [
  { key: 'format', label: '格式化' }, { key: 'minify', label: '压缩' },
  { key: 'escape', label: '转义' }, { key: 'unescape', label: '反转义' },
];
const mode = ref<Mode>('transform');
const documents = shallowReactive<Record<Slot, Document>>({
  input: { data: emptyDocument }, output: { data: emptyDocument },
  left: { data: emptyDocument }, right: { data: emptyDocument },
});
const view = shallowReactive<Partial<Record<Slot, ViewPosition>>>({});
const importers = { input: new WorkerClient(), output: new WorkerClient(), left: new WorkerClient(), right: new WorkerClient() };
const pagers = { input: new WorkerClient(), output: new WorkerClient(), left: new WorkerClient(), right: new WorkerClient() };
const importing = shallowReactive<Partial<Record<Slot, object>>>({});
const engine = new WorkerClient();
const searchWorker = new WorkerClient();
const exporter = new WorkerClient();
const active = shallowRef<{ mode: Mode }>();
const comparison = shallowRef<Comparison>();
const outputName = ref('');
let outputEdited = false;
const differenceIndex = ref(-1);
const notice = shallowRef<{ message: string; error?: boolean; slot?: Slot; offset?: number }>();
const currentPanes = computed<Slot[]>(() => mode.value === 'transform' ? ['input', 'output'] : ['left', 'right']);
const pendingImport = computed(() => currentPanes.value.some((slot) => importing[slot] !== undefined));
const activePane = ref<Slot>('input');

function visibleData(slot: Slot): DocumentData {
  if (slot === 'left' || slot === 'right') return comparison.value?.[slot] ?? documents[slot].data;
  return documents[slot].data;
}

function resetPosition(slot: Slot) {
  pagers[slot].cancel();
  delete view[slot];
}

function clearComparison() {
  comparison.value = undefined;
  differenceIndex.value = -1;
  resetPosition('left');
  resetPosition('right');
}

function cancelOperation(message = '操作已取消。') {
  engine.cancel();
  active.value = undefined;
  notice.value = { message };
}

function cancelSlotOperation(slot: Slot) {
  if (active.value?.mode === (slot === 'left' || slot === 'right' ? 'compare' : 'transform')) cancelOperation();
}

function setDocument(slot: Slot, data: DocumentData, name?: string) {
  cancelSlotOperation(slot);
  if ((slot === 'left' || slot === 'right') && comparison.value) {
    const other = slot === 'left' ? 'right' : 'left';
    const otherPreview = view[other]?.preview;
    documents[other] = { ...documents[other], data: comparison.value[other] };
    clearComparison();
    if (otherPreview) view[other] = { preview: otherPreview };
  } else if (slot === 'output') {
    outputEdited = true;
    outputName.value ||= 'json-forge.txt';
  } else if (slot === 'input' && !outputEdited) {
    documents.output = { data: emptyDocument };
    outputName.value = '';
    resetPosition('output');
  }
  documents[slot] = { data, name };
  resetPosition(slot);
  notice.value = undefined;
}

function edit(slot: Slot, text: string) {
  const original = visibleData(slot);
  const preview = view[slot]?.preview ?? original.preview;
  if (text === preview.text) return;
  const data = replacePreview(original.source, preview, text);
  const partial = preview.text.length < preview.total;
  if (partial ? text.length > 2 * PREVIEW_LENGTH : !canShowFull(text)) {
    void loadDocument(slot, data.source, documents[slot].name, preview.start);
    return;
  }
  importers[slot].cancel();
  delete importing[slot];
  setDocument(slot, data, documents[slot].name);
}

function clearDocument(slot: Slot) {
  importers[slot].cancel();
  delete importing[slot];
  setDocument(slot, emptyDocument);
}

function describe(error: unknown): Failure {
  if (error instanceof JobFailure) return error.detail;
  return { message: error instanceof Error ? error.message : '操作失败，请重试。' };
}

function report(error: unknown, defaultSlot?: Slot) {
  if (wasCancelled(error)) return;
  const { message, line, column, offset, side } = describe(error);
  const slot = side ?? defaultSlot;
  const position = line ? ' 第 ' + line + ' 行，第 ' + column + ' 列。' : '';
  notice.value = { message: (slot ? titles[slot] + ' · ' : '') + message + position,
    error: true, slot, offset };
}

async function loadDocument(slot: Slot, source: Source, name?: string, offset?: number) {
  const worker = importers[slot];
  const ticket = {};
  cancelSlotOperation(slot);
  worker.cancel();
  importing[slot] = ticket;
  notice.value = undefined;
  try {
    const data = await worker.run('import', { source, offset, maxBytes: slot === 'output' ? MAX_OUTPUT_BYTES : undefined });
    if (importing[slot] === ticket) setDocument(slot, data, name);
  } catch (error) {
    if (importing[slot] === ticket) report(error, slot);
  } finally {
    if (importing[slot] === ticket) delete importing[slot];
  }
}

function cancelCurrent() {
  if (active.value) cancelOperation();
  for (const slot of currentPanes.value) {
    if (importing[slot] === undefined) continue;
    importers[slot].cancel();
    delete importing[slot];
    notice.value = { message: '已取消导入。' };
  }
}

async function transform(operation: Transform) {
  if (active.value) return;
  const ticket = { mode: 'transform' as const };
  const original = documents.input;
  active.value = ticket;
  notice.value = undefined;
  try {
    const data = await engine.run('transform', { operation, source: original.data.source });
    if (active.value !== ticket || documents.input !== original) return;
    resetPosition('output');
    documents.output = { data };
    outputEdited = false;
    const extension = operation === 'format' || operation === 'minify' ? '.json' : '.txt';
    const base = original.name?.replace(/\.[^.]+$/, '') || 'json-forge';
    outputName.value = base + '-' + operation + extension;
    notice.value = { message: '已' + actions.find((action) => action.key === operation)?.label + '。' };
  } catch (error) {
    if (active.value === ticket) report(error, 'input');
  } finally {
    if (active.value === ticket) active.value = undefined;
  }
}

async function compare() {
  if (active.value) return;
  const ticket = { mode: 'compare' as const };
  const left = documents.left;
  const right = documents.right;
  active.value = ticket;
  clearComparison();
  notice.value = undefined;
  try {
    const result = await engine.run('compare', { left: left.data.source, right: right.data.source }, 10000);
    if (active.value !== ticket || documents.left !== left || documents.right !== right) return;
    comparison.value = result;
    notice.value = { message: result.differences.length ? '找到 ' + result.differences.length + ' 处差异。' : '两侧内容相同。' };
    if (result.differences.length) navigateDifference(0);
  } catch (error) {
    if (active.value === ticket) report(error);
  } finally {
    if (active.value === ticket) active.value = undefined;
  }
}

async function showPosition(slot: Slot, offset: number, range?: Match, kind?: FocusKind) {
  const data = visibleData(slot);
  const existing = view[slot]?.preview ?? data.preview;
  const worker = pagers[slot];
  worker.cancel();
  if (existing.text.length === existing.total) {
    view[slot] = { range, kind };
    return;
  }
  try {
    const preview = await worker.run('preview', { source: data.source, offset, center: !!range });
    if (data === visibleData(slot)) view[slot] = { preview, range, kind };
  } catch (error) {
    if (data === visibleData(slot)) report(error, slot);
  }
}

const differenceMarks = computed(() => ({
  left: comparison.value?.differences.map(({ left }) => left),
  right: comparison.value?.differences.map(({ right }) => right),
}));

function navigateDifference(index: number) {
  const differences = comparison.value?.differences;
  if (!differences?.length) return;
  const wrapped = (index + differences.length) % differences.length;
  const difference = differences[wrapped];
  if (!difference) return;
  differenceIndex.value = wrapped;
  void showPosition('left', difference.left.from, difference.left, 'difference');
  void showPosition('right', difference.right.from, difference.right, 'difference');
}

function download(source: PlainSource, name: string) {
  const url = URL.createObjectURL(downloadBlob(source));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function downloadResult() {
  const { source } = documents.output.data;
  const name = outputName.value;
  try {
    download(isEditedSource(source) ? await exporter.run('export', { source }) : source, name);
  } catch (error) {
    report(error, 'output');
  }
}

async function copy() {
  const edited = documents.output.data.source;
  try {
    const source = isEditedSource(edited) ? await exporter.run('export', { source: edited }) : edited;
    if (typeof source === 'string') {
      await navigator.clipboard.writeText(source);
    } else if (hasIsolatedSurrogates(source)) {
      const worker = new WorkerClient();
      try {
        await navigator.clipboard.writeText(await worker.run('read', { source }));
      } finally {
        worker.cancel();
      }
    } else {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': source.slice(0, source.size, 'text/plain') })]);
    }
    notice.value = { message: '已复制完整结果。' };
  } catch {
    notice.value = { message: '浏览器无法写入剪贴板，可下载完整结果。', error: true };
  }
}

const searchOpen = ref(false);
const searchInput = ref<HTMLInputElement>();
const searchTarget = ref<Slot>('input');
const query = ref('');
const caseSensitive = ref(false);
const useRegex = ref(false);
const REGEX_TIMEOUT = 5000;
const matchTotal = ref<number>();
const matchIndex = ref(-1);
const searchState = ref('');
const searchData = computed(() => visibleData(searchTarget.value));
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchGeneration = 0;
let navigationGeneration = 0;

function presentMatch(slot: Slot, position: Position) {
  pagers[slot].cancel();
  view[slot] = { preview: position.preview, range: position.match, kind: 'search' };
  matchIndex.value = position.index;
}

watch([searchOpen, searchTarget, searchData, query, caseSensitive, useRegex], () => {
  const generation = ++searchGeneration;
  clearTimeout(searchTimer);
  searchWorker.cancel();
  matchIndex.value = -1;
  matchTotal.value = undefined;
  for (const slot of currentPanes.value) {
    const position = view[slot];
    if (position?.kind === 'search') view[slot] = { preview: position.preview };
  }
  searchState.value = '';
  if (!searchOpen.value || !query.value) return;
  const slot = searchTarget.value;
  const data = searchData.value;
  const keyword = query.value;
  const exact = caseSensitive.value;
  const regex = useRegex.value;
  searchState.value = '搜索中…';
  searchTimer = setTimeout(async () => {
    try {
      const result = await searchWorker.run('search', {
        source: data.source, query: keyword, caseSensitive: exact, regex,
      }, regex ? REGEX_TIMEOUT : 30000);
      if (generation !== searchGeneration) return;
      matchTotal.value = result.total;
      searchState.value = result.total ? '' : '无匹配';
      if (result.position) presentMatch(slot, result.position);
    } catch (error) {
      if (generation === searchGeneration && !wasCancelled(error)) searchState.value = describe(error).message;
    }
  }, 100);
}, { flush: 'sync' });

async function navigateSearch(direction: number) {
  if (!matchTotal.value) return;
  const generation = searchGeneration;
  const navigation = ++navigationGeneration;
  const slot = searchTarget.value;
  const index = (matchIndex.value + direction + matchTotal.value) % matchTotal.value;
  matchIndex.value = index;
  try {
    const position = await searchWorker.run('position', { index }, useRegex.value ? REGEX_TIMEOUT : undefined);
    if (generation === searchGeneration && navigation === navigationGeneration) presentMatch(slot, position);
  } catch (error) {
    if (generation === searchGeneration && navigation === navigationGeneration && !wasCancelled(error)) {
      matchTotal.value = undefined;
      matchIndex.value = -1;
      if (view[slot]?.kind === 'search') view[slot] = { preview: view[slot].preview };
      searchState.value = describe(error).message;
    }
  }
}

async function openSearch() {
  if (!searchOpen.value) searchTarget.value = activePane.value;
  searchOpen.value = true;
  await nextTick();
  searchInput.value?.focus();
  searchInput.value?.select();
}

function setMode(next: Mode) {
  if (mode.value === next) return;
  if (active.value) cancelOperation();
  searchOpen.value = false;
  mode.value = next;
  activePane.value = next === 'transform' ? 'input' : 'left';
  notice.value = undefined;
}

function keyboard(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    void openSearch();
  } else if (event.key === 'Escape' && searchOpen.value) {
    event.preventDefault();
    searchOpen.value = false;
  }
}

onMounted(() => window.addEventListener('keydown', keyboard));
onUnmounted(() => {
  window.removeEventListener('keydown', keyboard);
  clearTimeout(searchTimer);
  for (const worker of [engine, searchWorker, exporter, ...Object.values(importers), ...Object.values(pagers)]) worker.cancel();
});
</script>

<template>
  <main class="workbench">
    <header class="masthead">
      <div class="brand"><span class="brand-mark" aria-hidden="true">{ }</span><h1>JSON Forge</h1></div>
      <nav class="mode-switch" aria-label="工作台模式">
        <button type="button" :aria-pressed="mode === 'transform'" @click="setMode('transform')">转换</button>
        <button type="button" :aria-pressed="mode === 'compare'" @click="setMode('compare')">Diff 对比</button>
      </nav>
      <button type="button" class="search-toggle" aria-keyshortcuts="Control+F Meta+F" @click="openSearch">
        搜索 <kbd>Ctrl / ⌘ + F</kbd>
      </button>
    </header>

    <div class="toolbar" aria-label="文档操作">
      <template v-if="mode === 'transform'">
        <div class="toolbar-group">
          <button v-for="action in actions" :key="action.key" type="button"
            :class="{ primary: action.key === 'format' }" :disabled="!!active || pendingImport" @click="transform(action.key)">
            {{ action.label }}
          </button>
        </div>
        <div class="toolbar-group export">
          <button type="button" :disabled="!outputName || !!importing.output" @click="copy">复制结果</button>
          <button type="button" :disabled="!outputName || !!importing.output" @click="downloadResult">下载结果</button>
        </div>
      </template>
      <template v-else>
        <div class="toolbar-group">
          <button class="primary" type="button" :disabled="!!active || pendingImport" @click="compare">比较 JSON</button>
          <template v-if="comparison?.differences.length">
            <button type="button" @click="navigateDifference(differenceIndex - 1)">上一处差异</button>
            <span class="position-label">{{ differenceIndex + 1 }} / {{ comparison.differences.length }}</span>
            <button type="button" @click="navigateDifference(differenceIndex + 1)">下一处差异</button>
          </template>
        </div>
        <div class="toolbar-group export">
          <button type="button" :disabled="!comparison?.patch"
            @click="comparison?.patch && download(comparison.patch, 'json-forge.diff')">下载 Diff</button>
        </div>
      </template>
      <button v-if="active || pendingImport" type="button" @click="cancelCurrent">取消操作</button>
    </div>

    <div v-if="searchOpen" class="search-bar" role="search" aria-label="全文搜索">
      <select v-model="searchTarget" aria-label="搜索范围">
        <option v-for="pane in currentPanes" :key="pane" :value="pane">{{ titles[pane] }}</option>
      </select>
      <input ref="searchInput" v-model="query" type="search" maxlength="1024" aria-label="搜索词"
        :placeholder="useRegex ? '输入正则表达式' : '查找文本'"
        @keydown.enter.prevent="navigateSearch($event.shiftKey ? -1 : 1)">
      <label class="search-option"><input v-model="caseSensitive" type="checkbox">区分大小写</label>
      <label class="search-option"><input v-model="useRegex" type="checkbox">正则</label>
      <span aria-live="polite" class="position-label">{{ searchState || (matchTotal ? (matchIndex + 1) + ' / ' + matchTotal : '') }}</span>
      <button type="button" :disabled="!matchTotal" @click="navigateSearch(-1)">上一处</button>
      <button type="button" :disabled="!matchTotal" @click="navigateSearch(1)">下一处</button>
      <button type="button" @click="searchOpen = false">关闭</button>
    </div>

    <div class="status" :class="{ 'status-error': notice?.error }" role="status">
      <template v-if="active || pendingImport"><span class="busy-dot"></span>{{ pendingImport ? '正在打开文档…' : '正在处理…' }}</template>
      <template v-else-if="notice">
        {{ notice.message }}
        <button v-if="notice.slot && notice.offset !== undefined" type="button" class="text-button"
          @click="showPosition(notice.slot!, notice.offset!, { from: notice.offset!, to: notice.offset! + 1 }, 'error')">
          定位
        </button>
      </template>
      <template v-else>{{ mode === 'transform' ? '粘贴文本或打开本地文件。' : '添加两份 JSON 以比较差异。' }}</template>
    </div>

    <div class="panes">
      <DocumentPane v-for="pane in currentPanes" :key="pane" :title="titles[pane]"
        :preview="view[pane]?.preview ?? visibleData(pane).preview" :file-name="documents[pane].name"
        :allow-file="pane !== 'output'"
        :changes="pane === 'left' || pane === 'right' ? differenceMarks[pane] : undefined"
        :change-kind="pane === 'left' ? 'removed' : 'added'"
        :focus-range="view[pane]?.range" :focus-kind="view[pane]?.kind"
        @activate="activePane = pane" @page="showPosition(pane, $event)"
        @edit="edit(pane, $event)" @clear="clearDocument(pane)"
        @import-source="loadDocument(pane, $event, $event.name)" />
    </div>
  </main>
</template>

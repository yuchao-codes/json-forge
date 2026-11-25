import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPatch } from 'diff';
import { compareJson } from '../lib/workbench/diff.ts';
import { downloadBlob, makeDocument, makePreview, readSource, replacePreview } from '../lib/workbench/document.ts';
import { escapeText, rewriteJson, unescapeText } from '../lib/workbench/json-text.ts';
import { TextSearch } from '../lib/workbench/search.ts';

test('formats JSON without replacing number spellings, duplicate keys or escape sequences', () => {
  const raw = '{"k":9007199254740993,"k":-0,"content":["a b","\\u0061",-2.0E+01,false,null,{}]}';
  const pretty = rewriteJson(' \n' + raw + '\t', true);
  assert.match(pretty, /\n  "k": 9007199254740993,\n  "k": -0,/);
  assert.equal(rewriteJson(pretty, false), raw);
  for (const text of ['"a b"', '9007199254740993', 'null', 'true', 'false', '{}', '[]']) {
    assert.equal(rewriteJson(' \r\n' + text + '\t', true), text);
  }
});

test('strict syntax rejects malformed numbers, strings, delimiters and extra values', () => {
  for (const text of ['{} []', '[1,]', '{"a":1,}', '/*comment*/{}', '01', '-01', '1.', '1e+',
    '"bad\\x"', '"bad\\u1z00"', '"a\tb"', '\u00a0false', '[}', '{"k" 4}', '', '{}\u0000']) {
    assert.throws(() => rewriteJson(text, false), (error) => error.line >= 1 && error.column >= 1, text);
  }
  assert.throws(() => rewriteJson('{\r\n  "k": }', true), { line: 2, column: 8, offset: 10 });
  assert.throws(() => rewriteJson('['.repeat(4500) + ']'.repeat(4500), true), /嵌套深度/);
});

test('unescapes exactly once and retains arbitrary string contents', () => {
  const text = '引号"\\ \r\n\t😃\u0000\ud800 ';
  assert.equal(unescapeText(escapeText(text)), text);
  assert.equal(unescapeText(JSON.stringify(JSON.stringify(text))), JSON.stringify(text));
  assert.throws(() => unescapeText('{"k":"x"}'), /JSON 字符串/);
  assert.throws(() => unescapeText('"\\q"'), /JSON 字符串/);
});

test('large escaping is byte-for-byte equivalent across a surrogate-pair boundary', () => {
  const text = ' '.repeat(65535) + '😃' + '\\\n\u0000雪'.repeat(300000);
  assert.equal(escapeText(text), JSON.stringify(text));
});

test('text download preserves a decoded isolated surrogate', async () => {
  const value = unescapeText('"\\ud800"');
  const { source } = makeDocument(value);
  const blob = downloadBlob(source);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), Uint8Array.of(0xff, 0xfe, 0, 0xd8));
  assert.equal(await readSource(blob), value);
});

test('bounded preview locates a distant UTF-16 range while retaining the full source', async () => {
  const text = 'x'.repeat(20000) + '😃\n' + 'tail'.repeat(20000);
  const { source, preview } = makeDocument(text);
  assert.equal(preview.start, 0);
  assert.ok(preview.text.length < text.length);
  const position = makePreview(text, 20000, true);
  assert.match(position.text, /😃\ntail/);
  assert.equal(text.slice(position.start, position.start + position.text.length), position.text);
  assert.equal(await readSource(source), text);
  await assert.rejects(readSource(new File([Uint8Array.of(0xc3, 0x28)], 'bad.json')), /UTF-8/);
});

test('editing multiple and overlapping preview spans preserves the rest of the document', async () => {
  const base = 'start 🎉middle end';
  const source = new Blob([base]);
  const edit = (document, from, to, text) => replacePreview(document, {
    start: from, total: text.length, text: text.slice(from, to), line: 1,
  }, 'NEW');
  const first = edit(source, 8, 14, base);
  const updated = 'start 🎉NEW end';
  assert.equal(await readSource(first.source), updated);
  assert.equal(first.preview.total, updated.length);
  const second = edit(first.source, 10, 14, updated);
  const next = 'start 🎉NENEWd';
  assert.equal(await readSource(second.source), next);
  const third = replacePreview(second.source, { start: 0, total: next.length, text: 'start ', line: 1 }, '');
  assert.equal(await readSource(third.source), '🎉NENEWd');
});

test('comparison skips whitespace, marks reordered keys, and exports a real unified patch', async () => {
  const left = '{"a":[1,2],"b":"before","c":true}';
  const right = '{"b":"after","a":[1,3],"d":null}';
  assert.equal((await compareJson(left, ' ' + rewriteJson(left, true) + '\n')).differences.length, 0);
  const reordered = await compareJson('{"a":1,"b":2}', '{"b":2,"a":1}');
  assert.ok(reordered.differences.length > 0);
  const result = await compareJson(left, right);
  assert.equal(applyPatch(rewriteJson(left, true), await result.patch.text()), rewriteJson(right, true));
  assert.ok(result.differences.every((difference) => difference.left.from <= difference.left.to
    && difference.right.from <= difference.right.to));
  await assert.rejects(compareJson(left, '[1,]'), { side: 'right', line: 1, column: 4 });
  await assert.rejects(compareJson(left, right, { timeout: 1, maxEditLength: 1 }), /对比未完成/);
});

test('literal search counts across segment boundaries and keeps original match offsets', async () => {
  const start = 256 * 1024 - 3;
  const text = 'x'.repeat(start) + '😃.FOO ' + '😃.foo';
  const insensitive = new TextSearch(text, '😃.foo', false);
  assert.equal(await insensitive.build(() => true), true);
  assert.equal(insensitive.total, 2);
  assert.deepEqual(insensitive.at(0), { from: start, to: start + 6 });
  assert.deepEqual(insensitive.at(1), { from: start + 7, to: start + 13 });
  const sensitive = new TextSearch(text, '😃.foo', true);
  await sensitive.build(() => true);
  assert.equal(sensitive.total, 1);
  assert.equal(sensitive.at(0).from, start + 7);
});

test('search navigates across checkpoints without retaining every match and can be interrupted', async () => {
  const text = 'x'.repeat(450000);
  const index = new TextSearch(text, 'x', true);
  await index.build(() => true);
  assert.equal(index.total, text.length);
  assert.deepEqual(index.at(449999), { from: 449999, to: 450000 });
  const interrupted = new TextSearch(text, 'x', true);
  assert.equal(await interrupted.build(() => false), false);
  assert.ok(interrupted.total < text.length);
});

test('regex search supports line anchors, case options and lookarounds across the whole document', async () => {
  const lineText = 'Foo 12\nfoo 34\nbar 56';
  const insensitive = new TextSearch(lineText, '^foo \\d+$', false, true);
  await insensitive.build(() => true);
  assert.equal(insensitive.total, 2);
  assert.deepEqual(insensitive.at(0), { from: 0, to: 6 });
  assert.deepEqual(insensitive.at(1), { from: 7, to: 13 });
  const sensitive = new TextSearch(lineText, '^foo \\d+$', true, true);
  await sensitive.build(() => true);
  assert.equal(sensitive.total, 1);
  assert.deepEqual(sensitive.at(0), { from: 7, to: 13 });

  const boundary = 256 * 1024;
  const text = 'x'.repeat(boundary - 5) + '<\n' + 'y'.repeat(boundary) + '\n>';
  const spanning = new TextSearch(text, '(?<=<)\\s+y+\\s+(?=>)', true, true);
  await spanning.build(() => true);
  assert.equal(spanning.total, 1);
  assert.deepEqual(spanning.at(0), { from: boundary - 4, to: text.length - 1 });
  assert.throws(() => new TextSearch(text, '[', true, true), /正则表达式无效/);
});

test('regex empty matches advance across Unicode characters and can be revisited', async () => {
  const text = '😃'.repeat(1030);
  const index = new TextSearch(text, '(?=.)|$', false, true);
  await index.build(() => true);
  assert.equal(index.total, 1031);
  for (const match of [0, 1, 1024, 1029, 1030]) {
    assert.deepEqual(index.at(match), { from: match * 2, to: match * 2 });
  }
  const empty = new TextSearch('', '^$', true, true);
  await empty.build(() => true);
  assert.equal(empty.total, 1);
  assert.deepEqual(empty.at(0), { from: 0, to: 0 });
});

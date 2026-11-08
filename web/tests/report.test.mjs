import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileSpecStream } from '@json-render/core';
import { streamCard } from '@json-render/chat';
import { presetSpec, validateReport } from '../catalog.mjs';
import { makeChatCard, validateEvidence } from '../results.mjs';

const evidence = JSON.parse(readFileSync(new URL('../data/kras-lung.json', import.meta.url)));

test('all presets compile from JSONL and pass both catalog and report validation', () => {
  for (const view of ['overview', 'ranked', 'missing', 'evidence']) {
    const spec = presetSpec(view);
    const lines = Object.entries(spec).map(([key, value]) => JSON.stringify({ op: 'add', path: `/${key}`, value })).join('\n');
    assert.deepEqual(validateReport(compileSpecStream(lines)), spec);
  }
});

test('rejects fabricated data, mutable state, hidden evidence and cyclic UI graphs', () => {
  const corruptions = [
    spec => { spec.state = { scores: [0] }; },
    spec => { spec.elements.plot.props.scores = [0]; },
    spec => { spec.elements.plot.props.limit = { $state: '/n' }; },
    spec => { spec.elements.evidence.visible = false; },
    spec => { spec.elements.table.on = { press: { action: 'setState' } }; },
    spec => { spec.elements.report.children.push('report'); },
    spec => { spec.elements.report.children[1] = 'unknown'; },
    spec => { spec.elements.report.children = spec.elements.report.children.filter(id => id !== 'evidence'); delete spec.elements.evidence; },
    spec => { spec.elements.plot.props.limit = 10000; },
  ];
  for (const corrupt of corruptions) { const spec = presetSpec(); corrupt(spec); assert.throws(() => validateReport(spec)); }
});

test('cohort counts reconcile and missing data cannot become zero', () => {
  validateEvidence(evidence, { gene: 'KRAS', lineage: 'Lung' });
  assert.throws(() => validateEvidence(evidence, { gene: 'BRAF', lineage: 'Lung' }));
  const corrupt = structuredClone(evidence);
  corrupt.rows.find(row => row.status === 'absent_from_dataset').dependency = 0;
  assert.throws(() => validateEvidence(corrupt, evidence.query));
  const duplicate = structuredClone(evidence);
  duplicate.rows[1] = duplicate.rows[0];
  assert.throws(() => validateEvidence(duplicate, evidence.query));
});

test('Chat SDK conversion and streamCard use real scores through an in-memory target', async () => {
  const { chatSpec, chatCard } = makeChatCard(evidence, presetSpec('ranked'));
  const top = evidence.rows.filter(row => row.status === 'observed').sort((a, b) => a.dependency - b.dependency).slice(0, 10);
  assert.deepEqual(chatSpec.elements.chart.props.chart.series[0].values, top.map(row => row.dependency));
  const updates = [];
  const target = { async post(card) { updates.push(card); return { async edit(card) { updates.push(card); } }; } };
  async function* patches() {
    yield JSON.stringify({ op: 'add', path: '/root', value: chatSpec.root }) + '\n';
    for (const [key, value] of Object.entries(chatSpec.elements)) {
      yield JSON.stringify({ op: 'add', path: `/elements/${key}`, value }) + '\n';
    }
  }
  const result = await streamCard(target, patches(), { limits: { tables: 1, charts: 1, tableRows: 11 } });
  assert.deepEqual(result.card, chatCard);
  assert.ok(updates.length >= 1);
});

test('an entirely unscored cohort remains unscored in Chat SDK output', () => {
  const empty = structuredClone(evidence);
  empty.rows = empty.rows.filter(row => row.status === 'absent_from_dataset');
  empty.counts = { cohort: empty.rows.length, observed: 0, null_score: 0, absent_from_dataset: empty.rows.length, present_in_dataset: 0 };
  const { chatSpec } = makeChatCard(empty, presetSpec('ranked'));
  assert.equal(chatSpec.elements.chart, undefined);
  assert.deepEqual(chatSpec.elements.table.props.rows, []);
  assert.match(chatSpec.elements.emptyPlot.props.content, /No observed scores/);
});

test('missing-data cards contain missing models and preserve their distinct statuses', () => {
  const sample = structuredClone(evidence);
  const missing = sample.rows.find(row => row.status === 'absent_from_dataset');
  missing.status = 'null_score';
  sample.counts.absent_from_dataset--;
  sample.counts.null_score++;
  sample.counts.present_in_dataset++;
  const { chatSpec } = makeChatCard(sample, presetSpec('missing'));
  const rows = chatSpec.elements.table.props.rows;
  assert.equal(chatSpec.elements.chart, undefined);
  assert.equal(rows.length, 10);
  assert.ok(rows.every(row => row[2] === 'No score'));
  assert.ok(rows.every(row => ['Null score', 'Absent from dataset'].includes(row[3])));
  assert.ok(rows.some(row => row[1] === missing.depmap_id && row[3] === 'Null score'));
  assert.ok(rows.every(row => sample.rows.find(source => source.depmap_id === row[1]).status !== 'observed'));
});

test('evidence-only cards preserve requested order and omit tables and charts', () => {
  const spec = presetSpec('evidence');
  spec.elements.report.children = ['evidence', 'coverage', 'interpretation'];
  const { chatSpec } = makeChatCard(evidence, spec);
  assert.deepEqual(chatSpec.elements.card.children, ['source', 'coverage', 'direction']);
  assert.equal(chatSpec.elements.table, undefined);
  assert.equal(chatSpec.elements.chart, undefined);
  assert.ok(evidence.provenance.datasets.every(dataset => chatSpec.elements.source.props.content.includes(dataset.given_id) && chatSpec.elements.source.props.content.includes(dataset.release)));
  assert.ok(evidence.warnings.every(warning => chatSpec.elements.source.props.content.includes(warning)));
  assert.ok(chatSpec.elements.source.props.content.includes(evidence.rows_sha256));
});

test('distribution cards count every observed score in the same 20 bins as the browser', () => {
  const { chatSpec } = makeChatCard(evidence, presetSpec('overview'));
  const chart = chatSpec.elements.chart.props.chart;
  const scores = evidence.rows.filter(row => row.status === 'observed').map(row => row.dependency);
  const min = Math.min(-1, ...scores) - 0.08;
  const max = Math.max(0, ...scores) + 0.08;
  const counts = chart.series[0].values;
  assert.equal(counts.length, 20);
  assert.equal(counts.reduce((total, count) => total + count, 0), evidence.counts.observed);
  assert.equal(chart.yLabel, 'Model count');
  for (let index = 0; index < 20; index++) {
    const lower = min + index / 20 * (max - min);
    const upper = min + (index + 1) / 20 * (max - min);
    assert.equal(counts[index], scores.filter(score => score >= lower && score < upper).length);
  }
});

test('Chat tables honor row limits, explain their cap, and require a matching validated report', () => {
  const spec = presetSpec('ranked');
  spec.elements.table.props.limit = 5;
  assert.equal(makeChatCard(evidence, spec).chatSpec.elements.table.props.rows.length, 5);
  spec.elements.table.props.limit = 100;
  const table = makeChatCard(evidence, spec).chatSpec.elements.table.props;
  assert.equal(table.rows.length, 10);
  assert.match(table.caption, /at most 10 rows \(requested 100\)/);
  assert.throws(() => makeChatCard(evidence));
  assert.throws(() => makeChatCard(evidence, presetSpec('ranked', 'BRAF', 'Skin')));
});

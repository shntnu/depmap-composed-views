import { toCard } from '@json-render/chat';
import { validateReport } from './catalog.mjs';

export function validateEvidence(evidence, query) {
  if (evidence.query.gene !== query.gene || evidence.query.lineage !== query.lineage) throw new Error('Evidence does not match the requested query.');
  const seen = new Set();
  const counts = { observed: 0, null_score: 0, absent_from_dataset: 0 };
  for (const row of evidence.rows) {
    if (!row.depmap_id || seen.has(row.depmap_id) || !Object.hasOwn(counts, row.status)) throw new Error('Invalid or duplicate model row.');
    seen.add(row.depmap_id);
    counts[row.status]++;
    if (row.status === 'observed' ? !Number.isFinite(row.dependency) : row.dependency !== null) throw new Error('Invalid score or missingness.');
  }
  if (evidence.counts.cohort !== evidence.rows.length || Object.entries(counts).some(([key, n]) => evidence.counts[key] !== n) ||
      evidence.counts.present_in_dataset !== counts.observed + counts.null_score) throw new Error('Cohort accounting failed.');
  return evidence;
}

export function makeChatCard(evidence, spec) {
  validateReport(spec);
  validateEvidence(evidence, spec.elements[spec.root].props);
  const observed = evidence.rows.filter(row => row.status === 'observed').sort((a, b) => a.dependency - b.dependency);
  const { gene, lineage } = evidence.query;
  const c = evidence.counts;
  const elements = {
    card: { type: 'Card', props: { title: `${gene} in ${lineage}`, subtitle: 'Verified DepMap query' }, children: [] },
  };
  const append = (id, type, props) => {
    elements[id] = { type, props, children: [] };
    elements.card.children.push(id);
  };
  for (const id of spec.elements[spec.root].children) {
    const { type, props } = spec.elements[id];
    if (type === 'Coverage') {
      append('coverage', 'Text', { content: `${c.observed} scored of ${c.cohort} cohort models; ${c.absent_from_dataset} absent from dataset; ${c.null_score} null scores.` });
    } else if (type === 'Interpretation') {
      append('direction', 'Text', { content: `${evidence.interpretation} This descriptive result does not establish lineage selectivity, drug response, or patient benefit.` });
    } else if (type === 'Evidence') {
      const sources = evidence.provenance.datasets.map(dataset => `${dataset.given_id}: ${dataset.release || 'unknown release'} (${dataset.name})`).join('; ');
      append('source', 'Text', { content: `Retrieved ${evidence.provenance.completed_at_utc}. Sources: ${sources}. ${evidence.warnings.join(' ')} Reported row SHA-256: ${evidence.rows_sha256}. ${evidence.limits}` });
    } else if (type === 'ModelTable') {
      const matching = evidence.rows.filter(row => props.filter === 'all' || (props.filter === 'observed' ? row.status === 'observed' : row.status !== 'observed'))
        .sort((a, b) => (a.dependency ?? Infinity) - (b.dependency ?? Infinity) || a.depmap_id.localeCompare(b.depmap_id));
      const rows = matching.slice(0, Math.min(props.limit, 10));
      const statuses = { observed: 'Observed', null_score: 'Null score', absent_from_dataset: 'Absent from dataset' };
      const description = { all: 'cohort models', observed: 'observed models, strongest first', missing: 'models without scores' }[props.filter];
      append('table', 'Table', {
        headers: ['Model', 'ID', 'Chronos', 'Coverage'],
        rows: rows.map(row => [row.cell_line_name || row.depmap_id, row.depmap_id, row.status === 'observed' ? row.dependency.toFixed(3) : 'No score', statuses[row.status]]),
        caption: `Showing ${rows.length} of ${matching.length} ${description}. Chat cards show at most 10 rows (requested ${props.limit}); the evidence contains every cohort row.`,
      });
    } else if (type === 'DependencyPlot') {
      if (!observed.length) {
        append('emptyPlot', 'Text', { content: 'No observed scores are available for this cohort.' });
      } else if (props.view === 'ranked') {
        const ranked = observed.slice(0, props.limit);
        append('chart', 'Chart', {
          title: `Strongest observed dependencies (${ranked.length} of ${observed.length})`,
          chart: { type: 'bar', categories: ranked.map(row => row.cell_line_name || row.depmap_id), series: [{ name: 'Chronos', values: ranked.map(row => row.dependency) }], xLabel: 'Cell-line model', yLabel: 'Chronos gene effect' },
        });
      } else {
        const min = Math.min(-1, observed[0].dependency) - 0.08;
        const max = Math.max(0, observed[observed.length - 1].dependency) + 0.08;
        const bins = Array(20).fill(0);
        observed.forEach(row => { bins[Math.min(19, Math.floor((row.dependency - min) / (max - min) * 20))] += 1; });
        append('chart', 'Chart', {
          title: `Distribution of all ${observed.length} observed scores`,
          chart: {
            type: 'bar', categories: bins.map((_, index) => `${(min + index / 20 * (max - min)).toFixed(2)} to ${(min + (index + 1) / 20 * (max - min)).toFixed(2)}`),
            series: [{ name: 'Observed models', values: bins }], xLabel: 'Chronos gene effect (bin ranges)', yLabel: 'Model count',
          },
        });
      }
    }
  }
  const chatSpec = { root: 'card', elements };
  return { chatSpec, chatCard: toCard(chatSpec, { limits: { tables: 1, charts: 1, tableRows: 11 } }) };
}

import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/react/schema';
import { z } from 'zod';

export const querySchema = z.object({
  gene: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/),
  lineage: z.string().regex(/^[A-Za-z][A-Za-z /()-]{0,79}$/),
}).strict();

const definitions = {
  Report: { props: querySchema, slots: ['default'], description: 'One gene and one exact Oncotree lineage. Root only.' },
  Coverage: { props: z.object({}).strict(), slots: [], description: 'Required cohort accounting from verified data.' },
  DependencyPlot: {
    props: z.object({ view: z.enum(['ranked', 'distribution']), limit: z.number().int().min(5).max(50) }).strict(),
    slots: [], description: 'Observed Chronos scores: ranked strongest first, or distribution of ALL observed scores.' },
  ModelTable: {
    props: z.object({ filter: z.enum(['all', 'observed', 'missing']), limit: z.number().int().min(5).max(100) }).strict(),
    slots: [], description: 'Verified rows. Missing includes absent models and null scores. Observed sorts strongest first.' },
  Evidence: { props: z.object({}).strict(), slots: [], description: 'Required source releases, requests and row hash.' },
  Interpretation: { props: z.object({}).strict(), slots: [], description: 'Trusted explanation of score direction and limitations.' },
};

export const catalog = defineCatalog(schema, { components: definitions, actions: {} });

// Shape validation alone permits expressions and state; this report needs neither.
export function validateReport(input) {
  const shell = z.object({ root: z.string(), elements: z.record(z.string(), z.unknown()) }).strict().parse(input);
  const entries = Object.entries(shell.elements);
  if (entries.length < 3 || entries.length > 7) throw new Error('A report needs 3 to 7 components.');
  const root = shell.elements[shell.root];
  if (!root || root.type !== 'Report') throw new Error('Report must be the root.');
  const types = new Set();
  for (const [id, value] of entries) {
    const element = z.object({ type: z.string(), props: z.record(z.string(), z.unknown()), children: z.array(z.string()).optional() }).strict().parse(value);
    const definition = definitions[element.type];
    if (!definition || types.has(element.type)) throw new Error('Unknown or repeated component.');
    types.add(element.type);
    definition.props.parse(element.props);
    if (id !== shell.root && (element.type === 'Report' || element.children?.length)) throw new Error('Only the report can have children.');
  }
  const children = root.children ?? [];
  if (new Set(children).size !== entries.length - 1 || children.length !== entries.length - 1 ||
      children.some(id => id === shell.root || !Object.hasOwn(shell.elements, id))) {
    throw new Error('Report children must reference every other component exactly once.');
  }
  if (!types.has('Coverage') || !types.has('Evidence')) throw new Error('Coverage and evidence are required.');
  const checked = catalog.validate(shell);
  if (!checked.success) throw new Error('UI catalog validation failed.');
  return shell;
}

export function presetSpec(view = 'overview', gene = 'KRAS', lineage = 'Lung') {
  const elements = { report: { type: 'Report', props: { gene, lineage }, children: ['coverage'] },
    coverage: { type: 'Coverage', props: {}, children: [] } };
  if (view === 'overview' || view === 'ranked') {
    elements.plot = { type: 'DependencyPlot', props: { view: view === 'overview' ? 'distribution' : 'ranked', limit: 10 }, children: [] };
    elements.report.children.push('plot');
  }
  if (view !== 'evidence') {
    elements.table = { type: 'ModelTable', props: { filter: view === 'missing' ? 'missing' : 'observed', limit: 10 }, children: [] };
    elements.report.children.push('table');
  }
  elements.evidence = { type: 'Evidence', props: {}, children: [] };
  elements.interpretation = { type: 'Interpretation', props: {}, children: [] };
  elements.report.children.push('evidence', 'interpretation');
  return validateReport({ root: 'report', elements });
}

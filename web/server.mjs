import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { streamText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { compileSpecStream } from '@json-render/core';
import { z } from 'zod';
import { catalog, presetSpec, querySchema, validateReport } from './catalog.mjs';
import { makeChatCard, validateEvidence } from './results.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const runFile = promisify(execFile);
const app = express();
const hosted = process.env.VERCEL === '1';
const useGateway = hosted || Boolean(process.env.AI_GATEWAY_API_KEY);
const model = process.env.AI_MODEL || process.env.OPENROUTER_MODEL || 'anthropic/claude-haiku-4.5';
const modelAvailable = useGateway || Boolean(process.env.OPENROUTER_API_KEY);
const snapshots = { 'KRAS/Lung': 'kras-lung.json', 'BRAF/Skin': 'braf-skin.json', 'EGFR/Lung': 'egfr-lung.json' };
const requestSchema = querySchema.extend({ source: z.enum(['snapshot', 'live']).default('snapshot') });
let busy = false;

app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  const expectedOrigin = `${hosted ? 'https' : 'http'}://${req.get('host')}`;
  if ((!hosted && !['127.0.0.1', 'localhost', '[::1]'].includes(req.hostname)) || (origin && origin !== expectedOrigin)) {
    return res.status(403).json({ error: 'This demo only accepts requests from its own page.' });
  }
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '16kb' }));
app.get('/api/config', (_req, res) => res.json({ modelAvailable, model, snapshots: Object.keys(snapshots),
  presets: ['overview', 'ranked', 'missing', 'evidence'].map(id => ({ id, label: id, gene: 'KRAS', lineage: 'Lung', view: id })) }));

async function retrieve(query, source) {
  let evidence;
  if (source === 'snapshot') {
    const filename = snapshots[`${query.gene}/${query.lineage}`];
    if (!filename) throw new Error('No saved snapshot for this query. Choose live data, or KRAS/Lung, EGFR/Lung, or BRAF/Skin.');
    evidence = JSON.parse(await readFile(path.join(directory, 'data', filename), 'utf8'));
  } else if (process.env.DEPMAP_SERVICE_URL) {
    try {
      const response = await fetch(`${process.env.DEPMAP_SERVICE_URL.replace(/\/$/, '')}/query`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query),
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) throw new Error('DepMap service rejected the query.');
      evidence = await response.json();
    } catch {
      throw new Error('Live retrieval failed or timed out. Check the gene and lineage, then retry or explicitly choose a saved snapshot.');
    }
  } else {
    if (hosted) throw new Error('Live retrieval is unavailable: the DepMap service binding is missing.');
    try {
      const { stdout } = await runFile('uv', ['run', '--no-project', path.join(directory, 'data_bridge.py'), '--gene', query.gene, '--lineage', query.lineage],
        { cwd: directory, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
      evidence = JSON.parse(stdout);
    } catch (error) {
      const detail = error.stderr?.split('\n').find(line => line.startsWith('DepMap query failed:'));
      throw new Error(detail || 'Live retrieval failed or timed out. Retry, or explicitly choose a saved snapshot.');
    }
  }
  return validateEvidence(evidence, query);
}

async function resultFor(spec, source, mode) {
  const evidence = await retrieve(spec.elements[spec.root].props, source);
  return { spec, evidence, mode, source, ...(mode === 'model' ? { model } : {}), ...makeChatCard(evidence, spec) };
}

app.post('/api/preset', async (req, res) => {
  try {
    const input = requestSchema.extend({ preset: z.enum(['overview', 'ranked', 'missing', 'evidence']) }).strict().parse(req.body);
    res.json(await resultFor(presetSpec(input.preset, input.gene, input.lineage), input.source, 'preset'));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/generate', async (req, res) => {
  const parsed = requestSchema.extend({ prompt: z.string().trim().min(1).max(2000) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Supply a question, gene, lineage and data source.' });
  if (!modelAvailable) return res.status(503).json({ error: 'Set OPENROUTER_API_KEY in the server environment to enable AI composition. Presets work without it.' });
  if (busy) return res.status(429).json({ error: 'A composition is already running. Try again when it finishes.' });
  busy = true;
  res.set({ 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = value => { if (!res.destroyed) res.write(`data: ${JSON.stringify(value)}\n\n`); };
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const timer = setTimeout(() => abort.abort(), 120_000);
  try {
    const { prompt, gene, lineage, source } = parsed.data;
    send({ type: 'status', message: 'Composing a view from the allowed scientific components...' });
    const languageModel = useGateway ? model : createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })(model);
    const instructions = catalog.prompt({ customRules: [
      'This is a scientific report. Never generate sample data, scientific values, text claims, state, expressions, actions, bindings, visibility, repeat, or event handlers. This overrides generic sample-data instructions.',
      'Output only JSONL patches to /root and /elements. The completed spec has EXACTLY root and elements. Do not add state, even an empty state.',
      'Exactly one Report root. Its props identify the requested gene and exact Oncotree lineage. The user question ALWAYS overrides the default gene and lineage when it names them. For example, Show BRAF in Skin means Report props gene=BRAF,lineage=Skin even if defaults are KRAS/Lung. This is an explicit query change, not an ambiguity: do not ask for confirmation. Correct common case to KRAS, BRAF, EGFR, Lung or Skin.',
      'Report children include Coverage and Evidence, plus whichever DependencyPlot, ModelTable or Interpretation is useful. Each component type occurs at most once. Every other element is a direct child of Report. Each element has ONLY type, props, children.',
      'For an overview choose a distribution plot and observed table. For strongest dependencies use ranked plot and observed table. For missing models use a missing table. For provenance use Evidence first. Only layout, gene, lineage, view, filter and row limit are yours to choose.',
      'DependencyPlot.limit is an integer from 5 to 50. For distribution use limit=10; distribution always includes ALL observed scores regardless of limit. ModelTable.limit is an integer from 5 to 100. Never exceed these schema limits. Emit raw JSONL without markdown fences.',
      'Only single-gene, single-lineage descriptive queries are supported. Do not pretend to compare cohorts, test selectivity, stratify mutations or predict drug response. For unsupported requests produce no spec.',
    ] });
    let modelFailure;
    const response = streamText({ model: languageModel, system: instructions,
      prompt: `Defaults when unspecified: gene=${gene}, lineage=${lineage}. User question (takes precedence over defaults): ${prompt}`,
      maxOutputTokens: 1500, maxRetries: 0, abortSignal: abort.signal,
      onError: ({ error }) => { modelFailure = error; } });
    let output = '';
    for await (const text of response.textStream) {
      output += text;
      if (output.length > 40_000) throw new Error('The generated view exceeded the demo size limit.');
      send({ type: 'delta', text });
    }
    if (modelFailure) {
      if (modelFailure.statusCode === 402) throw new Error('Model credits are insufficient for this request. Presets still work without model credits.');
      throw new Error('The model connection failed. Check the server model configuration and retry; presets remain available.');
    }
    let spec;
    try { spec = validateReport(compileSpecStream(output)); }
    catch { throw new Error('The model did not produce a valid supported report. Try asking for ranked scores, a distribution, missing models, or evidence for one gene and lineage.'); }
    send({ type: 'status', message: `View validated. ${source === 'live' ? 'Retrieving and checking Breadbox data' : 'Loading the recorded Breadbox evidence'}...` });
    send({ type: 'result', result: await resultFor(spec, source, 'model') });
  } catch (error) {
    const safe = /valid supported|snapshot|DepMap query|Live retrieval|size limit|Evidence|Cohort|Model credits/.test(error.message);
    send({ type: 'error', message: safe ? error.message : 'The model connection failed or timed out. Check the server model configuration and retry; presets remain available.' });
  } finally { clearTimeout(timer); busy = false; res.end(); }
});

if (hosted) {
  // Service rewrites reach Express for assets as well as API requests.
  app.get('/', (_req, res) => res.sendFile(path.join(directory, 'public', 'index.html')));
  app.get('/assets/:filename', (req, res) => res.sendFile(req.params.filename, { root: path.join(directory, 'public', 'assets'), dotfiles: 'deny' }));
} else if (process.argv.includes('--production')) {
  app.use(express.static(path.join(directory, 'dist')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: directory, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
app.use((error, _req, res, _next) => res.status(400).json({ error: error.type === 'entity.too.large' ? 'Request too large.' : 'Invalid request.' }));
if (!hosted && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317);
  app.listen(port, '127.0.0.1', () => console.log(`DepMap demo: http://127.0.0.1:${port} (${modelAvailable ? 'AI enabled' : 'presets only'})`));
}
export default app;

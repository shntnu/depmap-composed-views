import React, { createContext, useContext, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { defineRegistry, JSONUIProvider, Renderer } from '@json-render/react';
import { catalog } from '../catalog.mjs';
import './style.css';

const EvidenceContext = createContext(null);
const useEvidence = () => useContext(EvidenceContext);
const observed = (evidence) => evidence.rows.filter((row) => row.status === 'observed' && Number.isFinite(row.dependency)).sort((a, b) => a.dependency - b.dependency);
const modelName = (row) => row.cell_line_name || row.depmap_id;
const formatScore = (value) => Number.isFinite(value) ? value.toFixed(3) : 'No score';
const statusLabel = (status) => ({ observed: 'Observed', null_score: 'Null score', absent_from_dataset: 'Absent from dataset' })[status] || status;

function Coverage() {
  const { counts } = useEvidence();
  const bars = [['observed', 'Observed', 'observed'], ['absent_from_dataset', 'Absent from dataset', 'absent'], ['null_score', 'Null score', 'null']];
  return <section className="coverage" aria-labelledby="coverage-title">
    <div className="section-heading"><h3 id="coverage-title">Cohort coverage</h3><span>{counts.cohort} models accounted for</span></div>
    <div className="coverage-bar" role="img" aria-label={`${counts.observed} observed, ${counts.absent_from_dataset} absent from dataset, ${counts.null_score} null scores`}>
      {bars.map(([key, , color]) => <span key={key} className={color} style={{ width: `${counts.cohort ? counts[key] / counts.cohort * 100 : 0}%` }} />)}
    </div>
    <div className="coverage-legend">{bars.map(([key, label, color]) => <div key={key}><span className={`key ${color}`} /><strong>{counts[key]}</strong><span>{label}</span></div>)}</div>
  </section>;
}

function DependencyPlot({ view, limit }) {
  const evidence = useEvidence();
  const rows = observed(evidence);
  if (!rows.length) return <section className="report-section"><h3>Dependency scores</h3><p>No observed scores are available for this cohort.</p></section>;
  const min = Math.min(-1, rows[0].dependency) - 0.08;
  const max = Math.max(0, rows[rows.length - 1].dependency) + 0.08;
  const left = view === 'ranked' ? 155 : 65;
  const right = 745;
  const x = (value) => left + (value - min) / (max - min) * (right - left);
  const ticks = Array.from({ length: 5 }, (_, index) => min + (max - min) * index / 4);
  const ranked = rows.slice(0, limit);
  const height = view === 'ranked' ? ranked.length * 29 + 75 : 250;
  const plotBottom = height - 42;
  const binCount = 20;
  const bins = Array.from({ length: binCount }, () => 0);
  rows.forEach((row) => { bins[Math.min(binCount - 1, Math.floor((row.dependency - min) / (max - min) * binCount))] += 1; });
  const maxBin = Math.max(...bins, 1);
  return <section className="report-section plot-section">
    <div className="section-heading"><div><h3>{view === 'ranked' ? 'Strongest observed dependencies' : 'Distribution of observed scores'}</h3><p>{view === 'ranked' ? `${ranked.length} of ${rows.length} observed models, ordered by gene effect` : `All ${rows.length} observed models; missing scores excluded`}</p></div><span className="unit">Chronos gene effect</span></div>
    <div className="chart-scroll"><svg viewBox={`0 0 790 ${height}`} role="img" aria-label={view === 'ranked' ? `Ranked Chronos gene effects for ${evidence.query.gene} in ${evidence.query.lineage}. More negative values indicate stronger dependency.` : `Histogram of ${rows.length} observed Chronos gene effects.`}>
      {ticks.map((tick, index) => <g key={index}><line className="gridline" x1={x(tick)} x2={x(tick)} y1="15" y2={plotBottom} /><text className="axis-label" x={x(tick)} y={plotBottom + 24} textAnchor="middle">{tick.toFixed(1)}</text></g>)}
      <line className="zero-line" x1={x(0)} x2={x(0)} y1="15" y2={plotBottom} />
      {view === 'ranked' ? ranked.map((row, index) => <g key={row.depmap_id}>
        <text className="model-label" x={left - 14} y={28 + index * 29} textAnchor="end">{modelName(row).length > 21 ? `${modelName(row).slice(0, 19)}..` : modelName(row)}</text>
        <line className="lollipop-line" x1={x(0)} x2={x(row.dependency)} y1={24 + index * 29} y2={24 + index * 29} />
        <circle className="score-dot" cx={x(row.dependency)} cy={24 + index * 29} r="5.2"><title>{modelName(row)} ({row.depmap_id}): {formatScore(row.dependency)}</title></circle>
        <text className="score-label" x={right + 12} y={28 + index * 29}>{formatScore(row.dependency)}</text>
      </g>) : <>
        {[0, Math.ceil(maxBin / 2), maxBin].map((count, index) => <text key={index} className="axis-label" x={left - 12} y={plotBottom - count / maxBin * 170 + 4} textAnchor="end">{count}</text>)}
        <text className="axis-label" x="17" y="115" transform="rotate(-90,17,115)" textAnchor="middle">Model count</text>
        {bins.map((count, index) => <rect key={index} className="histogram-bar" x={left + index / binCount * (right - left) + 1} y={plotBottom - count / maxBin * 170} width={(right - left) / binCount - 2} height={count / maxBin * 170}><title>{(min + index / binCount * (max - min)).toFixed(2)} to {(min + (index + 1) / binCount * (max - min)).toFixed(2)}: {count} models</title></rect>)}
      </>}
    </svg></div>
    <p className="plot-note">More negative means stronger dependency. Missing scores are never treated as zero.</p>
  </section>;
}

function ModelTable({ filter, limit }) {
  const evidence = useEvidence();
  const [search, setSearch] = useState('');
  const rows = evidence.rows.filter((row) => (filter === 'all' || (filter === 'observed' ? row.status === 'observed' : row.status !== 'observed')) && `${modelName(row)} ${row.depmap_id}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => (a.dependency ?? Infinity) - (b.dependency ?? Infinity) || a.depmap_id.localeCompare(b.depmap_id));
  return <section className="report-section">
    <div className="section-heading"><div><h3>{filter === 'missing' ? 'Models without scores' : filter === 'observed' ? 'Observed model scores' : 'Model records'}</h3><p>Showing {Math.min(rows.length, limit)} of {rows.length} matching models</p></div><label className="table-search"><span className="sr-only">Search model records</span><input type="search" placeholder="Find a model" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
    <div className="table-scroll"><table><thead><tr><th>Model</th><th>DepMap ID</th><th className="numeric">Gene effect</th><th>Coverage</th></tr></thead><tbody>{rows.slice(0, limit).map((row) => <tr key={row.depmap_id}><td>{modelName(row)}</td><td className="muted">{row.depmap_id}</td><td className="numeric">{formatScore(row.dependency)}</td><td><span className={`row-status ${row.status === 'observed' ? '' : 'missing'}`}>{statusLabel(row.status)}</span></td></tr>)}</tbody></table></div>
    {!rows.length && <p className="empty-state">No models match this filter.</p>}
    <p className="small-note">The evidence download contains all {evidence.counts.cohort} cohort records.</p>
  </section>;
}

function Evidence() {
  const evidence = useEvidence();
  return <section className="report-section evidence-section"><h3>Source evidence</h3>
    <div className="evidence-grid"><div><span>Retrieved (UTC)</span><strong>{evidence.provenance.completed_at_utc.replace('T', ' ').slice(0, 19)}</strong></div><div><span>Exact feature</span><strong>{evidence.feature.label} / {evidence.feature.id}</strong></div></div>
    {evidence.provenance.datasets.map((dataset) => <div className="dataset" key={dataset.id}><div><strong>{dataset.given_id}</strong><span>{dataset.name}</span></div><span className="release-tag">{dataset.release || 'Unknown release'}</span></div>)}
    <details><summary>Inspect verification and row fingerprint</summary><dl className="checks">{Object.entries(evidence.checks).map(([key, value]) => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{value === true ? 'Passed' : value === null ? 'Not applicable' : String(value)}</dd></div>)}</dl><p className="hash-label">Row SHA-256 reported by the notebook</p><code className="hash">{evidence.rows_sha256}</code><p className="small-note">{evidence.limits}</p></details>
  </section>;
}

function Interpretation() {
  return <aside className="interpretation"><strong>Reading this result</strong><p>Chronos measures gene dependency in cell lines. A lower score indicates stronger dependency. This ranking alone does not establish lineage selectivity, drug response, or patient benefit.</p></aside>;
}

const { registry } = defineRegistry(catalog, { components: {
  Report: ({ children }) => { const evidence = useEvidence(); return <article className="report"><header className="report-heading"><span>Gene dependency</span><h2>{evidence.query.gene} <span>in {evidence.query.lineage}</span></h2></header>{children}</article>; },
  Coverage: () => <Coverage />,
  DependencyPlot: ({ props }) => <DependencyPlot {...props} />,
  ModelTable: ({ props }) => <ModelTable {...props} />,
  Evidence: () => <Evidence />,
  Interpretation: () => <Interpretation />,
} });

async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || payload.message || `Request failed (${response.status}).`); }
  return response;
}

function ChatPreview({ result }) {
  const spec = result.chatSpec;
  const card = spec.elements[spec.root];
  function renderChild(id) {
    const { type, props } = spec.elements[id];
    if (type === 'Text') return <p key={id} style={{ overflowWrap: 'anywhere' }}>{props.content}</p>;
    if (type === 'Table') return <div className="table-scroll" key={id}><table>{props.caption && <caption>{props.caption}</caption>}<thead><tr>{props.headers.map((header, index) => <th key={index}>{header}</th>)}</tr></thead><tbody>{props.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((value, index) => <td key={index}>{value}</td>)}</tr>)}</tbody></table></div>;
    if (type === 'Chart') return <section key={id}><h3>{props.title || 'Chart'}</h3><p className="small-note">Chart data{props.chart.yLabel ? `: ${props.chart.yLabel}` : ''}</p><div className="table-scroll"><table><thead><tr><th>{props.chart.xLabel || 'Category'}</th>{props.chart.series.map((series, index) => <th className="numeric" key={index}>{series.name}</th>)}</tr></thead><tbody>{props.chart.categories.map((category, rowIndex) => <tr key={rowIndex}><td>{category}</td>{props.chart.series.map((series, index) => <td className="numeric" key={index}>{series.values[rowIndex]}</td>)}</tr>)}</tbody></table></div></section>;
    return <p key={id}>This component is available in the native card below.</p>;
  }
  return <section className="inspector"><div className="inspector-intro"><h2>A portable chat card</h2><p>The same verified results are converted by <code>@json-render/chat</code>. This is a local preview; nothing is sent to a chat service.</p></div>
    <div className="chat-preview"><div className="chat-avatar">D</div><div className="chat-card"><strong>DepMap</strong><h3>{card.props.title}</h3>{card.props.subtitle && <p>{card.props.subtitle}</p>}{card.children.map(renderChild)}</div></div>
    <details><summary>Validated Chat SDK card</summary><pre>{JSON.stringify(result.chatCard, null, 2)}</pre></details><details><summary>Chat specification</summary><pre>{JSON.stringify(result.chatSpec, null, 2)}</pre></details>
  </section>;
}

function App() {
  const [config, setConfig] = useState(null);
  const [gene, setGene] = useState('KRAS');
  const [lineage, setLineage] = useState('Lung');
  const [source, setSource] = useState('snapshot');
  const [prompt, setPrompt] = useState('Show the ten strongest dependencies, a table of observed scores, and source evidence.');
  const [result, setResult] = useState(null);
  const [tab, setTab] = useState('Result');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [stream, setStream] = useState('');

  function accept(next) { setResult(next); setGene(next.evidence.query.gene); setLineage(next.evidence.query.lineage); setTab('Result'); }
  async function runPreset(preset, inputs = { gene, lineage, source }) {
    setBusy(true); setError(''); setStatus(inputs.source === 'live' ? 'Retrieving and verifying Breadbox data...' : 'Loading the verified snapshot...'); setStream('');
    try { const response = await post('/api/preset', { preset, ...inputs }); accept(await response.json()); } catch (err) { setError(err.message); } finally { setBusy(false); setStatus(''); }
  }
  useEffect(() => {
    fetch('/api/config').then((response) => { if (!response.ok) throw new Error('Could not load model configuration.'); return response.json(); }).then(setConfig).catch((err) => setError(err.message));
    runPreset('overview', { gene: 'KRAS', lineage: 'Lung', source: 'snapshot' });
  }, []);

  async function generate(event) {
    event.preventDefault(); setBusy(true); setError(''); setStatus('Composing a view...'); setStream('');
    try {
      const response = await post('/api/generate', { prompt, gene, lineage, source });
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let received = false;
      const handle = (line) => {
        if (!line.startsWith('data:')) return;
        const item = JSON.parse(line.slice(5).trim());
        if (item.type === 'status') setStatus(item.message);
        if (item.type === 'delta') setStream((value) => value + item.text);
        if (item.type === 'result') { accept(item.result); received = true; }
        if (item.type === 'error') throw new Error(item.message);
      };
      while (true) { const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done }); const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(handle); if (done) break; }
      if (buffer.trim()) handle(buffer);
      if (!received) throw new Error('The stream ended before a validated result arrived. Please try again.');
    } catch (err) { setError(err.message); } finally { setBusy(false); setStatus(''); }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.evidence, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${result.evidence.query.gene}-${result.evidence.query.lineage}-evidence.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const presets = [{ id: 'overview', label: 'Overview' }, { id: 'ranked', label: 'Top dependencies' }, { id: 'missing', label: 'Missing scores' }, { id: 'evidence', label: 'Source evidence' }];
  return <div className="app-shell"><header className="masthead"><a href="/" className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><strong>DepMap</strong><span>Composed views</span></a><a className="source-link" href="https://vercel.com/changelog/json-render-and-chat-sdk-agents" target="_blank" rel="noreferrer">Inspired by json-render</a></header>
    <section className="experiment-intro" aria-labelledby="experiment-title">
      <h1 id="experiment-title">Two bets for working with a scientific agent</h1>
      <div className="experiment-story">
        <p>Scientists need to inspect an agent's work and keep exploring after its first answer. <a href="https://github.com/broadinstitute/jx" target="_blank" rel="noreferrer">JX</a>, a project for exploring JUMP Cell Painting data, makes one bet: the notebook itself can be the interface between the scientist and the agent.</p>
        <p>In <a href="https://github.com/broadinstitute/jx/blob/main/PLAN.md#hypothesis" target="_blank" rel="noreferrer">JX's notebook approach</a>, an agent draws on a catalog of reusable analyses, writes Python cells, and runs them in a marimo notebook. Code, explanations, and outputs stay together in a document the scientist can inspect and rerun. Follow-up questions can extend that notebook with more cells.</p>
        <p>This demo explores another bet: the agent can compose a structured interface over reusable analysis functions. With <a href="https://json-render.dev/" target="_blank" rel="noreferrer">json-render</a>, the model describes a view using allowed charts, tables, and evidence components, and the app renders it. Both approaches reuse scientific code; here the model produces a description of the interface, while the existing functions perform the analysis.</p>
        <p>We are trying that second approach with one DepMap query from <a href="https://github.com/broadinstitute/dmx" target="_blank" rel="noreferrer">DMX</a>, JX's sibling notebook catalog. <a href="https://molab.marimo.io/github/shntnu/depmap-composed-views/blob/main/python/notebooks/nb06_verified_dependency_query.py" target="_blank" rel="noreferrer">View the rendered notebook and its recorded results</a>, then try the interface below. The notebook retrieves dependency scores for one gene within one lineage and checks the returned data. In this prototype, you choose that query; the model chooses how to display its results.</p>
        <p className="experiment-scope"><strong>What this tests:</strong> a different way to interact with one notebook's analysis. It is a working prototype, not the full DepMap portal or a system that creates new analyses. New scientific questions still need additional analysis code.</p>
      </div>
    </section>
    <div className="workspace"><aside className="request-panel"><div className="intro"><h2>Try the notebook's query</h2><p>Select a gene and lineage, then describe the charts and tables you want to see.</p></div>
      <form onSubmit={generate}><fieldset disabled={busy}><legend>1. Choose data</legend><p className="field-note">These fields determine which dependency scores are retrieved.</p><div className="query-fields"><label>Gene symbol<input value={gene} onChange={(event) => setGene(event.target.value)} required maxLength={64} /></label><label>Lineage<input value={lineage} onChange={(event) => setLineage(event.target.value)} required maxLength={80} /></label></div><label>Data source<select value={source} onChange={(event) => setSource(event.target.value)}><option value="snapshot">Saved verified snapshot</option><option value="live">Retrieve from Breadbox</option></select></label><p className="field-note">Saved snapshots: KRAS / Lung, EGFR / Lung, and BRAF / Skin. Choose Breadbox for a fresh retrieval.</p></fieldset>
      <fieldset disabled={busy}><legend>2. Choose display</legend><p className="field-note" id="display-guidance">Ask for charts, tables, coverage, or source evidence. Your gene, lineage, and data source stay as selected above.</p><label className="prompt-label">How should these results be displayed?<textarea aria-describedby="display-guidance" rows="5" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={2000} required /></label><div className="suggestions"><button type="button" onClick={() => setPrompt('Show the distribution of observed scores and the ten strongest dependencies.')}>Show a distribution</button><button type="button" onClick={() => setPrompt('Focus on models with missing scores and show the source evidence.')}>Inspect missingness</button></div><button className="primary-button" type="submit" disabled={!config?.modelAvailable || busy}>{busy ? 'Working...' : 'Compose view'}</button></fieldset></form>
      <p className="model-status">{config ? config.modelAvailable ? <>Model connected: <span>{config.model}</span></> : 'No model key configured. Try a preset below.' : 'Checking model connection...'}</p>
      <div className="preset-section"><h2>Or try a preset</h2><p>Use the selected data with a fixed layout. These buttons ignore the display instructions.</p><div className="preset-buttons">{presets.map((preset) => <button key={preset.id} type="button" onClick={() => runPreset(preset.id)} disabled={busy || !gene.trim() || !lineage.trim()}>{preset.label}</button>)}</div></div>
      <details className="how-it-works"><summary>What changes from a notebook?</summary><p>The notebook still retrieves and verifies the data. The model chooses a layout from a small catalog of charts, tables, coverage, and evidence.</p><p>The UI specification contains no scientific measurements. Each component reads the same trusted result.</p><p>This makes routine exploration conversational. New analyses still need new, tested computational helpers.</p></details>
    </aside><main className="result-panel" aria-busy={busy}>
      {error && <div className="error-banner" role="alert"><strong>The request could not be completed.</strong><p>{error}</p>{result && <p>The previous result remains below.</p>}</div>}
      {busy && <div className="progress-banner" role="status"><span className="busy-dot" />{status}</div>}
      {stream && <details className="stream-details"><summary>{busy ? 'View the specification as it arrives' : 'Inspect the model output'}</summary><pre>{stream}</pre></details>}
      {result ? <>
        <div className="result-toolbar"><div className="result-meta"><span className={`mode-tag ${result.mode}`}>{result.mode === 'model' ? 'Model-composed layout' : 'Preset layout'}</span><span>{result.source === 'live' ? 'Fresh Breadbox retrieval' : 'Saved evidence'}</span></div><button type="button" className="download-button" onClick={download}>Download evidence</button></div>
        <div className="tabs" role="tablist" aria-label="Result format">{['Result', 'UI specification', 'Chat card'].map((name) => <button type="button" role="tab" aria-selected={tab === name} id={`tab-${name.replaceAll(' ', '-')}`} aria-controls="result-content" key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}</div>
        <div className="release-warning" role="note">{result.evidence.warnings.length ? <><strong>Release drift is visible</strong><p>{result.evidence.warnings.join(' ')}</p></> : <p>Source releases match the catalog baseline.</p>}</div>
        <div id="result-content" role="tabpanel" aria-labelledby={`tab-${tab.replaceAll(' ', '-')}`}>
          {tab === 'Result' && <EvidenceContext.Provider value={result.evidence}><JSONUIProvider registry={registry} initialState={{}}><Renderer spec={result.spec} registry={registry} /></JSONUIProvider></EvidenceContext.Provider>}
          {tab === 'UI specification' && <section className="inspector"><div className="inspector-intro"><h2>The view, as data</h2><p>{result.mode === 'model' ? 'The model generated this validated component tree.' : 'This fixed preset uses the same validated component catalog.'} Component names, order, and display options determine the view. Measurements come from the notebook result.</p></div><pre>{JSON.stringify(result.spec, null, 2)}</pre></section>}
          {tab === 'Chat card' && <ChatPreview result={result} />}
        </div><footer className="result-footer">Built from nb06_verified_dependency_query.py. Public DepMap data; no patient or drug-response inference.</footer>
      </> : !busy && <div className="empty-state">Choose a preset or compose a view to begin.</div>}
    </main></div>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);

import test from 'node:test';
import assert from 'node:assert/strict';
import { presetSpec } from '../catalog.mjs';

const originalFetch = globalThis.fetch;
const environmentKeys = ['VERCEL', 'AI_PROVIDER', 'AI_MODEL', 'ANTHROPIC_API_KEY', 'AI_GATEWAY_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL'];
let importId = 0;

async function withApp(environment, fetchProvider, run) {
  const previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  for (const key of environmentKeys) delete process.env[key];
  Object.assign(process.env, { VERCEL: '1', ...environment });
  globalThis.fetch = fetchProvider;
  let server;
  try {
    const { default: app } = await import(`../server.mjs?provider-test=${importId++}`);
    server = await new Promise((resolve, reject) => {
      const value = app.listen(0, '127.0.0.1', () => resolve(value));
      value.once('error', reject);
    });
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (server) await new Promise(resolve => server.close(resolve));
  }
}

const request = { prompt: 'Show KRAS in Lung with coverage and source evidence.', gene: 'KRAS', lineage: 'Lung', source: 'snapshot' };
const post = base => originalFetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
const unexpectedFetch = async () => { assert.fail('No provider request should be sent.'); };

function successfulStream(spec = presetSpec('evidence'), model = 'claude-haiku-5-5') {
  const text = Object.entries(spec).map(([key, value]) => JSON.stringify({ op: 'add', path: `/${key}`, value })).join('\n');
  const events = [
    { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 100 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('direct Anthropic composition uses the selected key and Haiku 5.5 without routing through Gateway', async () => {
  const requests = [];
  const mockProvider = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body), headers: new Headers(options.headers) });
    return successfulStream();
  };
  await withApp({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test-anthropic-key', AI_GATEWAY_API_KEY: 'unused-gateway-key', OPENROUTER_API_KEY: 'unused-openrouter-key' }, mockProvider, async base => {
    const config = await (await originalFetch(`${base}/api/config`)).json();
    assert.equal(config.provider, 'anthropic');
    assert.equal(config.model, 'claude-haiku-5-5');
    assert.equal(config.modelAvailable, true);
    assert.ok(!JSON.stringify(config).includes('test-anthropic-key'));
    const response = await post(base);
    const events = (await response.text()).split('\n\n').filter(Boolean).map(line => JSON.parse(line.slice(6)));
    const result = events.find(event => event.type === 'result')?.result;
    assert.ok(result, JSON.stringify(events));
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.evidence.counts.observed, 126);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(requests[0].headers.get('x-api-key'), 'test-anthropic-key');
    assert.equal(requests[0].body.model, 'claude-haiku-5-5');
    assert.equal(requests[0].body.max_tokens, 1500);
    assert.deepEqual(requests[0].body.thinking, { type: 'disabled' });
    assert.equal(requests[0].body.output_config.effort, 'medium');
  });
});

test('an explicitly selected Anthropic provider stays unavailable when its key is missing', async () => {
  await withApp({ AI_PROVIDER: 'anthropic', AI_GATEWAY_API_KEY: 'unused-gateway-key', OPENROUTER_API_KEY: 'unused-openrouter-key' }, unexpectedFetch, async base => {
    const config = await (await originalFetch(`${base}/api/config`)).json();
    assert.equal(config.provider, 'anthropic');
    assert.equal(config.modelAvailable, false);
    const response = await post(base);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /ANTHROPIC_API_KEY/);
  });
});

test('Anthropic authentication failures produce an error without another provider request', async () => {
  const requests = [];
  await withApp({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'rejected-test-key', AI_GATEWAY_API_KEY: 'unused-gateway-key', OPENROUTER_API_KEY: 'unused-openrouter-key' }, async url => {
    requests.push(String(url));
    return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } }, { status: 401 });
  }, async base => {
    const response = await post(base);
    const events = (await response.text()).split('\n\n').filter(Boolean).map(line => JSON.parse(line.slice(6)));
    assert.ok(events.some(event => event.type === 'error'));
    assert.ok(!events.some(event => event.type === 'result'));
    assert.deepEqual(requests, ['https://api.anthropic.com/v1/messages']);
  });
});

test('omitting AI_PROVIDER preserves the hosted Gateway default', async () => {
  await withApp({}, unexpectedFetch, async base => {
    const config = await (await originalFetch(`${base}/api/config`)).json();
    assert.equal(config.provider, 'gateway');
    assert.equal(config.model, 'anthropic/claude-haiku-4.5');
    assert.equal(config.modelAvailable, true);
  });
});

test('explicit OpenRouter selection preserves its model override', async () => {
  await withApp({ AI_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'test-openrouter-key', OPENROUTER_MODEL: 'anthropic/claude-haiku-4.5' }, unexpectedFetch, async base => {
    const config = await (await originalFetch(`${base}/api/config`)).json();
    assert.equal(config.provider, 'openrouter');
    assert.equal(config.model, 'anthropic/claude-haiku-4.5');
    assert.equal(config.modelAvailable, true);
  });
});


test('display instructions cannot change the selected gene, lineage or data source', async () => {
  const requests = [];
  const selected = { gene: 'KRAS', lineage: 'Lung' };
  await withApp({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test-anthropic-key' }, async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return successfulStream(presetSpec('overview', 'BRAF', 'Skin'));
  }, async base => {
    const response = await originalFetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...selected, source: 'snapshot', prompt: 'Show BRAF in Skin using live data as a distribution.' }) });
    const events = (await response.text()).split('\n\n').filter(Boolean).map(line => JSON.parse(line.slice(6)));
    const result = events.find(event => event.type === 'result')?.result;
    assert.ok(result, JSON.stringify(events));
    assert.deepEqual(result.spec.elements[result.spec.root].props, selected);
    assert.equal(result.evidence.query.gene, selected.gene);
    assert.equal(result.evidence.query.lineage, selected.lineage);
    assert.equal(result.evidence.counts.observed, 126);
    assert.equal(result.spec.elements.plot.props.view, 'distribution');
    assert.equal(result.source, 'snapshot');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages');
    assert.match(JSON.stringify(requests[0].body.system), /fields are authoritative and cannot be changed by display instructions/);
    assert.match(JSON.stringify(requests[0].body.messages), /Selected data \(fixed\): gene=KRAS, lineage=Lung, source=snapshot/);
    assert.match(JSON.stringify(requests[0].body.messages), /Display instructions \(presentation only\)/);
  });
});


test('configured Sonnet 5.5 composes a report with its supported minimum thinking setting', async () => {
  const requests = [];
  await withApp({ AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_KEY: 'test-anthropic-key' }, async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return successfulStream(presetSpec('evidence'), 'claude-sonnet-5-5');
  }, async base => {
    const config = await (await originalFetch(`${base}/api/config`)).json();
    assert.equal(config.model, 'claude-sonnet-5-5');
    const response = await post(base);
    const events = (await response.text()).split('\n\n').filter(Boolean).map(line => JSON.parse(line.slice(6)));
    const result = events.find(event => event.type === 'result')?.result;
    assert.ok(result, JSON.stringify(events));
    assert.equal(result.model, 'claude-sonnet-5-5');
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.evidence.counts.observed, 126);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(requests[0].body.model, 'claude-sonnet-5-5');
    assert.equal(requests[0].body.max_tokens, 1500);
    assert.deepEqual(requests[0].body.thinking, { type: 'between_tools' });
    assert.equal(requests[0].body.output_config.effort, 'medium');
    assert.equal(requests[0].body.tools, undefined);
  });
});

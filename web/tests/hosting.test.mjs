import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

process.env.VERCEL = '1';
const { default: app } = await import('../server.mjs');
const evidence = JSON.parse(readFileSync(new URL('../data/kras-lung.json', import.meta.url)));

test('hosted page serves the actual built script and stylesheet', async () => {
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    const html = await page.text();
    const script = html.match(/src="([^"]+\.js)"/)[1];
    const stylesheet = html.match(/href="([^"]+\.css)"/)[1];
    for (const [asset, type] of [[script, /javascript/], [stylesheet, /text\/css/]]) {
      const response = await fetch(new URL(asset, base));
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), type);
      assert.ok((await response.text()).length > 100);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('hosted API preserves same-origin checks and uses the private Python service', async () => {
  let serviceCalls = 0;
  const service = createServer((req, res) => {
    serviceCalls++;
    assert.equal(req.url, '/query');
    assert.equal(req.method, 'POST');
    let body = '';
    req.on('data', data => { body += data; });
    req.on('end', () => {
      assert.deepEqual(JSON.parse(body), { gene: 'KRAS', lineage: 'Lung' });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(evidence));
    });
  });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  process.env.DEPMAP_SERVICE_URL = `http://127.0.0.1:${service.address().port}/`;
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const wrongOrigin = await fetch(`${base}/api/config`, { headers: { Origin: 'https://unrelated.example' } });
    assert.equal(wrongOrigin.status, 403);
    const response = await fetch(`${base}/api/preset`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base.replace('http:', 'https:') }, body: JSON.stringify({ preset: 'ranked', gene: 'KRAS', lineage: 'Lung', source: 'live' }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.source, 'live');
    assert.equal(result.evidence.counts.observed, 126);
    assert.equal(serviceCalls, 1);
    delete process.env.DEPMAP_SERVICE_URL;
    const missing = await fetch(`${base}/api/preset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preset: 'ranked', gene: 'KRAS', lineage: 'Lung', source: 'live' }) });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /service binding is missing/);
  } finally {
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => service.close(resolve))]);
  }
});

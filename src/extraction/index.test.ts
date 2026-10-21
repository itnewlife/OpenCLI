import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { learnExtraction, runExtraction } from './index.js';

const schema = { type: 'object', additionalProperties: false, required: ['name', 'price'], properties: { name: { type: 'string' }, price: { type: ['number', 'null'] } } };
const rule = { version: 1, scope: { origin: 'https://shop.example', pathPrefix: '/products' }, fields: {
  name: { source: 'dom', selector: 'h1', read: 'text' }, price: { source: 'dom', selector: '[itemprop="price"]', read: 'attribute', attribute: 'content' },
} };
const page = (name: string, price: string, changed = false) => ({
  version: 1, url: `https://shop.example/products/${name}`, title: name, observedAt: '2026-10-21T00:00:00Z',
  html: `<html><body>${changed ? '<section>' : ''}<h1>${name}</h1>${changed ? '</section>' : ''}<meta itemprop="price" content="${price}"></body></html>`,
});
const samples = (changed = false) => [
  { page: page('A', '10', changed), expected: { name: 'A', price: 10 } },
  { page: page('B', '20', changed), expected: { name: 'B', price: 20 } },
];
let cacheDir: string;
beforeEach(async () => { cacheDir = await mkdtemp(join(tmpdir(), 'opencli-extraction-')); });
afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });
const options = () => ({ cacheDir, schema, name: 'product', context: 'test-account:US:en', page: page('C', '30') });

describe('learned extraction lifecycle', () => {
  it('learns once, caches only rules, and reads new values without calling the model', async () => {
    const generator = vi.fn().mockResolvedValue(rule);
    const learned = await learnExtraction({ ...options(), samples: samples(), generator });
    expect(learned.cache).toMatchObject({ state: 'learned', revision: 1 });
    expect(generator).toHaveBeenCalledTimes(1);
    const generatedRequest = generator.mock.calls[0][0];
    expect(generatedRequest.samples[0]).not.toHaveProperty('expected');
    const result = await runExtraction({ ...options(), page: page('D', '40') });
    expect(result.data).toEqual({ name: 'D', price: 40 });
    expect(result.cache.state).toBe('hit');
    expect(generator).toHaveBeenCalledTimes(1);
    const stored = await readFile(join(cacheDir, `${result.cache.key}.json`), 'utf8');
    expect(stored).not.toContain('<html>');
    expect(stored).not.toContain('test-account');
  });

  it('requires distinct checked samples and rejects plausible but wrong outputs', async () => {
    await expect(learnExtraction({ ...options(), samples: [samples()[0], samples()[0]], proposal: rule })).rejects.toThrow(/distinct/);
    const incorrect = samples();
    incorrect[1].expected.price = 19;
    await expect(learnExtraction({ ...options(), samples: incorrect, proposal: rule })).rejects.toThrow(/independently checked/);
    expect((await readdir(cacheDir)).filter(name => name.endsWith('.json'))).toEqual([]);
  });

  it('isolates names, schemas and account/view context', async () => {
    await learnExtraction({ ...options(), samples: samples(), proposal: rule });
    await expect(runExtraction({ ...options(), context: 'other-account' })).rejects.toThrow(/No learned/);
    await expect(runExtraction({ ...options(), name: 'other-task' })).rejects.toThrow(/No learned/);
  });

  it('marks a changed template invalid without making any implicit repair request', async () => {
    await learnExtraction({ ...options(), samples: samples(), proposal: rule });
    const result = await runExtraction({ ...options(), page: page('C', '30', true) });
    expect(result.status).toBe('invalid');
    expect(result.cache).toMatchObject({ state: 'invalid', revision: 1 });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'template' }));
  });

  it('repairs once only after validating the changed template and retains the prior version', async () => {
    await learnExtraction({ ...options(), samples: samples(), proposal: rule });
    const generator = vi.fn().mockResolvedValue(rule);
    const result = await runExtraction({ ...options(), page: page('C', '30', true), repair: { samples: samples(true), generator } });
    expect(result.cache).toMatchObject({ state: 'repaired', revision: 2 });
    expect(generator).toHaveBeenCalledTimes(1);
    expect(generator.mock.calls[0][0]).toHaveProperty('previousRule');
    const previous = JSON.parse(await readFile(join(cacheDir, `${result.cache.key}.previous.json`), 'utf8'));
    expect(previous.revision).toBe(1);
  });

  it('reuses explicit template regions across changing recommendations and rejects changes within them', async () => {
    const withRegion = (name: string, price: string, extra = '') => ({ ...page(name, price), html: `<html><body><main><h1>${name}</h1><meta itemprop="price" content="${price}"></main>${extra}</body></html>` });
    const scoped = { ...rule, template: { selectors: ['main'] } };
    await learnExtraction({ ...options(), page: withRegion('C', '30'), samples: [
      { page: withRegion('A', '10'), expected: { name: 'A', price: 10 } },
      { page: withRegion('B', '20', '<aside><article>Previously viewed</article></aside>'), expected: { name: 'B', price: 20 } },
    ], proposal: scoped });
    const fresh = withRegion('D', '40', '<aside><article>First</article><article>Second</article></aside>');
    const result = await runExtraction({ ...options(), page: fresh });
    expect(result.cache.state).toBe('hit');
    expect(result.status).toBe('verified');
    expect(result.data).toEqual({ name: 'D', price: 40 });
    const changed = { ...fresh, html: fresh.html.replace('<h1>D</h1>', '<section><h1>D</h1></section>') };
    expect((await runExtraction({ ...options(), page: changed })).cache.state).toBe('invalid');
  });

  it('does not let a repair widen the validated scope', async () => {
    await learnExtraction({ ...options(), samples: samples(), proposal: rule });
    const widened = { ...rule, scope: { ...rule.scope, pathPrefix: '/' } };
    await expect(runExtraction({ ...options(), page: page('C', '30', true), repair: { samples: samples(true), proposal: widened } })).rejects.toThrow(/cannot change/);
  });

  it.each(['repair', 'learn'])('rejects a stale %s proposal when another writer commits during generation', async mode => {
    const initial = await learnExtraction({ ...options(), samples: samples(), proposal: rule });
    let release!: (proposal: unknown) => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const generator = vi.fn(() => {
      started();
      return new Promise<unknown>(resolve => { release = resolve; });
    });
    const pending = mode === 'repair'
      ? runExtraction({ ...options(), page: page('C', '30', true), repair: { samples: samples(true), generator } })
      : learnExtraction({ ...options(), samples: samples(), generator });
    await waiting;
    const narrowed = { ...rule, scope: { ...rule.scope, pathPrefix: '/products/' } };
    const concurrent = await learnExtraction({ ...options(), samples: samples(), proposal: narrowed });
    release(rule);
    await expect(pending).rejects.toThrow(/changed while validating/);
    const saved = JSON.parse(await readFile(join(cacheDir, `${initial.cache.key}.json`), 'utf8'));
    expect(saved.revision).toBe(concurrent.cache.revision);
    expect(saved.rule.scope.pathPrefix).toBe('/products/');
    expect(generator).toHaveBeenCalledTimes(1);
  });

  it('keeps the last validated cache when repair validation fails', async () => {
    const initial = await learnExtraction({ ...options(), samples: samples(), proposal: rule });
    const wrong = { ...rule, fields: { ...rule.fields, price: { source: 'dom', selector: 'h1', read: 'text' } } };
    await expect(runExtraction({ ...options(), page: page('C', '30', true), repair: { samples: samples(true), proposal: wrong } })).rejects.toThrow(/failed sample/);
    const cached = JSON.parse(await readFile(join(cacheDir, `${initial.cache.key}.json`), 'utf8'));
    expect(cached.revision).toBe(1);
  });
});

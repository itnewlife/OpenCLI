import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __test__ as learn } from './learn.js';
import { __test__ as run } from './run.js';
import { __test__ as capture } from './capture.js';

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'learned-extract-adapter-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const snapshot = (name, price) => ({ version: 1, url: `https://shop.example/products/${name}`, title: name, observedAt: '2026-10-21T00:00:00Z', html: `<html><body><h1>${name}</h1><meta itemprop="price" content="${price}"></body></html>` });

async function files() {
  const schema = { type: 'object', additionalProperties: false, required: ['name', 'price'], properties: { name: { type: 'string' }, price: { type: ['number', 'null'] } } };
  const rule = { version: 1, scope: { origin: 'https://shop.example', pathPrefix: '/products' }, fields: {
    name: { source: 'dom', selector: 'h1', read: 'text' }, price: { source: 'dom', selector: '[itemprop="price"]', read: 'attribute', attribute: 'content' },
  } };
  const values = {
    'schema.json': schema, 'rule.json': rule,
    'a.json': snapshot('A', '1'), 'b.json': snapshot('B', '2'), 'current.json': snapshot('C', '3'),
    'samples.json': [{ snapshot: 'a.json', expected: { name: 'A', price: 1 } }, { snapshot: 'b.json', expected: { name: 'B', price: 2 } }],
  };
  await Promise.all(Object.entries(values).map(([name, value]) => writeFile(join(dir, name), JSON.stringify(value))));
  return { name: 'product', context: 'account-one:US', schema: join(dir, 'schema.json'), snapshot: join(dir, 'current.json'), 'cache-dir': join(dir, 'cache'), samples: join(dir, 'samples.json'), rule: join(dir, 'rule.json') };
}

describe('learned-extract adapters', () => {
  it('uses actual exported adapters for learn and offline run with no browser or provider', async () => {
    const args = await files();
    const learned = await learn.command.func(args);
    expect(learned.cache.state).toBe('learned');
    const result = await run.command.func(args);
    expect(result.data).toEqual({ name: 'C', price: 3 });
    expect(result.cache.state).toBe('hit');
    expect(learn.command.browser).toBe(false);
    expect(run.command.browser).toBe(false);
  });

  it('captures through the fixed expression and never overwrites an existing snapshot', async () => {
    const dom = new JSDOM('<html><body><h1>A</h1><input value="private"><div contenteditable>Private draft</div><div contenteditable="plaintext-only">Plaintext draft</div><script>throw new Error("not executed")</script></body></html>', { url: 'https://shop.example/products/A', runScripts: 'outside-only' });
    try {
      const page = { goto: vi.fn().mockResolvedValue(undefined), wait: vi.fn(), evaluate: expression => Promise.resolve(dom.window.eval(expression)) };
      const args = { url: 'https://shop.example/products/A', output: join(dir, 'captured.json'), wait: 0 };
      const result = await capture.command.func(page, args);
      expect(result.status).toBe('captured');
      const saved = JSON.parse(await readFile(args.output, 'utf8'));
      expect(saved.html).toContain('<h1>A</h1>');
      expect(saved.html).not.toContain('private');
      expect(saved.html).not.toContain('Private draft');
      expect(saved.html).not.toContain('Plaintext draft');
      await expect(capture.command.func(page, args)).rejects.toThrow(/EEXIST/);
    } finally { dom.window.close(); }
  });

  it('initializes a blank browser lease before navigating on older bridge extensions', async () => {
    const dom = new JSDOM('<html><body><h1>A</h1></body></html>', { url: 'https://shop.example/products/A', runScripts: 'outside-only' });
    let initialized = false;
    try {
      const page = {
        goto: vi.fn(async () => { if (!initialized) throw new Error('Navigation rejected.'); }),
        wait: vi.fn(),
        evaluate: vi.fn(async expression => {
          if (expression === 'void 0') initialized = true;
          return dom.window.eval(expression);
        }),
      };
      const result = await capture.command.func(page, { url: 'https://shop.example/products/A', output: join(dir, 'legacy-bridge.json'), wait: 0 });
      expect(result.status).toBe('captured');
      expect(page.goto).toHaveBeenCalledTimes(1);
      expect(page.evaluate.mock.calls[0][0]).toBe('void 0');
    } finally { dom.window.close(); }
  });

  it('rejects bad capture input before any browser navigation', async () => {
    const page = { goto: vi.fn(), evaluate: vi.fn() };
    await expect(capture.command.func(page, { url: 'https://shop.example', output: 'unused', wait: 100 })).rejects.toThrow(/wait/);
    expect(page.goto).not.toHaveBeenCalled();
  });
});

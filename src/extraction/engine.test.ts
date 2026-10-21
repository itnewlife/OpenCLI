import { describe, expect, it } from 'vitest';
import { extractWithRule } from './engine.js';
import { parseRule, parseSchema } from './validation.js';
import { sanitizeSnapshot } from './snapshot.js';

const schema = { type: 'object', additionalProperties: false, required: ['name', 'price'], properties: {
  name: { type: 'string' }, price: { type: ['number', 'null'] }, weight: { type: ['number', 'null'] },
} };
const rule = { version: 1, scope: { origin: 'https://shop.example', pathPrefix: '/products' }, fields: {
  name: { source: 'dom', selector: 'h1', read: 'text' },
  price: { source: 'dom', selector: '[itemprop="price"]', read: 'attribute', attribute: 'content' },
  weight: { source: 'dom', selector: '[data-weight]', read: 'attribute', attribute: 'data-weight' },
} };
const page = (html: string, url = 'https://shop.example/products/one') => ({ version: 1, url, title: 'Product', observedAt: '2026-10-21T00:00:00Z', html: `<html><body>${html}</body></html>` });

describe('validated extraction rules', () => {
  it('reads live evidence and leaves optional absent fields null', () => {
    const result = extractWithRule(page('<h1>Brush</h1><meta itemprop="price" content="12.50">'), schema, rule);
    expect(result.status).toBe('partial');
    expect(result.data).toEqual({ name: 'Brush', price: 12.5, weight: null });
    expect(result.evidence.price).toMatchObject({ raw: '12.50', value: 12.5, matches: 1, status: 'observed' });
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('never fills a missing required nullable number with zero', () => {
    const result = extractWithRule(page('<h1>Brush</h1>'), schema, rule);
    expect(result.status).toBe('invalid');
    expect(result.data.price).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ field: 'price', code: 'missing' }));
  });

  it('distinguishes observed zero from missing and rejects unit-bearing numbers', () => {
    expect(extractWithRule(page('<h1>Brush</h1><meta itemprop="price" content="0">'), schema, rule).data.price).toBe(0);
    const result = extractWithRule(page('<h1>Brush</h1><meta itemprop="price" content="$12.50">'), schema, rule);
    expect(result.status).toBe('invalid');
    expect(result.evidence.price.raw).toBe('$12.50');
    expect(result.data.price).toBeNull();
  });

  it('rejects ambiguous selectors instead of choosing an arbitrary product', () => {
    const result = extractWithRule(page('<h1>A</h1><h1>B</h1><meta itemprop="price" content="10">'), schema, rule);
    expect(result.status).toBe('invalid');
    expect(result.evidence.name).toMatchObject({ status: 'ambiguous', matches: 2, value: null });
  });

  it('rejects sources outside the allowed URL path segment', () => {
    const result = extractWithRule(page('<h1>Brush</h1>', 'https://shop.example/products-evil/one'), schema, rule);
    expect(result.status).toBe('invalid');
    expect(result.issues[0].code).toBe('scope');
    expect(result.data).toEqual({});
  });

  it('reads JSON-LD using bounded data paths without executing script', () => {
    const structuredRule = { ...rule, fields: { name: { source: 'jsonld', path: 'name' }, price: { source: 'jsonld', path: 'offers.price' } } };
    const result = extractWithRule(page('<script type="application/ld+json">{"name":"Brush","offers":{"price":"12.50"}}</script>'), schema, structuredRule);
    expect(result.data.price).toBe(12.5);
    expect(result.evidence.price.locator).toBe('jsonld:offers.price');
  });

  it('rejects executable or literal-value rules, unsafe paths, and unknown schema features', () => {
    const parsed = parseSchema(schema);
    expect(() => parseRule({ ...rule, code: 'fetch("https://example.com")' }, parsed)).toThrow(/Unsupported rule key/);
    expect(() => parseRule({ ...rule, fields: { name: { source: 'literal', value: 'Brush' } } }, parsed)).toThrow();
    expect(() => parseRule({ ...rule, fields: { name: { source: 'jsonld', path: 'constructor.prototype' }, price: rule.fields.price } }, parsed)).toThrow(/Invalid JSON-LD path/);
    expect(() => parseSchema({ ...schema, $ref: 'remote' })).toThrow(/Unsupported schema key/);
  });

  it('does not read form or script content through DOM selectors', () => {
    const result = extractWithRule(page('<form><h1>Secret</h1></form><meta itemprop="price" content="12">'), schema, rule);
    expect(result.evidence.name.status).toBe('invalid');
  });

  it('ignores text-value changes in template identity but detects structural changes', () => {
    const first = extractWithRule(page('<h1>A</h1><meta itemprop="price" content="1">'), schema, rule);
    const second = extractWithRule(page('<h1>B</h1><meta itemprop="price" content="2">'), schema, rule);
    const changed = extractWithRule(page('<section><h1>B</h1></section><meta itemprop="price" content="2">'), schema, rule);
    expect(second.templateHash).toBe(first.templateHash);
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(changed.templateHash).not.toBe(first.templateHash);
  });

  it('distinguishes template parent-child relationships with the same tag order', () => {
    const first = extractWithRule(page('<main><section><h1>A</h1></section><p>Summary</p></main><meta itemprop="price" content="1">'), schema, rule);
    const reparented = extractWithRule(page('<main><section><h1>A</h1><p>Summary</p></section></main><meta itemprop="price" content="1">'), schema, rule);
    expect(reparented.templateHash).not.toBe(first.templateHash);
  });

  it('validates explicit template regions while ignoring unrelated recommendation modules', () => {
    const scopedRule = { ...rule, template: { selectors: ['main'] } };
    const first = extractWithRule(page('<main><h1>A</h1><meta itemprop="price" content="1"></main>'), schema, scopedRule);
    const extra = extractWithRule(page('<main><h1>B</h1><meta itemprop="price" content="2"></main><aside><article>Recently viewed</article></aside>'), schema, scopedRule);
    const changed = extractWithRule(page('<main><section><h1>B</h1></section><meta itemprop="price" content="2"></main>'), schema, scopedRule);
    expect(first.status).toBe('partial');
    expect(extra.templateHash).toBe(first.templateHash);
    expect(extra.data.price).toBe(2);
    expect(changed.templateHash).not.toBe(first.templateHash);
  });

  it('rejects missing or duplicate template anchors and sources outside their regions', () => {
    const scopedRule = { ...rule, template: { selectors: ['main'] } };
    for (const html of [
      '<h1>A</h1><meta itemprop="price" content="1">',
      '<main><h1>A</h1><meta itemprop="price" content="1"></main><main></main>',
      '<main><h1>A</h1></main><meta itemprop="price" content="1">',
    ]) {
      const result = extractWithRule(page(html), schema, scopedRule);
      expect(result.status).toBe('invalid');
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'template' }));
    }
  });

  it('rejects duplicate or unsupported template selector definitions', () => {
    const parsed = parseSchema(schema);
    for (const template of [{ selectors: [] }, { selectors: ['main', 'main'] }, { selectors: [':has(h1)'] }, { selectors: ['main'], ignored: true }]) {
      expect(() => parseRule({ ...rule, template }, parsed)).toThrow();
    }
  });

  it.each(['', 'true', 'TRUE', 'plaintext-only'])('removes editable draft content for contenteditable=%j', attribute => {
    const input = page(`<div contenteditable="${attribute}"><h1>Private draft</h1></div><meta itemprop="price" content="1">`);
    expect(sanitizeSnapshot(input).html).not.toContain('Private draft');
    expect(extractWithRule(input, schema, rule).evidence.name.status).toBe('invalid');
  });

  it('preserves explicitly non-editable content', () => {
    const input = page('<div contenteditable="false"><h1>Public title</h1></div><meta itemprop="price" content="1">');
    expect(sanitizeSnapshot(input).html).toContain('Public title');
    expect(extractWithRule(input, schema, rule).data.name).toBe('Public title');
  });

  it('sanitizes snapshot forms, executable scripts, event handlers and credential-like attributes', () => {
    const result = sanitizeSnapshot(page('<input value="private"><form>hidden</form><h1 data-id="x" data-token="secret" onclick="alert(1)">A</h1><script>alert(1)</script><script type="application/ld+json">{"name":"A"}</script>'));
    expect(result.html).not.toContain('secret');
    expect(result.html).not.toContain('private');
    expect(result.html).not.toContain('alert');
    expect(result.html).toContain('data-id="x"');
    expect(result.html).toContain('application/ld+json');
  });
});

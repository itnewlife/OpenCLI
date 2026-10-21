import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractWithRule } from './engine.js';
import { learnExtraction, runExtraction } from './index.js';
import { parseRule, parseSchema } from './validation.js';

const schema = { type: 'object', additionalProperties: false, required: ['title', 'body'], properties: {
  title: { type: 'string' }, body: { type: 'string' },
} };
const titleSelector = '[data-hook="reviewTitle"]';
const bodySelector = '[data-hook="reviewRichContentContainer"]';
const rule = {
  version: 1,
  scope: { origin: 'https://shop.example', pathPrefix: '/reviews' },
  template: { selectors: [titleSelector], textRegions: [{ selector: bodySelector, within: '[data-hook="review"]' }] },
  fields: {
    title: { source: 'dom', selector: titleSelector, read: 'text' },
    body: { source: 'dom', selector: bodySelector, read: 'text' },
  },
};
const page = (body: string, title = 'Works') => ({
  version: 1, url: 'https://shop.example/reviews/one', title, observedAt: '2026-10-21T00:00:00Z',
  html: `<html><body><article data-hook="review"><h5 data-hook="reviewTitle">${title}</h5><div data-hook="reviewRichContentContainer">${body}</div></article></body></html>`,
});

describe('explicit text template regions', () => {
  it('accepts changing paragraphs and inline formatting while preserving structural region checks', () => {
    const first = extractWithRule(page('<p><span>First.</span></p>'), schema, rule);
    const longer = extractWithRule(page('<p>Second.</p><p><strong>More</strong> detail.<br>End.</p>'), schema, rule);
    expect(first.status).toBe('verified');
    expect(longer.status).toBe('verified');
    expect(longer.templateHash).toBe(first.templateHash);
    expect(longer.data.body).toBe('Second.More detail.End.');
    const moved = page('<p>Second.</p>');
    moved.html = moved.html.replace('<div data-hook="reviewRichContentContainer">', '<section><div data-hook="reviewRichContentContainer">').replace('</div></article>', '</div></section></article>');
    expect(extractWithRule(moved, schema, rule).templateHash).not.toBe(first.templateHash);
    const changed = { ...page('<p>Second.</p>'), html: page('<p>Second.</p>').html.replaceAll('h5', 'h4') };
    expect(extractWithRule(changed, schema, rule).templateHash).not.toBe(first.templateHash);
  });

  it('rejects missing, duplicate, moved-out and overlapping text anchors', () => {
    const original = page('<p>First.</p>');
    const cases = [
      original.html.replace('reviewRichContentContainer', 'missing'),
      original.html.replace('</article>', '<div data-hook="reviewRichContentContainer">Other</div></article>'),
      original.html.replace('data-hook="review"', 'data-hook="missing"'),
      original.html.replace('</body>', '<article data-hook="review"></article></body>'),
      '<html><body><article data-hook="review"><h5 data-hook="reviewTitle">Works</h5></article><div data-hook="reviewRichContentContainer">Outside</div></body></html>',
      '<html><body><h5 data-hook="reviewTitle">Unrelated</h5><article data-hook="review"><div data-hook="reviewRichContentContainer">First.</div></article></body></html>',
    ];
    for (const html of cases) {
      const result = extractWithRule({ ...original, html }, schema, rule);
      expect(result.status).toBe('invalid');
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'template' }));
    }
    const overlapping = { ...rule, template: { ...rule.template, selectors: ['[data-hook="review"]'] } };
    expect(extractWithRule(original, schema, overlapping).status).toBe('invalid');
  });

  it('limits text regions to safe text formatting and exact string text sources', () => {
    for (const body of ['<script type="application/ld+json">{"body":"Wrong"}</script>', '<input value="Wrong">', '<iframe></iframe>', '<img src="tracking">']) {
      expect(extractWithRule(page(body), schema, rule).status).toBe('invalid');
    }
    const nested = { ...rule, fields: { ...rule.fields, body: { source: 'dom', selector: `${bodySelector} p`, read: 'text' } } };
    expect(extractWithRule(page('<p>First.</p>'), schema, nested).status).toBe('invalid');
    const attribute = { ...rule, fields: { ...rule.fields, body: { source: 'dom', selector: bodySelector, read: 'attribute', attribute: 'data-value' } } };
    expect(extractWithRule(page('<p>First.</p>'), schema, attribute).status).toBe('invalid');
    const numeric = { ...schema, properties: { ...schema.properties, body: { type: 'number' } } };
    expect(extractWithRule(page('<p>1</p>'), numeric, rule).status).toBe('invalid');
    const empty = extractWithRule(page(''), schema, rule);
    expect(empty.status).toBe('invalid');
    expect(empty.data.body).toBeNull();
  });

  it('rejects malformed or unbounded text region declarations', () => {
    for (const textRegions of [[], [{ selector: bodySelector }], [{ selector: bodySelector, within: ':has(article)' }],
      [{ selector: bodySelector, within: 'article', ignored: true }],
      [{ selector: bodySelector, within: 'article' }, { selector: bodySelector, within: 'article' }],
      Array.from({ length: 8 }, (_, index) => ({ selector: `.body-${index}`, within: 'article' })),
    ]) {
      expect(() => parseRule({ ...rule, template: { ...rule.template, textRegions } }, parseSchema(schema))).toThrow();
    }
  });

  it('learns mixed-length samples and reuses the cached rule on a seven-paragraph review', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'opencli-text-region-'));
    try {
      const options = { cacheDir, schema, name: 'review', context: 'public:en', page: page('<p>A</p>') };
      await learnExtraction({ ...options, proposal: rule, samples: [
        { page: page('<p>A</p>', 'One'), expected: { title: 'One', body: 'A' } },
        { page: page('<p>B</p><p>C</p>', 'Two'), expected: { title: 'Two', body: 'BC' } },
      ] });
      const result = await runExtraction({ ...options, page: page(Array.from({ length: 7 }, (_, index) => `<p>${index}</p>`).join(''), 'New') });
      expect(result.status).toBe('verified');
      expect(result.cache.state).toBe('hit');
      expect(result.data).toEqual({ title: 'New', body: '0123456' });
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

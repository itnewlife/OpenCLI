import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';

import { __test__ } from './discussion.js';

const ASIN = 'B0DNMP29SK';
const OTHER_ASIN = 'B07GV57JYJ';
const REVIEW_PAGE = `https://www.amazon.com/product-reviews/${ASIN}`;
const PRODUCT_PAGE = `https://www.amazon.com/dp/${ASIN}`;
const SUMMARY = '<div data-hook="rating-out-of-text">4.6 out of 5</div><div data-hook="total-review-count">39,332 global ratings</div>';
// Handwritten, deidentified fixtures retain only the observed Amazon DOM structure.
const MODERN_REVIEW = `
  <div data-hook="review" id="RTESTMODERN1">
    <span class="a-profile-name">Private reviewer sentinel</span>
    <a href="/portal/customer-reviews/srp/-/RTESTMODERN1/ref=cm_cr_dp_d_rvw_ttl">
      <h5 data-hook="reviewTitle">Useful floor roller</h5>
    </a>
    <span data-hook="review-star-rating">5 out of 5 stars</span>
    <span data-hook="review-date">Reviewed in the United States on October 1, 2026</span>
    <a data-hook="format-strip" href="/portal/customer-reviews/${ASIN}/ref=cm_cr_dp_d_rvw_fmt?formatType=current_format">Set name: Floor roller</a>
    <span data-hook="avp-badge">Verified Purchase</span>
    <div data-hook="reviewRichContentContainer"><p><span>Picks up pet hair.</span></p><p><span></span></p><p><span>The handle reaches under the chair.</span></p></div>
    <button>Read more</button>
  </div>`;
const LEGACY_REVIEW = `
  <div data-hook="review" id="customer_review-RTESTLEGACY2">
    <a data-hook="review-title" href="/gp/customer-reviews/RTESTLEGACY2/ref=cm_cr_getr_d_rvw_ttl"><i>4.0 out of 5 stars</i> Good refill</a>
    <span data-hook="cmps-review-star-rating">4.0 out of 5 stars</span>
    <span data-hook="review-date">Reviewed in the United States on September 1, 2026</span>
    <a data-hook="format-strip" href="/product-reviews/${OTHER_ASIN}/ref=cm_cr_arp_d_rvw_fmt">Set name: Refills</a>
    <span data-hook="review-body"><span>First line.<br>Second line.<br><br>Next paragraph.</span><a class="a-expander-header" role="button"><span class="a-expander-prompt">Read more</span><span class="a-offscreen">Read more about this review</span></a></span>
  </div>`;
const INTERNATIONAL_REVIEW = `
  <div data-hook="review" id="RTESTWORLD3">
    <h5 data-hook="reviewTitle">Useful travel roller</h5>
    <span data-hook="review-star-rating">5 out of 5 stars</span>
    <span data-hook="review-date">Reviewed in Canada on June 7, 2026</span>
    <div data-hook="reviewRichContentContainer"><p><span>Easy to carry.</span></p></div>
  </div>`;

function fixturePage(routes, { requireLease = false, extractionOverride } = {}) {
  const events = [];
  let current;
  let warmed = false;
  function load(route, requestedUrl) {
    current?.window.close();
    current = new JSDOM(`<!doctype html><title>${route.title ?? 'Amazon product reviews'}</title>${route.html ?? ''}`, {
      url: route.url ?? requestedUrl,
      runScripts: 'outside-only',
    });
    Object.defineProperty(current.window.HTMLElement.prototype, 'innerText', {
      get() { return this.textContent; },
    });
  }
  load({}, 'https://www.amazon.com/');
  return {
    events,
    async goto(url) {
      events.push(['goto', url]);
      if (requireLease && !warmed) throw new Error('Browser Bridge lease not acquired before goto');
      const route = routes[url];
      if (!route) throw new Error(`Unexpected navigation in fixture: ${url}`);
      load(route, url);
    },
    async wait() {},
    async evaluate(script) {
      if (script === 'void 0') {
        events.push(['warmup']);
        warmed = true;
        return undefined;
      }
      const result = current.window.eval(script);
      return result?.review_samples && extractionOverride ? extractionOverride(result) : result;
    },
    close() { current.window.close(); },
  };
}

async function runDiscussion(page, kwargs = {}) {
  try {
    const command = __test__.command ?? getRegistry().get('amazon/discussion');
    return await command.func(page, { input: ASIN, limit: 10, ...kwargs });
  } finally {
    page.close();
  }
}

describe('amazon discussion normalization', () => {
  it('normalizes review summary and sample reviews', () => {
    const result = __test__.normalizeDiscussionPayload({
      href: 'https://www.amazon.com/product-reviews/B0FJS72893',
      average_rating_text: '3.9 out of 5',
      total_review_count_text: '27 global ratings',
      qa_links: [],
      review_samples: [
        {
          title: '5.0 out of 5 stars Great value and quality',
          rating_text: '5.0 out of 5 stars',
          author: 'GTreader2',
          date_text: 'Reviewed in the United States on February 21, 2026',
          body: 'Small but mighty.',
          verified: true,
        },
      ],
    });

    expect(result.asin).toBe('B0FJS72893');
    expect(result.average_rating_value).toBe(3.9);
    expect(result.total_review_count).toBe(27);
    expect(result.review_samples).toMatchObject([
      {
        title: 'Great value and quality',
        rating_text: '5.0 out of 5 stars',
        rating_value: 5,
        author: null,
        date_text: 'Reviewed in the United States on February 21, 2026',
        body: 'Small but mighty.',
        verified_purchase: true,
      },
    ]);
  });

  it('keeps the review marketplace in every emitted url', () => {
    const result = __test__.normalizeDiscussionPayload({
      href: 'https://www.amazon.co.uk/product-reviews/B0FGCPFY9L',
      average_rating_text: '4.4 out of 5',
      total_review_count_text: '40 global ratings',
      qa_links: [],
      review_samples: [],
    });

    expect(result.asin).toBe('B0FGCPFY9L');
    expect(result.discussion_url).toBe('https://www.amazon.co.uk/product-reviews/B0FGCPFY9L');
    expect(result.product_url).toBe('https://www.amazon.co.uk/dp/B0FGCPFY9L');
  });

  it('does not treat a public product page with sign-in copy as a gated page', () => {
    expect(__test__.isSignInState({
      href: 'https://www.amazon.com/dp/B09HKN2ZRT',
      title: 'Amazon.com: Example product',
      body_text: 'Hello, sign in Account & Lists Create account',
    })).toBe(false);
  });
});

// The approved seam is the actual adapter command, with only the browser replaced.
// These tests execute its browser script against DOM, not canned parser results.
describe('amazon discussion adapter', () => {
  it('reads modern and legacy cards with observed identity, mixed variants, paragraphs and no reviewer PII', async () => {
    const page = fixturePage({ [REVIEW_PAGE]: { html: SUMMARY + MODERN_REVIEW + LEGACY_REVIEW + INTERNATIONAL_REVIEW } });
    const [result] = await runDiscussion(page);
    expect(result.review_samples[0]).toMatchObject({
      title: 'Useful floor roller',
      body: 'Picks up pet hair.\n\nThe handle reaches under the chair.',
    });
    expect(result).toMatchObject({
      asin: ASIN,
      requested_asin: ASIN,
      source_url: REVIEW_PAGE,
      status: 'ok',
      review_samples_status: 'ok',
      usable_review_sample_count: 3,
    });
    expect(result.review_samples).toHaveLength(3);
    expect(result.review_samples[0]).toMatchObject({
      review_id: 'RTESTMODERN1',
      review_url: 'https://www.amazon.com/portal/customer-reviews/srp/-/RTESTMODERN1/ref=cm_cr_dp_d_rvw_ttl',
      requested_asin: ASIN,
      review_variant_asin: ASIN,
      matches_requested_variant: true,
      variant_text: 'Set name: Floor roller',
      variant_url: `https://www.amazon.com/portal/customer-reviews/${ASIN}/ref=cm_cr_dp_d_rvw_fmt?formatType=current_format`,
      title: 'Useful floor roller',
      body: 'Picks up pet hair.\n\nThe handle reaches under the chair.',
      author: null,
      verified_purchase: true,
      source_url: REVIEW_PAGE,
      fetched_at: result.fetched_at,
      status: 'ok',
      field_completeness: { review_id: true, review_url: true, title: true, body: true, review_variant_asin: true },
    });
    expect(result.review_samples[1]).toMatchObject({
      review_id: 'RTESTLEGACY2',
      review_url: 'https://www.amazon.com/gp/customer-reviews/RTESTLEGACY2/ref=cm_cr_getr_d_rvw_ttl',
      review_variant_asin: OTHER_ASIN,
      matches_requested_variant: false,
      title: 'Good refill',
      rating_value: 4,
      body: 'First line.\nSecond line.\n\nNext paragraph.',
    });
    expect(result.review_samples[2]).toMatchObject({
      review_id: 'RTESTWORLD3',
      review_url: null,
      review_variant_asin: null,
      matches_requested_variant: null,
      status: 'partial',
      field_completeness: { review_url: false, review_variant_asin: false },
    });
    expect(Number.isFinite(Date.parse(result.fetched_at))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Private reviewer sentinel');
    expect(JSON.stringify(result)).not.toContain('Read more');
    expect(page.events.filter(([event]) => event === 'goto')).toEqual([['goto', REVIEW_PAGE]]);
  });

  it('reads public product reviews despite hidden, navigation or sidebar login widgets', async () => {
    const cards = Array.from({ length: 13 }, (_, i) => MODERN_REVIEW.replaceAll('RTESTMODERN1', `RTESTPUBLIC${i}`)).join('');
    const widgets = [
      '<div hidden><form name="signIn" action="/ap/signin"><input id="ap_password" type="password"></form></div>',
      '<div style="display: none"><form name="signIn" action="/ap/signin"><input type="password"></form></div>',
      '<div aria-hidden="true"><form name="signIn" action="/ap/signin"><input type="password"></form></div>',
      '<nav><form name="signIn" action="/ap/signin"><input type="password"></form></nav>',
      '<aside><form name="signIn" action="/ap/signin"><input type="password"></form></aside>',
      '<div><form name="signIn" action="/ap/signin"><input type="password"></form></div>',
    ];
    for (const widget of widgets) {
      const page = fixturePage({ [PRODUCT_PAGE]: { title: 'Amazon.com: Public product', html: widget + '<main>' + SUMMARY + cards + '</main>' } });
      const [result] = await runDiscussion(page, { source: 'product', limit: 20 });
      expect(result).toMatchObject({ source_url: PRODUCT_PAGE, usable_review_sample_count: 13 });
      expect(page.events.filter(([event]) => event === 'goto')).toEqual([['goto', PRODUCT_PAGE]]);
    }
    for (const widget of widgets.slice(0, 5)) {
      const [result] = await runDiscussion(fixturePage({ [PRODUCT_PAGE]: { title: 'Amazon.com: Public product', html: widget + '<main>' + SUMMARY + '</main>' } }), { source: 'product' });
      expect(result).toMatchObject({ status: 'summary_only', usable_review_sample_count: 0 });
    }
  });

  it('keeps true sign-in gates with non-PII classification hints', async () => {
    const cases = [
      { url: 'https://www.amazon.com/ap/signin?email=private@example.test', title: 'Amazon Sign-In', html: SUMMARY + MODERN_REVIEW, reason: 'sign_in_path', path: '/ap/signin' },
      { url: PRODUCT_PAGE, title: 'Amazon Sign-In', html: SUMMARY + MODERN_REVIEW, reason: 'sign_in_title', path: `/dp/${ASIN}` },
      { url: PRODUCT_PAGE, title: 'Amazon', html: '<main><h1>Sign in</h1><form name="signIn" action="/ap/signin"><input id="ap_password" type="password"><button>Sign in</button></form></main>', reason: 'dominant_visible_sign_in_form', path: `/dp/${ASIN}` },
    ];
    for (const { reason, path, ...route } of cases) {
      const page = fixturePage({ [PRODUCT_PAGE]: route });
      let caught;
      try { await runDiscussion(page, { source: 'product' }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AuthRequiredError);
      expect(caught.hint).toContain(`landed_host=www.amazon.com; landed_path=${path}; auth_reason=${reason}`);
      expect(caught.hint).not.toContain('private@example.test');
      expect(caught.hint).not.toContain('Private reviewer sentinel');
      expect(page.events.filter(([event]) => event === 'goto')).toEqual([['goto', PRODUCT_PAGE]]);
    }
  });

  it('exposes conflicting or duplicate card sources and excludes conflicted cards from usable counts', async () => {
    const cards = [
      MODERN_REVIEW.replace('<h5 data-hook="reviewTitle">Useful floor roller</h5>', '<h5 data-hook="reviewTitle">Useful floor roller</h5><span data-hook="review-title">Different title</span>'),
      MODERN_REVIEW.replace('<h5 data-hook="reviewTitle">Useful floor roller</h5>', '<h5 data-hook="reviewTitle">Useful floor roller</h5><h5 data-hook="reviewTitle">Useful floor roller</h5>'),
      MODERN_REVIEW.replace('<button>Read more</button>', '<div data-hook="review-body">Conflicting body.</div>'),
      MODERN_REVIEW.replace('<button>Read more</button>', '<div data-hook="reviewRichContentContainer"><p>Duplicate modern body.</p></div>'),
      MODERN_REVIEW.replace('/srp/-/RTESTMODERN1/', '/srp/-/RTESTDIFFERENT/'),
      INTERNATIONAL_REVIEW,
    ].join('');
    const [result] = await runDiscussion(fixturePage({ [REVIEW_PAGE]: { html: SUMMARY + cards } }));
    expect(result).toMatchObject({ status: 'partial', review_samples_status: 'conflict', usable_review_sample_count: 1 });
    const expectedIssues = [
      ['title', 'conflicting_sources'],
      ['title', 'source_cardinality'],
      ['body', 'conflicting_sources'],
      ['body', 'source_cardinality'],
      ['review_id', 'identity_conflict'],
    ];
    for (const [index, [field, code]] of expectedIssues.entries()) {
      const sample = result.review_samples[index];
      expect(sample.status).toBe('conflict');
      expect(sample.field_issues).toContainEqual(expect.objectContaining({ field, code }));
      expect(sample.field_completeness[field]).toBe(false);
    }
    expect(result.review_samples[0].title).toBeNull();
    expect(result.review_samples[1].title).toBeNull();
    expect(result.review_samples[2].body).toBeNull();
    expect(result.review_samples[3].body).toBeNull();
    expect(result.review_samples[4]).toMatchObject({ review_id: null, review_url: null, field_completeness: { review_id: false, review_url: false } });
    expect(result.review_samples[5]).toMatchObject({ status: 'partial', review_url: null, field_issues: [] });
    const identicalSources = MODERN_REVIEW.replace('<button>Read more</button>', '<div data-hook="review-body">Picks up pet hair.<br><br>The handle reaches under the chair.</div>');
    const [consistent] = await runDiscussion(fixturePage({ [REVIEW_PAGE]: { html: SUMMARY + identicalSources } }));
    expect(consistent).toMatchObject({ usable_review_sample_count: 1, review_samples_status: 'ok' });
    expect(consistent.review_samples[0]).toMatchObject({ status: 'ok', field_issues: [] });
    const onlyConflict = fixturePage({ [REVIEW_PAGE]: { html: SUMMARY + MODERN_REVIEW.replace('/srp/-/RTESTMODERN1/', '/srp/-/RTESTDIFFERENT/') } });
    const [blockedSample] = await runDiscussion(onlyConflict);
    expect(blockedSample).toMatchObject({ review_samples_status: 'conflict', usable_review_sample_count: 0 });
    expect(onlyConflict.events.filter(([event]) => event === 'goto')).toEqual([['goto', REVIEW_PAGE]]);
  });

  it('opens an explicitly requested product source directly and validates exact portal ASIN landings', async () => {
    const command = __test__.command ?? getRegistry().get('amazon/discussion');
    expect(command.args.find((arg) => arg.name === 'source')).toMatchObject({ default: 'reviews', choices: ['reviews', 'product'] });
    const page = fixturePage({ [PRODUCT_PAGE]: { html: SUMMARY + MODERN_REVIEW } }, { requireLease: true });
    const [direct] = await runDiscussion(page, { source: 'product' });
    expect(direct).toMatchObject({ source_url: PRODUCT_PAGE, usable_review_sample_count: 1 });
    expect(page.events).toEqual([['warmup'], ['goto', PRODUCT_PAGE]]);
    const invalidChoice = fixturePage({});
    await expect(runDiscussion(invalidChoice, { source: 'other' })).rejects.toBeInstanceOf(ArgumentError);
    expect(invalidChoice.events).toEqual([]);
    const portal = `https://www.amazon.com/portal/customer-reviews/${ASIN}/ref=observed?formatType=current_format`;
    const [landed] = await runDiscussion(fixturePage({ [REVIEW_PAGE]: { url: portal, html: SUMMARY + MODERN_REVIEW } }));
    expect(landed).toMatchObject({ source_url: portal, asin: ASIN, requested_asin: ASIN });
    const [fromPortalInput] = await runDiscussion(fixturePage({ [REVIEW_PAGE]: { url: portal, html: SUMMARY + MODERN_REVIEW } }), { input: portal });
    expect(fromPortalInput.source_url).toBe(portal);
    for (const path of [`/portal/customer-reviews/${ASIN}X`, `/unexpected/portal/customer-reviews/${ASIN}`]) {
      const url = `https://www.amazon.com${path}`;
      await expect(runDiscussion(fixturePage({ [REVIEW_PAGE]: { url, html: SUMMARY + MODERN_REVIEW } }))).rejects.toBeInstanceOf(CommandExecutionError);
    }
    const gated = fixturePage({ [PRODUCT_PAGE]: { url: 'https://www.amazon.com/ap/signin', title: 'Amazon Sign-In', html: SUMMARY } });
    await expect(runDiscussion(gated, { source: 'product' })).rejects.toBeInstanceOf(AuthRequiredError);
    expect(gated.events.filter(([event]) => event === 'goto')).toEqual([['goto', PRODUCT_PAGE]]);
    const [onlyProductSummary] = await runDiscussion(fixturePage({ [PRODUCT_PAGE]: { html: SUMMARY } }), { source: 'product' });
    expect(onlyProductSummary).toMatchObject({ status: 'summary_only', usable_review_sample_count: 0, review_samples: [] });
  });

  it('preserves paragraph separators and inline words while excluding embedded read-more and accessibility controls', async () => {
    const card = `<div data-hook="review" id="RTESTTEXT4">
      <h5 data-hook="reviewTitle">Paragraphs</h5>
      <div data-hook="reviewRichContentContainer">
        <p><span>One </span><span>continuous sentence.</span><span class="a-offscreen">Read more about this review</span></p>
        <p><span></span></p><p>Another paragraph with “Read more” quoted in the review.</p>
        <p>Third.</p><p>Fourth.</p><p>Fifth.</p><p>Sixth.</p><p>Seventh.</p>
        <button>Read more</button><span aria-hidden="true">Accessibility prompt</span>
      </div></div>`;
    const [result] = await runDiscussion(fixturePage({ [REVIEW_PAGE]: { html: SUMMARY + card } }));
    expect(result.review_samples[0].body).toBe('One continuous sentence.\n\nAnother paragraph with “Read more” quoted in the review.\n\nThird.\n\nFourth.\n\nFifth.\n\nSixth.\n\nSeventh.');
  });

  it('marks summary-only and missing-content results without implying usable samples', async () => {
    const [summary] = await runDiscussion(fixturePage({
      [REVIEW_PAGE]: { html: SUMMARY },
      [PRODUCT_PAGE]: { html: SUMMARY },
    }));
    expect(summary).toMatchObject({ status: 'summary_only', review_samples_status: 'missing', usable_review_sample_count: 0, review_samples: [] });
    const emptyCard = '<div data-hook="review" id="RTESTEMPTY5"><span data-hook="review-star-rating">5 out of 5 stars</span></div><div data-hook="review" id="RTESTRATINGONLY"><a data-hook="review-title">5.0 out of 5 stars</a><span data-hook="review-body">A body with no observed title.</span></div>';
    const [missing] = await runDiscussion(fixturePage({
      [REVIEW_PAGE]: { html: SUMMARY + emptyCard },
      [PRODUCT_PAGE]: { html: SUMMARY + emptyCard },
    }));
    expect(missing).toMatchObject({ status: 'partial', review_samples_status: 'missing_content', usable_review_sample_count: 0 });
    expect(missing.review_samples[0]).toMatchObject({ title: null, body: null, status: 'missing_content', field_completeness: { title: false, body: false } });
    expect(missing.review_samples[1]).toMatchObject({ title: null, status: 'missing_content', field_completeness: { title: false, body: true } });
    const [noSummary] = await runDiscussion(fixturePage({ [REVIEW_PAGE]: { html: MODERN_REVIEW } }));
    expect(noSummary).toMatchObject({ status: 'partial', average_rating_value: null, total_review_count: null, usable_review_sample_count: 1 });
    await expect(runDiscussion(fixturePage({ [REVIEW_PAGE]: {}, [PRODUCT_PAGE]: {} }))).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('uses a checked product fallback for summary-only pages and acquires the bridge lease before goto', async () => {
    const page = fixturePage({
      [REVIEW_PAGE]: { html: SUMMARY },
      [PRODUCT_PAGE]: { html: SUMMARY + MODERN_REVIEW },
    }, { requireLease: true });
    const [result] = await runDiscussion(page);
    expect(result).toMatchObject({ source_url: PRODUCT_PAGE, discussion_url: PRODUCT_PAGE, usable_review_sample_count: 1 });
    expect(result.review_samples[0].source_url).toBe(PRODUCT_PAGE);
    const [conflictingSummaries] = await runDiscussion(fixturePage({
      [REVIEW_PAGE]: { html: SUMMARY },
      [PRODUCT_PAGE]: { html: '<div data-hook="rating-out-of-text">2 out of 5</div><div data-hook="total-review-count">3 ratings</div>' + MODERN_REVIEW },
    }));
    expect(conflictingSummaries).toMatchObject({ source_url: PRODUCT_PAGE, average_rating_value: 2, total_review_count: 3 });
    expect(page.events.slice(0, 2)).toEqual([['warmup'], ['goto', REVIEW_PAGE]]);
    expect(page.events.filter(([event]) => event === 'goto')).toEqual([['goto', REVIEW_PAGE], ['goto', PRODUCT_PAGE]]);
  });

  it('rejects conflicting observed source, ASIN and unsafe inputs before accepting samples', async () => {
    const invalidInputs = ['https://amazon.com.evil.test/dp/B0DNMP29SK', 'https://www.amazon.com/dp/B0DNMP29SKX', 'https://www.amazon.com/s?k=B0DNMP29SK', 'https://user:pass@www.amazon.com/dp/B0DNMP29SK', 'https://www.amazon.com:444/dp/B0DNMP29SK', 'https://www.amazon.com/foo/dp/B0DNMP29SK-bar'];
    for (const input of invalidInputs) {
      const page = fixturePage({ [REVIEW_PAGE]: { html: SUMMARY + MODERN_REVIEW } });
      await expect(runDiscussion(page, { input })).rejects.toBeInstanceOf(ArgumentError);
      expect(page.events).toEqual([]);
    }
    const badLandings = ['https://www.amazon.com.evil.test/product-reviews/B0DNMP29SK', 'https://www.amazon.com/product-reviews/B07GV57JYJ', 'https://www.amazon.com/product-reviews/B0DNMP29SKX', 'https://www.amazon.co.uk/product-reviews/B0DNMP29SK', 'https://smile.amazon.com/product-reviews/B0DNMP29SK'];
    for (const url of badLandings) {
      await expect(runDiscussion(fixturePage({ [REVIEW_PAGE]: { url, html: SUMMARY + MODERN_REVIEW } }))).rejects.toBeInstanceOf(CommandExecutionError);
    }
    const page = fixturePage({ [REVIEW_PAGE]: { html: SUMMARY + MODERN_REVIEW } }, {
      extractionOverride: (payload) => ({ ...payload, href: 'https://www.amazon.com/dp/B07GV57JYJ' }),
    });
    await expect(runDiscussion(page)).rejects.toBeInstanceOf(CommandExecutionError);
    expect(page.events.filter(([event]) => event === 'goto')).toHaveLength(1);
    const conflictingSource = fixturePage({ [REVIEW_PAGE]: { html: SUMMARY + MODERN_REVIEW } }, {
      extractionOverride: (payload) => ({ ...payload, source_url: PRODUCT_PAGE }),
    });
    await expect(runDiscussion(conflictingSource)).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('stops at login or captcha without a product fallback even if a summary is visible', async () => {
    const challenges = [
      { url: 'https://www.amazon.com/ap/signin', title: 'Amazon Sign-In', html: SUMMARY, error: AuthRequiredError },
      { url: REVIEW_PAGE, title: 'Amazon Sign-In', html: SUMMARY, error: AuthRequiredError },
      { url: REVIEW_PAGE, html: '<form action="/ap/signin"><input name="password" type="password"></form>' + SUMMARY, error: AuthRequiredError },
      { url: 'https://www.amazon.com/errors/validateCaptcha', html: SUMMARY, error: CommandExecutionError },
      { url: REVIEW_PAGE, html: '<form action="/errors/validateCaptcha"><input id="captchacharacters"></form>' + SUMMARY, error: CommandExecutionError },
      { url: REVIEW_PAGE, html: 'Sorry, we just need to make sure you\'re not a robot' + SUMMARY, error: CommandExecutionError },
    ];
    for (const { error, ...route } of challenges) {
      const page = fixturePage({ [REVIEW_PAGE]: route, [PRODUCT_PAGE]: { html: SUMMARY + MODERN_REVIEW } });
      await expect(runDiscussion(page)).rejects.toBeInstanceOf(error);
      expect(page.events.filter(([event]) => event === 'goto')).toEqual([['goto', REVIEW_PAGE]]);
    }
    const gatedFallback = fixturePage({
      [REVIEW_PAGE]: { html: SUMMARY },
      [PRODUCT_PAGE]: { url: 'https://www.amazon.com/ap/signin', title: 'Amazon Sign-In', html: SUMMARY },
    });
    await expect(runDiscussion(gatedFallback)).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('keeps marketplace URLs and nulls unobserved or conflicting review identity and variants', async () => {
    const uk = 'https://www.amazon.co.uk/product-reviews/' + ASIN;
    const cards = `<div data-hook="review" id="RTESTCONFLICT6">
      <a href="https://www.amazon.com/gp/customer-reviews/ROTHER/ref=title"><h5 data-hook="reviewTitle">Local title</h5></a>
      <a data-hook="format-strip" href="https://www.amazon.co.uk.evil.test/portal/customer-reviews/${OTHER_ASIN}/ref=format">Other variant</a>
      <span data-hook="review-star-rating">4 out of 5 stars</span><span data-hook="review-date">Reviewed yesterday</span>
      <div data-hook="reviewRichContentContainer"><p>Local body.</p></div>
      </div>
      <div data-hook="review"><h5 data-hook="reviewTitle">No observed ID</h5><div data-hook="review-body">Still usable text.</div></div>`;
    const [result] = await runDiscussion(fixturePage({ [uk]: { html: SUMMARY + cards } }), { input: `https://www.amazon.co.uk/dp/${ASIN}` });
    expect(result.product_url).toBe('https://www.amazon.co.uk/dp/' + ASIN);
    expect(result.review_samples[0]).toMatchObject({ review_id: 'RTESTCONFLICT6', review_url: null, review_variant_asin: null, matches_requested_variant: null });
    expect(result.review_samples[1]).toMatchObject({ review_id: null, review_url: null });
    expect(result.review_samples).toHaveLength(2);
    const observedSingleUrl = 'https://www.amazon.co.uk/gp/customer-reviews/RTESTWORLD3/ref=observed';
    expect(__test__.normalizeReviewSample({ review_id: 'RTESTWORLD3', title: 'Title', body: 'Body' }, ASIN, observedSingleUrl, '2026-10-21T00:00:00Z'))
      .toMatchObject({ review_id: 'RTESTWORLD3', review_url: observedSingleUrl });
    expect(__test__.normalizeReviewSample({ review_id: 'RTESTOTHER', title: 'Title', body: 'Body' }, ASIN, observedSingleUrl, '2026-10-21T00:00:00Z'))
      .toMatchObject({ review_id: null, review_url: null, status: 'conflict', field_issues: expect.arrayContaining([expect.objectContaining({ field: 'review_id', code: 'identity_conflict' })]) });
  });
});

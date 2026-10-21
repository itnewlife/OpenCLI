import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { DOMAIN, amazonHostFromInput, buildDiscussionUrl, buildProvenance, cleanText, parseRatingValue, parseReviewCount, assertUsableState, gotoAndReadState } from './shared.js';

function asinFromProductPath(pathname) {
    return (pathname.match(/\/(?:dp|gp\/product|product-reviews)\/([A-Z0-9]{10})(?=\/|$)/i)
        ?? pathname.match(/^\/portal\/customer-reviews\/([A-Z0-9]{10})(?:\/ref=[^/]*)?\/?$/i))?.[1].toUpperCase() ?? null;
}

function safeAmazonUrl(value, base) {
    try {
        const url = base ? new URL(value, base) : new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && !url.port
            && amazonHostFromInput(url.href) ? url : null;
    } catch {
        return null;
    }
}

export function resolveDiscussionRequest(input) {
    const value = cleanText(input);
    const bareAsin = /^[A-Z0-9]{10}$/i.test(value) ? value.toUpperCase() : null;
    const url = bareAsin ? new URL(buildDiscussionUrl(bareAsin)) : safeAmazonUrl(value);
    const asin = bareAsin ?? (url ? asinFromProductPath(url.pathname) : null);
    if (!url || !asin) {
        throw new ArgumentError('amazon discussion expects an ASIN or an HTTPS Amazon product URL', 'Example: opencli amazon discussion B0DNMP29SK');
    }
    return {
        asin,
        origin: url.origin,
        host: url.hostname,
        reviewUrl: new URL(`/product-reviews/${asin}`, url.origin).href,
        productUrl: new URL(`/dp/${asin}`, url.origin).href,
    };
}

function signInReason(state) {
    let path = '';
    try { path = new URL(state.href).pathname; } catch { /* The source validator handles malformed URLs. */ }
    if (/^\/ap\/(?:signin|register)(?:\/|$)/i.test(path)) return 'sign_in_path';
    if (/amazon[\s-]*sign[\s-]*in/i.test(cleanText(state.title))) return 'sign_in_title';
    return state.is_sign_in === true && state.sign_in_reason === 'dominant_visible_sign_in_form'
        ? 'dominant_visible_sign_in_form' : null;
}

export function isSignInState(state) {
    return signInReason(state) !== null;
}

function assertDiscussionState(state, request, expectedHref) {
    assertUsableState(state, 'discussion');
    if (state.is_captcha === true || /\/(?:errors\/validatecaptcha|captcha)(?:\/|$)/i.test(safeAmazonUrl(state.href)?.pathname ?? '')
        || /robot check|captcha/i.test(cleanText(state.title))) {
        throw new CommandExecutionError('amazon discussion hit a robot check', 'Clear the challenge in the shared Chrome profile before retrying.');
    }
    const authReason = signInReason(state);
    if (authReason) {
        const landed = safeAmazonUrl(state.href);
        const host = landed?.hostname ?? 'unknown';
        // Emit only recognized auth/product routes: no query, title or page text.
        const authPath = landed?.pathname.match(/^\/ap\/(?:signin|register)(?=\/|$)/i)?.[0];
        const productPath = landed?.pathname.match(/\/(?:dp|gp\/product|product-reviews|portal\/customer-reviews)\/[A-Z0-9]{10}(?=\/|$)/i)?.[0];
        const path = authPath ?? productPath ?? 'unrecognized';
        throw new AuthRequiredError(request.host ?? DOMAIN, 'Amazon review discussion requires an active signed-in Amazon session in the shared Chrome profile.',
            `Open the requested Amazon page in the shared Chrome profile. landed_host=${host}; landed_path=${path}; auth_reason=${authReason}`);
    }
    const observed = safeAmazonUrl(state.href);
    if (!observed || observed.origin !== request.origin || asinFromProductPath(observed.pathname) !== request.asin
        || (expectedHref && observed.href !== expectedHref)) {
        throw new CommandExecutionError('amazon discussion source does not match the requested host and ASIN', 'Open the requested product in the same Amazon marketplace and retry.');
    }
    return observed.href;
}

// This self-contained function is shared by page.evaluate and offline DOM replay.
// Read only review content and public review links; never collect profile names/URLs.
export function extractDiscussionDom(document, window, limit) {
    const text = (node) => node?.textContent || '';
    const content = (node) => {
        if (!node) return '';
        if (node.nodeType === 3) return (node.nodeValue || '').replace(/\s+/g, ' ');
        if (node.nodeType !== 1) return '';
        if (node.matches('script, style, noscript, template, svg, button, input, [role="button"], [hidden], [aria-hidden="true"], .a-offscreen, .a-expander-prompt, .a-expander-header, [data-action="a-expander-toggle"]')) return '';
        if (node.tagName === 'BR') return '\n';
        const value = Array.from(node.childNodes).map(content).join('');
        return /^(P|DIV|LI|BLOCKQUOTE)$/.test(node.tagName) ? `\n\n${value}\n\n` : value;
    };
    const bodyText = (node) => content(node).replace(/\u00a0/g, ' ')
        .split('\n').map((line) => line.replace(/[^\S\n]+/g, ' ').trim()).join('\n')
        .replace(/\n{3,}/g, '\n\n').trim();
    const href = (node) => node?.getAttribute('href') || null;
    const cards = Array.from(document.querySelectorAll('[data-hook="review"]')).slice(0, limit);
    const visible = (node) => {
        for (let current = node; current; current = current.parentElement) {
            if (current.matches('[hidden], [aria-hidden="true"], [inert], template')) return false;
            const style = window.getComputedStyle(current);
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
        }
        return true;
    };
    const peripheral = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="complementary"], [role="contentinfo"], #navbar';
    const primary = document.querySelector('main, [role="main"], #a-page') ?? document.body;
    const hasProductContent = Array.from(document.querySelectorAll('[data-hook="review"], #productTitle, #dp, #dp-container'))
        .some((node) => !node.closest(peripheral) && visible(node));
    const dominantSignIn = !hasProductContent && Array.from(document.querySelectorAll('form[action*="/ap/signin"], form[name="signIn"]'))
        .some((form) => !form.closest(peripheral) && primary?.contains(form) && visible(form)
            && Array.from(form.querySelectorAll('input[type="password"]')).some(visible));
    return {
        href: window.location.href,
        title: document.title || '',
        is_sign_in: dominantSignIn,
        sign_in_reason: dominantSignIn ? 'dominant_visible_sign_in_form' : null,
        is_captcha: !!document.querySelector('form[action*="validateCaptcha"], #captchacharacters, input[name="cvf_captcha_input"]'),
        average_rating_text: text(document.querySelector('[data-hook="rating-out-of-text"]')),
        total_review_count_text: text(document.querySelector('[data-hook="total-review-count"]')),
        qa_links: Array.from(document.querySelectorAll('a[href*="ask/questions"]')).map(href),
        review_samples: cards.map((card) => {
            const issues = [];
            const compact = (value) => value.replace(/\s+/g, ' ').trim();
            const field = (name, selectors, read = (node) => compact(text(node))) => {
                const sources = selectors.map((selector) => {
                    const nodes = Array.from(card.querySelectorAll(selector));
                    if (nodes.length > 1) issues.push({ field: name, code: 'source_cardinality', source: selector, count: nodes.length });
                    return { node: nodes[0], value: nodes.length ? read(nodes[0]) : null };
                }).filter((source) => source.node);
                if (sources.length > 1 && sources.some((source) => source.value !== sources[0].value)) {
                    issues.push({ field: name, code: 'conflicting_sources' });
                }
                return issues.some((issue) => issue.field === name) ? { node: null, value: null } : sources[0] ?? { node: null, value: null };
            };
            const title = field('title', ['h5[data-hook="reviewTitle"]', '[data-hook="review-title"]'],
                (node) => compact(text(node)).replace(/^\d+(?:\.\d+)?\s*out of 5 stars\s*/i, '').trim());
            const body = field('body', ['div[data-hook="reviewRichContentContainer"]', '[data-hook="review-body"]'], bodyText);
            const rating = field('rating_value', ['[data-hook="review-star-rating"]', '[data-hook="cmps-review-star-rating"]']);
            const date = field('date_text', ['[data-hook="review-date"]']);
            const format = field('review_variant_asin', ['[data-hook="format-strip"]'], (node) => compact(text(node)));
            const titleLink = title.node?.closest('a[href]');
            const formatLink = format.node?.matches('a[href]') ? format.node : format.node?.querySelector('a[href]');
            return {
                review_id: card.id || null,
                review_url: titleLink && card.contains(titleLink) ? href(titleLink) : null,
                variant_text: format.value,
                variant_url: href(formatLink),
                title: title.value,
                rating_text: rating.value,
                date_text: date.value,
                body: body.value,
                verified: !!card.querySelector('[data-hook="avp-badge"]'),
                field_issues: issues,
            };
        }),
    };
}

export function buildDiscussionExtractJs(limit) {
    return `(${extractDiscussionDom.toString()})(document, window, ${JSON.stringify(limit)})`;
}

export async function readCurrentDiscussionPayload(page, limit) {
    return await page.evaluate(buildDiscussionExtractJs(limit));
}

function normalizeBody(value) {
    return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ')
        .split('\n').map((line) => line.replace(/[^\S\n]+/g, ' ').trim()).join('\n')
        .replace(/\n{3,}/g, '\n\n').trim() : '';
}

function reviewTitle(value) {
    return cleanText(value).replace(/^\d+(?:\.\d+)?\s*out of 5 stars\s*/i, '').trim() || null;
}

function reviewId(value) {
    return cleanText(value).match(/^(?:customer_review-)?(R[A-Z0-9]+)$/i)?.[1].toUpperCase() ?? null;
}

function reviewIdFromUrl(url) {
    return url?.pathname.match(/\/(?:gp\/customer-reviews|portal\/customer-reviews\/srp\/-)\/(R[A-Z0-9]+)(?=\/|$)/i)?.[1].toUpperCase() ?? null;
}

function sameSourceLink(value, sourceUrl) {
    if (!cleanText(value)) return null;
    const url = safeAmazonUrl(value, sourceUrl);
    return url?.origin === new URL(sourceUrl).origin ? url : null;
}

// Useful for replaying a captured individual review page, whose URL has a review
// ID rather than a product ASIN. The command validates its product landing first.
export function normalizeReviewSample(sample, requestedAsin, sourceUrl, fetchedAt) {
    const issues = (sample.field_issues ?? []).map((issue) => ({ ...issue }));
    const cardId = reviewId(sample.review_id);
    const link = sameSourceLink(sample.review_url, sourceUrl);
    const linkId = reviewIdFromUrl(link);
    const source = safeAmazonUrl(sourceUrl);
    const sourceId = reviewIdFromUrl(source);
    const ids = [cardId, linkId, sourceId].filter(Boolean);
    const identityConflict = new Set(ids).size > 1;
    if (identityConflict) {
        issues.push({ field: 'review_id', code: 'identity_conflict', card_review_id: cardId, link_review_id: linkId, source_review_id: sourceId });
        issues.push({ field: 'review_url', code: 'identity_conflict' });
    }
    const hasIssue = (field) => issues.some((issue) => issue.field === field);
    const observedReviewUrl = identityConflict || hasIssue('title') ? null : linkId ? link.href
        : cardId && sourceId === cardId ? source.href : null;
    const variantLink = sameSourceLink(sample.variant_url, sourceUrl);
    const observedVariantAsin = variantLink?.pathname.match(/^\/(?:portal\/customer-reviews|product-reviews)\/([A-Z0-9]{10})(?=\/|$)/i)?.[1].toUpperCase() ?? null;
    const variantAsin = hasIssue('review_variant_asin') ? null : observedVariantAsin;
    const title = hasIssue('title') ? null : reviewTitle(sample.title);
    const body = hasIssue('body') ? null : normalizeBody(sample.body) || null;
    const ratingText = hasIssue('rating_value') ? null : cleanText(sample.rating_text) || null;
    const ratingValue = parseRatingValue(ratingText);
    const dateText = hasIssue('date_text') ? null : cleanText(sample.date_text) || null;
    const id = identityConflict ? null : cardId ?? linkId;
    const variantText = hasIssue('review_variant_asin') ? null : cleanText(sample.variant_text) || null;
    const variantUrl = variantAsin ? variantLink.href : null;
    const completeness = {
        review_id: id !== null,
        review_url: observedReviewUrl !== null,
        title: title !== null,
        body: body !== null,
        rating_value: ratingValue !== null,
        date_text: dateText !== null,
        review_variant_asin: variantAsin !== null,
        variant_text: variantText !== null,
        variant_url: variantUrl !== null,
    };
    return {
        review_id: id,
        review_url: observedReviewUrl,
        requested_asin: requestedAsin,
        review_variant_asin: variantAsin,
        matches_requested_variant: variantAsin ? variantAsin === requestedAsin : null,
        variant_text: variantText,
        variant_url: variantUrl,
        title,
        rating_text: ratingText,
        rating_value: ratingValue,
        // Retain the legacy key without retaining reviewer identity.
        author: null,
        date_text: dateText,
        body,
        verified_purchase: sample.verified === true,
        source_url: sourceUrl,
        fetched_at: fetchedAt,
        field_completeness: completeness,
        field_issues: issues,
        status: issues.length ? 'conflict' : !title || !body ? 'missing_content' : Object.values(completeness).every(Boolean) ? 'ok' : 'partial',
    };
}

export function hasDiscussionSummary(payload) {
    return Boolean(cleanText(payload.average_rating_text) || cleanText(payload.total_review_count_text));
}

function isUsableSample(sample) {
    return sample.status !== 'conflict' && sample.title && sample.body;
}

function normalizedSamples(payload, request, fetchedAt) {
    return (payload.review_samples ?? []).map((sample) => normalizeReviewSample(sample, request.asin, payload.href, fetchedAt));
}

export function normalizeDiscussionPayload(payload, input = payload.href, fetchedAt = new Date().toISOString()) {
    const request = resolveDiscussionRequest(input);
    const sourceUrl = assertDiscussionState(payload, request);
    if (payload.source_url && payload.source_url !== sourceUrl) {
        throw new CommandExecutionError('amazon discussion payload contains conflicting source URLs');
    }
    const provenance = { ...buildProvenance(sourceUrl), fetched_at: fetchedAt };
    const averageRatingText = cleanText(payload.average_rating_text) || null;
    const averageRatingValue = parseRatingValue(averageRatingText);
    const totalReviewCountText = cleanText(payload.total_review_count_text) || null;
    const totalReviewCount = parseReviewCount(totalReviewCountText);
    const samples = normalizedSamples(payload, request, fetchedAt);
    const usableCount = samples.filter(isUsableSample).length;
    const sampleStatus = samples.some((sample) => sample.status === 'conflict') ? 'conflict'
        : !samples.length ? 'missing' : !usableCount ? 'missing_content' : usableCount < samples.length ? 'partial' : 'ok';
    return {
        asin: request.asin,
        requested_asin: request.asin,
        product_url: request.productUrl,
        discussion_url: sourceUrl,
        ...provenance,
        average_rating_text: averageRatingText,
        average_rating_value: averageRatingValue,
        total_review_count_text: totalReviewCountText,
        total_review_count: totalReviewCount,
        qa_urls: [...new Set((payload.qa_links ?? []).map((value) => sameSourceLink(value, sourceUrl)?.href).filter(Boolean))],
        review_samples: samples,
        usable_review_sample_count: usableCount,
        review_samples_status: sampleStatus,
        field_completeness: { average_rating_value: averageRatingValue !== null, total_review_count: totalReviewCount !== null, review_samples: sampleStatus === 'ok' },
        status: !samples.length && hasDiscussionSummary(payload) ? 'summary_only'
            : sampleStatus === 'ok' && averageRatingValue !== null && totalReviewCount !== null ? 'ok' : 'partial',
        coverage: 'Observed review cards on this page only; may include other variants and international reviews.',
    };
}

export async function readDiscussionPayload(page, input, limit, source = 'reviews') {
    const request = resolveDiscussionRequest(input);
    if (!['reviews', 'product'].includes(source)) throw new ArgumentError('amazon discussion source must be reviews or product');
    // Browser Bridge allocates the adapter lease on evaluate, before navigation.
    await page.evaluate('void 0');
    const readAt = async (url) => {
        const state = await gotoAndReadState(page, url, 2500, 'discussion');
        const sourceUrl = assertDiscussionState(state, request);
        const payload = await readCurrentDiscussionPayload(page, limit);
        assertDiscussionState(payload, request, sourceUrl);
        return payload;
    };
    if (source === 'product') return await readAt(request.productUrl);
    const reviews = await readAt(request.reviewUrl);
    const samples = normalizedSamples(reviews, request);
    if (samples.some(isUsableSample) || samples.some((sample) => sample.status === 'conflict')) return reviews;
    // Only an ungated, source-validated page may use the product-page fallback.
    const product = await readAt(request.productUrl);
    const productSamples = normalizedSamples(product, request);
    if (productSamples.some(isUsableSample) || productSamples.some((sample) => sample.status === 'conflict')
        || (product.review_samples?.length ?? 0) > (reviews.review_samples?.length ?? 0)
        || (!hasDiscussionSummary(reviews) && hasDiscussionSummary(product))) return product;
    return reviews;
}

export async function runDiscussion(page, kwargs) {
    const input = String(kwargs.input ?? '');
    const limit = Number(kwargs.limit ?? 10);
    resolveDiscussionRequest(input);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new ArgumentError('amazon discussion limit must be a positive integer');
    const payload = await readDiscussionPayload(page, input, limit, kwargs.source ?? 'reviews');
    const normalized = normalizeDiscussionPayload(payload, input);
    if (!hasDiscussionSummary(payload) && !normalized.review_samples.length) {
        throw new CommandExecutionError('amazon discussion page did not expose review summary or review cards', 'Open the review page in Chrome, verify reviews are visible, and retry.');
    }
    return [normalized];
}

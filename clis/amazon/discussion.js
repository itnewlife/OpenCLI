import { cli, Strategy } from '@jackwener/opencli/registry';
import { runDiscussion, readDiscussionPayload, readCurrentDiscussionPayload, normalizeDiscussionPayload, normalizeReviewSample, extractDiscussionDom, buildDiscussionExtractJs, hasDiscussionSummary, isSignInState } from './discussion-core.js';

const command = cli({
    site: 'amazon',
    name: 'discussion',
    access: 'read',
    description: 'Amazon review summary and observed customer review samples with variant and completeness metadata',
    domain: 'amazon.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    args: [
        {
            name: 'input',
            required: true,
            positional: true,
            help: 'ASIN or product URL, for example B0FJS72893',
        },
        {
            name: 'source',
            default: 'reviews',
            choices: ['reviews', 'product'],
            help: 'Start at reviews (default) or read the product page directly',
        },
        {
            name: 'limit',
            type: 'int',
            default: 10,
            help: 'Maximum number of review samples to return (default 10)',
        },
    ],
    columns: ['asin', 'average_rating_value', 'total_review_count', 'usable_review_sample_count', 'review_samples_status', 'status'],
    func: runDiscussion,
});

export const __test__ = {
    command,
    runDiscussion,
    readDiscussionPayload,
    readCurrentDiscussionPayload,
    normalizeDiscussionPayload,
    normalizeReviewSample,
    extractDiscussionDom,
    buildDiscussionExtractJs,
    hasDiscussionSummary,
    isSignInState,
};

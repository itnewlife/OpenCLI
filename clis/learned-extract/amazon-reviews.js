import { cli, Strategy } from '@jackwener/opencli/registry';
import { runDiscussion } from '../amazon/discussion-core.js';

const command = cli({
  site: 'learned-extract', name: 'amazon-reviews', access: 'read',
  description: 'Read rendered Amazon review samples with per-review identity, variants and field status',
  domain: 'amazon.com', strategy: Strategy.COOKIE, navigateBefore: false,
  args: [
    { name: 'input', positional: true, required: true, help: 'Amazon ASIN or product/review URL' },
    { name: 'limit', type: 'int', default: 10, help: 'Maximum rendered review samples; no pagination' },
    { name: 'source', default: 'reviews', choices: ['reviews', 'product'], help: 'Initial page to read: review list or product-page review samples' },
  ],
  defaultFormat: 'json',
  columns: ['asin', 'status', 'usable_review_sample_count', 'review_samples_status'],
  func: runDiscussion,
});

export const __test__ = { command };

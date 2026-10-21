import { cli, Strategy } from '@jackwener/opencli/registry';
import { capturePage } from './_shared.js';

const command = cli({
  site: 'learned-extract', name: 'capture', access: 'read',
  description: 'Capture a bounded page snapshot for reusable read-only extraction',
  strategy: Strategy.COOKIE, navigateBefore: false,
  args: [
    { name: 'url', positional: true, required: true, help: 'Authorized page URL to capture' },
    { name: 'output', required: true, help: 'New snapshot JSON file (never overwrites)' },
    { name: 'wait', type: 'int', default: 1, help: 'Page settling time in seconds (0-30)' },
  ],
  defaultFormat: 'json',
  func: capturePage,
});
export const __test__ = { command };

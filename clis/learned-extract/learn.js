import { cli, Strategy } from '@jackwener/opencli/registry';
import { learnExtraction } from '@jackwener/opencli/extraction';
import { commonArgs, learningArgs, learningFrom, optionsFrom } from './_shared.js';

const command = cli({
  site: 'learned-extract', name: 'learn', access: 'read',
  description: 'Validate proposed extraction rules against checked samples and cache a version',
  strategy: Strategy.LOCAL, browser: false,
  args: [...commonArgs, ...learningArgs],
  defaultFormat: 'json',
  func: async args => learnExtraction({ ...await optionsFrom(args), ...await learningFrom(args) }),
});
export const __test__ = { command };

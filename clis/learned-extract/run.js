import { cli, Strategy } from '@jackwener/opencli/registry';
import { runExtraction } from '@jackwener/opencli/extraction';
import { commonArgs, learningArgs, learningFrom, optionsFrom } from './_shared.js';

const command = cli({
  site: 'learned-extract', name: 'run', access: 'read',
  description: 'Apply a learned rule to a fresh snapshot with field evidence and validation',
  strategy: Strategy.LOCAL, browser: false,
  args: [
    ...commonArgs,
    { name: 'repair', type: 'boolean', default: false, help: 'Attempt one repair using explicitly provided checked samples and proposal/provider' },
    ...learningArgs,
  ],
  defaultFormat: 'json',
  func: async args => runExtraction({
    ...await optionsFrom(args),
    ...(args.repair === true || args.repair === 'true' ? { repair: await learningFrom(args) } : {}),
  }),
});
export const __test__ = { command };

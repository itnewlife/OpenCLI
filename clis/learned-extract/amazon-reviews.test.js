import { describe, expect, it } from 'vitest';
import { __test__ } from './amazon-reviews.js';
import { runDiscussion } from '../amazon/discussion-core.js';

describe('installed Amazon review entry', () => {
  it('shares the corrected adapter implementation with explicit source selection', () => {
    expect(__test__.command.func).toBe(runDiscussion);
    expect(__test__.command.access).toBe('read');
    expect(__test__.command.navigateBefore).toBe(false);
    expect(__test__.command.args.find(argument => argument.name === 'source')).toMatchObject({ default: 'reviews', choices: ['reviews', 'product'] });
  });
});

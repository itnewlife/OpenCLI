import { RuleCache } from './cache.js';
import { digest, extractWithRule } from './engine.js';
import { ArgumentError, ConfigError } from '../errors.js';
import type { RuleGenerator } from './generator.js';
import { sanitizeSnapshot } from './snapshot.js';
import { keys, matchesType, object, parseRule, parseSchema, text } from './validation.js';
import type { ExtractionResult, ExtractionSchema, PageSnapshot, RuleEntry, Scalar } from './types.js';

export { createRuleGenerator } from './generator.js';
export { RuleCache } from './cache.js';
export { extractWithRule } from './engine.js';
export { sanitizeSnapshot, SNAPSHOT_EXPRESSION } from './snapshot.js';
export type { PageSnapshot, ExtractionRule, ExtractionResult } from './types.js';

export interface ValidationSample {
  page: unknown;
  expected: Record<string, Scalar>;
}

interface SessionOptions {
  cacheDir: string;
  name: string;
  context: string;
  schema: unknown;
  page: unknown;
}

export interface LearningOptions extends SessionOptions {
  samples: ValidationSample[];
  proposal?: unknown;
  generator?: RuleGenerator;
}

export interface RunOptions extends SessionOptions {
  repair?: { samples: ValidationSample[]; proposal?: unknown; generator?: RuleGenerator };
}

export type RunResult = ExtractionResult & { cache: { key: string; revision: number; state: 'learned' | 'hit' | 'repaired' | 'invalid' } };

function cacheKey(options: SessionOptions): string {
  const schema = parseSchema(options.schema);
  const page = sanitizeSnapshot(options.page);
  const name = text(options.name, 'rule name', 128);
  const context = text(options.context, 'account/view context', 256);
  return digest(JSON.stringify({ version: 1, name, context, origin: new URL(page.url).origin, schema }));
}

function parseEntry(value: unknown, key: string, schema: ExtractionSchema): RuleEntry {
  const entry = object(value, 'cached rule');
  keys(entry, ['version', 'key', 'rule', 'templateHash', 'revision', 'createdAt'], 'cached rule');
  if (entry.version !== 1 || entry.key !== key || typeof entry.templateHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.templateHash)
    || !Number.isSafeInteger(entry.revision) || Number(entry.revision) < 1 || typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt))) throw new ConfigError('Invalid cached rule metadata');
  return { version: 1, key, rule: parseRule(entry.rule, schema), templateHash: entry.templateHash, revision: entry.revision as number, createdAt: entry.createdAt };
}

function prepareSamples(samples: ValidationSample[], schema: ExtractionSchema): { page: PageSnapshot; expected: Record<string, Scalar> }[] {
  if (!Array.isArray(samples) || samples.length < 2 || samples.length > 8) throw new ArgumentError('Learning requires 2-8 independently checked samples');
  const prepared = samples.map(sample => {
    const expected = object(sample.expected, 'sample.expected') as Record<string, Scalar>;
    if (Object.keys(expected).sort().join('\0') !== Object.keys(schema.properties).sort().join('\0')) throw new ArgumentError('Each sample must specify expected values (including null) for every field');
    for (const [name, value] of Object.entries(expected)) {
      if (value !== null && !matchesType(value, schema.properties[name])) throw new ArgumentError(`Wrong expected type for ${name}`);
    }
    return { page: sanitizeSnapshot(sample.page), expected };
  });
  if (new Set(prepared.map(sample => digest(sample.page.html))).size < 2) throw new ArgumentError('Learning requires at least two distinct page snapshots');
  return prepared;
}

async function learn(options: LearningOptions, previous?: RuleEntry, issues?: unknown[]): Promise<RunResult> {
  const schema = parseSchema(options.schema);
  const page = sanitizeSnapshot(options.page);
  const samples = prepareSamples(options.samples, schema);
  const key = cacheKey(options);
  const cache = new RuleCache(options.cacheDir);
  const existingValue = await cache.load(key);
  const existing = existingValue === null ? undefined : parseEntry(existingValue, key, schema);
  if (previous && existing?.revision !== previous.revision) throw new ConfigError('Rule cache changed while validating; reload before saving');
  if (options.proposal !== undefined && options.generator) throw new ArgumentError('Choose either an imported proposal or a model generator');
  if (options.proposal === undefined && !options.generator) throw new ArgumentError('Provide a rule JSON file or an explicitly configured model endpoint');
  const sampleBytes = samples.reduce((total, sample) => total + Buffer.byteLength(sample.page.html), 0);
  if (options.proposal === undefined && sampleBytes > 200_000) throw new ArgumentError('Model sample HTML exceeds 200 KB; use smaller snapshots or an imported rule');
  const proposal = options.proposal ?? await options.generator!({
    schema: options.schema,
    samples: samples.map(sample => ({ url: sample.page.url, html: sample.page.html })),
    ...(previous ? { previousRule: previous.rule } : {}),
    ...(issues ? { issues } : {}),
  });
  const rule = parseRule(proposal, schema);
  if (previous && (rule.scope.origin !== previous.rule.scope.origin || rule.scope.pathPrefix !== previous.rule.scope.pathPrefix)) throw new ConfigError('Repair cannot change the learned URL scope; use a separate rule name');
  let templateHash: string | undefined;
  for (const sample of samples) {
    const result = extractWithRule(sample.page, options.schema, rule);
    if (result.status === 'invalid') throw new ConfigError('Proposed rule failed sample extraction; cache was not changed');
    if (templateHash !== undefined && templateHash !== result.templateHash) throw new ArgumentError('Samples must share one page structure; learn a separate rule for each template');
    templateHash = result.templateHash;
    for (const [name, expected] of Object.entries(sample.expected)) {
      if (result.data[name] !== expected) throw new ConfigError(`Proposed rule failed independently checked sample field ${name}; cache was not changed`);
    }
  }
  const result = extractWithRule(page, options.schema, rule);
  if (result.status === 'invalid' || result.templateHash !== templateHash) throw new ConfigError('Proposed rule does not validate the current page; cache was not changed');
  const entry: RuleEntry = {
    version: 1, key, rule, templateHash: result.templateHash,
    revision: (existing?.revision ?? 0) + 1, createdAt: new Date().toISOString(),
  };
  await cache.save(key, entry);
  return { ...result, cache: { key, revision: entry.revision, state: previous ? 'repaired' : 'learned' } };
}

export async function learnExtraction(options: LearningOptions): Promise<RunResult> {
  return learn(options);
}

export async function runExtraction(options: RunOptions): Promise<RunResult> {
  const key = cacheKey(options);
  const schema = parseSchema(options.schema);
  const value = await new RuleCache(options.cacheDir).load(key);
  if (value === null) throw new ConfigError('No learned extraction rule matches this name, origin, schema and context', 'Learn and validate a rule before running it.');
  const entry = parseEntry(value, key, schema);
  const result = extractWithRule(sanitizeSnapshot(options.page), options.schema, entry.rule);
  if (result.templateHash !== entry.templateHash) {
    result.status = 'invalid';
    result.issues.push({ field: '*', code: 'template', message: 'Page structure differs from the validated template' });
  }
  if (result.issues.some(issue => issue.code === 'scope')) throw new ConfigError('Page is outside the learned URL scope; learn a separate rule instead of repairing its scope');
  if (result.status === 'invalid' && options.repair) {
    return learn({ ...options, ...options.repair }, entry, result.issues);
  }
  return { ...result, cache: { key, revision: entry.revision, state: result.status === 'invalid' ? 'invalid' : 'hit' } };
}

import { readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ArgumentError } from '@jackwener/opencli/errors';
import { createRuleGenerator, SNAPSHOT_EXPRESSION, sanitizeSnapshot } from '@jackwener/opencli/extraction';

export const commonArgs = [
  { name: 'name', positional: true, required: true, help: 'Name of the learned rule' },
  { name: 'schema', required: true, help: 'Path to a flat scalar JSON Schema' },
  { name: 'context', required: true, help: 'Non-secret account/view/locale identifier for cache isolation' },
  { name: 'snapshot', required: true, help: 'Snapshot JSON file produced by learned-extract capture' },
  { name: 'cache-dir', help: 'Rule cache directory (default ~/.opencli/extraction-rules)' },
];

export const learningArgs = [
  { name: 'samples', help: 'Validation manifest with 2-8 independently checked snapshots' },
  { name: 'rule', help: 'Proposed rule JSON file; no model request is made' },
  { name: 'endpoint', help: 'Explicit full /chat/completions endpoint; sends sample HTML to that endpoint' },
  { name: 'model', help: 'Exact model name at the configured endpoint' },
  { name: 'timeout', type: 'int', default: 60, help: 'Model request timeout in seconds' },
];

export async function readJson(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 4_000_000) throw new ArgumentError('JSON input must be a file of at most 4 MB');
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new ArgumentError('Input is not valid JSON'); }
}

export async function optionsFrom(args) {
  return {
    name: args.name,
    context: args.context,
    cacheDir: args['cache-dir'] || join(homedir(), '.opencli', 'extraction-rules'),
    schema: await readJson(args.schema),
    page: await readJson(args.snapshot),
  };
}

export async function learningFrom(args) {
  if (!args.samples) throw new ArgumentError('--samples is required when learning or repairing a rule');
  const manifest = await readJson(args.samples);
  if (!Array.isArray(manifest)) throw new ArgumentError('Samples must be an array of {snapshot, expected} entries');
  const samples = await Promise.all(manifest.map(async item => {
    if (!item || typeof item.snapshot !== 'string' || !item.expected) throw new ArgumentError('Each sample needs a snapshot path and expected object');
    const snapshotPath = isAbsolute(item.snapshot) ? item.snapshot : resolve(dirname(args.samples), item.snapshot);
    return { page: await readJson(snapshotPath), expected: item.expected };
  }));
  if (args.rule && args.endpoint) throw new ArgumentError('Choose either --rule or --endpoint');
  if (args.rule) return { samples, proposal: await readJson(args.rule) };
  if (!args.endpoint || !args.model) throw new ArgumentError('Provide --rule, or both --endpoint and --model');
  const seconds = Number(args.timeout);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) throw new ArgumentError('--timeout must be 1-120 seconds');
  return { samples, generator: createRuleGenerator({
    endpoint: args.endpoint,
    model: args.model,
    apiKey: process.env.OPENCLI_EXTRACT_API_KEY,
    timeoutMs: seconds * 1000,
  }) };
}

export async function capturePage(page, args) {
  let url;
  try { url = new URL(args.url); } catch { throw new ArgumentError('Expected an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ArgumentError('Expected an HTTP(S) URL without credentials');
  const seconds = Number(args.wait);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) throw new ArgumentError('--wait must be 0-30 seconds');
  // Older bridge extensions can duplicate navigation while creating a new lease.
  await page.evaluate('void 0');
  await page.goto(url.href);
  if (seconds) await page.wait(seconds);
  const snapshot = sanitizeSnapshot(await page.evaluate(SNAPSHOT_EXPRESSION));
  await writeFile(args.output, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { status: 'captured', path: args.output, url: snapshot.url, observedAt: snapshot.observedAt };
}

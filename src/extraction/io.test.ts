import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuleCache } from './cache.js';
import { createRuleGenerator } from './generator.js';

let directory: string;
const key = 'a'.repeat(64);
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'extraction-io-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('extraction cache integrity', () => {
  it('writes private atomic versions and preserves the previous entry', async () => {
    const cache = new RuleCache(directory);
    expect(await cache.load(key)).toBeNull();
    await cache.save(key, { revision: 1 });
    await cache.save(key, { revision: 2 });
    expect(await cache.load(key)).toEqual({ revision: 2 });
    expect(JSON.parse(await readFile(join(directory, `${key}.previous.json`), 'utf8'))).toEqual({ revision: 1 });
    expect((await stat(join(directory, `${key}.json`))).mode & 0o777).toBe(0o600);
  });

  it('rejects traversal, corruption and concurrent updates rather than returning cache misses', async () => {
    const cache = new RuleCache(directory);
    await expect(cache.load('../bad')).rejects.toThrow(/key/);
    await writeFile(join(directory, `${key}.json`), 'broken');
    await expect(cache.load(key)).rejects.toThrow(/invalid JSON/);
    await writeFile(join(directory, `${key}.json.lock`), 'writer');
    await expect(cache.save(key, { revision: 2 })).rejects.toThrow(/being updated/);
  });

  it('rejects a stale revision under the writer lock', async () => {
    const cache = new RuleCache(directory);
    await cache.save(key, { version: 1, key, revision: 1 });
    await cache.save(key, { version: 1, key, revision: 2 });
    await expect(cache.save(key, { version: 1, key, revision: 2 })).rejects.toThrow(/changed while validating/);
    expect(await cache.load(key)).toMatchObject({ revision: 2 });
  });

  it('refuses symlink cache directories and entries', async () => {
    const cache = new RuleCache(directory);
    const target = join(directory, 'target.json');
    await writeFile(target, '{}');
    await symlink(target, join(directory, `${key}.json`));
    await expect(cache.load(key)).rejects.toThrow(/regular file/);
    await expect(cache.save(key, {})).rejects.toThrow(/regular file/);
    const alias = join(directory, 'alias');
    await symlink(directory, alias);
    await expect(new RuleCache(alias).load(key)).rejects.toThrow(/symbolic link/);
  });
});

const envelope = (content = '{"version":1}', finish = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }] }), { headers: { 'content-type': 'application/json' } });
const request = { schema: {}, samples: [] };
const endpoint = 'http://127.0.0.1:1234/v1/chat/completions';

describe('explicit rule model transport', () => {
  it('makes one explicit JSON-only request and does not expose its credentials in the body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(envelope());
    const generate = createRuleGenerator({ endpoint, model: 'local-model', apiKey: 'test-secret', fetchImpl });
    expect(await generate(request)).toEqual({ version: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0][1]!;
    expect(init.redirect).toBe('error');
    expect(init.body).not.toContain('test-secret');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'local-model', response_format: { type: 'json_object' }, stream: false, store: false });
  });

  it('does not retry HTTP failures or print provider secrets', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret provider detail', { status: 429 }));
    const generate = createRuleGenerator({ endpoint, model: 'local', fetchImpl });
    await expect(generate(request)).rejects.toThrow('HTTP 429');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects truncated, invalid JSON and oversized responses', async () => {
    await expect(createRuleGenerator({ endpoint, model: 'local', fetchImpl: vi.fn().mockResolvedValue(envelope('{}', 'length')) })(request)).rejects.toThrow(/incomplete/);
    await expect(createRuleGenerator({ endpoint, model: 'local', fetchImpl: vi.fn().mockResolvedValue(envelope('not JSON')) })(request)).rejects.toThrow(/valid JSON/);
    await expect(createRuleGenerator({ endpoint, model: 'local', fetchImpl: vi.fn().mockResolvedValue(new Response('x', { headers: { 'content-length': '1000001' } })) })(request)).rejects.toThrow(/exceeds/);
  });

  it('rejects insecure remote endpoints, credentials and implicit redirect targets', () => {
    expect(() => createRuleGenerator({ endpoint: 'http://remote.example/v1/chat/completions', model: 'x' })).toThrow();
    expect(() => createRuleGenerator({ endpoint: 'https://user:secret@remote.example/v1/chat/completions', model: 'x' })).toThrow();
    expect(() => createRuleGenerator({ endpoint: endpoint + '?key=secret', model: 'x' })).toThrow();
  });

  it('aborts a real delayed local HTTP request without a retry', async () => {
    let calls = 0;
    const server = createServer((_req, response) => { calls++; setTimeout(() => response.end('{}'), 100); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    try {
      const generate = createRuleGenerator({ endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, model: 'local', timeoutMs: 20 });
      await expect(generate(request)).rejects.toThrow(/timed out/);
      expect(calls).toBeLessThanOrEqual(1);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

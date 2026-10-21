import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigError } from '../errors.js';

const LIMIT = 1_000_000;

async function safeFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new ConfigError('Rule cache path must be a regular file');
    if (info.size > LIMIT) throw new ConfigError('Rule cache file exceeds 1 MB');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export class RuleCache {
  constructor(private readonly directory: string) {}

  private async path(key: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new ConfigError('Invalid extraction cache key');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ConfigError('Rule cache directory must not be a symbolic link');
    return join(this.directory, `${key}.json`);
  }

  async load(key: string): Promise<unknown | null> {
    const path = await this.path(key);
    if (!await safeFile(path)) return null;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await file.stat()).size > LIMIT) throw new ConfigError('Rule cache file exceeds 1 MB');
      const content = await file.readFile('utf8');
      try { return JSON.parse(content); }
      catch { throw new ConfigError('Rule cache contains invalid JSON; inspect or restore its previous version'); }
    } finally { await file.close(); }
  }

  async save(key: string, entry: unknown): Promise<void> {
    const content = JSON.stringify(entry, null, 2);
    if (!content || Buffer.byteLength(content) > LIMIT) throw new ConfigError('Rule cache entry exceeds 1 MB or is not JSON');
    const path = await this.path(key);
    const previous = join(this.directory, `${key}.previous.json`);
    let lock;
    try { lock = await open(`${path}.lock`, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ConfigError('Rule cache is being updated; retry after the writer finishes');
      throw error;
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    const previousTemporary = `${previous}.${randomUUID()}.tmp`;
    try {
      await safeFile(previous);
      const hasCurrent = await safeFile(path);
      const proposed = entry && typeof entry === 'object' ? entry as Record<string, unknown> : undefined;
      if (proposed?.version === 1 && proposed.key === key && typeof proposed.revision === 'number' && !hasCurrent && proposed.revision !== 1) throw new ConfigError('Rule cache changed while validating; reload before saving');
      if (hasCurrent) {
        const old = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let oldContent: string;
        try { oldContent = await old.readFile('utf8'); } finally { await old.close(); }
        const current = JSON.parse(oldContent) as Record<string, unknown>;
        if (proposed?.version === 1 && proposed.key === key && typeof proposed.revision === 'number' && proposed.revision !== Number(current.revision) + 1) throw new ConfigError('Rule cache changed while validating; reload before saving');
        const backup = await open(previousTemporary, 'wx', 0o600);
        try { await backup.writeFile(oldContent); await backup.sync(); } finally { await backup.close(); }
        await rename(previousTemporary, previous);
      }
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(content + '\n'); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
    } finally {
      await lock.close();
      await Promise.all([temporary, previousTemporary, `${path}.lock`].map(file => unlink(file).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      })));
    }
  }
}

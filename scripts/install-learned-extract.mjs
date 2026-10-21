import { cp, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'dist', 'learned-extract-plugin', 'opencli-plugin.json'), 'utf8'));
const destination = resolve(process.argv[2] || join(homedir(), '.local', 'share', 'opencli', 'learned-extract', `${manifest.version}-${new Date().toISOString().replace(/[^0-9]/g, '')}`));
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
await mkdir(destination, { recursive: false, mode: 0o700 });
await cp(join(root, 'dist', 'learned-extract-plugin'), destination, { recursive: true, force: false, errorOnExist: true });
execFileSync('opencli', ['plugin', 'install', `file://${destination}`], { stdio: 'inherit' });
console.log(`Installed from durable directory: ${destination}`);

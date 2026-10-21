import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist', 'learned-extract-plugin');
await mkdir(join(output, 'lib'), { recursive: true });
const source = join(root, 'clis', 'learned-extract');
const manifest = JSON.parse(await readFile(join(source, 'opencli-plugin.json'), 'utf8'));
for (const name of ['capture.js', 'learn.js', 'run.js', '_shared.js', 'amazon-reviews.js']) {
  const content = (await readFile(join(source, name), 'utf8'))
    .replaceAll("from '@jackwener/opencli/extraction'", "from './lib/extraction/index.js'")
    .replaceAll("from '../amazon/discussion-core.js'", "from './lib/amazon/discussion-core.js'");
  await writeFile(join(output, name), content);
}
const amazonCommand = (await readFile(join(root, 'clis', 'amazon', 'discussion.js'), 'utf8'))
  .replaceAll("from './discussion-core.js'", "from './lib/amazon/discussion-core.js'");
await writeFile(join(output, 'amazon-discussion.js'), amazonCommand);
await cp(join(root, 'dist', 'src', 'extraction'), join(output, 'lib', 'extraction'), {
  recursive: true,
  filter: path => !path.endsWith('.test.js') && !path.endsWith('.test.d.ts'),
});
await mkdir(join(output, 'lib', 'amazon'), { recursive: true });
for (const name of ['discussion-core.js', 'shared.js']) {
  await cp(join(root, 'clis', 'amazon', name), join(output, 'lib', 'amazon', name));
}
await cp(join(root, 'dist', 'src', 'errors.js'), join(output, 'lib', 'errors.js'));
await writeFile(join(output, 'lib', 'extraction', 'package.json'), '{"type":"module"}\n');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(output, 'package.json'), JSON.stringify({
  name: 'opencli-plugin-learned-extract', version: manifest.version, type: 'module',
  description: 'Validated reusable extraction rules with field evidence',
  license: 'Apache-2.0', dependencies: { linkedom: pkg.dependencies.linkedom },
  peerDependencies: { '@jackwener/opencli': '>=2.0.0 <3.0.0' },
}, null, 2) + '\n');
await writeFile(join(output, 'opencli-plugin.json'), JSON.stringify({
  name: manifest.name, version: manifest.version, opencli: '>=2.0.0 <3.0.0',
  description: 'Validated reusable read-only extraction rules with checked samples',
}, null, 2) + '\n');
await cp(join(root, 'LICENSE'), join(output, 'LICENSE'));
await cp(join(source, 'README.md'), join(output, 'README.md'));
console.log(output);

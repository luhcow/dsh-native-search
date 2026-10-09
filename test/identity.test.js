import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SEARCH_PROVIDER_ID } from '../lib/search.js';
import { requestHeaders } from '../lib/protocols.js';

const ID = 'dsh-native-search';
const readProjectFile = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('package and search provider use the standalone project name', async () => {
  const manifest = JSON.parse(await readProjectFile('package.json'));
  assert.equal(manifest.name, ID);
  assert.equal(SEARCH_PROVIDER_ID, ID);
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
});

test('bundle patch and plugin export register the same identity', async () => {
  const patch = await readProjectFile('cordis.patch.yml');
  const entry = await readProjectFile('lib/index.js');
  assert.match(patch, new RegExp(`^    - id: ${ID}$`, 'm'));
  assert.match(patch, new RegExp(`^      name: ${ID}$`, 'm'));
  assert.match(entry, new RegExp(`^export const name = '${ID}';$`, 'm'));
});

test('documented configuration selects the standalone search provider', async () => {
  const readme = await readProjectFile('README.md');
  assert.match(readme, new RegExp(`^- id: ${ID}$`, 'm'));
  assert.match(readme, new RegExp(`^    searchProvider: ${ID}$`, 'm'));
});

test('provider-specific user agent uses the standalone project name', () => {
  assert.equal(requestHeaders('copilot-responses', 'auto', 'fake-key')['User-Agent'], ID);
});

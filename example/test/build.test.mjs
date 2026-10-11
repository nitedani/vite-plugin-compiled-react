import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('build', () => {
  let html;
  before(async () => {
    process.chdir(root);
    const { build } = await import('vike/api');
    await build({ viteConfig: { logLevel: 'warn' } });
    const { renderPage } = await import('vike/server');
    ({ body: html } = (await renderPage({ urlOriginal: '/' })).httpResponse);
  });

  it('renders the css prop as a class whose rule is in a linked stylesheet', async () => {
    assertCompiled(html);
    const stylesheets = await Promise.all(
      [...html.matchAll(/<link rel="stylesheet"[^>]* href="([^"]+)"/g)].map(
        ([, href]) => readFile(`${root}/dist/client${href}`, 'utf8'),
      ),
    );
    assert.match(stylesheets.join('\n'), /\._syazruxl\{color:orange\}/);
  });
});

function assertCompiled(html) {
  assert.doesNotMatch(html, /css="\[object Object\]"/);
  assert.match(html, /<h1 class="_syazruxl">Welcome<\/h1>/);
}

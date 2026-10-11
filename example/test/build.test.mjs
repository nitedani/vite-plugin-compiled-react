import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('build', () => {
  let render;
  before(async () => {
    process.chdir(root);
    const { build } = await import('vike/api');
    await build({ viteConfig: { logLevel: 'warn' } });
    const { renderPage } = await import('vike/server');
    render = async urlOriginal =>
      (await renderPage({ urlOriginal })).httpResponse.body;
  });

  it('renders the css prop as a class whose rule is in a linked stylesheet', async () => {
    const html = await render('/');
    assertCompiled(html);
    assert.match(await linkedCss(html), /\._syazruxl\{color:orange\}/);
  });

  it("links the rules of every module in Compiled's order", async () => {
    // The about page's paragraph and the layout's footer share a base rule, which the footer's
    // media query must follow.
    const css = await linkedCss(await render('/about'));
    assert.ok(css.lastIndexOf('{color:gray}') < css.indexOf('@media'), css);
  });
});

function linkedCss(html) {
  return Promise.all(
    [...html.matchAll(/<link rel="stylesheet"[^>]* href="([^"]+)"/g)].map(
      ([, href]) => readFile(`${root}/dist/client${href}`, 'utf8'),
    ),
  ).then(sheets => sheets.join('\n'));
}

function assertCompiled(html) {
  assert.doesNotMatch(html, /css="\[object Object\]"/);
  assert.match(html, /<h1 class="_syazruxl">Welcome<\/h1>/);
}

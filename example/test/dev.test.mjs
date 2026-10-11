import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('dev', () => {
  let server;
  before(async () => {
    const { createServer } = await import('vite');
    server = await createServer({
      root,
      logLevel: 'warn',
      server: { middlewareMode: true },
    });
  });
  after(() => server?.close());

  it('renders the css prop as a class and serves its rule', async () => {
    const { renderPage } = await import('vike/server');
    const { httpResponse } = await renderPage({ urlOriginal: '/' });
    const html = httpResponse.body;
    assertCompiled(html);
    // The browser requests the stylesheet's id under /@id/, with \0 encoded.
    const [, id] = html.match(
      /"\/@id\/__x00__(virtual:vite-plugin-compiled-react:[^"]+)"/,
    );
    const { code } = await server.environments.client.transformRequest(
      '\0' + id,
    );
    assert.match(code, /\._syazruxl\{color:orange\}/);
  });
});

function assertCompiled(html) {
  assert.doesNotMatch(html, /css="\[object Object\]"/);
  assert.match(html, /<h1 class="_syazruxl">Welcome<\/h1>/);
}

import assert from 'node:assert/strict';
import { it } from 'node:test';

it('loads extracted CSS only for the resolved virtual module id', async () => {
  const { compiled } = await import('../lib/index.js');
  const plugin = compiled({ extract: true });
  plugin.configResolved({ root: '/project', resolve: { alias: [] } });
  const environment = {
    name: 'client',
    config: { resolve: { conditions: [] } },
  };

  const result = await plugin.transform.call(
    { environment },
    "export const Page = () => <div css={{ color: 'red' }} />;",
    '/project/src/Page.jsx'
  );
  const [, source] = result.code.match(
    /"(virtual:vite-plugin-compiled-react:[^"]+)"/
  );
  const resolved = plugin.resolveId.call({ environment }, source);
  assert.equal(resolved, '\0' + source);

  const load = id => plugin.load.call({ environment }, id);
  assert.match(load(resolved), /color:red/);
  assert.match(load(resolved + '?direct'), /color:red/);
  // Unresolved ids and ids merely containing the name are not this plugin's.
  assert.equal(load(source), undefined);
  assert.equal(load('/project/src/' + source), undefined);
});

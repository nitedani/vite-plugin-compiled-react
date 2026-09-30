import assert from 'node:assert/strict';
import { it } from 'node:test';

// @vitejs/plugin-react 6 no longer runs in server environments, so under RSC this plugin's own
// transform is the only thing compiling `css` props on server components. Those are usually
// .tsx files, which Babel must be able to parse before Vite strips the types.
it('compiles the css prop of a TypeScript component in a server environment', async () => {
  const { compiled } = await import('../lib/index.js');
  const plugin = compiled({ extract: true });
  plugin.configResolved({ root: '/project', resolve: { alias: [] } });

  const code = `
import type { ReactNode } from 'react';
interface Props { children: ReactNode }
export default function Card({ children }: Props): ReactNode {
  const label: string = 'card';
  return <section aria-label={label} css={{ color: 'red' }}>{children}</section>;
}
`;
  const environment = { name: 'rsc', config: { consumer: 'server' } };
  const result = await plugin.transform.call(
    { environment },
    code,
    '/project/pages/index/Card.tsx'
  );

  assert.ok(result, 'the file was not transformed');
  assert.match(result.code, /className=\{ax\(/);
  assert.doesNotMatch(result.code, /\bcss=\{/);
  // Types are only parsed, not stripped: lowering them is left to Vite.
  assert.match(result.code, /interface Props/);
  const cssImport = result.code.match(/"(virtual:vite-plugin-compiled-react:[^"]+)"/);
  assert.ok(cssImport, 'no extracted stylesheet import');
  assert.match(plugin.load.call({ environment }, '\0' + cssImport[1]), /color:red/);
});

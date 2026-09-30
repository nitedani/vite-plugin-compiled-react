import assert from 'node:assert/strict';
import { it } from 'node:test';
import { compiled } from '../lib/index.js';

it('only rewrites alias targets inside the root', async () => {
  for (const replacement of ['/project-other/src', '/else/project/src']) {
    const plugin = compiled();
    plugin.configResolved({
      root: '/project',
      command: 'build',
      resolve: { alias: [{ find: '@', replacement }] },
    });
    const result = await plugin.transform.call(
      {},
      "import { x } from '@/styles'; export const Page = () => <div>{x}</div>;",
      '/project/src/pages/Page.jsx',
    );
    assert.ok(
      result.code.includes(`from "${replacement}/styles"`),
      replacement,
    );
  }
});

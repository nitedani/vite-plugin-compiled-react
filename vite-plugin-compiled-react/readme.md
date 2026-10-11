# vite-plugin-compiled-react

Vite plugin for [Compiled](https://compiledcssinjs.com), the CSS-in-JS library: write the `css` prop on any element, get atomic CSS that Vite bundles and links like any other CSS. It works in client, SSR and React Server Components environments.

## Install

```sh
npm i @compiled/react
npm i -D vite-plugin-compiled-react
```

## Usage

```js
// vite.config.js
import react from '@vitejs/plugin-react';
import { compiled } from 'vite-plugin-compiled-react';

export default {
  plugins: [react(), compiled()],
};
```

```jsx
const Greeting = () => (
  <p css={{ color: 'red', ':hover': { color: 'blue' } }}>Hello</p>
);
```

The `css` prop works in `.jsx` and `.tsx` files without importing Compiled. Compiled's other APIs (`css()`, `styled`, `cssMap`, `keyframes`) are imported from `@compiled/react` as usual, in `.js`, `.jsx`, `.ts` and `.tsx` files.

Styles can use values imported from other modules, including through your `resolve.alias` entries.

The `css` prop is typed on every HTML and SVG element once the plugin's types are part of your TypeScript program: either your `vite.config.ts` is, or add the plugin to `compilerOptions.types`:

```json
{
  "compilerOptions": {
    "types": ["vite-plugin-compiled-react"]
  }
}
```

## Options

```js
compiled({
  extract: true,
  addComponentName: false,
  optimizeCss: true,
});
```

- `extract` (default `true`): extract the styles into one stylesheet for the whole app, sorted in Compiled's order, which atomic CSS needs to cascade right. It goes through your PostCSS config, and every page links it, including in the server-rendered HTML. With `false`, Compiled's runtime inserts `<style>` elements while rendering instead. Pass `{ build: true, serve: false }` to decide per command, for example when your framework doesn't link CSS in development. Server components always extract, since Compiled's runtime can't run in them.
- `addComponentName` (default `false`): add the component name as a class name to `styled` components outside production.
- `optimizeCss` (default `true`): minify the generated CSS rules.

## Migrating from 1.x

- Requires Vite 6.3 or later and `@compiled/react` 2. `@vitejs/plugin-react` is no longer a peer dependency: the plugin compiles in its own transform.
- `extract` defaults to `true`. Pass `extract: false` to keep the runtime.
- Extracted styles go into one stylesheet linked on every page, not a stylesheet per module.
- The `cache` and `onIncludedFiles` options are removed.
- The plugin no longer adds `@compiled/react` to `ssr.noExternal`.

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

Styles can use values imported from other modules, including through your string `resolve.alias` entries.

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

- `extract` (default `true`): extract the styles into one stylesheet for the whole app, sorted in Compiled's order, which atomic CSS needs to cascade right. It goes through your PostCSS config, and every page links it, including in the server-rendered HTML. It also gets the rules of the `.compiled.css` files that packages such as Atlaskit ship already extracted, in place of their own `<style>` or stylesheet. A library build (`build.lib`) puts the rules in the library's own stylesheet, for example `dist/my-lib.css`. With `build.cssCodeSplit: true`, each stylesheet Vite splits out, for example `dist/index.css`, gets the rules of its own modules. In a library, the rules of different modules follow the order of their modules rather than Compiled's, since Vite gives plugins no way to sort a library's CSS before minifying it. With `extract: false`, Compiled's runtime inserts `<style>` elements while rendering instead. Pass `{ build: true, serve: false }` to decide per command, for example when your framework doesn't link CSS in development. Server components always extract, since Compiled's runtime can't run in them.
- `addComponentName` (default `false`): add the component name as a class name to `styled` components outside production.
- `optimizeCss` (default `true`): minify the generated CSS rules.

## Migrating from 1.x

- Requires Vite 6.3 or later and `@compiled/react` 2. `@vitejs/plugin-react` is no longer a peer dependency: the plugin compiles in its own transform.
- `extract` defaults to `true`. Pass `extract: false` to keep the runtime.
- Extracted styles go into one stylesheet linked on every page, not a stylesheet per module.
- The `cache` and `onIncludedFiles` options are removed.
- The plugin no longer adds `@compiled/react` to `ssr.noExternal`.
- In a build, the files the stylesheet's URLs point to are always emitted, never inlined under `build.assetsInlineLimit`, and their URLs get your `base` rather than going through `experimental.renderBuiltUrl`. To serve them from another host, set `base` to that host's URL.
- A relative URL in a `css` prop resolves from the module that uses the styles, rather than from the project root. Styles shared across folders should use an aliased or root-relative URL.

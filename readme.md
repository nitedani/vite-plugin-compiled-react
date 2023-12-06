# vite-plugin-compiled-react

Vite plugin for https://github.com/atlassian-labs/compiled
PostCSS config is supported

Usage:
```
npm i @compiled/react
npm i -D vite-plugin-compiled-react
```

```ts
import { compiled } from "vite-plugin-compiled-react";

export default defineConfig({
  plugins: [react(), compiled({ extract: true })],
});
```

```tsx
const Component = () => (
  <div
    css={{
      color: "red",
      ":hover": {
        color: "blue",
      },
    }}
  >
   Hello
  </div>
);
```
Typescript should work out of the box.

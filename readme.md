# vite-plugin-compiled-react

Vite plugin for https://github.com/atlassian-labs/compiled

```css
input
css={{ color: "light-dark(green,red)"}}

output
._syaz1602{color:green}[data-mantine-color-scheme=dark]
._syaz1602{color:red}
```

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

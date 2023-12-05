# vite-plugin-compiled-react

Vite plugin for https://github.com/atlassian-labs/compiled


The compiled.css files are temporarily created in the source directory, then removed after build. This way, the Vite css processing pipeline, postcss is applied to the extracted styles. For example, using Mantine:
```css
input
css={{ color: "light-dark(green,red)"}}

output
._syaz1602{color:green}[data-mantine-color-scheme=dark]
._syaz1602{color:red}
```

Usage:
```ts
import { compiled } from "@nitedani/vite-plugin-compiled-react";

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

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

#### For the css props to work, you need to `import "@compiled/react";` on top of the file where you use the css prop.

```tsx
import "@compiled/react";

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
Typescript:
```ts
// types.d.ts
import { CssFunction } from "@compiled/react";
export { };
declare module "react" {
  interface HTMLAttributes<T> extends AriaAttributes, DOMAttributes<T> {
    // extends React's HTMLAttributes
    css?: CssFunction | CssFunction[]
  }
}
```
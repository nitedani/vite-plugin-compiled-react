import type { CssFunction } from "@compiled/react";
declare module "react" {
  interface HTMLAttributes<T> extends AriaAttributes, DOMAttributes<T> {
    // extends React's HTMLAttributes
    css?: CssFunction | CssFunction[];
  }
}

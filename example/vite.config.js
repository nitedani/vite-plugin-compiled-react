import react from "@vitejs/plugin-react";
import vike from "vike/plugin";
import { compiled } from "vite-plugin-compiled-react";

export default {
  plugins: [react(), vike(), compiled({ extract: true, debug: true })],
};

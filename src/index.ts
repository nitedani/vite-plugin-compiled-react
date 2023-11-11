import fg from "fast-glob";
import { rm } from "fs/promises";
import { Plugin } from "vite"

export type CompiledPluginExtractOptions = {
  /**
  Will callback at the end of a file pass with all found style rules.
  */
  onFoundStyleRules?: (rules: string[]) => void

  /**
  When set will prevent additional require (one import per rule) in the bundle and add style rules to meta data. This could be used when enabling style sheet extraction in a different configuration for SSR.
  Defaults to false.
   */
  compiledRequireExclude?: boolean

  /**
  When set, extracts styles to an external CSS file. This is beneficial for building platform components that are to be published on NPM.
   */
  extractStylesToDirectory?: { source: string; dest: string };
}

export type CompiledPluginOptions = {
  /**
  Will import React into the module if it is not found.
  When using \@babel/preset-react with the automatic runtime this is not needed and can be set to false.
  Defaults to true.
  */

  importReact?: boolean;
  /**
  Will cache the result of statically evaluated imports.
  true will cache for the duration of the node process
  'single-pass' will cache for a single pass of a file
  false turns caching off
  Defaults to true.
   */
  cache?: boolean | 'single-pass'

  /**  
  Will run additional cssnano plugins to normalize CSS during build.
  Defaults to true.
   */
  optimizeCss?: boolean;

  /**
  Will callback at the end of a file pass with all imported files that were statically evaluated into the file.
  */
  onIncludedFiles?: (files: string[]) => void

  /**
  Add the component name as class name to DOM in non-production environment if styled is used.
  Default to false
   */
  addComponentName?: boolean

  extract?: boolean | CompiledPluginExtractOptions
}

export const compiled = (options: CompiledPluginOptions = {}): Plugin => {
  let outDir = "";
  let root = "";
  const { extract, ...baseOptions } = options
  return {
    name: "@nitedani/compiled-react-plugin",
    config(config, env) {
      return {
        ssr: {
          // https://github.com/vikejs/vike/issues/621
          noExternal: [/@compiled\/react/],
        },
      };
    },
    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },
    api: {
      reactBabel(babelConfig, context, config) {
        const alias = config.resolve.alias;
        babelConfig.plugins.push(["babel-plugin-module-resolver", { alias }]);
        babelConfig.plugins.push(["@compiled/babel-plugin", baseOptions]);
        if (config.command === "build" && options.extract) {
          babelConfig.plugins.push([
            "@compiled/babel-plugin-strip-runtime",
            typeof options.extract === "object" ? options.extract : { extractStylesToDirectory: { source: root, dest: "" } },
          ]);
        }
      },
    },
    async buildEnd() {
      const entries = await fg(["./**/*.compiled.css"], {
        ignore: [`${outDir}/**`],
        followSymbolicLinks: false,
      });
      for (const e of entries) {
        rm(e);
      }
    },
  };
};
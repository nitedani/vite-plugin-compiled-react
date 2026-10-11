import t from '@babel/types';
import babel from '@babel/core';
import compiledPlugin, {
  type PluginOptions,
  type Resolver,
} from '@compiled/babel-plugin';
import compiledStripRuntimePlugin from '@compiled/babel-plugin-strip-runtime';
import enhancedResolve from 'enhanced-resolve';
import { createHash } from 'crypto';
import path from 'node:path';
import type { CssFunction } from '@compiled/react';
import {
  createFilter,
  normalizePath,
  type Plugin,
  type ResolvedConfig,
} from 'vite';

export type CompiledPluginOptions = Pick<
  PluginOptions,
  'cache' | 'optimizeCss' | 'addComponentName'
> & {
  /**
  Extract the styles into CSS files, for `build` and `serve` separately or for both with `true`.
  Defaults to false.
   */
  extract?: { build: boolean; serve: boolean } | boolean;
};

declare module 'react' {
  interface HTMLAttributes<T> {
    css?: CssFunction | CssFunction[];
  }
  interface SVGAttributes<T> {
    css?: CssFunction | CssFunction[];
  }
}

const virtualCssFiles = new Map<string, string>();
const defaultIncludeRE = /\.[tj]sx?$/;

export const compiled = (options: CompiledPluginOptions = {}): Plugin => {
  const filter = createFilter(defaultIncludeRE);
  // Extracted stylesheets are keyed by this hash: two with the same hash would share one module.
  const hash = (code: string) => {
    return createHash('md5').update(code).digest('hex').slice(0, 16);
  };

  const virtualCssFileName = 'virtual:vite-plugin-compiled-react';
  const resolvedVirtualCssPrefix = `\0${virtualCssFileName}:`;
  const { extract, ...baseOptions } = options;
  let plugins: babel.PluginItem[] = [];
  let resolver: Resolver;
  let extractPlugins: babel.PluginItem[] = [];
  // Compiled reads values from the modules a module imports, so each of those files maps to the
  // modules whose output it is part of.
  const dependents = new Map<string, Set<string>>();

  return {
    name: 'vite-plugin-compiled-react',
    enforce: 'pre',
    config() {
      return {
        ssr: {
          // https://github.com/vikejs/vike/issues/621
          noExternal: [/@compiled\/react/],
        },
      };
    },
    configResolved(config) {
      resolver = createResolver(config);
      plugins = [
        {
          visitor: {
            Program(path) {
              // Vike's ?extractAssets modules are reduced to their CSS imports.
              if (/[?&]extractAssets(&|$)/.test(this.filename)) {
                return;
              }
              // Compiled only compiles the css prop in files importing @compiled/react. A new
              // node per file: an AST node must not be shared between files.
              path.unshiftContainer(
                'body',
                t.importDeclaration([], t.stringLiteral('@compiled/react')),
              );
            },
          },
        },
      ];

      extractPlugins = [];
      if (typeof extract === 'object' ? extract[config.command] : extract) {
        extractPlugins.push([
          compiledStripRuntimePlugin,
          { compiledRequireExclude: true },
        ]);

        extractPlugins.push({
          visitor: {
            Program: {
              exit(path, { file }) {
                const styleRules = file.metadata.styleRules;
                if (styleRules.length) {
                  const code = styleRules.join('\n');
                  const fileId = hash(code) + '.css';
                  virtualCssFiles.set(fileId, code);
                  path.unshiftContainer(
                    'body',
                    t.importDeclaration(
                      [],
                      t.stringLiteral(`${virtualCssFileName}:${fileId}`),
                    ),
                  );
                }
              },
            },
          },
        });
      }
    },
    resolveId(source) {
      if (source.startsWith(`${virtualCssFileName}:`)) {
        return '\0' + source;
      }
    },
    hotUpdate({ file }) {
      // Vite only re-transforms the changed module, not the modules that copied its values.
      const { moduleGraph } = this.environment;
      for (const id of dependents.get(file) ?? []) {
        const mod = moduleGraph.getModuleById(id);
        if (mod) moduleGraph.invalidateModule(mod);
      }
    },
    load(id) {
      if (id.startsWith(resolvedVirtualCssPrefix)) {
        const [fileId] = id.slice(resolvedVirtualCssPrefix.length).split('?');
        return virtualCssFiles.get(fileId);
      }

      if (
        (this.environment.config.resolve.conditions.includes('react-server') ||
          this.environment.name === 'rsc') &&
        /@compiled\/react\/dist\/.*\/style-cache.js/.test(id)
      ) {
        return `export default {};
                export const useCache = () => {
                  throw new Error("Please set extract: true in compiled plugin options for RSC support");
                };
                `;
      }
    },
    async transform(code, id) {
      // Keep the same default boundary as @vitejs/plugin-react: dependencies are excluded, the
      // query is stripped before filtering, and plain .js/.ts files are eligible as well.
      if (id.includes('/node_modules/')) {
        return;
      }
      const [filepath] = id.split('?');
      if (!filepath || !filter(filepath)) {
        return;
      }
      if (
        !filepath.endsWith('x') &&
        !code.includes("'@compiled/react'") &&
        !code.includes('"@compiled/react"')
      ) {
        return;
      }
      const res = await babel.transformAsync(code, {
        filename: id,
        sourceFileName: filepath,
        sourceMaps: true,
        // React's dev runtime reports the line numbers its JSX transform sees.
        retainLines: true,
        plugins: [
          ...plugins,
          [
            compiledPlugin,
            {
              importReact: false,
              ...baseOptions,
              resolver,
              onIncludedFiles(files: string[]) {
                for (const included of files.map(normalizePath)) {
                  dependents.set(included, (dependents.get(included) ?? new Set()).add(id));
                }
              },
            },
          ],
          ...extractPlugins,
        ],
        // Parse only: TypeScript and JSX are left for Vite's own transform. Babel must still
        // understand them, otherwise annotations and `interface` are syntax errors here. JSX
        // stays off in .ts files, where it would reject `<string>value` type assertions.
        parserOpts: {
          plugins: filepath.endsWith('.ts')
            ? ['typescript']
            : filepath.endsWith('.tsx')
              ? ['jsx', 'typescript']
              : ['jsx'],
        },
        configFile: false,
        babelrc: false,
      });

      if (!res || !res.code) {
        return;
      }

      return {
        code: res.code,
        map: res.map,
      };
    },
  };
};

// Compiled resolves the imports it reads values from on its own, so it gets Vite's string aliases,
// extensions and `/` paths relative to the root.
function createResolver(config: ResolvedConfig): Resolver {
  const resolveSync = enhancedResolve.create.sync({
    alias: config.resolve.alias.flatMap(({ find, replacement }) =>
      typeof find === 'string' ? [{ name: find, alias: replacement }] : [],
    ),
    roots: [config.root],
    extensions: config.resolve.extensions,
    conditionNames: ['import', 'module', 'default'],
    mainFields: ['module', 'main'],
  });
  return {
    resolveSync: (context, request) =>
      resolveSync(path.dirname(context), request) as string,
  };
}

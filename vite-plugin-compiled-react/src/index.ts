import babel, { type PluginItem, type PluginObj } from '@babel/core';
import compiledBabelPlugin, { type Resolver } from '@compiled/babel-plugin';
import stripRuntimeBabelPlugin, {
  type BabelFileMetadata,
} from '@compiled/babel-plugin-strip-runtime';
import type { CssFunction } from '@compiled/react';
import enhancedResolve from 'enhanced-resolve';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizePath, type Plugin, type ResolvedConfig } from 'vite';

export type CompiledPluginOptions = {
  /**
   * Extract the styles into CSS files, which Vite bundles and links like any other CSS.
   * With `false`, Compiled's runtime inserts them while rendering.
   * `{ build, serve }` decides per Vite command.
   *
   * @default false
   */
  extract?: boolean | { build: boolean; serve: boolean };
  /**
   * Add the component name as a class name to `styled` components outside production.
   *
   * @default false
   */
  addComponentName?: boolean;
  /**
   * Minify the generated CSS rules.
   *
   * @default true
   */
  optimizeCss?: boolean;
};

declare module 'react' {
  interface HTMLAttributes<T> {
    css?: CssFunction | CssFunction[];
  }
  interface SVGAttributes<T> {
    css?: CssFunction | CssFunction[];
  }
}

const stylesheetPrefix = 'virtual:vite-plugin-compiled-react:';
// Extracted stylesheets by the hash of their CSS: modules with the same CSS share one stylesheet.
const stylesheets = new Map<string, string>();

export function compiled(options: CompiledPluginOptions = {}): Plugin {
  let extract: boolean;
  let resolver: Resolver;
  // Compiled reads values from the modules a module imports, so each of those files maps to the
  // modules whose output it is part of.
  const dependents = new Map<string, Set<string>>();

  return {
    name: 'vite-plugin-compiled-react',
    enforce: 'pre',
    config: () => ({
      // https://github.com/vikejs/vike/issues/621
      ssr: { noExternal: [/@compiled\/react/] },
    }),
    configResolved(config) {
      extract =
        typeof options.extract === 'object'
          ? options.extract[config.command]
          : !!options.extract;
      resolver = createResolver(config);
    },
    resolveId(id) {
      if (id.startsWith(stylesheetPrefix)) {
        return '\0' + id;
      }
    },
    load(id) {
      if (id.startsWith('\0' + stylesheetPrefix)) {
        const [name] = id.slice(1 + stylesheetPrefix.length).split('?');
        return stylesheets.get(name!);
      }
      if (
        (this.environment.config.resolve.conditions.includes('react-server') ||
          this.environment.name === 'rsc') &&
        /@compiled\/react\/dist\/.*\/style-cache.js/.test(id)
      ) {
        return `export default {};
export const useCache = () => {
  throw new Error("Please set extract: true in compiled plugin options for RSC support");
};`;
      }
    },
    transform: {
      async handler(code, id) {
        // Like @vitejs/plugin-react: source modules, with or without a query.
        const [file] = id.split('?') as [string];
        if (id.includes('/node_modules/') || !/\.[jt]sx?$/.test(file)) {
          return;
        }
        // The css prop works in JSX without importing Compiled; anything else needs the import.
        const isJsxFile = /\.[jt]sx$/.test(file);
        if (!isJsxFile && !code.includes('@compiled/react')) {
          return;
        }
        const result = await babel.transformAsync(code, {
          filename: file,
          sourceMaps: true,
          // React's dev runtime reports the line numbers its JSX transform sees.
          retainLines: true,
          configFile: false,
          babelrc: false,
          // Parse only: Vite transforms TypeScript and JSX afterwards. JSX is off in .ts files,
          // where it would reject `<string>value` type assertions.
          parserOpts: {
            plugins: file.endsWith('.ts')
              ? ['typescript']
              : file.endsWith('.tsx')
                ? ['jsx', 'typescript']
                : ['jsx'],
          },
          plugins: [
            isJsxFile && enableCssProp,
            [
              compiledBabelPlugin,
              {
                importReact: false,
                addComponentName: options.addComponentName,
                optimizeCss: options.optimizeCss,
                resolver,
                onIncludedFiles(files: string[]) {
                  for (const included of files.map(normalizePath)) {
                    dependents.set(included, (dependents.get(included) ?? new Set()).add(id));
                  }
                },
              },
            ],
            extract && [
              stripRuntimeBabelPlugin,
              { compiledRequireExclude: true },
            ],
            extract && importStylesheet,
          ].filter(Boolean) as PluginItem[],
        });
        if (result?.code) {
          return { code: result.code, map: result.map };
        }
      },
    },
    hotUpdate({ file }) {
      // Vite only re-transforms the changed module, not the modules that copied its values.
      const { moduleGraph } = this.environment;
      for (const id of dependents.get(file) ?? []) {
        const mod = moduleGraph.getModuleById(id);
        if (mod) moduleGraph.invalidateModule(mod);
      }
    },
  };
}

// Compiled only compiles the css prop in modules importing @compiled/react.
function enableCssProp({ types: t }: typeof babel): PluginObj {
  return {
    visitor: {
      Program(program) {
        program.unshiftContainer(
          'body',
          t.importDeclaration([], t.stringLiteral('@compiled/react')),
        );
      },
    },
  };
}

// Imports the rules that @compiled/babel-plugin-strip-runtime moved to the file's metadata.
function importStylesheet({ types: t }: typeof babel): PluginObj {
  return {
    visitor: {
      Program: {
        exit(program, { file }) {
          const { styleRules } = file.metadata as unknown as BabelFileMetadata;
          if (!styleRules?.length) return;
          const css = styleRules.join('\n');
          const name = `${createHash('md5').update(css).digest('hex').slice(0, 16)}.css`;
          stylesheets.set(name, css);
          program.unshiftContainer(
            'body',
            t.importDeclaration([], t.stringLiteral(stylesheetPrefix + name)),
          );
        },
      },
    },
  };
}

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

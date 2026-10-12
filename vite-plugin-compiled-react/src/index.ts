import babel, { type PluginItem, type PluginObj, type types } from '@babel/core';
// @ts-expect-error The package has no types.
import transformJsxBabelPlugin from '@babel/plugin-transform-react-jsx';
import compiledBabelPlugin, { type Resolver } from '@compiled/babel-plugin';
import stripRuntimeBabelPlugin, {
  type BabelFileMetadata,
} from '@compiled/babel-plugin-strip-runtime';
import { sort } from '@compiled/css';
import type { CssFunction } from '@compiled/react';
import enhancedResolve from 'enhanced-resolve';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  normalizePath,
  preprocessCSS,
  type Environment,
  type LibraryOptions,
  type Plugin,
  type ResolvedConfig,
  type Rollup,
  type Update,
  type ViteDevServer,
} from 'vite';

export type CompiledPluginOptions = {
  /**
   * Extract the styles into CSS files, which Vite bundles and links like any other CSS.
   * With `false`, Compiled's runtime inserts them while rendering.
   * `{ build, serve }` decides per Vite command.
   * React Server Components always extract: the runtime can't run there.
   *
   * @default true
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

const stylesheetName = 'vite-plugin-compiled-react.css';
const stylesheetId = `virtual:${stylesheetName}`;
const stylesheetRE = /^\0virtual:vite-plugin-compiled-react\.css(?:\?|$)/;
// In dev, browsers get the stylesheet from a script that keeps the newest of its versions.
const browserStylesheetId = 'virtual:vite-plugin-compiled-react.js';
const browserStylesheetRE = /^\0virtual:vite-plugin-compiled-react\.js(?:\?|$)/;
// React Server environments that bundle @compiled/react have no createContext(), which this
// module calls when imported.
const styleCacheRE = /\/@compiled\/react\/dist\/.+\/style-cache\.js(?:\?|$)/;

export function compiled(options: CompiledPluginOptions = {}): Plugin[] {
  let extract: boolean;
  let resolver: Resolver;
  let server: ViteDevServer | undefined;
  // Atomic rules only cascade right in Compiled's order, which separate stylesheets can't keep, so
  // all extracted rules go into one stylesheet.
  const rules = new Set<string>();
  // Compiled reads values from the modules a module imports, so each of those files maps to the
  // modules whose output it is part of.
  const dependents = new Map<string, Set<string>>();
  const addDependent = (file: string, id: string) =>
    dependents.set(file, (dependents.get(file) ?? new Set()).add(id));
  // Compiled's sort keeps the order of rules of the same kind: sorting them first makes a build's
  // stylesheet, and its file name, the same whatever order its modules compile in.
  const stylesheet = () => sort([...rules].sort().join(''));
  const processStylesheet = async (config: ResolvedConfig) =>
    (await preprocessCSS(stylesheet(), path.join(config.root, stylesheetName), config)).code;

  const plugin: Plugin = {
    name: 'vite-plugin-compiled-react',
    enforce: 'pre',
    // A build's client stylesheet then has the rules of the environments built before it.
    sharedDuringBuild: true,
    configResolved(config) {
      extract =
        typeof options.extract === 'object'
          ? options.extract[config.command]
          : (options.extract ?? true);
      resolver = createResolver(config);
    },
    configureServer(devServer) {
      server = devServer;
    },
    resolveId: {
      filter: { id: /^virtual:vite-plugin-compiled-react\.css$/ },
      handler(id) {
        return server && this.environment.config.consumer === 'client'
          ? '\0' + browserStylesheetId
          : '\0' + id;
      },
    },
    load: {
      filter: { id: [stylesheetRE, browserStylesheetRE, styleCacheRE] },
      async handler(id) {
        if (styleCacheRE.test(id)) {
          return isReactServer(this.environment)
            ? `export default {};
export const useCache = () => {
  throw new Error("[vite-plugin-compiled-react] Compiled's runtime can't render styles in React Server Components.");
};`
            : undefined;
        }
        if (stylesheetRE.test(id)) return stylesheet();
        const version = rules.size;
        const code = await processStylesheet(this.environment.config);
        // A page can run an older version after a newer one: the version with more rules wins.
        return `import { updateStyle } from '/@vite/client';
if (!(import.meta.hot.data.rules >= ${version})) {
  import.meta.hot.data.rules = ${version};
  updateStyle(${JSON.stringify('\0' + stylesheetId)}, ${JSON.stringify(code)});
}
import.meta.hot.accept();`;
      },
    },
    transform: {
      // Like @vitejs/plugin-react: source modules, with or without a query.
      filter: {
        id: { include: /\.[jt]sx?(?:\?|$)/, exclude: /\/node_modules\// },
        code: /css|@compiled\/react/,
      },
      async handler(code, id) {
        const [file] = id.split('?') as [string];
        // The css prop works in JSX without importing Compiled; anything else needs the import.
        const isJsxFile = /\.[jt]sx$/.test(file);
        if (!isJsxFile && !code.includes('@compiled/react')) {
          return;
        }
        const extractStyles = extract || isReactServer(this.environment);
        const ast = await parse(code, file);
        if (server) {
          // Compiled doesn't report the files it reads a member expression from, and TypeScript
          // drops the imports whose values Compiled inlined, which Vite's module graph then misses.
          for (const source of await valueSources(resolver, file, ast)) {
            addDependent(source, id);
          }
        }
        const result = await babel.transformFromAstAsync(ast, code, {
          filename: file,
          cloneInputAst: false,
          sourceMaps: true,
          // React's dev runtime reports the line numbers its JSX transform sees.
          retainLines: true,
          configFile: false,
          babelrc: false,
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
                  for (const included of files) addDependent(normalizePath(included), id);
                },
              },
            ],
            extractStyles && [
              stripRuntimeBabelPlugin,
              { compiledRequireExclude: true },
            ],
            extractStyles && server && importStylesheet,
            // `styled` compiles to JSX, which Vite doesn't expect in .ts and .js files.
            !isJsxFile && [transformJsxBabelPlugin, { runtime: 'automatic' }],
          ].filter(Boolean) as PluginItem[],
        });
        if (!result?.code) return;
        const { styleRules = [] } = result.metadata as unknown as BabelFileMetadata;
        const ruleCount = rules.size;
        for (const rule of styleRules) rules.add(rule);
        if (server && rules.size > ruleCount) refreshStylesheet(server);
        return { code: result.code, map: result.map };
      },
    },
    async generateBundle(_, bundle) {
      const { config } = this.environment;
      // React Server environments build before the client, whose stylesheet has their rules too.
      if (
        !rules.size ||
        !config.build.emitAssets ||
        isReactServer(this.environment) ||
        config.build.lib
      ) {
        return;
      }
      const source = await processStylesheet(config);
      const fileName = this.getFileName(
        this.emitFile({ type: 'asset', name: stylesheetName, source }),
      );
      // Every page links it: HTML and manifest-based frameworks link the CSS of their entry chunks.
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && chunk.isEntry) {
          chunk.viteMetadata!.importedCss.add(fileName);
        }
      }
    },
    hotUpdate({ file, modules }) {
      // Vite re-transforms and updates the modules that copied the changed file's values only
      // once they're returned here: some don't even import it any more.
      const { moduleGraph } = this.environment;
      const dependentModules = [...(dependents.get(file) ?? [])].flatMap(
        id => moduleGraph.getModuleById(id) ?? [],
      );
      if (dependentModules.length) return [...modules, ...dependentModules];
    },
  };

  // A library's consumers import its one stylesheet, which Vite emits after the plugin's
  // generateBundle.
  const library: Plugin = {
    name: 'vite-plugin-compiled-react:library',
    generateBundle: {
      order: 'post',
      async handler(_, bundle) {
        const { config } = this.environment;
        if (!rules.size || !config.build.emitAssets || !config.build.lib) return;
        const name = await libraryStylesheetName(config.root, config.build.lib);
        const source = await processStylesheet(config);
        const own = Object.values(bundle).find(
          (output): output is Rollup.OutputAsset =>
            output.type === 'asset' && output.names.includes(name),
        );
        if (own) own.source += source;
        else this.emitFile({ type: 'asset', name, source });
      },
    },
  };

  return [plugin, library];
}

// Vite's file name for a library's stylesheet.
async function libraryStylesheetName(root: string, { cssFileName, fileName }: LibraryOptions) {
  if (typeof cssFileName === 'string') return `${cssFileName}.css`;
  if (typeof fileName === 'string') return `${fileName}.css`;
  for (let dir = root; ; dir = path.dirname(dir)) {
    const { name } = JSON.parse(
      await readFile(path.join(dir, 'package.json'), 'utf8').catch(() => '{}'),
    );
    if (name) return `${name.replace(/^@[^/]+\//, '')}.css`;
    if (dir === path.dirname(dir)) return stylesheetName;
  }
}

// Parse only: Vite transforms TypeScript and JSX afterwards. JSX is off in .ts files, where it
// would reject `<string>value` type assertions.
async function parse(code: string, file: string) {
  const ast = await babel.parseAsync(code, {
    filename: file,
    configFile: false,
    babelrc: false,
    parserOpts: {
      plugins: file.endsWith('.ts')
        ? ['typescript']
        : file.endsWith('.tsx')
          ? ['jsx', 'typescript']
          : ['jsx'],
    },
  });
  return ast!;
}

// The local files a module's styles can read values from: the modules it imports, and the
// modules those re-export.
async function valueSources(resolver: Resolver, file: string, ast: types.File) {
  const sources = new Set<string>();
  const follow = async (importer: string, requests: string[]) => {
    for (const request of requests) {
      let source: string;
      try {
        source = normalizePath(resolver.resolveSync(importer, request));
      } catch {
        continue;
      }
      if (sources.has(source) || source.includes('/node_modules/')) continue;
      sources.add(source);
      await follow(source, await reexports(source));
    }
  };
  await follow(
    file,
    ast.program.body.flatMap(node =>
      node.type === 'ImportDeclaration' ? [node.source.value] : [],
    ),
  );
  return sources;
}

// Parsed once per change of the file.
const reexportsCache = new Map<string, { mtimeMs: number; requests: string[] }>();

async function reexports(file: string) {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return [];
  const { mtimeMs } = await stat(file);
  const cached = reexportsCache.get(file);
  if (cached?.mtimeMs === mtimeMs) return cached.requests;
  const requests = await parse(await readFile(file, 'utf8'), file).then(
    ast =>
      ast.program.body.flatMap(node =>
        (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
        node.source
          ? [node.source.value]
          : [],
      ),
    () => [],
  );
  reexportsCache.set(file, { mtimeMs, requests });
  return requests;
}

function isReactServer(environment: Environment) {
  return environment.config.resolve.conditions.includes('react-server');
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

// In dev, modules with rules, which @compiled/babel-plugin-strip-runtime moved to the file's
// metadata, import the stylesheet. A build links it on every page instead.
function importStylesheet({ types: t }: typeof babel): PluginObj {
  return {
    visitor: {
      Program: {
        exit(program, { file }) {
          const { styleRules } = file.metadata as unknown as BabelFileMetadata;
          if (!styleRules?.length) return;
          program.unshiftContainer(
            'body',
            t.importDeclaration([], t.stringLiteral(stylesheetId)),
          );
        },
      },
    },
  };
}

// The stylesheet is out of date in every environment once a module adds rules. Its new URL makes
// the browser fetch it before running that module, and every module transformed afterwards. Pages
// that already loaded it, as a script or a <link>, get it as a hot update.
function refreshStylesheet(server: ViteDevServer) {
  const timestamp = Date.now();
  for (const environment of Object.values(server.environments)) {
    const { moduleGraph } = environment;
    const updates: Update[] = [];
    for (const id of [stylesheetId, browserStylesheetId]) {
      for (const mod of moduleGraph.getModulesByFile('\0' + id) ?? []) {
        moduleGraph.invalidateModule(mod);
        mod.lastHMRTimestamp = timestamp;
        if (mod.type === 'css') {
          // Vite's client finds the <link>s to replace by their URL.
          const path = `/@id/__x00__${id}`;
          updates.push({ type: 'css-update', path, acceptedPath: path, timestamp });
        } else if (mod.isSelfAccepting) {
          updates.push({ type: 'js-update', path: mod.url, acceptedPath: mod.url, timestamp });
        }
      }
    }
    if (environment.config.consumer === 'client' && updates.length) {
      environment.hot.send({ type: 'update', updates });
    }
  }
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

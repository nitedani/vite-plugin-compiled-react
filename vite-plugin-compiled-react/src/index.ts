import babel, { type PluginItem, type PluginObj } from '@babel/core';
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
  type Plugin,
  type ResolvedConfig,
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
// Browsers request a virtual module under /@id/, with \0 encoded.
const browserUrl = (id: string) => `/@id/__x00__${id}`;
const stylesheetUrl = browserUrl(stylesheetId);
// In dev, browsers get the stylesheet from a script that keeps the newest of its versions.
const browserStylesheetId = 'virtual:vite-plugin-compiled-react.js';
const browserStylesheetRE = /^\0virtual:vite-plugin-compiled-react\.js(?:\?|$)/;
// In a library, the stylesheet of a module, named after its whole file name: Vite takes one ending
// in `.module.css` for a CSS module.
const moduleStylesheetId = (file: string) => `${file}.css?vite-plugin-compiled-react`;
const moduleStylesheetIdRE = /\.css\?vite-plugin-compiled-react$/;
// Packages ship their rules already extracted, in `.compiled.css` files their modules import. Each
// of these imports gets a script, so its rules go into the stylesheet with the others.
const packageStylesheetRE = /\.compiled\.css$/;
const packageStylesheetScriptId = (file: string) => `\0vite-plugin-compiled-react:${file}.js`;
const packageStylesheetScriptRE = /^\0vite-plugin-compiled-react:(.+)\.js$/;
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
  // In a library, each module with rules imports a stylesheet of its own, so its rules go wherever
  // Vite puts the CSS of its chunk. Vite has no hook to sort a chunk's CSS before minifying it, so
  // the rules of different modules keep the order Vite puts their modules in.
  const moduleRules = new Map<string, string[]>();
  // Compiled reads values from the modules a module imports, so each of those files maps to the
  // modules whose output it is part of.
  const dependents = new Map<string, Set<string>>();
  const addDependent = (file: string, id: string) =>
    dependents.set(file, (dependents.get(file) ?? new Set()).add(id));
  // Compiled's sort keeps the order of rules of the same kind: sorting them first makes a build's
  // stylesheet, and its file name, the same whatever order its modules compile in.
  const stylesheet = (sheetRules: Iterable<string> = rules) =>
    sort([...new Set(sheetRules)].sort().join(''));
  const processStylesheet = async (config: ResolvedConfig) =>
    (await preprocessCSS(stylesheet(), path.join(config.root, stylesheetName), config)).code;
  const addRules = (newRules: Iterable<string>) => {
    const ruleCount = rules.size;
    for (const rule of newRules) rules.add(rule);
    if (server && rules.size > ruleCount) refreshStylesheet(server);
  };

  const plugin: Plugin = {
    name: 'vite-plugin-compiled-react',
    enforce: 'pre',
    // A build's client stylesheet then has the rules of the environments built before it.
    sharedDuringBuild: true,
    configEnvironment(name, config) {
      // The compiled modules import Compiled's runtime, which Vite's dependency scan doesn't see
      // in their source: discovered on a page load, it makes Vite reload the page.
      if ((config.consumer ?? (name === 'client' ? 'client' : 'server')) === 'client') {
        return { optimizeDeps: { include: ['@compiled/react/runtime'] } };
      }
    },
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
      filter: {
        id: [
          /^virtual:vite-plugin-compiled-react\.css$/,
          moduleStylesheetIdRE,
          packageStylesheetRE,
        ],
      },
      async handler(id, importer, resolveOptions) {
        if (moduleStylesheetIdRE.test(id)) return id;
        if (packageStylesheetRE.test(id)) {
          // Libraries, and Compiled's runtime, leave them to Vite like any other CSS.
          const { config } = this.environment;
          if (config.build.lib || !(extract || isReactServer(this.environment))) return;
          const resolved = await this.resolve(id, importer, { ...resolveOptions, skipSelf: true });
          return resolved && !resolved.external
            ? packageStylesheetScriptId(resolved.id)
            : resolved;
        }
        return server && this.environment.config.consumer === 'client'
          ? '\0' + browserStylesheetId
          : '\0' + id;
      },
    },
    load: {
      filter: {
        id: [
          stylesheetRE,
          browserStylesheetRE,
          moduleStylesheetIdRE,
          packageStylesheetScriptRE,
          styleCacheRE,
        ],
      },
      async handler(id) {
        const packageStylesheet = id.match(packageStylesheetScriptRE)?.[1];
        if (packageStylesheet) {
          this.addWatchFile(packageStylesheet);
          if (server) addDependent(packageStylesheet, id);
          addRules([await readFile(packageStylesheet, 'utf8')]);
          // A build links the stylesheet on every page.
          return server
            ? `import ${JSON.stringify(stylesheetId)};
if (import.meta.hot) import.meta.hot.accept();`
            : '';
        }
        if (styleCacheRE.test(id)) {
          return isReactServer(this.environment)
            ? `export default {};
export const useCache = () => {
  throw new Error("[vite-plugin-compiled-react] Compiled's runtime can't render styles in React Server Components.");
};`
            : undefined;
        }
        if (stylesheetRE.test(id)) return stylesheet();
        if (moduleStylesheetIdRE.test(id)) return stylesheet(moduleRules.get(id)!);
        const version = rules.size;
        const code = await processStylesheet(this.environment.config);
        // A page can run an older version after a newer one: the version with more rules wins.
        // A page can also link the stylesheet more than once, for example from server-rendered HTML
        // and from a React Server Components payload, and Vite's hot update replaces one link only:
        // the newest version goes after every link, so their older rules don't override it.
        return `import { updateStyle } from '/@vite/client';
if (!(import.meta.hot.data.rules >= ${version})) {
  import.meta.hot.data.rules = ${version};
  updateStyle(${JSON.stringify('\0' + stylesheetId)}, ${JSON.stringify(code)});
  const sheets = [...document.querySelectorAll('link[rel="stylesheet"], style')];
  const style = sheets.find(sheet => sheet.dataset.viteDevId === ${JSON.stringify('\0' + stylesheetId)});
  const link = sheets.findLast(sheet => sheet.href && new URL(sheet.href).pathname.endsWith(${JSON.stringify(stylesheetUrl)}));
  if (style && sheets.indexOf(link) > sheets.indexOf(style)) link.after(style);
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
        // Taken before Compiled changes the module.
        const imports = ast.program.body.flatMap(node =>
          node.type === 'ImportDeclaration' ? [node.source.value] : [],
        );
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
        // Compiled doesn't report the files it reads a member expression from, and TypeScript
        // drops the imports whose values Compiled inlined, which Vite's module graph then misses.
        // A module without rules has no values to update, and its imports would make it update
        // with them, reloading the page when it isn't a Fast Refresh boundary. Without extraction,
        // the rules aren't known, so every module counts.
        if (server && (styleRules.length || !extractStyles)) {
          for (const source of await valueSources(resolver, file, imports)) {
            addDependent(source, id);
          }
        }
        addRules(styleRules);
        let output = result.code;
        if (styleRules.length && this.environment.config.build.lib && !server) {
          const sheet = moduleStylesheetId(file);
          moduleRules.set(sheet, styleRules);
          // Imported last, so the rules follow the CSS of the module's imports.
          output += `\nimport ${JSON.stringify(sheet)};`;
        }
        return { code: output, map: result.map };
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

  return [plugin];
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

// The local files a module's styles can read values from: the modules it imports, and the modules
// their values come from, transitively.
async function valueSources(resolver: Resolver, file: string, requests: string[]) {
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
      await follow(source, await valueImports(source));
    }
  };
  await follow(file, requests);
  return sources;
}

// Parsed once per change of the file.
const valueImportsCache = new Map<string, { mtimeMs: number; requests: string[] }>();

// The modules a file's exported values can come from: its re-exports, and all its imports unless
// it's a component (.jsx, .tsx), which would make its importers depend on the whole tree below it.
async function valueImports(file: string) {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return [];
  const { mtimeMs } = await stat(file);
  const cached = valueImportsCache.get(file);
  if (cached?.mtimeMs === mtimeMs) return cached.requests;
  const isComponent = /\.[jt]sx$/.test(file);
  const requests = await parse(await readFile(file, 'utf8'), file).then(
    ast =>
      ast.program.body.flatMap(node =>
        (node.type === 'ImportDeclaration' && !isComponent) ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration'
          ? (node.source?.value ?? [])
          : [],
      ),
    () => [],
  );
  valueImportsCache.set(file, { mtimeMs, requests });
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
      // Vite's client finds the <link>s and the modules to update by their URL.
      const path = browserUrl(id);
      for (const mod of moduleGraph.getModulesByFile('\0' + id) ?? []) {
        moduleGraph.invalidateModule(mod);
        mod.lastHMRTimestamp = timestamp;
        if (mod.type === 'css') {
          updates.push({ type: 'css-update', path, acceptedPath: path, timestamp });
        } else if (mod.isSelfAccepting) {
          updates.push({ type: 'js-update', path, acceptedPath: path, timestamp });
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

import babel, { type PluginItem, type PluginObj } from '@babel/core';
// @ts-expect-error The package has no types.
import transformJsxBabelPlugin from '@babel/plugin-transform-react-jsx';
import compiledBabelPlugin, { type Resolver } from '@compiled/babel-plugin';
import stripRuntimeBabelPlugin, {
  type BabelFileMetadata,
} from '@compiled/babel-plugin-strip-runtime';
import { sort } from '@compiled/css';
import { ATOMIC_VALUE_HASH_LENGTH, hash } from '@compiled/utils';
import type { CssFunction } from '@compiled/react';
import enhancedResolve from 'enhanced-resolve';
import { statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  isFileLoadingAllowed,
  type DevEnvironment,
  normalizePath,
  preprocessCSS,
  type Environment,
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
const packageStylesheetScriptRE = /^\0vite-plugin-compiled-react:(.+\.compiled\.css)\.js$/;
// React Server environments that bundle @compiled/react have no createContext(), which this
// module calls when imported.
const styleCacheRE = /\/@compiled\/react\/dist\/.+\/style-cache\.js(?:\?|$)/;
// A url() and its URL, quoted or not, with CSS escapes.
const cssUrlRE = /\burl\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:\\.|[^\s'"()\\])*))\s*\)/gi;

export function compiled(options: CompiledPluginOptions = {}): Plugin {
  let extract: boolean;
  let resolver: Resolver;
  let server: ViteDevServer | undefined;
  // Atomic rules only cascade right in Compiled's order, which separate stylesheets can't keep, so
  // all extracted rules go into one stylesheet. A module compiled again replaces its rules.
  const rules = new Map<string, string[]>();
  // Counts the changes of the rules: pages keep the stylesheet of the newest.
  let revision = 0;
  // In a library, each module with rules imports a stylesheet of its own, so its rules go wherever
  // Vite puts the CSS of its chunk. Vite has no hook to sort a chunk's CSS before minifying it, so
  // the rules of different modules keep the order Vite puts their modules in.
  const moduleRules = new Map<string, string[]>();
  // The .compiled.css files Vite resolved: browsers can request a package stylesheet's script for
  // any file, but only these are read.
  const packageStylesheets = new Set<string>();
  // Compiled reads values from the modules a module imports, so each of those files maps to the
  // modules whose output it is part of.
  const dependents = new Map<string, Set<string>>();
  const addDependent = (file: string, id: string) => {
    dependents.set(file, (dependents.get(file) ?? new Set()).add(id));
    // Vite only watches the files under its root and the modules in its graph.
    server?.watcher.add(file);
  };
  // Compiled's sort keeps the order of rules of the same kind: sorting them first makes a build's
  // stylesheet, and its file name, the same whatever order its modules compile in.
  const stylesheet = (sheetRules: Iterable<string> = new Set([...rules.values()].flat())) =>
    sort([...sheetRules].sort().join(''));
  const setRules = (id: string, newRules: string[]) => {
    if (JSON.stringify(rules.get(id) ?? []) === JSON.stringify(newRules)) return;
    if (newRules.length) rules.set(id, newRules);
    else rules.delete(id);
    revision++;
    if (server) refreshStylesheet(server);
  };

  return {
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
          if (!resolved || resolved.external) return resolved;
          // Left to Vite, which refuses the file to browsers.
          if (
            server &&
            config.consumer === 'client' &&
            !isFileLoadingAllowed(server.config, resolved.id)
          ) {
            return;
          }
          packageStylesheets.add(resolved.id);
          return packageStylesheetScriptId(resolved.id);
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
          if (!packageStylesheets.has(packageStylesheet)) return;
          this.addWatchFile(packageStylesheet);
          if (server) addDependent(packageStylesheet, id);
          const css = await resolveUrls(this, await readFile(packageStylesheet, 'utf8'), packageStylesheet);
          setRules(id, [css]);
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
        const version = revision;
        const { code } = (await (this.environment as DevEnvironment).transformRequest(
          `\0${stylesheetId}?direct`,
        ))!;
        // A page can run an older version after a newer one: the newest revision wins.
        // A page can also link the stylesheet more than once, for example from server-rendered HTML
        // and from a React Server Components payload, and Vite's hot update replaces one link only:
        // the newest version goes after every link, so their older rules don't override it.
        return `import { updateStyle } from '/@vite/client';
if (!(import.meta.hot.data.revision >= ${version})) {
  import.meta.hot.data.revision = ${version};
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
          // Without extraction, the rules are read from it.
          ast: !!server && !extractStyles,
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
        // Compiled names a class after its declaration as written, so a URL that resolves to a
        // different file in another folder needs a class of its own.
        const classNames = new Map<string, string>();
        const { root } = this.environment.config;
        const styleRules = await Promise.all(
          ((result.metadata as unknown as BabelFileMetadata).styleRules ?? []).map(async rule => {
            const resolved = await resolveUrls(this, rule, file);
            return resolved === rule ? rule : renameClasses(resolved, classNames, root);
          }),
        );
        // In dev, a module with rules depends on the files its styles can read values from:
        // Compiled reports some, and TypeScript drops the imports of the values it inlined.
        // TODO: rely on Compiled's report once https://github.com/atlassian-labs/compiled/issues/1960 is fixed
        // (it misses imported objects, destructured imports and values passed through another module).
        if (server) {
          const compiledRules = extractStyles ? styleRules : await findRules(result.ast!, file);
          if (compiledRules.length) {
            for (const source of await valueSources(resolver, file, imports)) {
              addDependent(source, id);
            }
          }
        }
        setRules(id, styleRules);
        let output = classNames.size
          ? result.code.replace(/(?<![\w-])_[\w-]+/g, name => classNames.get(name) ?? name)
          : result.code;
        if (styleRules.length && this.environment.config.build.lib && !server) {
          const sheet = moduleStylesheetId(file);
          moduleRules.set(sheet, styleRules);
          // Imported last, so the rules follow the CSS of the module's imports.
          output += `\nimport ${JSON.stringify(sheet)};`;
        }
        return { code: output, map: result.map };
      },
    },
    // Emitted once every module is compiled, which a module of the build can't wait for.
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
      const { code } = await preprocessCSS(
        stylesheet(),
        path.join(config.root, stylesheetName),
        config,
      );
      const base = stylesheetBase(config);
      // The rules' URLs name public files and resolved files (resolveUrls): Vite resolves the URLs
      // of its modules' CSS only, so a public file gets the base here, and a file is emitted.
      const source = await replaceUrls(code, async url => {
        // On Windows, a resolved file starts with its drive.
        const [, encoded, suffix] = url.match(/^((?:\/(?!\/)|[a-z]:\/)[^?#]*)(.*)$/is) ?? [];
        if (!encoded) return;
        const file = decodeUrl(encoded);
        if (config.publicDir && isFile(path.join(config.publicDir, file))) {
          return base + encoded.slice(1) + suffix;
        }
        if (!isFile(file)) return;
        const reference = this.emitFile({
          type: 'asset',
          name: path.basename(file),
          source: await readFile(file),
        });
        return base + encodeURI(this.getFileName(reference)) + suffix;
      });
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
}

// The stylesheet is one file, so each rule's URLs are resolved from the module that uses the rule,
// as Vite resolves a stylesheet's: a public file stays as it is, and another file becomes its path.
// Compiled evaluates imported styles in that module and doesn't say where a rule was written.
async function resolveUrls(
  context: Pick<Rollup.PluginContext, 'resolve'> & { environment: Environment },
  css: string,
  importer: string,
) {
  const { publicDir } = context.environment.config;
  return replaceUrls(css, async url => {
    const [, encoded, suffix] = url.match(/^([^?#]*)(.*)$/s)!;
    if (!encoded || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(encoded)) return;
    const file = decodeUrl(encoded);
    if (file.startsWith('/') && publicDir && isFile(path.join(publicDir, file))) return;
    // Like Vite's, a URL that isn't a path is first looked for beside its stylesheet.
    for (const request of /^[./]/.test(file) ? [file] : [`./${file}`, file]) {
      const resolved = await context.resolve(request, importer);
      const [resolvedFile] = (!resolved?.external && resolved?.id.split('?')) || [];
      if (resolvedFile && isFile(resolvedFile)) {
        return encodeURI(resolvedFile).replace(/[?#]/g, encodeURIComponent) + suffix;
      }
    }
  });
}

// Names a rule's classes as Compiled does, after their declaration's value, with paths from the
// root so the names don't depend on where the project is. The rest of each name, which `ax` groups
// classes by, stays, and so does its length, which keeps the module's source map right.
function renameClasses(rule: string, classNames: Map<string, string>, root: string) {
  const block = rule.lastIndexOf('{');
  const value = rule.slice(rule.indexOf(':', block) + 1).replace(/\}+$/, '');
  const portable = value.replace(/"((?:\/|[a-z]:\/)[^"]*)"/gi, (_, url: string) =>
    JSON.stringify(path.posix.relative(encodeURI(root), url)),
  );
  const valueHash = hash(portable).slice(0, ATOMIC_VALUE_HASH_LENGTH);
  const selectors = rule.slice(0, block).replace(/\.(_[\w-]+)/g, (_, name: string) => {
    const renamed = name.slice(0, -ATOMIC_VALUE_HASH_LENGTH) + valueHash;
    classNames.set(name, renamed);
    return `.${renamed}`;
  });
  return selectors + rule.slice(block);
}

// Replaces the URLs of a stylesheet's url()s for which `replace` returns one.
async function replaceUrls(
  css: string,
  replace: (url: string) => string | undefined | Promise<string | undefined>,
) {
  const urls = await Promise.all(
    [...css.matchAll(cssUrlRE)].map(([, ...url]) =>
      replace(unescapeCss(url.find(part => part != null)!)),
    ),
  );
  return css.replace(cssUrlRE, match => {
    const url = urls.shift();
    return url === undefined ? match : `url(${JSON.stringify(url)})`;
  });
}

// The base of the stylesheet's URLs. A relative base is relative to the stylesheet, in the
// directory Vite would put a CSS file of its name in, found as Vite finds it.
function stylesheetBase({ base, build }: ResolvedConfig) {
  if (base && !base.startsWith('.')) return base;
  const { output } = build.rollupOptions;
  const { assetFileNames } = (Array.isArray(output) ? output[0] : output) ?? {};
  const directory = !assetFileNames
    ? build.assetsDir
    : path.posix.dirname(
        typeof assetFileNames === 'string'
          ? assetFileNames
          : // Rollup and Rolldown type a missing original file differently.
            assetFileNames({
              type: 'asset',
              name: stylesheetName,
              names: [stylesheetName],
              originalFileNames: [],
              source: '',
            } as unknown as Parameters<typeof assetFileNames>[0]),
      );
  return `${path.posix.relative(directory, '') || '.'}/`;
}

// A CSS escape is a backslash before a character, or before a code point in hex.
const unescapeCss = (value: string) =>
  value.replace(/\\(?:([\da-f]{1,6})\s?|(.))/gis, (_, hex: string | undefined, char: string) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : char,
  );

// As Vite reads a file's URL: a URL it can't decode names the file as it is.
function decodeUrl(url: string) {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

const isFile = (file: string) => !!statSync(file, { throwIfNoEntry: false })?.isFile();

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

// The rules strip-runtime would extract from a module's output. It changes the AST, which the
// output's code no longer needs.
async function findRules(ast: babel.types.File, file: string) {
  const result = await babel.transformFromAstAsync(ast, undefined, {
    filename: file,
    code: false,
    cloneInputAst: false,
    configFile: false,
    babelrc: false,
    plugins: [[stripRuntimeBabelPlugin, { compiledRequireExclude: true }]],
  });
  return (result?.metadata as unknown as BabelFileMetadata).styleRules ?? [];
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

// The stylesheet is out of date in every environment once the rules change. Its new URL makes
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

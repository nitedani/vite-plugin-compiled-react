import t from '@babel/types';
import babel from '@babel/core';
import compiledPlugin, { type PluginOptions } from '@compiled/babel-plugin';
import compiledStripRuntimePlugin from '@compiled/babel-plugin-strip-runtime';
import moduleResolverPlugin from 'babel-plugin-module-resolver';
import { createHash } from 'crypto';
import { createFilter, type EnvironmentModuleNode, type Plugin } from 'vite';

export type CompiledPluginOptions = Pick<
  PluginOptions,
  'cache' | 'optimizeCss' | 'onIncludedFiles' | 'addComponentName'
> & {
  /**
  Extract the styles into CSS files, for `build` and `serve` separately or for both with `true`.
  Defaults to false.
   */
  extract?: { build: boolean; serve: boolean } | boolean;
};

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
      const { root } = config;
      const moduleResolverPluginAlias: Record<string, string> = {};
      for (const { find, replacement } of config.resolve.alias) {
        // babel-plugin-module-resolver's alias keys are strings, RegExp aliases are left out.
        if (typeof find !== 'string' || !find || !replacement) {
          continue;
        }
        moduleResolverPluginAlias[find] = replacement.startsWith(root + '/')
          ? '.' + replacement.slice(root.length)
          : replacement;
      }

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
        // Relative alias targets are relative to Vite's root, not to the working directory.
        [
          moduleResolverPlugin,
          { root, cwd: root, alias: moduleResolverPluginAlias },
        ],
        [compiledPlugin, { importReact: false, ...baseOptions }],
      ];

      if (typeof extract === 'object' ? extract[config.command] : extract) {
        plugins.push([
          compiledStripRuntimePlugin,
          { compiledRequireExclude: true },
        ]);

        plugins.push({
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
    hotUpdate(ctx) {
      const originalMods = new Set<EnvironmentModuleNode>();
      for (const mod of ctx.modules) {
        originalMods.add(mod);
        for (const importer of mod.importers) {
          originalMods.add(importer);
        }
      }

      const virtualCssImporterMods = new Set<EnvironmentModuleNode>();
      for (const cssId of virtualCssFiles.keys()) {
        const mod = this.environment.moduleGraph.getModuleById(
          resolvedVirtualCssPrefix + cssId,
        );
        if (!mod) {
          continue;
        }
        virtualCssImporterMods.add(mod);
        for (const importer of mod.importers) {
          virtualCssImporterMods.add(importer);
        }
      }

      const modsToInvalidate = new Set<EnvironmentModuleNode>();
      for (const mod of originalMods) {
        if (virtualCssImporterMods.has(mod)) {
          modsToInvalidate.add(mod);
          for (const importer of mod.importers) {
            modsToInvalidate.add(importer);
          }
        }
      }

      for (const mod of modsToInvalidate) {
        this.environment.moduleGraph.invalidateModule(mod);
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
        plugins,
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

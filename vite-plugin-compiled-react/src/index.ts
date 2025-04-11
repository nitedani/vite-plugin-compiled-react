import t from '@babel/types';
import compiledPlugin from '@compiled/babel-plugin';
import compiledStripRuntimePlugin from '@compiled/babel-plugin-strip-runtime';
import type { ReactBabelOptions } from '@vitejs/plugin-react';
import moduleResolverPlugin from 'babel-plugin-module-resolver';
import { createHash } from 'crypto';
import { EnvironmentModuleNode, type Plugin } from 'vite';

export type CompiledPluginOptions = {
  /**
  Will cache the result of statically evaluated imports.
  true will cache for the duration of the node process
  'single-pass' will cache for a single pass of a file
  false turns caching off
  Defaults to true.
   */
  cache?: boolean | 'single-pass';

  /**  
  Will run additional cssnano plugins to normalize CSS during build.
  Defaults to true.
   */
  optimizeCss?: boolean;

  /**
  Will callback at the end of a file pass with all imported files that were statically evaluated into the file.
  */
  onIncludedFiles?: (files: string[]) => void;

  /**
  Add the component name as class name to DOM in non-production environment if styled is used.
  Default to false
   */
  addComponentName?: boolean;

  extract?: { build: boolean; serve: boolean } | boolean;
};

const virtualCssFiles = new Map();

export const compiled = (options: CompiledPluginOptions = {}): Plugin => {
  const hash = (code: string) => {
    return createHash('md5').update(code).digest('hex').substring(2, 9);
  };

  const virtualCssFileName = 'virtual:vite-plugin-compiled-react';
  const importDeclaration = t.importDeclaration(
    [],
    t.stringLiteral('@compiled/react')
  );
  const { extract, ...baseOptions } = options;
  let command = '';
  let root: string;
  const moduleResolverPluginAlias = {};
  return {
    name: 'vite-plugin-compiled-react',
    enforce: 'pre',
    config(config, env) {
      command = env.command;
      return {
        ssr: {
          // https://github.com/vikejs/vike/issues/621
          noExternal: [/@compiled\/react/],
        },
      };
    },
    configResolved(config) {
      root = config.root;
      if (!Array.isArray(config.resolve.alias)) {
        return;
      }
      for (const e of config.resolve.alias) {
        const find = e.find;
        let replacement = e.replacement;
        if (find && replacement) {
          if (typeof replacement !== 'string' || typeof find !== 'string') {
            continue;
          }
          if (replacement.split('/').length > 2) {
            replacement = replacement.replace(root, '.');
          }
          moduleResolverPluginAlias[find] = replacement;
        }
      }
    },
    resolveId(source, importer, options) {
      if (source.startsWith(virtualCssFileName)) {
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
        const ids = `\0${virtualCssFileName}:${cssId}`;
        const mod = this.environment.moduleGraph.getModuleById(ids);
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
      if (id.includes(virtualCssFileName)) {
        const fileId = id.split(':').pop()?.split('?')[0];
        if (!fileId) {
          return;
        }
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
    api: {
      reactBabel(babelConfig: ReactBabelOptions) {
        babelConfig.plugins.push({
          visitor: {
            Program(root) {
              if (
                /node_modules/.test(this.filename) ||
                /extractAssets/.test(this.filename)
              ) {
                return;
              }
              if (/\.[jt]sx$/.test(this.filename)) {
                root.unshiftContainer('body', importDeclaration);
              }
            },
          },
        });

        babelConfig.plugins.push([
          moduleResolverPlugin,
          { root, alias: moduleResolverPluginAlias },
        ]);
        babelConfig.plugins.push([
          compiledPlugin,
          { importReact: false, ...baseOptions },
        ]);
        if (
          options.extract &&
          (options.extract === true ||
            (command === 'serve' && options.extract.serve) ||
            (command === 'build' && options.extract.build))
        ) {
          babelConfig.plugins.push([
            compiledStripRuntimePlugin,
            { compiledRequireExclude: true },
          ]);

          babelConfig.plugins.push({
            visitor: {
              Program: {
                exit(path, { file }) {
                  const styleRules = file.metadata.styleRules;
                  if (styleRules.length) {
                    const code = styleRules.join('\n');
                    const fileId = hash(code) + '.css';
                    virtualCssFiles.set(fileId, styleRules.join('\n'));
                    path.unshiftContainer(
                      'body',
                      t.importDeclaration(
                        [],
                        t.stringLiteral(`${virtualCssFileName}:${fileId}`)
                      )
                    );
                  }
                },
              },
            },
          });
        }
      },
    },
  };
};

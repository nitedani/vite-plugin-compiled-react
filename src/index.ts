import t from '@babel/types';
import compiledPlugin from '@compiled/babel-plugin';
import compiledStripRuntimePlugin from '@compiled/babel-plugin-strip-runtime';
import moduleResolverPlugin from 'babel-plugin-module-resolver';
import type { Plugin } from 'vite';
import type { ReactBabelOptions } from '@vitejs/plugin-react';

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

export const compiled = (options: CompiledPluginOptions = {}): Plugin => {
  const virtualCssFiles = new Map();
  const generateUniqueShortId = () => {
    return '_' + Math.random().toString(36).substring(2, 9);
  };

  const virtualCssFileName = 'virtual:vite-plugin-compiled-react';
  const importDeclaration = t.importDeclaration(
    [],
    t.stringLiteral('@compiled/react')
  );
  const { extract, ...baseOptions } = options;
  let command = '';

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
    resolveId(source, importer, options) {
      if (source.startsWith(virtualCssFileName)) {
        return '\0' + source;
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
    },
    api: {
      reactBabel(babelConfig: ReactBabelOptions, context, config) {
        const alias = config.resolve.alias;
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
        babelConfig.plugins.push([moduleResolverPlugin, { alias }]);
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
                    const fileId = generateUniqueShortId() + '.css';
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

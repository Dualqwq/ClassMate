//@ts-check

'use strict';

const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

//@ts-check
/** @typedef {import('webpack').Configuration') WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  target: 'node', // VS Code extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/
	mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')

  entry: './src/extension.ts', // the entry point of this extension, 📖 -> https://code.visualstudio.com/api/get-started/extension-anatomy#extens
  output: {
    // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode', // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    // web-tree-sitter 含 wasm 加载与动态 require,打进 bundle 会破坏其
    // 内部路径解析;保持 node_modules 运行时依赖,wasm 由下方 copy 落到
    // dist/wasm 并随 .vscodeignore 放行进 VSIX。
    'web-tree-sitter': 'commonjs web-tree-sitter',
    // modules added here also need to be added in the .vscodeignore file
  },
  resolve: {
    // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
    ]
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        {
          // Tree-sitter 运行时与 C++ 语法 wasm,随扩展分发(避免依赖用户
          // 机器上的 node_modules)。cppWorkspaceIndex 按 dist/wasm 优先
          // 的顺序定位。
          from: 'node_modules/web-tree-sitter/web-tree-sitter.wasm',
          to: 'wasm/web-tree-sitter.wasm',
        },
        {
          from: 'node_modules/tree-sitter-cpp/tree-sitter-cpp.wasm',
          to: 'wasm/tree-sitter-cpp.wasm',
        },
        {
          from: 'node_modules/tree-sitter-c/tree-sitter-c.wasm',
          to: 'wasm/tree-sitter-c.wasm',
        },
      ],
    }),
  ],
  devtool: 'source-map',
  infrastructureLogging: {
    level: "log", // enables logging required for problem matchers
  },
};
module.exports = [ extensionConfig ];
module.exports = api => {
  const isWebpack = api.caller(caller => Boolean(caller && caller.name === 'babel-loader'));

  return {
    presets: [
      [
        '@babel/preset-env',
        isWebpack
          ? {
            targets: {
              "chrome": "70",
              "firefox": "70"
            },
          }
          : {
            targets: {
              node: '8.14',
            },
          },
      ],
      '@babel/preset-react',
      '@babel/preset-typescript',
      '@babel/preset-flow',
    ],
    plugins: [
      '@babel/plugin-syntax-dynamic-import',
      '@babel/plugin-proposal-class-properties',
      '@babel/plugin-proposal-object-rest-spread',
      'lodash',
      isWebpack ? 'webpack-chunkname' : 'dynamic-import-node',
    ],
    overrides: [
      {
        test: './src/client/vendor',
        compact: true,
      },
    ],
  };
};

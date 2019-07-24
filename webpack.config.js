module.exports = {
  mode: 'production',
  resolve: {
    extensions: ['.js']
  },
  output: {
    library: 'appleHack',
    libraryTarget: 'umd'
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        use: [
          {
            loader: 'babel-loader'
          }
        ],
        exclude: [
          /node_modules/
        ]
      }
    ]
  }
}

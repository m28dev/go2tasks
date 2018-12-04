const path = require('path');
const Dotenv = require('dotenv-webpack');

module.exports = {
    mode: "development",
    entry: ["./src/index.js"],
    output: {
        filename: "main.js",
        path: path.resolve(__dirname, 'public/assets'),
        publicPath: '/assets/'
    },
    devtool: 'source-map',
    devServer: {
        contentBase: path.resolve(__dirname, "public"),
        publicPath: '/assets/'
    },
    plugins: [
        new Dotenv()
    ]
};

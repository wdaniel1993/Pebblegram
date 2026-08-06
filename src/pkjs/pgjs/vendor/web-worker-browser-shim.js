/*
 * web-worker-browser-shim.js — replaces `@eshaz/web-worker` inside the
 * vendored opus-decoder bundle. The package's cjs/node.js is ESM and cannot
 * be parsed by the SDK's webpack 1.x; the browser variant is just
 * `module.exports = Worker`, and the phone WebView (WKWebView / Android
 * WebView) provides a native Worker constructor.
 */
module.exports = (typeof Worker !== 'undefined') ? Worker : function Worker() {};

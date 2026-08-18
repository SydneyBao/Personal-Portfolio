import assert from 'node:assert/strict';

import createViteConfig from '../vite.config.js';
import { validatePublicOrigin } from '../dev/local-media-plugin.mjs';

assert.equal(validatePublicOrigin('https://sydneybao.com'), 'https://sydneybao.com');
assert.throws(() => validatePublicOrigin('http://127.0.0.1:9000'));
assert.throws(() => validatePublicOrigin('https://sydneybao.com/extra'));

const config = createViteConfig({ mode: 'test' });
const proxy = config.server.proxy['^/portfolio/uploads/'];
assert.equal(proxy.target, 'https://sydneybao.com');
assert.equal(proxy.changeOrigin, true);
assert.equal(proxy.secure, true);
assert.equal(proxy.followRedirects, false);

const handlers = {};
proxy.configure({
  on(event, handler) {
    handlers[event] = handler;
  },
});

const removedHeaders = [];
handlers.proxyReq({
  removeHeader(name) {
    removedHeaders.push(name);
  },
});
assert.deepEqual(removedHeaders, ['authorization', 'cookie', 'proxy-authorization']);

const proxyResponse = { headers: { 'set-cookie': ['session=secret'], 'content-type': 'image/webp' } };
handlers.proxyRes(proxyResponse);
assert.equal('set-cookie' in proxyResponse.headers, false);
assert.equal(proxyResponse.headers['content-type'], 'image/webp');

console.log('Vite local media proxy tests passed.');

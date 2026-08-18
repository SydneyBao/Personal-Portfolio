// vite.config.js
/* eslint-env node */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import {
  createLocalOwnerMediaPlugin,
  validatePublicOrigin,
} from './dev/local-media-plugin.mjs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const packageMetadata = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const firestoreRules = readFileSync(new URL('./firebase/firestore.rules', import.meta.url), 'utf8');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, '');
  const publicOrigin = validatePublicOrigin(
    env.OWNER_MEDIA_PUBLIC_ORIGIN || packageMetadata.homepage,
  );
  return {
    plugins: [
      react(),
      createLocalOwnerMediaPlugin({
        env,
        publicOrigin,
        repositoryRoot: projectRoot,
        rules: firestoreRules,
      }),
    ],
    cacheDir: '.vite-cache',
    server: {
      port: 5173,
      proxy: {
        '^/portfolio/uploads/': {
          changeOrigin: true,
          configure(proxy) {
            proxy.on('proxyReq', (proxyRequest) => {
              proxyRequest.removeHeader('authorization');
              proxyRequest.removeHeader('cookie');
              proxyRequest.removeHeader('proxy-authorization');
            });
            proxy.on('proxyRes', (proxyResponse) => {
              delete proxyResponse.headers['set-cookie'];
            });
          },
          followRedirects: false,
          secure: true,
          target: publicOrigin,
        },
      },
      strictPort: true,
    },
  };
});

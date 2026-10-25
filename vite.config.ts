import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const releaseTag = process.env.GITHUB_REF_NAME ?? '';
const chatReleaseVersion = process.env.GITHUB_REF_TYPE === 'tag' &&
  process.env.GITHUB_REF === `refs/tags/${releaseTag}` && /^v\d+\.\d+\.\d+$/.test(releaseTag)
  ? releaseTag : null;

export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: { __CHAT_RELEASE_VERSION__: JSON.stringify(command === 'build' ? chatReleaseVersion : null) },
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      name: 'TightbeamChat',
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: { external: ['react', 'react-dom', 'react/jsx-runtime'] },
  },
  test: { environment: 'jsdom' },
}));

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@gitroom/nestjs-libraries': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
  },
});

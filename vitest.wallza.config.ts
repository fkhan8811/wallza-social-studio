import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@gitroom/nestjs-libraries': fileURLToPath(
        new URL('./libraries/nestjs-libraries/src', import.meta.url)
      ),
      '@gitroom/helpers': fileURLToPath(
        new URL('./libraries/helpers/src', import.meta.url)
      ),
    },
  },
  test: {
    environment: 'node',
    include: [
      'libraries/nestjs-libraries/src/database/prisma/integrations/*.spec.ts',
      'libraries/helpers/src/utils/safe.return.url.spec.ts',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});

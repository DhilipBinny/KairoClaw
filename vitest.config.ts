import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/core/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'packages/core/src/tools/builtin/files.ts',
        'packages/core/src/tools/builtin/exec.ts',
        'packages/core/src/tools/permissions.ts',
        'packages/core/src/agent/scope.ts',
        'packages/core/src/db/repositories/tool-permission.ts',
      ],
    },
  },
});

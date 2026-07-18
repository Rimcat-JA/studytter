import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      "src/core/**/*.test.ts",
      "src/ingest/**/*.test.ts",
      "src/llm/**/*.test.ts",
    ],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/core/**/*.ts", "src/ingest/pdf.ts"],
      exclude: ["src/**/*.test.ts", "src/core/types.ts"],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});

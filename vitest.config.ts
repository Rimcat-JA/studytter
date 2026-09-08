import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
    ],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/core/**/*.ts", "src/ingest/pdf.ts", "src/services/**/*.ts", "src/db/**/*.ts", "src/llm/**/*.ts", "src/ui/PostCard.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/core/types.ts", "src/db/schema.ts", "src/db/seed.ts"],
      // Keep the established pure-logic gate while making persistence, network
      // and UI coverage visible instead of hiding these layers from reports.
      thresholds: {
        "src/core/**/*.ts": { lines: 90, functions: 90, branches: 85, statements: 90 },
        "src/ingest/pdf.ts": { lines: 90, functions: 90, branches: 80, statements: 90 },
      },
    },
  },
});

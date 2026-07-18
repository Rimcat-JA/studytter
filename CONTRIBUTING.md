# Contributing

Thanks for improving LearnStream.

1. Fork the repository and create a focused branch.
2. Keep `src/core/` pure TypeScript with no React, Expo, network, or database imports.
3. Validate every external JSON boundary with Zod. Never log API keys or raw material contents.
4. Run `pnpm typecheck`, `pnpm lint`, and `pnpm test` before opening a pull request.
5. Explain user-visible privacy or data-flow changes in the pull request.

Do not add analytics or crash reporting enabled by default. New tunable ranking values belong in `src/core/config.ts`.

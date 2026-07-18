# LearnStream

**Your key. Your device. Your materials go only to the AI provider you choose.**

LearnStream turns your PDFs, lecture slides, and note photos into a local, adaptive micro-learning feed for Android, iOS, and best-effort web. It has no account system, analytics, telemetry, or LearnStream backend.

## What is included

- Bundled 50-post linear-algebra demo; no API key is required to try the feed
- PDF/image extraction through OpenAI, Anthropic, or NanoGPT with physical 20-page PDF chunks, schema validation, Retry-After-aware backoff, and bounded retry
- Durable extraction jobs with SQLite progress, an Android foreground worker, and automatic resume after task dismissal or process restart
- Grounded continuous post generation, interactive quizzes, persistent streaming AI reply threads, and Ollama text support
- Per-provider Base URLs, model catalogs, connection diagnostics, and independent extraction/generation/reply routing
- Local SQLite data, SecureStore API keys, Thompson sampling, spaced repetition, IRT, XP, streaks, rare cards, and local notifications
- Subject/material management, usage estimates, editable price table, JSON backup/restore, and Japanese/English/Simplified Chinese UI

## Data flow and privacy

```text
PDF / image on device ──only when you request extraction──▶ chosen OpenAI, Anthropic, or NanoGPT API
Atom + generation prompt ──only when content is needed────▶ chosen provider (or local Ollama)
SQLite learning state, interactions, API usage────────────▶ stays on device
API key────────────────────────────────────────────────────▶ OS secure storage only
```

Uploaded materials are sent as native document/image inputs to the provider you choose. PDFs are structurally split into bounded page excerpts on-device; their text is not parsed or sent anywhere else first. Materials never pass through a LearnStream server. JSON exports omit original material files and API keys. There is no multi-device sync.

## Run on Android

Requirements: Node.js 22 or newer, pnpm 10 or newer, Android Studio/emulator or a physical Android device.

```bash
pnpm install
pnpm android
```

The app uses native modules. Expo Go can run most foreground features, but a development build is recommended for SecureStore, background tasks, and notification testing:

```bash
pnpm exec expo prebuild --platform android
pnpm exec expo run:android
```

On first launch, choose the bundled demo or configure an API key. The onboarding key check validates authentication without invoking a model, so a temporary model overload cannot reject an otherwise valid key. Settings → Providers lets each provider use an editable Base URL, optional secure custom headers, and a live model catalog. Extraction, post generation, and AI replies can use different provider/model pairs; OpenAI-compatible endpoints can choose Responses or Chat Completions. Extraction models must accept PDF or image input. NanoGPT defaults to its subscription endpoint, and Ollama supports generation and AI replies only; its Android-emulator default is `http://10.0.2.2:11434/v1`.

Settings → Automatic post generation controls the unread pool, batch size, foreground/background intervals, and daily safety limit. Feed refill remains deferrable background work. Material extraction is different: it starts immediately in a notification-backed Android foreground WorkManager, persists progress in SQLite, and resumes stale work after process or device restart. Removing the app from Android's recent-apps list does not cancel the extraction. Android's explicit Settings → Force stop is OS-enforced and prevents every app job from running until the user launches the app again.

### PDF page ranges

The app reads the PDF page count and creates real excerpts of at most 20 pages per provider request. Original page numbers are preserved in the extraction prompt and source anchors. An unspecified range processes the complete PDF up to 150 pages; larger selections are rejected with a page-range message. Corrupt and password-protected PDFs stop with an actionable review-screen error instead of being uploaded repeatedly.

## Quality checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm simulate
pnpm dlx expo-doctor
pnpm exec expo export --platform web
```

The simulation prints posterior means and pull counts so bandit convergence and IRT adaptation can be inspected. `src/core` is pure TypeScript and has no React or Expo imports.

## Project map

- `app/` — expo-router screens
- `src/core/` — pure bandit, SRS, IRT, ranking, and scheduling logic
- `src/db/` — Drizzle schema, SQLite migration, data access, and demo seed
- `src/llm/` — provider adapters, extraction, generation, deep-dive, validation, and usage logging
- `src/ingest/` — material copying, chunk orchestration, retry, and staleness handling

## Security notes

Never commit API keys. Native provider calls are direct. Web provider support depends on each provider's browser-call policy; native Android is the primary target. Price estimates are informational and visible only under Settings → Usage.

## License

MIT. See [LICENSE](LICENSE).

// Define durable background tasks before Expo Router mounts any UI. Android
// can load this bundle with no Activity, so importing only from app/_layout.tsx
// is too late for a cold-start TaskManager event.
import "./src/services/background";
import "expo-router/entry";

import { requireOptionalNativeModule } from "expo";
import { NativeModules, Platform } from "react-native";

type NativeExtractionWorkModule = {
  schedule?: () => Promise<void> | void;
};

export type ExtractionScheduleMode =
  | "native"
  | "periodic"
  | "unavailable";

/**
 * Ask Android to start extraction as soon as possible. Production Android
 * builds can provide LearnStreamExtractionWork as a long-running foreground
 * WorkManager bridge. Expo's periodic task remains a durable fallback for
 * development builds and other platforms.
 */
export async function scheduleImmediateExtractionWork(): Promise<ExtractionScheduleMode> {
  let periodicRegistered = false;
  try {
    // The native WorkManager bridge dispatches through Expo TaskManager. Its
    // JS consumer must be persisted before enqueueing the immediate worker,
    // especially when automatic feed generation is disabled.
    const { syncBackgroundExtractionRegistration } = await import(
      "./background"
    );
    periodicRegistered = (
      await syncBackgroundExtractionRegistration()
    ).registered;
  } catch {
    periodicRegistered = false;
  }

  const nativeModule =
    requireOptionalNativeModule<NativeExtractionWorkModule>(
      "LearnStreamExtractionWork",
    ) ??
    (NativeModules
      .LearnStreamExtractionWork as NativeExtractionWorkModule | undefined);
  if (
    periodicRegistered &&
    Platform.OS === "android" &&
    nativeModule?.schedule
  ) {
    await nativeModule.schedule();
    return "native";
  }
  return periodicRegistered ? "periodic" : "unavailable";
}

import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, AppState, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { getSetting } from "../src/db/database";
import { seedDemoIfNeeded } from "../src/db/seed";
import { initI18n } from "../src/i18n";
import { colors } from "../src/ui/theme";
import { registerBackgroundRefill } from "../src/services/background";
import { requestExtractionWork } from "../src/services/extraction-jobs";
import { evaluateNotifications } from "../src/services/notifications";
import { grantDailyOpen } from "../src/gamification";
import {
  getAutoGenerationSettings,
  requestAutoGeneration,
  subscribeToAutoGenerationSettings,
} from "../src/services/autogeneration";

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const router = useRouter();
  const segments = useSegments();
  useEffect(() => {
    let cancelled = false;
    let healthTimer: ReturnType<typeof setTimeout> | undefined;
    let healthScheduleVersion = 0;
    const generateIfOnboarded = async (
      trigger: "initial" | "foreground" | "health",
    ) => {
      if (await getSetting("onboardingComplete", false))
        await requestAutoGeneration(trigger);
    };
    const scheduleHealthCheck = async () => {
      const version = ++healthScheduleVersion;
      const settings = await getAutoGenerationSettings();
      if (cancelled || version !== healthScheduleVersion) return;
      if (healthTimer) clearTimeout(healthTimer);
      healthTimer = setTimeout(async () => {
        if (AppState.currentState === "active")
          await generateIfOnboarded("health").catch(() => {});
        await scheduleHealthCheck();
      }, settings.foregroundIntervalMinutes * 60_000);
    };
    const unsubscribeSettings = subscribeToAutoGenerationSettings(() => {
      void scheduleHealthCheck();
    });
    (async () => {
      await initI18n();
      await seedDemoIfNeeded();
      await grantDailyOpen();
      await registerBackgroundRefill();
      await evaluateNotifications();
      setReady(true);
      void requestExtractionWork("startup").catch(() => {});
      void generateIfOnboarded("initial").catch(() => {});
      void scheduleHealthCheck();
    })().catch((error) => {
      console.error(error);
      setReady(true);
    });
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        requestExtractionWork("foreground").catch(() => {});
        generateIfOnboarded("foreground").catch(() => {});
        evaluateNotifications().catch(() => {});
      }
    });
    return () => {
      cancelled = true;
      unsubscribeSettings();
      if (healthTimer) clearTimeout(healthTimer);
      listener.remove();
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    getSetting("onboardingComplete", false).then((done) => {
      if (!done && segments[0] !== "onboarding") router.replace("/onboarding");
    });
  }, [ready, segments, router]);
  if (!ready)
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator color={colors.blue} />
      </View>
    );
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      />
    </SafeAreaProvider>
  );
}

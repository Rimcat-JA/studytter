import { Tabs } from "expo-router";
import { Text, type ColorValue } from "react-native";
import { useTranslation } from "react-i18next";
import { ScreenSafeAreaProvider } from "../../src/ui/components";
import { colors } from "../../src/ui/theme";

const TabIcon = ({ glyph, color }: { glyph: string; color: ColorValue }) => (
  <Text style={{ color, fontSize: 20 }}>{glyph}</Text>
);

export default function TabsLayout() {
  const { t } = useTranslation();
  return (
    <ScreenSafeAreaProvider edges={["bottom"]}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarPosition: "top",
          tabBarLabelPosition: "below-icon",
          tabBarStyle: {
            backgroundColor: colors.bg,
            borderBottomColor: colors.line,
          },
          tabBarActiveTintColor: colors.blue,
          tabBarInactiveTintColor: colors.muted,
          tabBarLabelStyle: { fontWeight: "700", paddingBottom: 4 },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: t("feed"),
            tabBarAccessibilityLabel: t("feed"),
            tabBarIcon: ({ color }) => <TabIcon glyph="⌂" color={color} />,
          }}
        />
        <Tabs.Screen
          name="progress"
          options={{
            title: t("progress"),
            tabBarAccessibilityLabel: t("progress"),
            tabBarIcon: ({ color }) => <TabIcon glyph="◒" color={color} />,
          }}
        />
        <Tabs.Screen
          name="settings/index"
          options={{
            title: t("settings"),
            tabBarAccessibilityLabel: t("settings"),
            tabBarIcon: ({ color }) => <TabIcon glyph="⚙" color={color} />,
          }}
        />
        <Tabs.Screen name="settings/providers" options={{ href: null }} />
        <Tabs.Screen name="settings/generation" options={{ href: null }} />
        <Tabs.Screen name="settings/subjects" options={{ href: null }} />
        <Tabs.Screen name="settings/usage" options={{ href: null }} />
        <Tabs.Screen name="settings/data" options={{ href: null }} />
        <Tabs.Screen name="settings/notifications" options={{ href: null }} />
        <Tabs.Screen name="settings/debug" options={{ href: null }} />
      </Tabs>
    </ScreenSafeAreaProvider>
  );
}

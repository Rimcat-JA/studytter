import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Header, Screen } from "../../../src/ui/components";
import { colors } from "../../../src/ui/theme";
import { setSetting } from "../../../src/db/database";

export default function Settings() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const items = [
    ["providers", "⌁", t("providers"), t("apiAndModels")],
    [
      "generation",
      "✦",
      t("autoGeneration"),
      t("autoGenerationSubtitle"),
    ],
    ["subjects", "◉", t("subjects"), t("materialManagement")],
    ["notifications", "♢", t("notifications"), t("localNotifications")],
    ["usage", "▥", t("usage"), ""],
    ["data", "⇅", t("data"), t("exportImport")],
    ["debug", "⌘", t("diagnostics"), t("interactionLog")],
  ] as const;
  return (
    <Screen>
      <Header title={t("settings")} />
      <ScrollView contentContainerStyle={styles.list}>
        {items.map(([path, icon, title, subtitle]) => (
          <Pressable
            key={path}
            onPress={() => router.push(`/(tabs)/settings/${path}` as never)}
            style={styles.item}
          >
            <Text style={styles.icon}>{icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{title}</Text>
              {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))}
        <View style={styles.languageCard}>
          <Text style={styles.title}>{t("language")}</Text>
          <View style={styles.languages}>
            {(
              [
                ["ja", "日本語"],
                ["en", "English"],
                ["zh-Hans", "简体中文"],
              ] as const
            ).map(([code, label]) => (
              <Pressable
                key={code}
                style={[
                  styles.languageChip,
                  i18n.language === code && styles.languageActive,
                ]}
                onPress={async () => {
                  await setSetting("uiLanguage", code);
                  await i18n.changeLanguage(code);
                }}
              >
                <Text style={styles.languageText}>{label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        <View style={styles.about}>
          <Text style={styles.brand}>LearnStream 1.0.0</Text>
          <Text style={styles.subtitle}>Your key. Your device.</Text>
          <Text style={styles.subtitle}>
            MIT License · No accounts · No telemetry
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}
const styles = StyleSheet.create({
  list: { padding: 16, gap: 10 },
  item: {
    minHeight: 68,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 16,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  icon: { fontSize: 23, color: colors.blue, width: 28, textAlign: "center" },
  title: { color: colors.text, fontSize: 16, fontWeight: "800" },
  subtitle: { color: colors.muted, fontSize: 13, marginTop: 3 },
  chevron: { color: colors.muted, fontSize: 26 },
  about: { alignItems: "center", gap: 6, padding: 30 },
  brand: { color: colors.text, fontWeight: "800" },
  languageCard: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 12,
  },
  languages: { flexDirection: "row", gap: 7 },
  languageChip: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 10,
    alignItems: "center",
    backgroundColor: colors.bg,
  },
  languageActive: { backgroundColor: colors.blue },
  languageText: { color: colors.text, fontSize: 12, fontWeight: "700" },
});

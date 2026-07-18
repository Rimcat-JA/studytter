import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { getSetting } from "../../../src/db/database";
import { setNotificationsEnabled } from "../../../src/services/notifications";
import { Card, Header, Screen } from "../../../src/ui/components";
import { colors } from "../../../src/ui/theme";
import { useTranslation } from "react-i18next";
export default function NotificationSettings() {
  const { t } = useTranslation();
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);
  useFocusEffect(
    useCallback(() => {
      getSetting("notificationsEnabled", false).then(setEnabled);
    }, []),
  );
  return (
    <Screen>
      <Header
        title={t("notifications")}
        right={
          <Pressable onPress={() => router.back()}>
            <Text style={styles.back}>‹</Text>
          </Pressable>
        }
      />
      <View style={styles.content}>
        <Card>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{t("learningReminders")}</Text>
              <Text style={styles.note}>{t("notificationHelp")}</Text>
            </View>
            <Switch
              value={enabled}
              onValueChange={async (v) =>
                setEnabled(await setNotificationsEnabled(v))
              }
              trackColor={{ true: colors.blue }}
            />
          </View>
        </Card>
        <Text style={styles.privacy}>{t("notificationPrivacy")}</Text>
      </View>
    </Screen>
  );
}
const styles = StyleSheet.create({
  back: { color: colors.text, fontSize: 35 },
  content: { padding: 16, gap: 14 },
  row: { flexDirection: "row", gap: 14, alignItems: "center" },
  title: {
    color: colors.text,
    fontWeight: "900",
    fontSize: 17,
    marginBottom: 7,
  },
  note: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  privacy: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 19,
    paddingHorizontal: 8,
  },
});

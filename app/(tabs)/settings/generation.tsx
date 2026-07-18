import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import type { AutoGenerationSettings } from "../../../src/core/autogeneration";
import {
  getAutoGenerationSettings,
  getAutoGenerationState,
  requestAutoGeneration,
  saveAutoGenerationSettings,
  type AutoGenerationState,
} from "../../../src/services/autogeneration";
import {
  getBackgroundRefillStatus,
  syncBackgroundRefillRegistration,
  type BackgroundRefillStatus,
} from "../../../src/services/background";
import {
  Button,
  Card,
  Field,
  Header,
  Loading,
  Screen,
  commonStyles,
} from "../../../src/ui/components";
import { colors } from "../../../src/ui/theme";

type Draft = {
  enabled: boolean;
  lowWatermark: string;
  targetUnread: string;
  batchSize: string;
  foregroundIntervalMinutes: string;
  backgroundIntervalMinutes: string;
  dailyPostLimit: string;
};

const toDraft = (settings: AutoGenerationSettings): Draft => ({
  enabled: settings.enabled,
  lowWatermark: String(settings.lowWatermark),
  targetUnread: String(settings.targetUnread),
  batchSize: String(settings.batchSize),
  foregroundIntervalMinutes: String(settings.foregroundIntervalMinutes),
  backgroundIntervalMinutes: String(settings.backgroundIntervalMinutes),
  dailyPostLimit: String(settings.dailyPostLimit),
});

const time = (value: number | null) =>
  value ? new Date(value).toLocaleString() : "—";

export default function GenerationSettingsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [state, setState] = useState<AutoGenerationState | null>(null);
  const [background, setBackground] = useState<BackgroundRefillStatus | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [settings, generationState, backgroundState] = await Promise.all([
      getAutoGenerationSettings(),
      getAutoGenerationState(),
      getBackgroundRefillStatus(),
    ]);
    setDraft(toDraft(settings));
    setState(generationState);
    setBackground(backgroundState);
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!draft || !state || !background)
    return (
      <Screen>
        <Loading />
      </Screen>
    );

  const update = (key: keyof Draft, value: string | boolean) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  const save = async () => {
    setBusy(true);
    try {
      const saved = await saveAutoGenerationSettings({
        enabled: draft.enabled,
        lowWatermark: Number(draft.lowWatermark),
        targetUnread: Number(draft.targetUnread),
        batchSize: Number(draft.batchSize),
        foregroundIntervalMinutes: Number(draft.foregroundIntervalMinutes),
        backgroundIntervalMinutes: Number(draft.backgroundIntervalMinutes),
        dailyPostLimit: Number(draft.dailyPostLimit),
      });
      await syncBackgroundRefillRegistration();
      setDraft(toDraft(saved));
      await load();
      Alert.alert(t("savedMessage"));
    } finally {
      setBusy(false);
    }
  };

  const generateNow = async () => {
    setBusy(true);
    try {
      const result = await requestAutoGeneration("manual", { force: true });
      await load();
      if (result.status === "failed")
        Alert.alert(
          t("generationFailed"),
          result.errorMessage ?? result.errorCode,
        );
      else if (result.inserted > 0)
        Alert.alert(
          t("generationComplete"),
          t("generatedPostsCount", { count: result.inserted }),
        );
      else
        Alert.alert(t("generationSkipped"), result.reason ?? "");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Header
        title={t("autoGeneration")}
        right={
          <Pressable onPress={() => router.back()}>
            <Text style={styles.back}>‹</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <View style={styles.row}>
            <View style={styles.grow}>
              <Text style={styles.title}>{t("autoGenerationEnabled")}</Text>
              <Text style={styles.note}>{t("autoGenerationEnabledHint")}</Text>
            </View>
            <Switch
              value={draft.enabled}
              onValueChange={(value) => update("enabled", value)}
              trackColor={{ true: colors.blue }}
            />
          </View>
        </Card>

        <Card>
          <Text style={styles.title}>{t("generationPool")}</Text>
          <NumericField
            label={t("lowWatermark")}
            value={draft.lowWatermark}
            onChange={(value) => update("lowWatermark", value)}
          />
          <Text style={styles.note}>{t("lowWatermarkHint")}</Text>
          <NumericField
            label={t("targetUnread")}
            value={draft.targetUnread}
            onChange={(value) => update("targetUnread", value)}
          />
          <NumericField
            label={t("generationBatchSize")}
            value={draft.batchSize}
            onChange={(value) => update("batchSize", value)}
          />
          <NumericField
            label={t("dailyPostLimit")}
            value={draft.dailyPostLimit}
            onChange={(value) => update("dailyPostLimit", value)}
          />
        </Card>

        <Card>
          <Text style={styles.title}>{t("generationIntervals")}</Text>
          <NumericField
            label={t("foregroundIntervalMinutes")}
            value={draft.foregroundIntervalMinutes}
            onChange={(value) => update("foregroundIntervalMinutes", value)}
          />
          <NumericField
            label={t("backgroundIntervalMinutes")}
            value={draft.backgroundIntervalMinutes}
            onChange={(value) => update("backgroundIntervalMinutes", value)}
          />
          <Text style={styles.note}>{t("backgroundTimingHint")}</Text>
        </Card>

        <Card>
          <Text style={styles.title}>{t("generationStatus")}</Text>
          <StatusRow label={t("status")} value={t(`generation_${state.phase}`)} />
          <StatusRow label={t("lastSuccess")} value={time(state.lastSuccessAt)} />
          <StatusRow label={t("nextRetry")} value={time(state.nextRetryAt)} />
          <StatusRow
            label={t("generatedToday")}
            value={String(state.generatedToday)}
          />
          <StatusRow
            label={t("backgroundTask")}
            value={
              !background.available
                ? t("backgroundUnavailable")
                : background.registered
                  ? t("backgroundRegistered", {
                      minutes: background.intervalMinutes,
                    })
                  : t("backgroundNotRegistered")
            }
          />
          {state.lastErrorMessage && (
            <View style={styles.error}>
              <Text style={styles.errorTitle}>
                {t("lastError")} · {state.lastErrorCode}
              </Text>
              <Text style={styles.errorText}>{state.lastErrorMessage}</Text>
            </View>
          )}
          {background.errorMessage && (
            <Text style={styles.errorText}>{background.errorMessage}</Text>
          )}
        </Card>

        <Button
          disabled={busy}
          title={busy ? t("generating") : t("generateNow")}
          onPress={generateNow}
        />
        <Button
          disabled={busy}
          variant="secondary"
          title={busy ? t("saving") : t("saveSettings")}
          onPress={save}
        />
      </ScrollView>
    </Screen>
  );
}

function NumericField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <View style={styles.numericField}>
      <Text style={commonStyles.label}>{label}</Text>
      <Field value={value} onChangeText={onChange} keyboardType="number-pad" />
    </View>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statusRow}>
      <Text style={styles.note}>{label}</Text>
      <Text style={styles.statusValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  back: { color: colors.text, fontSize: 35 },
  content: { padding: 16, paddingBottom: 48, gap: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  grow: { flex: 1 },
  title: {
    color: colors.text,
    fontWeight: "800",
    fontSize: 16,
    marginBottom: 10,
  },
  note: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  numericField: { marginTop: 10 },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    paddingVertical: 5,
  },
  statusValue: { color: colors.text, flex: 1, textAlign: "right" },
  error: {
    marginTop: 10,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#381820",
    gap: 5,
  },
  errorTitle: { color: colors.warning, fontWeight: "800" },
  errorText: { color: colors.text, fontSize: 12, lineHeight: 18 },
});

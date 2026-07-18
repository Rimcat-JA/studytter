import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { getDb } from "../../../src/db/database";
import { getExtractionJobPresentation } from "../../../src/core/extraction-jobs";
import { refillIfNeeded } from "../../../src/llm/generate";
import { formatProviderError } from "../../../src/llm/provider";
import {
  getExtractionJob,
  retryExtraction as retryExtractionJob,
  subscribeToExtractionJobs,
  type ExtractionJob,
} from "../../../src/services/extraction-jobs";
import {
  Button,
  Field,
  Header,
  Loading,
  Screen,
} from "../../../src/ui/components";
import { colors } from "../../../src/ui/theme";
import { useTranslation } from "react-i18next";

type Atom = {
  atom_id: string;
  topic_label: string;
  core: string;
  source_anchor: string;
  enabled: number;
};
type Material = {
  material_id: string;
  filename: string;
  status: string;
  error_message: string | null;
};
export default function Review() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [atoms, setAtoms] = useState<Atom[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [job, setJob] = useState<ExtractionJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const nameDirty = useRef(false);
  const handleDirty = useRef(false);
  const load = useCallback(async () => {
    const db = await getDb();
    const s = await db.getFirstAsync<{ display_name: string; handle: string }>(
      "SELECT display_name,handle FROM subjects WHERE subject_id=?",
      id,
    );
    // The background worker updates this screen every two seconds. Preserve
    // edits the user has already started while still accepting the extracted
    // profile suggestion until either field is touched.
    if (!nameDirty.current) setName(s?.display_name ?? "");
    if (!handleDirty.current) setHandle(s?.handle ?? "");
    setAtoms(
      await db.getAllAsync<Atom>(
        "SELECT atom_id,topic_label,core,source_anchor,enabled FROM atoms WHERE subject_id=? ORDER BY topic_label,created_at",
        id,
      ),
    );
    setMaterials(
      await db.getAllAsync<Material>(
        "SELECT material_id,filename,status,error_message FROM materials WHERE subject_id=?",
        id,
      ),
    );
    setJob(await getExtractionJob(id));
    setLoading(false);
  }, [id]);
  useFocusEffect(
    useCallback(() => {
      void load();
      const unsubscribe = subscribeToExtractionJobs((nextJob) => {
        if (nextJob.subjectId === id) void load();
      });
      // A headless/native worker can update SQLite from another JS runtime, so
      // local events alone are insufficient while this screen is visible.
      const timer = setInterval(() => {
        void load();
      }, 2_000);
      return () => {
        unsubscribe();
        clearInterval(timer);
      };
    }, [id, load]),
  );
  const toggle = async (atom: Atom) => {
    const next = atom.enabled ? 0 : 1;
    setAtoms((a) =>
      a.map((x) => (x.atom_id === atom.atom_id ? { ...x, enabled: next } : x)),
    );
    await (
      await getDb()
    ).runAsync(
      "UPDATE atoms SET enabled=? WHERE atom_id=?",
      next,
      atom.atom_id,
    );
  };
  const retry = async () => {
    setRetrying(true);
    try {
      await retryExtractionJob(id);
      await load();
    } catch (e) {
      Alert.alert(
        t("retryExtractionError"),
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setRetrying(false);
    }
  };
  const confirm = async () => {
    if (!atoms.some((a) => a.enabled)) {
      Alert.alert(t("confirmation"), t("enableAtLeastOneAtom"));
      return;
    }
    const db = await getDb();
    await db.runAsync(
      "UPDATE subjects SET display_name=?,handle=?,enabled=1 WHERE subject_id=?",
      name,
      handle.startsWith("@") ? handle : `@${handle}`,
      id,
    );
    router.replace("/(tabs)");
    refillIfNeeded().catch(console.error);
  };
  if (loading)
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  const grouped = atoms.reduce<Record<string, Atom[]>>((group, atom) => {
    (group[atom.topic_label] ??= []).push(atom);
    return group;
  }, {});
  const jobPresentation = job
    ? getExtractionJobPresentation(job.status)
    : null;
  const extractionActive = jobPresentation?.active === true;
  const progressPercent =
    job?.totalUnits && job.totalUnits > 0
      ? Math.min(100, (job.completedUnits / job.totalUnits) * 100)
      : 0;
  const jobTitle = jobPresentation ? t(jobPresentation.titleKey) : "";
  const extractionNeedsAttention = job?.status === "failed";
  const extractionWaitingToRetry = job?.status === "backoff";
  return (
    <Screen>
      <Header
        title={t("reviewTitle")}
        right={
          <Text style={styles.count}>
            {atoms.filter((a) => a.enabled).length}/{atoms.length}
          </Text>
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.intro}>{t("reviewIntro")}</Text>
        {job && job.status !== "complete" && (
          <View
            style={[
              styles.job,
              jobPresentation?.tone === "warning" && styles.jobFailed,
            ]}
          >
            <Text style={styles.jobTitle}>{jobTitle}</Text>
            {job.totalUnits > 0 && (
              <>
                <View style={styles.progressTrack}>
                  <View
                    style={[styles.progressFill, { width: `${progressPercent}%` }]}
                  />
                </View>
                <Text style={styles.jobText}>
                  {t("extractionProgress", {
                    completed: job.completedUnits,
                    total: job.totalUnits,
                  })}
                </Text>
              </>
            )}
            {job.status === "backoff" && job.nextAttemptAt && (
              <Text style={styles.jobText}>
                {t("extractionRetryAt", {
                  time: new Date(job.nextAttemptAt).toLocaleTimeString(),
                })}
              </Text>
            )}
            {job.lastError && (
              <Text style={styles.jobError}>
                {formatProviderError(job.lastError)}
              </Text>
            )}
            {extractionActive && (
              <Text style={styles.jobHint}>
                {t("extractionContinuesInBackground")}
              </Text>
            )}
            {extractionNeedsAttention && (
              <>
                <Button
                  disabled={retrying}
                  title={t("openAiConnectionSettings")}
                  variant="secondary"
                  onPress={() => router.push("/(tabs)/settings/providers")}
                />
                <Button
                  disabled={retrying}
                  title={retrying ? t("retrying") : t("retryFailed")}
                  variant="secondary"
                  onPress={retry}
                />
              </>
            )}
            {extractionWaitingToRetry && (
              <Button
                disabled={retrying}
                title={retrying ? t("retrying") : t("retryNow")}
                variant="secondary"
                onPress={retry}
              />
            )}
          </View>
        )}
        <Field
          value={name}
          onChangeText={(value) => {
            nameDirty.current = true;
            setName(value);
          }}
          placeholder={t("subjectName")}
        />
        <Field
          value={handle}
          onChangeText={(value) => {
            handleDirty.current = true;
            setHandle(value);
          }}
          autoCapitalize="none"
          placeholder="@handle"
        />
        {materials.some((m) => m.status === "failed") &&
          !extractionActive && (
          <View style={styles.error}>
            <Text style={styles.errorTitle}>{t("extractionFailed")}</Text>
            {materials
              .filter((m) => m.status === "failed")
              .map((m) => (
                <Text key={m.material_id} style={styles.errorText}>
                  {m.filename}: {formatProviderError(m.error_message)}
                </Text>
              ))}
            <Text style={styles.errorHelp}>
              {t("extractionSettingsHelp")}
            </Text>
            {!extractionNeedsAttention && (
              <>
                <Button
                  disabled={retrying}
                  title={t("openAiConnectionSettings")}
                  variant="secondary"
                  onPress={() => router.push("/(tabs)/settings/providers")}
                />
                <Button
                  disabled={retrying}
                  title={retrying ? t("retrying") : t("retryFailed")}
                  variant="secondary"
                  onPress={retry}
                />
              </>
            )}
          </View>
        )}
        {Object.entries(grouped).map(([topic, items]) => (
          <View key={topic} style={styles.group}>
            <Text style={styles.topic}>{topic}</Text>
            {items.map((atom) => (
              <Pressable
                key={atom.atom_id}
                onPress={() => toggle(atom)}
                style={styles.atom}
              >
                <View style={{ flex: 1, gap: 5 }}>
                  <Text style={[styles.core, !atom.enabled && styles.off]}>
                    {atom.core}
                  </Text>
                  <Text style={styles.anchor}>
                    {t("source")}: {atom.source_anchor}
                  </Text>
                </View>
                <Switch
                  value={!!atom.enabled}
                  onValueChange={() => toggle(atom)}
                  trackColor={{ true: colors.blue }}
                />
              </Pressable>
            ))}
          </View>
        ))}
        {!atoms.length && !extractionActive && (
          <View style={styles.error}>
            <Text style={styles.errorTitle}>{t("noAtoms")}</Text>
            <Text style={styles.errorText}>{t("noAtomsHelp")}</Text>
          </View>
        )}
        <Button
          disabled={!atoms.length || extractionActive}
          title={t("followSubject")}
          onPress={confirm}
        />
        <Button
          title={t("back")}
          variant="ghost"
          onPress={() => router.back()}
        />
      </ScrollView>
    </Screen>
  );
}
const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 42 },
  count: { color: colors.blue, fontWeight: "800" },
  intro: { color: colors.muted, lineHeight: 21 },
  group: { gap: 8 },
  topic: { color: colors.text, fontWeight: "900", fontSize: 18, paddingTop: 8 },
  atom: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    padding: 14,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.line,
  },
  core: { color: colors.text, lineHeight: 21 },
  off: { color: colors.muted, textDecorationLine: "line-through" },
  anchor: { color: colors.blue, fontSize: 12 },
  error: { padding: 14, borderRadius: 14, backgroundColor: "#381820", gap: 8 },
  errorTitle: { color: colors.warning, fontWeight: "800" },
  errorText: { color: colors.text, fontSize: 12 },
  errorHelp: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  job: {
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.blue,
    backgroundColor: "#0d1d29",
    gap: 8,
  },
  jobFailed: { borderColor: colors.warning, backgroundColor: "#381820" },
  jobTitle: { color: colors.text, fontSize: 16, fontWeight: "900" },
  jobText: { color: colors.text, fontSize: 13 },
  jobError: { color: colors.warning, fontSize: 12, lineHeight: 18 },
  jobHint: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: colors.surfaceAlt,
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: colors.blue,
  },
});

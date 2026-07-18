import * as DocumentPicker from "expo-document-picker";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { createId, getDb } from "../../src/db/database";
import {
  copyMaterials,
  type PickedMaterial,
} from "../../src/ingest";
import { getPurposeRoute } from "../../src/llm/config";
import { getApiKey } from "../../src/llm/provider";
import { enqueueExtraction } from "../../src/services/extraction-jobs";
import {
  Button,
  Field,
  Header,
  Screen,
  commonStyles,
} from "../../src/ui/components";
import { colors } from "../../src/ui/theme";
import { useTranslation } from "react-i18next";

const weights = {
  explainer: 0.3,
  quiz: 0.3,
  funfact: 0.1,
  misconception: 0.1,
  comparison: 0.1,
  mnemonic: 0.1,
};
export default function NewSubject() {
  const { t } = useTranslation();
  const router = useRouter();
  const [name, setName] = useState("");
  const [files, setFiles] = useState<PickedMaterial[]>([]);
  const [pageStart, setPageStart] = useState("");
  const [pageEnd, setPageEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const pick = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "image/*"],
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (!result.canceled)
      setFiles(
        result.assets.map((a) => ({
          uri: a.uri,
          name: a.name,
          mimeType:
            a.mimeType ??
            (a.name.toLowerCase().endsWith(".pdf")
              ? "application/pdf"
              : "image/jpeg"),
        })),
      );
  };
  const create = async () => {
    if (!name.trim() || !files.length) {
      Alert.alert("入力を確認してください", "科目名と教材が必要です。");
      return;
    }
    const { providerId } = await getPurposeRoute("extraction");
    if (providerId === "ollama" || !(await getApiKey(providerId))) {
      Alert.alert(
        "APIキーが必要です",
        "教材の抽出設定で、OpenAI・Anthropic・NanoGPTのAPIキーを保存してください。",
        [
          { text: "キャンセル" },
          {
            text: "設定へ",
            onPress: () => router.push("/(tabs)/settings/providers"),
          },
        ],
      );
      return;
    }
    const start = pageStart.trim() ? Number(pageStart) : undefined;
    const end = pageEnd.trim() ? Number(pageEnd) : undefined;
    if (
      (start !== undefined && (!Number.isInteger(start) || start < 1)) ||
      (end !== undefined && (!Number.isInteger(end) || end < 1))
    ) {
      Alert.alert("ページ範囲", "ページ番号は1以上の整数で指定してください。");
      return;
    }
    if (start && end && end < start) {
      Alert.alert("ページ範囲", "終了ページは開始ページ以降にしてください。");
      return;
    }
    if (end !== undefined && end - (start ?? 1) + 1 > 150) {
      Alert.alert(
        "大きなPDF",
        "一度に抽出できる範囲は150ページまでです。範囲を狭めてください。",
      );
      return;
    }
    setBusy(true);
    const subjectId = createId("subject");
    try {
      const db = await getDb();
      await db.runAsync(
        "INSERT INTO subjects VALUES(?,?,?,?,?,?,?,?,?)",
        subjectId,
        name.trim(),
        `@${name.trim().replace(/\s+/g, "_").toLowerCase()}`,
        "subject-" + subjectId,
        "ja",
        "mixed",
        JSON.stringify(weights),
        0,
        Date.now(),
      );
      await copyMaterials(
        subjectId,
        files.map((f) =>
          f.mimeType === "application/pdf"
            ? { ...f, pageStart: start, pageEnd: end }
            : f,
        ),
      );
      await enqueueExtraction(subjectId, "material");
      router.replace(`/subject/${subjectId}/review`);
    } catch (e) {
      Alert.alert(
        "抽出を開始できませんでした",
        e instanceof Error ? e.message : String(e),
      );
      router.replace(`/subject/${subjectId}/review`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen>
      <Header
        title={t("newSubjectTitle")}
        right={
          <Pressable onPress={() => router.back()}>
            <Text style={styles.close}>×</Text>
          </Pressable>
        }
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.content}>
          <View>
            <Text style={commonStyles.label}>{t("subjectName")}</Text>
            <Field
              value={name}
              onChangeText={setName}
              placeholder={t("subjectPlaceholder")}
              editable={!busy}
            />
          </View>
          <View>
            <Text style={commonStyles.label}>{t("materialsLabel")}</Text>
            <Pressable onPress={pick} disabled={busy} style={styles.drop}>
              <Text style={styles.dropIcon}>＋</Text>
              <Text style={styles.dropTitle}>{t("chooseMaterials")}</Text>
              <Text style={commonStyles.muted}>{t("materialsHint")}</Text>
            </Pressable>
          </View>
          {files.map((file, i) => (
            <View key={`${file.uri}-${i}`} style={styles.file}>
              <Text style={styles.fileIcon}>
                {file.mimeType === "application/pdf" ? "PDF" : "IMG"}
              </Text>
              <Text numberOfLines={1} style={styles.fileName}>
                {file.name}
              </Text>
              <Pressable
                disabled={busy}
                onPress={() => setFiles((f) => f.filter((_, j) => j !== i))}
              >
                <Text style={styles.remove}>×</Text>
              </Pressable>
            </View>
          ))}
          {files.some((f) => f.mimeType === "application/pdf") && (
            <View>
              <Text style={commonStyles.label}>{t("pdfRange")}</Text>
              <View style={commonStyles.row}>
                <Field
                  style={{ flex: 1 }}
                  keyboardType="number-pad"
                  value={pageStart}
                  onChangeText={setPageStart}
                  placeholder={t("startPage")}
                />
                <Text style={commonStyles.muted}>〜</Text>
                <Field
                  style={{ flex: 1 }}
                  keyboardType="number-pad"
                  value={pageEnd}
                  onChangeText={setPageEnd}
                  placeholder={t("endPage")}
                />
              </View>
              <Text style={styles.note}>{t("pdfRangeHint")}</Text>
            </View>
          )}
          {busy ? (
            <View style={styles.progress}>
              <Text style={styles.progressIcon}>◌</Text>
              <Text style={styles.progressText}>{t("preparing")}</Text>
              <Text style={commonStyles.muted}>{t("largeFileTime")}</Text>
            </View>
          ) : (
            <Button title={t("extractStart")} onPress={create} />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
const styles = StyleSheet.create({
  content: { padding: 16, gap: 18, paddingBottom: 40 },
  close: { fontSize: 32, color: colors.text },
  drop: {
    minHeight: 150,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: colors.blue,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    backgroundColor: "#0d1d29",
  },
  dropIcon: { fontSize: 34, color: colors.blue },
  dropTitle: { color: colors.text, fontWeight: "800", fontSize: 17 },
  file: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  fileIcon: { color: colors.blue, fontSize: 11, fontWeight: "900" },
  fileName: { flex: 1, color: colors.text },
  remove: { color: colors.muted, fontSize: 24 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 8 },
  progress: {
    minHeight: 140,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  progressIcon: { fontSize: 36, color: colors.blue },
  progressText: { color: colors.text, fontWeight: "800" },
});

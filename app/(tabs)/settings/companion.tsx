import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { importLearningPackage } from "../../../src/services/learning-package";
import { MAX_LEARNING_PACKAGE_BYTES, parseLearningPackage, type LearningPackage } from "../../../src/services/learning-package-schema";
import { Button, Card, Header, Screen, commonStyles } from "../../../src/ui/components";
import { colors } from "../../../src/ui/theme";
import { useAppStore } from "../../../src/state/app";

export default function CompanionImport() {
  const router = useRouter();
  const [preview, setPreview] = useState<LearningPackage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const running = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const choose = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setResult("");
    setPreview(null);
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: ["application/json", "text/plain", "application/octet-stream"], copyToCacheDirectory: true });
      if (picked.canceled) return;
      const asset = picked.assets[0];
      if ((asset.size ?? 0) > MAX_LEARNING_PACKAGE_BYTES)
        throw new Error("学習パッケージは25MB以下にしてください。");
      const file = new File(asset.uri);
      if (file.size > MAX_LEARNING_PACKAGE_BYTES)
        throw new Error("学習パッケージは25MB以下にしてください。");
      const parsed = parseLearningPackage(await file.text());
      if (mounted.current) setPreview(parsed);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error && cause.name !== "ZodError" ? cause.message : "学習パッケージの内容を検証できませんでした。PCアプリから書き出したJSONファイルを選んでください。");
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const importPreview = async () => {
    if (!preview || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const imported = await importLearningPackage(preview);
      if (!mounted.current) return;
      useAppStore.getState().setSelectedSubject(imported.subjectId);
      setResult(imported.alreadyImported ? "このパッケージは取り込み済みです。" : `${preview.subject.displayName}を追加しました。ホームで学習できます。`);
      setPreview(null);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "取り込めませんでした。もう一度お試しください。");
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Screen>
      <Header title="PCから取り込む" right={<Pressable onPress={() => router.back()}><Text style={styles.back}>‹</Text></Pressable>} />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <View style={styles.gap}>
            <Text style={styles.title}>PCで準備した教材を追加</Text>
            <Text style={commonStyles.subtitle}>PCアプリから書き出した学習パッケージ（JSON）を、この端末にコピーして選択してください。</Text>
            <Text style={commonStyles.subtitle}>問題・解説・出典を科目として追加します。既存の学習履歴は保持されます。</Text>
            <Button disabled={busy} title={busy ? "処理中…" : "ファイルを選ぶ"} onPress={choose} />
          </View>
        </Card>
        {preview && (
          <Card>
            <View style={styles.gap}>
              <Text style={styles.title}>{preview.subject.displayName}</Text>
              <Text style={commonStyles.text}>教材 {preview.materials.length} 件 · 知識 {preview.atoms.length} 件 · 投稿 {preview.posts.length} 件</Text>
              <Text style={commonStyles.subtitle}>作成日: {new Date(preview.createdAt).toLocaleDateString()}</Text>
              <Text style={commonStyles.subtitle}>{preview.materials.slice(0, 5).map((item) => item.filename).join("\n")}{preview.materials.length > 5 ? "\n…" : ""}</Text>
              <Text style={commonStyles.subtitle}>投稿の例: {preview.posts[0].text}</Text>
              <Text style={commonStyles.subtitle}>元のPDF・画像はパッケージに含まれません。出典と抜粋は学習データに保存されます。</Text>
              <Button disabled={busy} title="この科目を追加する" onPress={importPreview} />
            </View>
          </Card>
        )}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {result ? <Card><View style={styles.gap}><Text style={commonStyles.text}>{result}</Text><Button title="ホームへ" onPress={() => router.replace("/(tabs)")} /></View></Card> : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 16 },
  gap: { gap: 12 },
  title: { color: colors.text, fontSize: 18, fontWeight: "800" },
  back: { color: colors.text, fontSize: 35 },
  error: { color: colors.warning, lineHeight: 22 },
});

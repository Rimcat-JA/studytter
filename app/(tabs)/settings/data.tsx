import * as DocumentPicker from "expo-document-picker";
import * as Sharing from "expo-sharing";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { createExportFile, importData } from "../../../src/services/data";
import {
  Button,
  Card,
  Header,
  Screen,
  commonStyles,
} from "../../../src/ui/components";
import { colors } from "../../../src/ui/theme";
import { useTranslation } from "react-i18next";

export default function DataSettings() {
  const { t } = useTranslation();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const exportJson = async () => {
    setBusy(true);
    try {
      const file = await createExportFile();
      await Sharing.shareAsync(file.uri, {
        mimeType: "application/json",
        dialogTitle: "LearnStreamデータを書き出す",
      });
    } catch (e) {
      Alert.alert("書き出しエラー", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const chooseImport = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: "application/json",
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    Alert.alert(
      "すべてのデータを置き換えますか？",
      "現在の科目、投稿、学習履歴は削除され、選択したバックアップに置き換わります。APIキーは変更されません。元に戻せません。",
      [
        { text: "キャンセル" },
        {
          text: "置き換える",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            try {
              await importData(result.assets[0].uri);
              Alert.alert("読み込みました", "ホームに戻ると反映されます。");
              router.replace("/(tabs)");
            } catch (e) {
              Alert.alert(
                "読み込めませんでした",
                e instanceof Error ? e.message : String(e),
              );
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };
  return (
    <Screen>
      <Header
        title={t("data")}
        right={
          <Pressable onPress={() => router.back()}>
            <Text style={styles.back}>‹</Text>
          </Pressable>
        }
      />
      <View style={styles.content}>
        <Card>
          <Text style={styles.title}>{t("dataExportTitle")}</Text>
          <Text style={commonStyles.subtitle}>{t("dataExportHelp")}</Text>
          <Button disabled={busy} title={t("export")} onPress={exportJson} />
        </Card>
        <Card>
          <Text style={styles.title}>{t("dataImportTitle")}</Text>
          <Text style={commonStyles.subtitle}>{t("dataImportHelp")}</Text>
          <Button
            disabled={busy}
            variant="secondary"
            title={t("import")}
            onPress={chooseImport}
          />
        </Card>
      </View>
    </Screen>
  );
}
const styles = StyleSheet.create({
  back: { color: colors.text, fontSize: 35 },
  content: { padding: 16, gap: 16 },
  title: {
    color: colors.text,
    fontWeight: "900",
    fontSize: 18,
    marginBottom: 8,
  },
});

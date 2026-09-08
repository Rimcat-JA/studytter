import { File } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Text } from "react-native";
import { getDb } from "../../src/db/database";
import { Button, Card, Empty, Header, Loading, Screen, commonStyles } from "../../src/ui/components";

type Source = { core: string; note: string | null; source_anchor: string; filename: string; file_uri: string; mime_type: string };

export default function SourceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SourceContent key={id} id={id} />;
}

function SourceContent({ id }: { id: string }) {
  const router = useRouter();
  const [source, setSource] = useState<Source | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void getDb().then((db) => db.getFirstAsync<Source>(
      "SELECT a.core,a.note,a.source_anchor,m.filename,m.file_uri,m.mime_type FROM posts p JOIN atoms a ON a.atom_id=p.atom_id JOIN materials m ON m.material_id=a.material_id WHERE p.id=?", id,
    )).then((value) => { if (active) setSource(value); })
      .catch(() => { if (active) setError("出典を読み込めませんでした。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; mounted.current = false; };
  }, [id]);
  const openMaterial = async () => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    try {
      if (!source?.file_uri.startsWith("file:///") || !new File(source.file_uri).exists)
        throw new Error("この端末に元の教材ファイルがありません。PCで元の教材を確認してください。");
      if (!(await Sharing.isAvailableAsync())) throw new Error("この環境ではファイルを開けません。");
      if (!mounted.current) return;
      await Sharing.shareAsync(source.file_uri, { mimeType: source.mime_type, dialogTitle: "教材を開く" });
    } catch (cause) {
      if (mounted.current) Alert.alert("教材", cause instanceof Error ? cause.message : "教材を開けませんでした。");
    } finally {
      openingRef.current = false;
      if (mounted.current) setOpening(false);
    }
  };
  return <Screen><Header title="出典・教材" right={<Pressable accessibilityRole="button" accessibilityLabel="戻る" onPress={() => router.back()}><Text style={commonStyles.text}>‹ 戻る</Text></Pressable>} />{loading ? <Loading /> : !source ? <Empty title={error ?? "この投稿の教材情報はありません"} /> : <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
    <Card><Text style={commonStyles.label}>{source.filename}</Text><Text style={commonStyles.text}>{source.source_anchor}</Text></Card>
    <Card><Text style={commonStyles.label}>教材から抽出された知識</Text><Text selectable style={commonStyles.text}>{source.core}</Text></Card>
    {source.note && <Card><Text style={commonStyles.label}>教材メモ・原文の抜粋</Text><Text selectable style={commonStyles.text}>{source.note}</Text></Card>}
    <Text style={commonStyles.muted}>AIが作成した問題や知識は、元の教材と照らし合わせて確認できます。PCから取り込んだ場合は、PCにある元の教材をご確認ください。</Text>
    {source.file_uri.startsWith("file:///") && <Button disabled={opening} title={opening ? "開いています…" : "元の教材を開く・共有"} onPress={() => void openMaterial()} />}
  </ScrollView>}</Screen>;
}

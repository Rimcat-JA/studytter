import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
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
import { getDb, listSubjects, withDbTransaction, type SubjectRow } from "../../../src/db/database";
import {
  copyMaterials,
  removeMaterial,
  type PickedMaterial,
} from "../../../src/ingest";
import {
  enqueueExtraction,
  subscribeToExtractionJobs,
} from "../../../src/services/extraction-jobs";
import { Button, Header, Loading, Screen } from "../../../src/ui/components";
import { colors } from "../../../src/ui/theme";
import { Avatar } from "../../../src/ui/PostCard";
import { useTranslation } from "react-i18next";

type Material = {
  material_id: string;
  filename: string;
  file_uri: string;
  status: string;
};
export default function Subjects() {
  const { t } = useTranslation();
  const router = useRouter();
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [materials, setMaterials] = useState<Record<string, Material[]>>({});
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const load = useCallback(async () => {
    const db = await getDb();
    const s = await listSubjects();
    setSubjects(s);
    const all = await db.getAllAsync<Material & { subject_id: string }>(
      "SELECT material_id,subject_id,filename,file_uri,status FROM materials ORDER BY added_at",
    );
    setMaterials(
      all.reduce<Record<string, Material[]>>((group, row) => {
        (group[row.subject_id] ??= []).push(row);
        return group;
      }, {}),
    );
    setLoading(false);
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
      const unsubscribe = subscribeToExtractionJobs(() => {
        void load();
      });
      const timer = setInterval(() => {
        void load();
      }, 2_000);
      return () => {
        unsubscribe();
        clearInterval(timer);
      };
    }, [load]),
  );
  const pickOne = async (): Promise<PickedMaterial | null> => {
    const r = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "image/*"],
      copyToCacheDirectory: true,
    });
    if (r.canceled) return null;
    const a = r.assets[0];
    return {
      uri: a.uri,
      name: a.name,
      mimeType:
        a.mimeType ??
        (a.name.endsWith(".pdf") ? "application/pdf" : "image/jpeg"),
    };
  };
  const add = async (subjectId: string) => {
    const f = await pickOne();
    if (!f) return;
    setWorking(subjectId);
    try {
      await copyMaterials(subjectId, [f]);
      await enqueueExtraction(subjectId, "material");
      await load();
    } catch (e) {
      Alert.alert(
        "追加できませんでした",
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setWorking("");
    }
  };
  const replace = async (materialId: string, subjectId: string) => {
    const f = await pickOne();
    if (!f) return;
    setWorking(subjectId);
    try {
      const ownerSubjectId = await removeMaterial(materialId, f);
      if (ownerSubjectId)
        await enqueueExtraction(ownerSubjectId, "material");
      await load();
    } catch (e) {
      Alert.alert(
        "差し替えできませんでした",
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setWorking("");
    }
  };
  const remove = async (material: Material, subjectId: string) =>
    Alert.alert(
      "教材を取り除きますか？",
      "この教材の知識項目と未読投稿は無効になります。学習履歴は残ります。",
      [
        { text: "キャンセル" },
        {
          text: "取り除く",
          style: "destructive",
          onPress: async () => {
            setWorking(subjectId);
            await removeMaterial(material.material_id);
            try {
              const file = new File(material.file_uri);
              if (file.exists) file.delete();
            } catch {}
            await load();
            setWorking("");
          },
        },
      ],
    );
  const deleteSubject = async (subject: SubjectRow) =>
    Alert.alert(
      `「${subject.display_name}」を削除しますか？`,
      "教材ファイル、知識項目、投稿、学習状態を端末から完全に削除します。この操作は取り消せません。",
      [
        { text: "キャンセル" },
        {
          text: "完全に削除",
          style: "destructive",
          onPress: async () => {
            for (const m of materials[subject.subject_id] ?? [])
              try {
                const f = new File(m.file_uri);
                if (f.exists) f.delete();
              } catch {}
            await withDbTransaction(async (db) => {
              await db.runAsync(
                "DELETE FROM quiz_attempts WHERE post_id IN (SELECT id FROM posts WHERE subject_id=?)",
                subject.subject_id,
              );
              await db.runAsync(
                "DELETE FROM interactions WHERE post_id IN (SELECT id FROM posts WHERE subject_id=?)",
                subject.subject_id,
              );
              await db.runAsync(
                "DELETE FROM deepdives WHERE post_id IN (SELECT id FROM posts WHERE subject_id=?)",
                subject.subject_id,
              );
              await db.runAsync(
                "DELETE FROM posts WHERE subject_id=?",
                subject.subject_id,
              );
              await db.runAsync(
                "DELETE FROM atom_memory WHERE atom_id IN (SELECT atom_id FROM atoms WHERE subject_id=?)",
                subject.subject_id,
              );
              await db.runAsync(
                "DELETE FROM atoms WHERE subject_id=?",
                subject.subject_id,
              );
              await db.runAsync(
                "DELETE FROM materials WHERE subject_id=?",
                subject.subject_id,
              );
              await db.runAsync(
                "DELETE FROM subjects WHERE subject_id=?",
                subject.subject_id,
              );
            });
            await load();
          },
        },
      ],
    );
  if (loading)
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  return (
    <Screen>
      <Header
        title={t("subjects")}
        right={
          <Pressable onPress={() => router.back()}>
            <Text style={styles.back}>‹</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        {subjects.map((s) => (
          <View key={s.subject_id} style={styles.card}>
            <View style={styles.head}>
              <Avatar seed={s.avatar_seed} name={s.display_name} />
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{s.display_name}</Text>
                <Text style={styles.handle}>{s.handle}</Text>
              </View>
              <Switch
                value={!!s.enabled}
                onValueChange={async (v) => {
                  await (
                    await getDb()
                  ).runAsync(
                    "UPDATE subjects SET enabled=? WHERE subject_id=?",
                    v ? 1 : 0,
                    s.subject_id,
                  );
                  await load();
                }}
                trackColor={{ true: colors.blue }}
              />
            </View>
            {materials[s.subject_id]?.map((m) => (
              <View key={m.material_id} style={styles.material}>
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={styles.filename}>
                    {m.filename}
                  </Text>
                  <Text
                    style={[
                      styles.status,
                      m.status === "failed" && { color: colors.warning },
                    ]}
                  >
                    {m.status}
                  </Text>
                </View>
                <Pressable onPress={() => replace(m.material_id, s.subject_id)}>
                  <Text style={styles.action}>{t("replace")}</Text>
                </Pressable>
                <Pressable onPress={() => remove(m, s.subject_id)}>
                  <Text style={styles.remove}>{t("remove")}</Text>
                </Pressable>
              </View>
            ))}
            <Button
              disabled={working === s.subject_id}
              variant="secondary"
              title={
                working === s.subject_id ? t("processing") : t("addMaterial")
              }
              onPress={() => add(s.subject_id)}
            />
            <Button
              variant="danger"
              title={t("deleteSubject")}
              onPress={() => deleteSubject(s)}
            />
          </View>
        ))}
        <Button
          title={t("createNewSubject")}
          onPress={() => router.push("/subject/new")}
        />
      </ScrollView>
    </Screen>
  );
}
const styles = StyleSheet.create({
  content: { padding: 16, gap: 16, paddingBottom: 40 },
  back: { color: colors.text, fontSize: 35 },
  card: {
    padding: 14,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    gap: 12,
  },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  name: { color: colors.text, fontWeight: "900", fontSize: 17 },
  handle: { color: colors.muted },
  material: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 10,
    borderRadius: 10,
    backgroundColor: colors.bg,
  },
  filename: { color: colors.text },
  status: { color: colors.green, fontSize: 11 },
  action: { color: colors.blue, fontWeight: "800" },
  remove: { color: colors.red, fontWeight: "800" },
});

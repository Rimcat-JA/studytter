import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { debugInteractions } from "../../../src/db/database";
import { Header, Loading, Screen } from "../../../src/ui/components";
import { colors } from "../../../src/ui/theme";
export default function Debug() {
  const router = useRouter();
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  useEffect(() => {
    debugInteractions().then((r) => setRows(r as Record<string, unknown>[]));
  }, []);
  return (
    <Screen>
      <Header
        title="Interaction log"
        right={
          <Pressable onPress={() => router.back()}>
            <Text style={styles.back}>‹</Text>
          </Pressable>
        }
      />
      {!rows ? (
        <Loading />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.count}>{rows.length} recent rows</Text>
          {rows.map((row, i) => (
            <Text key={String(row.id ?? i)} style={styles.row}>
              {JSON.stringify(row)}
            </Text>
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}
const styles = StyleSheet.create({
  back: { color: colors.text, fontSize: 35 },
  content: { padding: 12, gap: 8 },
  count: { color: colors.blue, fontWeight: "800" },
  row: {
    color: colors.text,
    fontFamily: "monospace",
    fontSize: 11,
    padding: 10,
    backgroundColor: colors.surface,
    borderRadius: 8,
  },
});

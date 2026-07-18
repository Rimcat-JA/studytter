import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import prices from "../../../assets/model-prices.json";
import { getDb, getSetting, setSetting } from "../../../src/db/database";
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
import { useTranslation } from "react-i18next";

type Summary = {
  monthCost: number;
  purpose: { purpose: string; input: number; output: number }[];
  models: { model_id: string; input: number; output: number; cost: number }[];
  months: { month: string; cost: number }[];
};
type Price = { inputPerMillion: number; outputPerMillion: number };
export default function Usage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [data, setData] = useState<Summary | null>(null);
  const [table, setTable] = useState<Record<string, Price>>({});
  const [capEnabled, setCapEnabled] = useState(false);
  const [cap, setCap] = useState("10");
  const load = useCallback(async () => {
    const db = await getDb();
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const purpose = await db.getAllAsync<{
      purpose: string;
      input: number;
      output: number;
    }>(
      "SELECT purpose,SUM(input_tokens) input,SUM(output_tokens) output FROM usage_log WHERE created_at>=? GROUP BY purpose",
      start.getTime(),
    );
    const models = await db.getAllAsync<{
      model_id: string;
      input: number;
      output: number;
      cost: number;
    }>(
      "SELECT model_id,SUM(input_tokens) input,SUM(output_tokens) output,SUM(est_cost_usd) cost FROM usage_log WHERE created_at>=? GROUP BY model_id",
      start.getTime(),
    );
    const raw = await db.getAllAsync<{
      created_at: number;
      est_cost_usd: number;
    }>(
      "SELECT created_at,est_cost_usd FROM usage_log WHERE created_at>=?",
      Date.now() - 190 * 86400000,
    );
    const monthMap = new Map<string, number>();
    for (const row of raw) {
      const key = new Date(row.created_at).toISOString().slice(0, 7);
      monthMap.set(key, (monthMap.get(key) ?? 0) + row.est_cost_usd);
    }
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const key = d.toISOString().slice(0, 7);
      months.push({ month: key, cost: monthMap.get(key) ?? 0 });
    }
    setData({
      monthCost: models.reduce((a, b) => a + b.cost, 0),
      purpose,
      models,
      months,
    });
    setTable(await getSetting("priceTable", prices.models));
    setCapEnabled(await getSetting("monthlyCapEnabled", false));
    setCap(String(await getSetting("monthlyCapUsd", 10)));
  }, []);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );
  if (!data)
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  const max = Math.max(...data.months.map((m) => m.cost), 0.01);
  const capped = capEnabled && data.monthCost >= Number(cap || 0);
  return (
    <Screen>
      <Header
        title={t("usage")}
        right={
          <Pressable onPress={() => router.back()}>
            <Text style={styles.back}>‹</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        {capped && (
          <View style={styles.capBanner}>
            <Text style={styles.capTitle}>{t("capReached")}</Text>
            <Text style={styles.capText}>{t("generationPaused")}</Text>
          </View>
        )}
        <Card>
          <Text style={styles.eyebrow}>{t("monthEstimate")}</Text>
          <Text style={styles.total}>${data.monthCost.toFixed(4)}</Text>
          <Text style={styles.note}>
            推定額は設定した単価を使います。実際の請求とは異なる場合があります。
          </Text>
        </Card>
        <Card>
          <Text style={styles.title}>{t("sixMonths")}</Text>
          <View style={styles.chart}>
            {data.months.map((m) => (
              <View key={m.month} style={styles.barSlot}>
                <View
                  style={[
                    styles.bar,
                    { height: Math.max(3, (90 * m.cost) / max) },
                  ]}
                />
                <Text style={styles.month}>{m.month.slice(5)}</Text>
              </View>
            ))}
          </View>
        </Card>
        <Card>
          <Text style={styles.title}>{t("tokensByPurpose")}</Text>
          {data.purpose.map((p) => (
            <View key={p.purpose} style={styles.stat}>
              <Text style={styles.statName}>{p.purpose}</Text>
              <Text style={styles.statValue}>
                {(p.input + p.output).toLocaleString()}
              </Text>
            </View>
          ))}
          {!data.purpose.length && (
            <Text style={styles.note}>{t("noUsage")}</Text>
          )}
        </Card>
        <Card>
          <Text style={styles.title}>{t("byModel")}</Text>
          {data.models.map((m) => (
            <View key={m.model_id} style={styles.stat}>
              <View style={{ flex: 1 }}>
                <Text style={styles.statName}>{m.model_id}</Text>
                <Text style={styles.note}>
                  {(m.input + m.output).toLocaleString()} tokens
                </Text>
              </View>
              <Text style={styles.statValue}>${m.cost.toFixed(4)}</Text>
            </View>
          ))}
        </Card>
        <Card>
          <View style={styles.stat}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{t("capAlert")}</Text>
              <Text style={styles.note}>{t("capOff")}</Text>
            </View>
            <Switch
              value={capEnabled}
              onValueChange={setCapEnabled}
              trackColor={{ true: colors.blue }}
            />
          </View>
          {capEnabled && (
            <Field
              keyboardType="decimal-pad"
              value={cap}
              onChangeText={setCap}
              placeholder="USD"
            />
          )}
          <Button
            variant="secondary"
            title={t("saveCap")}
            onPress={async () => {
              await setSetting("monthlyCapEnabled", capEnabled);
              await setSetting("monthlyCapUsd", Number(cap) || 0);
            }}
          />
        </Card>
        <Card>
          <Text style={styles.title}>{t("priceTable")}</Text>
          <Text style={styles.note}>{prices.note}</Text>
          {Object.entries(table).map(([model, p]) => (
            <View key={model} style={{ gap: 6 }}>
              <Text style={styles.statName}>{model}</Text>
              <View style={commonStyles.row}>
                <Field
                  style={{ flex: 1 }}
                  value={String(p.inputPerMillion)}
                  keyboardType="decimal-pad"
                  onChangeText={(v) =>
                    setTable((t) => ({
                      ...t,
                      [model]: { ...p, inputPerMillion: Number(v) || 0 },
                    }))
                  }
                  placeholder="Input"
                />
                <Field
                  style={{ flex: 1 }}
                  value={String(p.outputPerMillion)}
                  keyboardType="decimal-pad"
                  onChangeText={(v) =>
                    setTable((t) => ({
                      ...t,
                      [model]: { ...p, outputPerMillion: Number(v) || 0 },
                    }))
                  }
                  placeholder="Output"
                />
              </View>
            </View>
          ))}
          <Button
            title={t("savePrices")}
            onPress={() => setSetting("priceTable", table)}
          />
        </Card>
      </ScrollView>
    </Screen>
  );
}
const styles = StyleSheet.create({
  back: { color: colors.text, fontSize: 35 },
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  eyebrow: { color: colors.muted, fontWeight: "700" },
  total: {
    color: colors.text,
    fontWeight: "900",
    fontSize: 38,
    marginVertical: 5,
  },
  note: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  title: {
    color: colors.text,
    fontWeight: "900",
    fontSize: 17,
    marginBottom: 8,
  },
  chart: { height: 120, flexDirection: "row", gap: 8, alignItems: "flex-end" },
  barSlot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 5,
  },
  bar: { width: "70%", backgroundColor: colors.blue, borderRadius: 5 },
  month: { color: colors.muted, fontSize: 10 },
  stat: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  statName: { color: colors.text, fontWeight: "700" },
  statValue: { color: colors.text, fontVariant: ["tabular-nums"] },
  capBanner: {
    padding: 15,
    borderRadius: 14,
    backgroundColor: "#3b2411",
    borderColor: colors.warning,
    borderWidth: 1,
  },
  capTitle: { color: colors.warning, fontWeight: "900" },
  capText: { color: colors.text, fontSize: 13, marginTop: 4 },
});

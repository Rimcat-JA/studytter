import { useRouter } from "expo-router";
import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import i18n from "../../src/i18n";
import { setSetting } from "../../src/db/database";
import {
  formatProviderError,
  setApiKey,
  testProviderCredentials,
} from "../../src/llm/provider";
import { Button, Field, Screen, commonStyles } from "../../src/ui/components";
import { colors } from "../../src/ui/theme";

export default function Onboarding() {
  const { t } = useTranslation();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<"openai" | "anthropic" | "nanogpt">("openai");
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [lang, setLang] = useState<"ja" | "en" | "zh-Hans">("ja");
  const saveProvider = async () => {
    if (key.trim()) {
      await setApiKey(provider, key);
      await setSetting("generationProvider", provider);
      await setSetting("extractionProvider", provider);
      await setSetting("deepdiveProvider", provider);
      const selectedModels = provider === "openai" ? {extraction:"gpt-5.4",generation:"gpt-5.4-mini",deepdive:"gpt-5.4"} : provider === "anthropic" ? {extraction:"claude-sonnet-4-6",generation:"claude-haiku-4-5",deepdive:"claude-sonnet-4-6"} : {extraction:"deepseek-chat",generation:"deepseek-chat",deepdive:"deepseek-chat"};
      await setSetting("extractionModel",selectedModels.extraction);await setSetting("generationModel",selectedModels.generation);await setSetting("deepdiveModel",selectedModels.deepdive);
      setStep(2);
    } else
      Alert.alert("APIキー", "APIキーを入力するか、デモを選んでください。");
  };
  const finish = async () => {
    await setSetting("uiLanguage", lang);
    await i18n.changeLanguage(lang);
    await setSetting("onboardingComplete", true);
    router.replace("/(tabs)");
  };
  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.wrap}
      >
        <View style={styles.dots}>
          {[0, 1, 2, 3].map((i) => (
            <View
              key={i}
              style={[styles.dot, i === step && styles.dotActive]}
            />
          ))}
        </View>
        {step === 0 && (
          <View style={styles.hero}>
            <View style={styles.logo}>
              <Text style={styles.logoText}>L</Text>
            </View>
            <Text style={styles.brand}>LearnStream</Text>
            <Text style={commonStyles.title}>{t("welcome")}</Text>
            <Text style={commonStyles.subtitle}>
              短い解説とクイズを、あなたのペースで。
            </Text>
            <Button title={t("start")} onPress={() => setStep(1)} />
          </View>
        )}
        {step === 1 && (
          <View style={styles.panel}>
            <Text style={commonStyles.title}>{t("provider")}</Text>
            <Text style={commonStyles.subtitle}>
              抽出には画像・PDF対応のOpenAI、Anthropic、またはNanoGPTが必要です。
            </Text>
            <View style={styles.toggle}>
              {(["openai", "anthropic", "nanogpt"] as const).map((id) => (
                <Pressable
                  key={id}
                  onPress={() => setProvider(id)}
                  style={[
                    styles.toggleItem,
                    provider === id && styles.toggleActive,
                  ]}
                >
                  <Text style={commonStyles.text}>
                    {id === "openai" ? "OpenAI" : id === "anthropic" ? "Anthropic" : "NanoGPT"}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Field
              value={key}
              onChangeText={setKey}
              secureTextEntry
              autoCapitalize="none"
              placeholder={t("apiKey")}
            />
            <Button
              disabled={!key.trim() || testing}
              variant="secondary"
              title={testing ? "確認中…" : t("test")}
              onPress={async () => {
                setTesting(true);
                try {
                  const trimmedKey = key.trim();
                  await testProviderCredentials(provider, {
                    apiKey: trimmedKey,
                  });
                  // Do not replace a previously working key until the entered
                  // key has actually passed the provider's auth-only probe.
                  await setApiKey(provider, trimmedKey);
                  Alert.alert(
                    t("apiKeyVerifiedTitle"),
                    t("apiKeyVerifiedMessage"),
                  );
                } catch (e) {
                  Alert.alert(
                    t("apiKeyCheckFailedTitle"),
                    formatProviderError(e),
                  );
                } finally {
                  setTesting(false);
                }
              }}
            />
            <Button title={t("next")} onPress={saveProvider} />
            <Button
              variant="ghost"
              title={t("demo")}
              onPress={() => setStep(2)}
            />
          </View>
        )}
        {step === 2 && (
          <View style={styles.panel}>
            <Text style={styles.privacyIcon}>⌁</Text>
            <Text style={commonStyles.title}>プライバシー</Text>
            <Text style={styles.privacy}>{t("privacy")}</Text>
            <Text style={commonStyles.subtitle}>
              アカウント、分析、中央サーバーはありません。APIキーは端末の安全な領域に保存されます。
            </Text>
            <Button title={t("next")} onPress={() => setStep(3)} />
          </View>
        )}
        {step === 3 && (
          <View style={styles.panel}>
            <Text style={commonStyles.title}>表示言語</Text>
            {(
              [
                ["ja", "日本語"],
                ["en", "English"],
                ["zh-Hans", "简体中文"],
              ] as const
            ).map(([id, label]) => (
              <Pressable
                key={id}
                onPress={() => setLang(id)}
                style={[styles.lang, lang === id && styles.langActive]}
              >
                <Text style={styles.langText}>{label}</Text>
                <Text style={styles.check}>{lang === id ? "✓" : ""}</Text>
              </Pressable>
            ))}
            <Button title={t("start")} onPress={finish} />
          </View>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}
const styles = StyleSheet.create({
  wrap: { flex: 1, padding: 24 },
  dots: {
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    paddingTop: 12,
  },
  dot: { width: 7, height: 7, borderRadius: 5, backgroundColor: colors.line },
  dotActive: { width: 22, backgroundColor: colors.blue },
  hero: { flex: 1, justifyContent: "center", gap: 18 },
  panel: { flex: 1, justifyContent: "center", gap: 18 },
  logo: {
    width: 72,
    height: 72,
    borderRadius: 22,
    backgroundColor: colors.blue,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: { color: "white", fontSize: 40, fontWeight: "900" },
  brand: { color: colors.blue, fontSize: 18, fontWeight: "800" },
  toggle: {
    flexDirection: "row",
    padding: 4,
    backgroundColor: colors.surface,
    borderRadius: 14,
  },
  toggleItem: { flex: 1, padding: 12, alignItems: "center", borderRadius: 10 },
  toggleActive: { backgroundColor: colors.surfaceAlt },
  privacyIcon: { fontSize: 64, color: colors.blue },
  privacy: {
    fontSize: 19,
    lineHeight: 30,
    color: colors.text,
    fontWeight: "700",
  },
  lang: {
    minHeight: 58,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  langActive: { borderColor: colors.blue, backgroundColor: "#0d2638" },
  langText: { color: colors.text, fontSize: 17, fontWeight: "700" },
  check: { color: colors.blue, fontSize: 20 },
});

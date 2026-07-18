import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDER_CONFIG,
  LLM_PURPOSES,
  PROVIDER_IDS,
  getProviderConfig,
  getPurposeRoute,
  setProviderConfig,
  setPurposeRoute,
  type LlmPurpose,
  type ProviderConfig,
  type ProviderId,
  type PurposeRoute,
} from "../../../src/llm/config";
import {
  deleteApiKey,
  diagnoseProvider,
  formatProviderError,
  getApiKey,
  getProviderHeaders,
  listProviderModels,
  setApiKey,
  setProviderHeaders,
  testProviderCredentials,
  type ProviderDiagnostic,
  type ProviderModel,
  type ProviderRuntimeOverrides,
} from "../../../src/llm/provider";
import {
  Button,
  Field,
  Header,
  Screen,
  commonStyles,
} from "../../../src/ui/components";
import { colors } from "../../../src/ui/theme";
import {
  clearAutoGenerationFailure,
  requestAutoGeneration,
} from "../../../src/services/autogeneration";
import { retryBackoffExtractions } from "../../../src/services/extraction-jobs";

type ProfileDraft = ProviderConfig & {
  apiKey: string;
  configured: boolean;
  headersText: string;
};
type Profiles = Record<ProviderId, ProfileDraft>;
type Routes = Record<LlmPurpose, PurposeRoute>;
type ModelLists = Record<ProviderId, ProviderModel[]>;

const initialProfiles: Profiles = {
  openai: {
    ...DEFAULT_PROVIDER_CONFIG.openai,
    apiKey: "",
    configured: false,
    headersText: "",
  },
  anthropic: {
    ...DEFAULT_PROVIDER_CONFIG.anthropic,
    apiKey: "",
    configured: false,
    headersText: "",
  },
  nanogpt: {
    ...DEFAULT_PROVIDER_CONFIG.nanogpt,
    apiKey: "",
    configured: false,
    headersText: "",
  },
  ollama: {
    ...DEFAULT_PROVIDER_CONFIG.ollama,
    apiKey: "",
    configured: true,
    headersText: "",
  },
};
const initialRoutes: Routes = {
  extraction: {
    providerId: "openai",
    model: DEFAULT_MODELS.openai.extraction,
  },
  generation: {
    providerId: "openai",
    model: DEFAULT_MODELS.openai.generation,
  },
  deepdive: {
    providerId: "openai",
    model: DEFAULT_MODELS.openai.deepdive,
  },
};
const emptyModelLists: ModelLists = {
  openai: [],
  anthropic: [],
  nanogpt: [],
  ollama: [],
};
const purposeLabelKeys: Record<LlmPurpose, string> = {
  extraction: "purposeExtraction",
  generation: "purposeGeneration",
  deepdive: "purposeAiReply",
};

function parseHeaders(value: string): Record<string, string> {
  if (!value.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      '追加ヘッダーはJSON形式で入力してください。例: {"X-Header":"value"}',
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("追加ヘッダーはJSONオブジェクトで入力してください。");
  const entries = Object.entries(parsed);
  if (entries.some(([name, value]) => !name.trim() || typeof value !== "string"))
    throw new Error("追加ヘッダーの名前と値は文字列で入力してください。");
  return Object.fromEntries(entries) as Record<string, string>;
}

function runtimeOverrides(profile: ProfileDraft): ProviderRuntimeOverrides {
  return {
    baseUrl: profile.baseUrl,
    protocol: profile.protocol,
    headers: parseHeaders(profile.headersText),
    apiKey: profile.apiKey.trim() || undefined,
  };
}

export default function Providers() {
  const { t } = useTranslation();
  const router = useRouter();
  const [selectedProvider, setSelectedProvider] =
    useState<ProviderId>("openai");
  const [profiles, setProfiles] = useState<Profiles>(initialProfiles);
  const [routes, setRoutes] = useState<Routes>(initialRoutes);
  const [modelLists, setModelLists] =
    useState<ModelLists>(emptyModelLists);
  const [diagnostic, setDiagnostic] = useState<{
    providerId: ProviderId;
    result: ProviderDiagnostic;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const profileEntries = await Promise.all(
      PROVIDER_IDS.map(async (providerId) => {
        const [config, headers, configured] = await Promise.all([
          getProviderConfig(providerId),
          getProviderHeaders(providerId),
          providerId === "ollama"
            ? Promise.resolve(true)
            : getApiKey(providerId).then(Boolean),
        ]);
        return [
          providerId,
          {
            ...config,
            apiKey: "",
            configured,
            headersText: Object.keys(headers).length
              ? JSON.stringify(headers, null, 2)
              : "",
          },
        ] as const;
      }),
    );
    const [extraction, generation, deepdive] = await Promise.all(
      LLM_PURPOSES.map(getPurposeRoute),
    );
    setProfiles(Object.fromEntries(profileEntries) as Profiles);
    setRoutes({ extraction, generation, deepdive });
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const profile = profiles[selectedProvider];
  const diagnosticModel = useMemo(() => {
    const matchingRoute =
      LLM_PURPOSES.map((purpose) => routes[purpose]).find(
        (route) => route.providerId === selectedProvider,
      ) ?? null;
    return matchingRoute?.model || DEFAULT_MODELS[selectedProvider].generation;
  }, [routes, selectedProvider]);

  const updateProfile = (change: Partial<ProfileDraft>) =>
    setProfiles((current) => ({
      ...current,
      [selectedProvider]: { ...current[selectedProvider], ...change },
    }));

  const fetchModels = async (providerId = selectedProvider) => {
    setBusy(`models-${providerId}`);
    try {
      const models = await listProviderModels(
        providerId,
        runtimeOverrides(profiles[providerId]),
      );
      setModelLists((current) => ({ ...current, [providerId]: models }));
      Alert.alert(
        t("modelListLoaded"),
        t("modelListLoadedCount", { count: models.length }),
      );
    } catch (error) {
      Alert.alert(
        t("modelListLoadFailed"),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setBusy(null);
    }
  };

  const runDiagnostic = async () => {
    setBusy(`diagnostic-${selectedProvider}`);
    try {
      const result = await diagnoseProvider(
        selectedProvider,
        diagnosticModel,
        runtimeOverrides(profile),
        {
          testPdf:
            routes.extraction.providerId === selectedProvider &&
            routes.extraction.model === diagnosticModel,
        },
      );
      setDiagnostic({ providerId: selectedProvider, result });
      if (result.models.length)
        setModelLists((current) => ({
          ...current,
          [selectedProvider]: result.models,
        }));
    } catch (error) {
      Alert.alert(
        t("diagnosticStartFailed"),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setBusy(null);
    }
  };

  const verifyCredentials = async () => {
    if (selectedProvider === "ollama") return;
    const providerId = selectedProvider;
    setBusy(`credentials-${providerId}`);
    try {
      await testProviderCredentials(
        providerId,
        runtimeOverrides(profiles[providerId]),
      );
      if (profiles[providerId].apiKey.trim()) {
        await setApiKey(providerId, profiles[providerId].apiKey);
        setProfiles((current) => ({
          ...current,
          [providerId]: {
            ...current[providerId],
            apiKey: "",
            configured: true,
          },
        }));
      }
      Alert.alert(t("apiKeyVerifiedTitle"), t("apiKeyVerifiedMessage"));
    } catch (error) {
      Alert.alert(t("apiKeyCheckFailedTitle"), formatProviderError(error));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    try {
      for (const providerId of PROVIDER_IDS) {
        const draft = profiles[providerId];
        const headers = parseHeaders(draft.headersText);
        await setProviderConfig(providerId, draft);
        await setProviderHeaders(providerId, headers);
        if (providerId !== "ollama" && draft.apiKey.trim())
          await setApiKey(providerId, draft.apiKey);
      }
      for (const purpose of LLM_PURPOSES)
        await setPurposeRoute(purpose, routes[purpose]);
      await clearAutoGenerationFailure();
      await retryBackoffExtractions();
      void requestAutoGeneration("settings");
      await load();
      Alert.alert(t("savedMessage"));
    } catch (error) {
      Alert.alert(
        t("settingsSaveFailed"),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      <Header
        title={t("providers")}
        right={
          <Pressable onPress={() => router.back()}>
            <Text style={styles.back}>‹</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.sectionTitle}>{t("connectionSettings")}</Text>
        <ProviderChips
          value={selectedProvider}
          onChange={setSelectedProvider}
        />
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{providerLabel(selectedProvider)}</Text>
          {selectedProvider !== "ollama" && (
            <>
              <Text style={commonStyles.label}>
                {t("apiKey")} {profile.configured && <Text style={styles.ok}>✓ {t("apiConfigured")}</Text>}
              </Text>
              <Field
                value={profile.apiKey}
                onChangeText={(apiKey) => updateProfile({ apiKey })}
                placeholder={
                  profile.configured ? t("replaceKey") : t("apiKey")
                }
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </>
          )}

          <Text style={commonStyles.label}>Base URL</Text>
          <Field
            value={profile.baseUrl}
            onChangeText={(baseUrl) => updateProfile({ baseUrl })}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          {selectedProvider === "openai" && (
            <>
              <Text style={commonStyles.label}>{t("apiProtocol")}</Text>
              <View style={styles.protocols}>
                {(["responses", "chat"] as const).map((protocol) => (
                  <Pressable
                    key={protocol}
                    onPress={() => updateProfile({ protocol })}
                    style={[
                      styles.protocol,
                      profile.protocol === protocol && styles.protocolActive,
                    ]}
                  >
                    <Text style={styles.protocolText}>
                      {protocol === "responses"
                        ? "Responses API"
                        : "Chat Completions"}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}

          <Text style={commonStyles.label}>{t("customHeaders")}</Text>
          <Field
            value={profile.headersText}
            onChangeText={(headersText) => updateProfile({ headersText })}
            placeholder={'{"X-Custom-Header":"value"}'}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            numberOfLines={3}
            style={styles.headers}
          />
          <Text style={styles.note}>{t("customHeadersSecureNote")}</Text>

          {selectedProvider !== "ollama" && (
            <Button
              variant="secondary"
              disabled={busy !== null || (!profile.configured && !profile.apiKey.trim())}
              title={
                busy === `credentials-${selectedProvider}`
                  ? t("testingApiKey")
                  : t("testKey")
              }
              onPress={() => void verifyCredentials()}
            />
          )}

          <View style={styles.buttonRow}>
            <View style={styles.buttonCell}>
              <Button
                variant="secondary"
                disabled={busy !== null}
                title={
                  busy === `models-${selectedProvider}`
                    ? t("loadingModels")
                    : t("fetchModels")
                }
                onPress={() => void fetchModels()}
              />
            </View>
            <View style={styles.buttonCell}>
              <Button
                variant="secondary"
                disabled={busy !== null || !diagnosticModel.trim()}
                title={
                  busy === `diagnostic-${selectedProvider}`
                    ? t("diagnosingConnection")
                    : t("diagnoseConnection")
                }
                onPress={() => void runDiagnostic()}
              />
            </View>
          </View>

          {profile.configured && selectedProvider !== "ollama" && (
            <Button
              variant="danger"
              disabled={busy !== null}
              title={t("deleteKey")}
              onPress={() =>
                Alert.alert(t("deleteApiKeyTitle"), t("irreversibleAction"), [
                  { text: t("cancel") },
                  {
                    text: t("remove"),
                    style: "destructive",
                    onPress: async () => {
                      await deleteApiKey(selectedProvider);
                      updateProfile({ configured: false, apiKey: "" });
                    },
                  },
                ])
              }
            />
          )}
        </View>

        {diagnostic?.providerId === selectedProvider && (
          <DiagnosticCard result={diagnostic.result} />
        )}

        <Text style={styles.sectionTitle}>{t("purposeRoutingTitle")}</Text>
        <Text style={styles.note}>{t("purposeRoutingNote")}</Text>
        {LLM_PURPOSES.map((purpose) => (
          <RouteEditor
            key={purpose}
            purpose={purpose}
            route={routes[purpose]}
            models={modelLists[routes[purpose].providerId]}
            onChange={(route) =>
              setRoutes((current) => ({ ...current, [purpose]: route }))
            }
            onFetchModels={() => void fetchModels(routes[purpose].providerId)}
            busy={busy !== null}
          />
        ))}

        <Button
          disabled={busy !== null}
          title={busy === "save" ? t("saving") : t("saveSettings")}
          onPress={() => void save()}
        />
      </ScrollView>
    </Screen>
  );
}

function ProviderChips({
  value,
  onChange,
  allowOllama = true,
}: {
  value: ProviderId;
  onChange: (providerId: ProviderId) => void;
  allowOllama?: boolean;
}) {
  return (
    <View style={styles.tabs}>
      {PROVIDER_IDS.filter((id) => allowOllama || id !== "ollama").map((id) => (
        <Pressable
          key={id}
          onPress={() => onChange(id)}
          style={[styles.tab, value === id && styles.active]}
        >
          <Text style={[styles.tabText, value === id && styles.activeText]}>
            {id === "nanogpt" ? "Nano" : providerLabel(id)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function RouteEditor({
  purpose,
  route,
  models,
  onChange,
  onFetchModels,
  busy,
}: {
  purpose: LlmPurpose;
  route: PurposeRoute;
  models: ProviderModel[];
  onChange: (route: PurposeRoute) => void;
  onFetchModels: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const capable =
    purpose === "extraction"
      ? models.filter((model) => model.pdfInput || model.imageInput)
      : models;
  const catalog = purpose === "extraction" ? capable : models;
  const query = route.model.trim().toLowerCase();
  const matching = query
    ? catalog.filter((model) => model.id.toLowerCase().includes(query))
    : catalog;
  const selected = catalog.find((model) => model.id === route.model);
  const suggestions = [
    ...(selected ? [selected] : []),
    ...matching.filter((model) => model.id !== selected?.id),
  ].slice(0, 10);
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{t(purposeLabelKeys[purpose])}</Text>
      <ProviderChips
        value={route.providerId}
        allowOllama={purpose !== "extraction"}
        onChange={(providerId) =>
          onChange({
            providerId,
            model: DEFAULT_MODELS[providerId][purpose],
          })
        }
      />
      <Text style={commonStyles.label}>{t("model")}</Text>
      <Field
        value={route.model}
        onChangeText={(model) => onChange({ ...route, model })}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={t("modelIdPlaceholder")}
      />
      {!models.length ? (
        <Pressable disabled={busy} onPress={onFetchModels}>
          <Text style={styles.link}>{t("fetchModelsForProvider")}</Text>
        </Pressable>
      ) : (
        <>
          <Text style={styles.note}>
            {purpose === "extraction"
              ? t("extractionCapableModelCount", {
                  capable: capable.length,
                  total: models.length,
                })
              : t("modelCatalogReady", { count: models.length })}
          </Text>
          <View style={styles.modelSuggestions}>
            {suggestions.map((model) => (
              <Pressable
                key={model.id}
                onPress={() => onChange({ ...route, model: model.id })}
                style={[
                  styles.modelChip,
                  route.model === model.id && styles.modelChipActive,
                ]}
              >
                <Text numberOfLines={2} style={styles.modelText}>
                  {model.id}
                  {model.pdfInput ? " · PDF" : ""}
                  {model.imageInput ? ` · ${t("imageCapability")}` : ""}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
      {purpose === "extraction" && route.providerId === "nanogpt" && (
        <Text style={styles.note}>{t("nanoPdfRoutingNote")}</Text>
      )}
      {purpose === "extraction" && (
        <Text style={styles.note}>{t("pdfDiagnosticHint")}</Text>
      )}
    </View>
  );
}

function DiagnosticCard({ result }: { result: ProviderDiagnostic }) {
  const { t } = useTranslation();
  return (
    <View style={[styles.card, result.ok ? styles.success : styles.failure]}>
      <Text style={styles.cardTitle}>
        {result.ok
          ? t("diagnosticAvailable")
          : t("diagnosticNeedsAttention")}
      </Text>
      <Text style={styles.note}>
        {t("diagnosticElapsed", { milliseconds: result.latencyMs })}
      </Text>
      {result.checks.map((check) => (
        <View key={check.label} style={styles.check}>
          <Text style={check.ok ? styles.checkOk : styles.checkBad}>
            {check.ok ? "✓" : "!"}
          </Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.checkLabel}>{check.label}</Text>
            <Text style={styles.checkDetail}>{check.detail}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function providerLabel(providerId: ProviderId) {
  if (providerId === "openai") return "OpenAI";
  if (providerId === "anthropic") return "Anthropic";
  if (providerId === "nanogpt") return "NanoGPT";
  return "Ollama";
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 48 },
  back: { color: colors.text, fontSize: 35 },
  sectionTitle: { color: colors.text, fontSize: 20, fontWeight: "900" },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 11,
  },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: "900" },
  tabs: {
    flexDirection: "row",
    backgroundColor: colors.bg,
    padding: 4,
    borderRadius: 12,
    gap: 2,
  },
  tab: { flex: 1, paddingVertical: 10, alignItems: "center", borderRadius: 9 },
  active: { backgroundColor: colors.blue },
  tabText: { color: colors.muted, fontSize: 11, fontWeight: "800" },
  activeText: { color: "white" },
  ok: { color: colors.green, fontSize: 12 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  headers: { minHeight: 88, paddingTop: 12, textAlignVertical: "top" },
  protocols: { flexDirection: "row", gap: 8 },
  protocol: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  protocolActive: { borderColor: colors.blue, backgroundColor: "#0d2638" },
  protocolText: { color: colors.text, fontSize: 12, fontWeight: "700" },
  buttonRow: { flexDirection: "row", gap: 8 },
  buttonCell: { flex: 1 },
  link: { color: colors.blue, fontWeight: "800", paddingVertical: 4 },
  modelSuggestions: { gap: 7 },
  modelChip: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bg,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: 10,
  },
  modelChipActive: { borderColor: colors.blue, backgroundColor: "#0d2638" },
  modelText: { color: colors.text, fontSize: 12, lineHeight: 17 },
  success: { borderColor: colors.green },
  failure: { borderColor: colors.warning },
  check: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  checkOk: { color: colors.green, fontWeight: "900", fontSize: 17 },
  checkBad: { color: colors.warning, fontWeight: "900", fontSize: 17 },
  checkLabel: { color: colors.text, fontWeight: "800" },
  checkDetail: { color: colors.muted, fontSize: 12, lineHeight: 17 },
});

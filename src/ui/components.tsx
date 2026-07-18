import {
  createContext,
  useContext,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from "react-native";
import {
  SafeAreaView,
  type Edge,
} from "react-native-safe-area-context";
import { colors, radius } from "./theme";

const ScreenSafeAreaEdgesContext = createContext<readonly Edge[]>(["top"]);

export function ScreenSafeAreaProvider({
  children,
  edges,
}: PropsWithChildren<{ edges: readonly Edge[] }>) {
  return (
    <ScreenSafeAreaEdgesContext.Provider value={edges}>
      {children}
    </ScreenSafeAreaEdgesContext.Provider>
  );
}

export function Screen({ children }: PropsWithChildren) {
  const edges = useContext(ScreenSafeAreaEdgesContext);
  return (
    <SafeAreaView edges={edges} style={styles.screen}>
      {children}
    </SafeAreaView>
  );
}
export function Header({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={styles.header}>
      <Text style={styles.headerTitle}>{title}</Text>
      {right}
    </View>
  );
}
export function Button({
  title,
  onPress,
  variant = "primary",
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        styles[`button_${variant}`],
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          variant === "ghost" && { color: colors.blue },
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}
export function Field(props: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={colors.muted}
      {...props}
      style={[styles.field, props.style]}
    />
  );
}
export function Card({ children }: PropsWithChildren) {
  return <View style={styles.card}>{children}</View>;
}
export function Loading({ label = "読み込み中…" }: { label?: string }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.blue} />
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}
export function Empty({
  icon = "✦",
  title,
  body,
  action,
}: {
  icon?: string;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyIcon}>{icon}</Text>
      <Text style={styles.emptyTitle}>{title}</Text>
      {body && <Text style={styles.muted}>{body}</Text>}
      {action}
    </View>
  );
}

export const commonStyles = StyleSheet.create({
  title: { color: colors.text, fontSize: 28, fontWeight: "800" },
  subtitle: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  label: {
    color: colors.text,
    fontWeight: "700",
    fontSize: 14,
    marginBottom: 8,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  separator: { height: 1, backgroundColor: colors.line },
  section: { padding: 16, gap: 12 },
  text: { color: colors.text },
  muted: { color: colors.muted },
});
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: {
    height: 54,
    paddingHorizontal: 16,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: { color: colors.text, fontSize: 20, fontWeight: "800" },
  button: {
    minHeight: 48,
    borderRadius: 999,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  button_primary: { backgroundColor: colors.blue },
  button_secondary: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.line,
  },
  button_danger: { backgroundColor: "#4a1730" },
  button_ghost: { backgroundColor: "transparent" },
  buttonText: { color: colors.white, fontWeight: "800", fontSize: 15 },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.4 },
  field: {
    minHeight: 50,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: 16,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  muted: { color: colors.muted, textAlign: "center", lineHeight: 21 },
  empty: {
    flex: 1,
    minHeight: 300,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 12,
  },
  emptyIcon: { fontSize: 38, color: colors.blue },
  emptyTitle: {
    color: colors.text,
    fontSize: 19,
    fontWeight: "800",
    textAlign: "center",
  },
});

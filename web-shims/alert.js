// react-native-web's Alert.alert is a no-op; surface dialogs with browser prompts.
import { Alert, Platform } from "react-native";

if (Platform.OS === "web") {
  Alert.alert = (title, message, buttons) => {
    const text = [title, message].filter(Boolean).join("\n\n");
    if (!buttons || buttons.length < 2) {
      window.alert(text);
      buttons?.[0]?.onPress?.();
      return;
    }
    const ok = buttons.find((b) => b.style !== "cancel" && b !== buttons[0]) ?? buttons[buttons.length - 1];
    const cancel = buttons.find((b) => b.style === "cancel") ?? buttons[0];
    (window.confirm(text) ? ok : cancel)?.onPress?.();
  };
}

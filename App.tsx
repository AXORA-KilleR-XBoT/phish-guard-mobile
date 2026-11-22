import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { ApiError, MAX_TEXT_CHARS, checkMessage, type CheckResult } from "./api";

const RED = "#d93025";
const BLUE = "#1a73e8"; // not green: a low score must not look like a "safe" verdict

// The server address comes from the EXPO_PUBLIC_API_URL environment variable (see the README).
// It is empty by default; the person using the app has to enter an address that works for them.
const DEFAULT_SERVER_URL = process.env.EXPO_PUBLIC_API_URL ?? "";

export default function App() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [text, setText] = useState("");
  const [result, setResult] = useState<CheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = text.trim().length > 0 && !loading;
  const usesPlainHttp = serverUrl.trim().toLowerCase().startsWith("http://");

  // Any edit makes the old result or error stale, so it is removed straight away.
  function onChangeServerUrl(value: string) {
    setServerUrl(value);
    setResult(null);
    setError(null);
  }

  function onChangeText(value: string) {
    setText(value);
    setResult(null);
    setError(null);
  }

  async function onCheck() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await checkMessage(serverUrl, text));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something unexpected went wrong. Please try again.");
    } finally {
      setLoading(false); // always runs: the button can never stay stuck in the loading state
    }
  }

  const isSpam = result?.label === "spam";
  const color = isSpam ? RED : BLUE;
  const percent = result ? Math.round(result.spam_probability * 100) : 0;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
            <Text style={styles.title}>Phish Guard</Text>
            <Text style={styles.subtitle}>Paste a message to see whether it looks like spam. Educational demo.</Text>

            <Text style={styles.label}>Server URL</Text>
            <TextInput
              style={styles.input}
              value={serverUrl}
              onChangeText={onChangeServerUrl}
              placeholder="http://192.168.1.20:8000"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              editable={!loading}
              accessibilityLabel="Server URL"
            />
            <Text style={styles.hint}>
              Android emulator: http://10.0.2.2:8000{"\n"}
              iOS simulator: http://localhost:8000{"\n"}
              Physical phone: http://YOUR-COMPUTER-LAN-IP:8000 (same Wi-Fi as the computer)
            </Text>
            {usesPlainHttp && (
              <Text style={styles.hint}>Plain http:// is not encrypted. Use it only on a network you trust.</Text>
            )}

            <Text style={styles.label}>Message</Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              value={text}
              onChangeText={onChangeText}
              placeholder="Paste a message here..."
              multiline
              maxLength={MAX_TEXT_CHARS}
              textAlignVertical="top"
              editable={!loading}
              accessibilityLabel="Message to check"
            />

            <Pressable
              style={[styles.button, !canSubmit && styles.disabled]}
              onPress={onCheck}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSubmit, busy: loading }}
            >
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Check message</Text>}
            </Pressable>

            {error && (
              <Text style={styles.error} accessibilityLiveRegion="polite">
                {error}
              </Text>
            )}

            {result && (
              <View style={[styles.card, { borderColor: color }]} accessibilityLiveRegion="polite">
                <Text style={[styles.verdict, { color }]}>{isSpam ? "Looks like spam" : "No spam signal found"}</Text>
                <Text style={styles.subtitle}>
                  {isSpam
                    ? "Do not open links or reply. This is an automated estimate and can be wrong."
                    : "A low score does not mean the message or any link in it is safe. This is an automated estimate and can be wrong."}
                </Text>
                <View style={styles.bar}>
                  <View style={[styles.fill, { width: `${percent}%`, backgroundColor: color }]} />
                </View>
                <Text style={styles.percent}>Spam probability: {percent}%</Text>
              </View>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f6f7f9" },
  flex: { flex: 1 },
  container: { padding: 20, gap: 8 },
  title: { fontSize: 28, fontWeight: "700", color: "#111" },
  subtitle: { fontSize: 15, color: "#555", marginBottom: 12 },
  label: { fontSize: 13, fontWeight: "600", color: "#444", marginTop: 8 },
  hint: { fontSize: 12, color: "#666" },
  input: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#d0d4da",
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
  },
  multiline: { minHeight: 120 },
  button: { backgroundColor: BLUE, borderRadius: 10, padding: 14, alignItems: "center", marginTop: 12 },
  disabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  error: { color: RED, marginTop: 8 },
  card: { backgroundColor: "#fff", borderWidth: 2, borderRadius: 12, padding: 16, marginTop: 16, gap: 10 },
  verdict: { fontSize: 20, fontWeight: "700" },
  bar: { height: 10, backgroundColor: "#e5e7eb", borderRadius: 5, overflow: "hidden" },
  fill: { height: "100%" },
  percent: { fontSize: 14, color: "#444" },
});

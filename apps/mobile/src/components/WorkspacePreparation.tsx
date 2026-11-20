import { useEffect, useRef } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "@/lib/theme";
import type { RecoveryPhase } from "../../../../src/core/sync/recovery-v2";
import {
  preparationConnection,
  preparationFailureMessage,
  preparationFailureTitle,
  preparationStatus,
  preparationStepState,
  preparationSteps,
  preparationTitle,
  type PreparationMode,
  type PreparationStepState,
} from "./workspace-preparation";

export function WorkspacePreparation({ phase, bucket, mode, error, onRetry, onDismiss }: {
  phase: RecoveryPhase | null;
  bucket?: string;
  mode: PreparationMode;
  error?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const { tokens } = useTheme();
  const failed = Boolean(error);
  const retryRef = useRef(onRetry);
  const dismissRef = useRef(onDismiss);
  retryRef.current = onRetry;
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!error) return;
    Alert.alert(preparationFailureTitle(phase), preparationFailureMessage(error), [
      { text: "返回工作区", style: "cancel", onPress: () => dismissRef.current?.() },
      { text: "重试", onPress: () => retryRef.current?.() },
    ]);
  }, [error, phase]);
  return (
    <SafeAreaProvider style={{ backgroundColor: tokens.bg }}>
      <SafeAreaView style={{ flex: 1, backgroundColor: tokens.bg }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 28, paddingBottom: 40, width: "100%", maxWidth: 560, alignSelf: "center" }}>
          <Text accessibilityRole="header" style={{ fontSize: 28, fontWeight: "700", color: tokens.fg }}>
            {preparationTitle(mode)}
          </Text>
          <Text style={{ marginTop: 8, fontSize: 16, lineHeight: 22, color: tokens.fgSoft }}>
            {preparationConnection(bucket)}
          </Text>
          <View style={{ marginTop: 36, gap: 20 }}>
            {phase === null ? (
              <View style={{ minHeight: 24, flexDirection: "row", alignItems: "center", gap: 14 }}>
                <StepMark state={failed ? "failed" : "current"} accent={tokens.accent} done={tokens.success} pending={tokens.lineStrong} failed={tokens.danger} />
                <Text accessibilityLiveRegion="polite" style={{ flex: 1, fontSize: 16, fontWeight: "600", color: tokens.fg }}>
                  正在检查工作区
                </Text>
              </View>
            ) : (
              preparationSteps.map((step) => {
                const state = preparationStepState(phase, step.phase, failed);
                const current = state === "current";
                return (
                  <View key={step.phase} style={{ minHeight: 24, flexDirection: "row", alignItems: "center", gap: 14 }}>
                    <StepMark state={state} accent={tokens.accent} done={tokens.success} pending={tokens.lineStrong} failed={tokens.danger} />
                    <Text
                      accessibilityLiveRegion={current || state === "failed" ? "polite" : "none"}
                      style={{ flex: 1, fontSize: 16, fontWeight: current || state === "failed" ? "600" : "400", color: state === "upcoming" ? tokens.fgSoft : tokens.fg }}
                    >
                      {step.label}
                    </Text>
                  </View>
                );
              })
            )}
          </View>
          {!failed && (
            <Text style={{ marginTop: 32, fontSize: 15, lineHeight: 22, color: tokens.fgSoft }}>
              {preparationStatus()}
            </Text>
          )}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function StepMark({ state, accent, done, pending, failed }: {
  state: PreparationStepState;
  accent: string;
  done: string;
  pending: string;
  failed: string;
}) {
  if (state === "current") return <ActivityIndicator color={accent} />;
  const color = state === "done" ? done : state === "failed" ? failed : pending;
  return (
    <View style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}>
      <View style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: state === "done" || state === "failed" ? color : "transparent",
        borderWidth: state === "done" || state === "failed" ? 0 : 1.5,
        borderColor: color,
      }} />
    </View>
  );
}

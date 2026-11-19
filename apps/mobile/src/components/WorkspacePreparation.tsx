import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "@/lib/theme";
import type { RecoveryPhase } from "../../../../src/core/sync/recovery-v2";
import {
  preparationConnection,
  preparationStepState,
  preparationSteps,
  preparationTitle,
  type PreparationMode,
} from "./workspace-preparation";

export function WorkspacePreparation({ phase, bucket, mode }: {
  phase: RecoveryPhase | null;
  bucket?: string;
  mode: PreparationMode;
}) {
  const { tokens } = useTheme();
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
                <ActivityIndicator color={tokens.accent} />
                <Text accessibilityLiveRegion="polite" style={{ flex: 1, fontSize: 16, fontWeight: "600", color: tokens.fg }}>
                  正在检查工作区
                </Text>
              </View>
            ) : (
              preparationSteps.map((step) => {
                const state = preparationStepState(phase, step.phase);
                const current = state === "current";
                return (
                  <View key={step.phase} style={{ minHeight: 24, flexDirection: "row", alignItems: "center", gap: 14 }}>
                    <StepMark state={state} accent={tokens.accent} done={tokens.success} pending={tokens.lineStrong} />
                    <Text
                      accessibilityLiveRegion={current ? "polite" : "none"}
                      style={{ flex: 1, fontSize: 16, fontWeight: current ? "600" : "400", color: state === "upcoming" ? tokens.fgSoft : tokens.fg }}
                    >
                      {step.label}
                    </Text>
                  </View>
                );
              })
            )}
          </View>
          <Text style={{ marginTop: 32, fontSize: 15, lineHeight: 22, color: tokens.fgSoft }}>
            请保持应用打开，完成后将自动进入工作区。
          </Text>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function StepMark({ state, accent, done, pending }: {
  state: "done" | "current" | "upcoming";
  accent: string;
  done: string;
  pending: string;
}) {
  if (state === "current") return <ActivityIndicator color={accent} />;
  const color = state === "done" ? done : pending;
  return (
    <View style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}>
      <View style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: state === "done" ? color : "transparent",
        borderWidth: state === "done" ? 0 : 1.5,
        borderColor: color,
      }} />
    </View>
  );
}

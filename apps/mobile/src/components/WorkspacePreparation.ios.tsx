import { useEffect, useState } from "react";
import { Alert, Button, HStack, Image, List, NavigationStack, ProgressView, Section, Text, Toolbar } from "@expo/ui/swift-ui";
import {
  font,
  foregroundStyle,
  listStyle,
  navigationBarTitleDisplayMode,
  navigationTitle,
  progressViewStyle,
} from "@expo/ui/swift-ui/modifiers";
import { NativeHost } from "@/components/native/NativeHost";
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

const secondary = { type: "hierarchical", style: "secondary" } as const;
const tertiary = { type: "hierarchical", style: "tertiary" } as const;

export function WorkspacePreparation({ phase, bucket, mode, error, onRetry, onDismiss }: {
  phase: RecoveryPhase | null;
  bucket?: string;
  mode: PreparationMode;
  error?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const failed = Boolean(error);
  const [presented, setPresented] = useState(false);
  useEffect(() => {
    if (!failed) {
      setPresented(false);
      return;
    }
    const id = setTimeout(() => setPresented(true), 50);
    return () => clearTimeout(id);
  }, [failed, error]);
  return (
    <NativeHost style={{ flex: 1 }}>
      <NavigationStack>
        <Alert title={preparationFailureTitle(phase)} isPresented={presented}>
          <Alert.Trigger>
            <Toolbar modifiers={[navigationTitle(preparationTitle(mode)), navigationBarTitleDisplayMode("large")]}>
              <List modifiers={[listStyle("insetGrouped")]}>
                <Section
                  title={preparationConnection(bucket)}
                  footer={failed ? undefined : <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(secondary)]}>{preparationStatus()}</Text>}
                >
                  {phase === null ? (
                    <Step label="正在检查工作区" state={failed ? "failed" : "current"} />
                  ) : (
                    preparationSteps.map((step) => (
                      <Step key={step.phase} label={step.label} state={preparationStepState(phase, step.phase, failed)} />
                    ))
                  )}
                </Section>
              </List>
            </Toolbar>
          </Alert.Trigger>
          <Alert.Actions>
            <Button role="cancel" onPress={onDismiss}><Text>返回工作区</Text></Button>
            <Button role="default" onPress={onRetry}><Text>重试</Text></Button>
          </Alert.Actions>
          {error ? <Alert.Message><Text>{preparationFailureMessage(error)}</Text></Alert.Message> : null}
        </Alert>
      </NavigationStack>
    </NativeHost>
  );
}

function Step({ label, state }: { label: string; state: PreparationStepState }) {
  return (
    <HStack spacing={12} alignment="center">
      {state === "current" ? (
        <ProgressView modifiers={[progressViewStyle("circular")]} />
      ) : (
        <Image
          systemName={state === "done" ? "checkmark.circle.fill" : state === "failed" ? "xmark.circle.fill" : "circle"}
          color={state === "done" ? "green" : state === "failed" ? "red" : undefined}
          modifiers={[font({ textStyle: "body" }), ...(state === "upcoming" ? [foregroundStyle(tertiary)] : [])]}
        />
      )}
      <Text modifiers={[font({ textStyle: "body" }), foregroundStyle(state === "upcoming" ? secondary : "primary")]}>
        {label}
      </Text>
    </HStack>
  );
}

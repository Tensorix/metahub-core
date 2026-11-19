import {
  HStack,
  Image,
  List,
  NavigationStack,
  ProgressView,
  Section,
  Text,
  Toolbar,
} from "@expo/ui/swift-ui";
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
  preparationStepState,
  preparationSteps,
  preparationTitle,
  type PreparationMode,
  type PreparationStepState,
} from "./workspace-preparation";

const secondary = { type: "hierarchical", style: "secondary" } as const;
const tertiary = { type: "hierarchical", style: "tertiary" } as const;

export function WorkspacePreparation({ phase, bucket, mode }: {
  phase: RecoveryPhase | null;
  bucket?: string;
  mode: PreparationMode;
}) {
  return (
    <NativeHost style={{ flex: 1 }}>
      <NavigationStack>
        <Toolbar modifiers={[navigationTitle(preparationTitle(mode)), navigationBarTitleDisplayMode("large")]}>
          <List modifiers={[listStyle("insetGrouped")]}>
            <Section
              title={preparationConnection(bucket)}
              footer={<Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(secondary)]}>请保持应用打开，完成后将自动进入工作区。</Text>}
            >
              {phase === null ? (
                <Step label="正在检查工作区" state="current" />
              ) : (
                preparationSteps.map((step) => (
                  <Step key={step.phase} label={step.label} state={preparationStepState(phase, step.phase)} />
                ))
              )}
            </Section>
          </List>
        </Toolbar>
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
          systemName={state === "done" ? "checkmark.circle.fill" : "circle"}
          color={state === "done" ? "green" : undefined}
          modifiers={[font({ textStyle: "body" }), ...(state === "upcoming" ? [foregroundStyle(tertiary)] : [])]}
        />
      )}
      <Text modifiers={[font({ textStyle: "body" }), foregroundStyle(state === "upcoming" ? secondary : "primary")]}>
        {label}
      </Text>
    </HStack>
  );
}

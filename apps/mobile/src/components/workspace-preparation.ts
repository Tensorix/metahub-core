import type { RecoveryPhase } from "../../../../src/core/sync/recovery-v2";

export type PreparationMode = "initializing" | "migration" | "rebuild";
export type PreparationStepState = "done" | "current" | "upcoming" | "failed";

const labels: Record<RecoveryPhase, string> = {
  saving: "保存本机更改",
  protecting: "备份本机数据",
  downloading: "下载工作区内容",
  verifying: "校验工作区内容",
  swapping: "启用本地副本",
  pending: "打开工作区",
};

export const preparationSteps: { phase: RecoveryPhase; label: string }[] = (
  Object.keys(labels) as RecoveryPhase[]
).map((phase) => ({ phase, label: labels[phase] }));

export function preparationTitle(mode: PreparationMode) {
  if (mode === "migration") return "升级工作区同步";
  if (mode === "rebuild") return "更新本地副本";
  return "准备工作区";
}

export function preparationConnection(bucket?: string) {
  return bucket ? `已连接到 ${bucket}` : "已连接到工作区";
}

export function preparationStepState(current: RecoveryPhase | null, phase: RecoveryPhase, failed = false): PreparationStepState {
  if (!current) return "upcoming";
  const at = preparationSteps.findIndex((step) => step.phase === current);
  const index = preparationSteps.findIndex((step) => step.phase === phase);
  if (index < at) return "done";
  if (index === at) return failed ? "failed" : "current";
  return "upcoming";
}

export function preparationStatus() {
  return "请保持应用打开，完成后将自动进入工作区。";
}

export function preparationFailureTitle(phase: RecoveryPhase | null) {
  const label = phase ? preparationSteps.find((step) => step.phase === phase)?.label : "检查工作区";
  return `未能${label ?? "更新本地副本"}。`;
}

export function preparationFailureMessage(reason: string) {
  const sentence = /[。！？]$/.test(reason.trim()) ? reason.trim() : `${reason.trim()}。`;
  return `${sentence}本地内容还在。`;
}

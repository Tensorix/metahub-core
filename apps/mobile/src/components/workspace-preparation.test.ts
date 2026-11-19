import { expect, test } from "bun:test";
import {
  preparationConnection,
  preparationStepState,
  preparationSteps,
  preparationTitle,
} from "./workspace-preparation";

test("preparation copy follows the access that started recovery", () => {
  expect(preparationTitle("initializing")).toBe("准备工作区");
  expect(preparationTitle("migration")).toBe("升级工作区同步");
  expect(preparationTitle("rebuild")).toBe("更新本地副本");
  expect(preparationConnection("notes")).toBe("已连接到 notes");
  expect(preparationConnection()).toBe("已连接到工作区");
});

test("preparation steps follow recovery order and only the current phase is active", () => {
  expect(preparationSteps.map((step) => step.phase)).toEqual([
    "saving",
    "protecting",
    "downloading",
    "verifying",
    "swapping",
    "pending",
  ]);
  expect(preparationStepState(null, "saving")).toBe("upcoming");
  expect(preparationStepState("downloading", "protecting")).toBe("done");
  expect(preparationStepState("downloading", "downloading")).toBe("current");
  expect(preparationStepState("downloading", "verifying")).toBe("upcoming");
  expect(preparationSteps.find((step) => step.phase === "verifying")?.label).toBe("校验工作区内容");
});

import { expect, test } from "bun:test";
import { applicationBuildEnvironment, assertApplicationBuild } from "./native-build-policy";

test("normal candidates allow clean and explicitly disabled diagnostic environments", () => {
  expect(() => assertApplicationBuild({})).not.toThrow();
  expect(() => assertApplicationBuild({ EXPO_PUBLIC_MH_SELFTEST: "0", EXPO_PUBLIC_MH_PERF: "" })).not.toThrow();
});

test("each diagnostic selector is rejected before candidate native builds start", () => {
  for (const name of [
    "EXPO_PUBLIC_MH_SELFTEST", "EXPO_PUBLIC_MH_DIAGNOSTICS_RELEASE", "EXPO_PUBLIC_MH_TRANSPORT",
    "EXPO_PUBLIC_MH_NETWORK_STRESS", "EXPO_PUBLIC_MH_PERF",
  ]) {
    expect(() => assertApplicationBuild({ [name]: "1" })).toThrow(name);
  }
});


test("normal subprocesses keep diagnostic flags disabled and preserve intentional non-diagnostic configuration", () => {
  const env = applicationBuildEnvironment({ EXPO_PUBLIC_APP_LABEL: "Metahub", EXPO_NO_DOTENV: "0" });
  expect(env.EXPO_PUBLIC_MH_SELFTEST).toBe("0");
  expect(env.EXPO_PUBLIC_MH_DIAGNOSTICS_RELEASE).toBe("0");
  expect(env.EXPO_PUBLIC_MH_NETWORK_STRESS).toBe("0");
  expect(env.EXPO_PUBLIC_MH_PERF).toBe("0");
  expect(env.EXPO_PUBLIC_APP_LABEL).toBe("Metahub");
  expect(env.EXPO_NO_DOTENV).toBe("1");
});

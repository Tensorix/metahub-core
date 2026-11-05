/** Candidate artifacts must always launch the ordinary application. */
const diagnosticFlags = [
    "EXPO_PUBLIC_MH_SELFTEST",
    "EXPO_PUBLIC_MH_DIAGNOSTICS_RELEASE",
    "EXPO_PUBLIC_MH_TRANSPORT",
    "EXPO_PUBLIC_MH_NETWORK_STRESS",
    "EXPO_PUBLIC_MH_PERF",
    "EXPO_PUBLIC_MH_RECOVERY_ADAPTER_ONLY",
];

export function assertApplicationBuild(environment: Record<string, string | undefined>) {
  const enabled = diagnosticFlags.filter((name) => {
    const value = environment[name];
    return value !== undefined && value !== "" && value !== "0";
  });
  if (enabled.length) {
    throw new Error(`Normal Release candidates forbid diagnostic flags: ${enabled.join(", ")}. Build synthetic diagnostics separately; see docs/impl-context/mobile-release-diagnostics.md.`);
  }
}


/** Explicit zeros also prevent nested Bun scripts from reviving flags from local .env files. */
export function applicationBuildEnvironment(environment: Record<string, string | undefined>) {
  assertApplicationBuild(environment);
  return {
    ...environment,
    ...Object.fromEntries(diagnosticFlags.map((name) => [name, "0"])),
    EXPO_NO_DOTENV: "1",
  };
}

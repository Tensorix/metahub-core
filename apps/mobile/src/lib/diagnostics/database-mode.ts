export const databaseBenchmark =
  process.env.EXPO_PUBLIC_MH_SELFTEST === "1" &&
  process.env.EXPO_PUBLIC_MH_DIAGNOSTICS_RELEASE === "1" &&
  process.env.EXPO_PUBLIC_MH_DATABASE_BENCHMARK === "1";
export const databaseBenchmarkBaseline =
  databaseBenchmark && process.env.EXPO_PUBLIC_MH_DATABASE_BASELINE === "1";

/** Release diagnostic fixture runner. Launch only a build with all three
 * EXPO_PUBLIC_MH_{SELFTEST,DIAGNOSTICS_RELEASE,DATABASE_BENCHMARK}=1 flags.
 * This records route-to-first-frame, not tap-to-interactive or real-device FPS.
 * bun scripts/benchmark-database-opening.ts baseline|optimized
 */
const device = process.env.MH_BENCHMARK_DEVICE;
if (!device)
  throw new Error("Set MH_BENCHMARK_DEVICE to a booted iOS simulator UUID");
const variant = Bun.argv[2],
  folder =
    process.env.MH_BENCHMARK_OUTPUT ?? "/private/tmp/metahub-database-opening";
if (variant !== "baseline" && variant !== "optimized")
  throw new Error("Expected baseline or optimized");
await Bun.$`mkdir -p ${folder}`;
const runtimes: any[] = [];
const stages: any[] = [],
  runs: any[] = (await Bun.file(`${folder}/${variant}-simulator.json`).exists())
    ? await Bun.file(`${folder}/${variant}-simulator.json`).json()
    : [];
let tag: any = null,
  ready = 0;
const run = async (args: string[], allow = false) => {
  const p = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
  if ((await p.exited) && !allow)
    throw new Error(await new Response(p.stderr).text());
};
const logs = Bun.spawn(
  [
    "xcrun",
    "simctl",
    "spawn",
    device,
    "log",
    "stream",
    "--level",
    "info",
    "--style",
    "compact",
    "--predicate",
    'process == "Metahub" AND (eventMessage CONTAINS "database-open" OR eventMessage CONTAINS "fixtures-ready" OR eventMessage CONTAINS "database-runtime")',
  ],
  { stdout: "pipe", stderr: "ignore" },
);
void (async () => {
  let buffer = "";
  for await (const chunk of logs.stdout) {
    buffer += new TextDecoder().decode(chunk);
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.includes("fixtures-ready")) ready++;
      if (line.includes("database-runtime")) {
        const state = line.match(/'(\{.*\})'/);
        if (state)
          try {
            runtimes.push({ ...JSON.parse(state[1]!), case: tag });
          } catch {}
      }
      const match = line.match(/'(\{"trace".*\})'/);
      if (match)
        try {
          stages.push({ ...JSON.parse(match[1]!), case: tag });
        } catch {}
    }
  }
})();
const wait = async (fn: () => boolean, timeout = 20000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) return false;
    await Bun.sleep(25);
  }
  return true;
};
try {
  await Bun.sleep(1000);
  for (const size of [16, 10000, 50000])
    for (const query of ["table", "v_complex"])
      for (const mode of ["cold", "warm"])
        for (let iteration = 1; iteration <= 20; iteration++) {
          if (
            runs.some(
              (r) =>
                r.size === size &&
                r.query === query &&
                r.mode === mode &&
                r.iteration === iteration &&
                r.ok,
            )
          )
            continue;
          tag = { variant, size, query, mode, iteration };
          if (mode === "cold") {
            await run(
              ["xcrun", "simctl", "terminate", device, "com.tensorix.metahub"],
              true,
            );
            const previous = ready;
            await run([
              "xcrun",
              "simctl",
              "launch",
              device,
              "com.tensorix.metahub",
            ]);
            if (!(await wait(() => ready > previous)))
              throw new Error("fixture launch timeout");
            await Bun.sleep(250);
          } else {
            await run(["idb", "ui", "tap", "38", "84", "--udid", device]);
            await Bun.sleep(350);
          }
          const from = stages.length;
          await run([
            "xcrun",
            "simctl",
            "openurl",
            device,
            `metahub://db/db_benchmark_${size}?view=${query}`,
          ]);
          const ok = await wait(() =>
            stages
              .slice(from)
              .some(
                (s) =>
                  s.runtime === "native" &&
                  s.stage === "web-first-frame-received",
              ),
          );
          const samples = stages.slice(from),
            result = { ...tag, ok, stages: samples };
          runs.push(result);
          await Bun.write(
            `${folder}/${variant}-simulator.json`,
            JSON.stringify(runs, null, 2),
          );
          console.log(
            JSON.stringify({
              ...tag,
              ok,
              ms: samples.find(
                (s) =>
                  s.runtime === "native" &&
                  s.stage === "web-first-frame-received",
              )?.elapsedMs,
            }),
          );
          if (!ok) throw new Error("first frame timeout");
          if (iteration === 1)
            await run([
              "xcrun",
              "simctl",
              "io",
              device,
              "screenshot",
              `${folder}/${variant}-${size}-${query}-${mode}.png`,
            ]);
          await Bun.sleep(150);
        }
} finally {
  await Bun.write(
    `${folder}/${variant}-runtimes.json`,
    JSON.stringify(runtimes, null, 2),
  );
  logs.kill();
  await Bun.write(
    `${folder}/${variant}-stages.json`,
    JSON.stringify(stages, null, 2),
  );
}

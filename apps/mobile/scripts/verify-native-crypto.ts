/** Verify public native diagnostic ciphertext with Bun's independent crypto. */
import { unwrapMasterKey, decryptBytes, fromB64 } from "../../../src/core/sync/e2ee.ts";
const path = Bun.argv[2];
if (!path) throw new Error("Usage: bun scripts/verify-native-crypto.ts <native-diagnostics.json>");
const report = await Bun.file(path).json();
if (report.results.some((line: string) => line.startsWith("FAIL"))) throw new Error("Native diagnostics contain failures");
const fixture = report.nativeFixture;
if (!fixture) throw new Error("Native fixture missing");
const key = await unwrapMasterKey(fixture.envelope, "手机跨端密码🔑");
const compressed = await decryptBytes(key, fromB64(fixture.payload));
const decoded = await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
if (decoded !== fixture.text) throw new Error("Native ciphertext incompatible with Bun");
console.log("PASS native PBKDF2/AES-GCM/gzip decoded by Bun " + Bun.version);

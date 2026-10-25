// Run from the repository root with Bun. Reads configuration only; never writes
// to the source database or bucket. Output is a private local credential artifact.
import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import qrcode from "qrcode-generator";
import { decodeEnroll, mobileEnrollUrl } from "../../../src/core/sync/enroll.ts";

const [databasePath, outputDirectory, peerUrl] = process.argv.slice(2);
if (!databasePath || !outputDirectory) {
  throw new Error("Usage: bun apps/mobile/scripts/export-enrollment.ts <database-file> <new-private-directory> [peer-url]");
}
const db = new Database(databasePath, { readonly: true });
let rows: { url: string; config: string }[];
try {
  rows = db.query("SELECT url, config FROM peers WHERE kind = 's3' AND enabled = 1").all() as typeof rows;
} finally {
  db.close();
}
const candidates = peerUrl ? rows.filter((row) => row.url === peerUrl) : rows;
if (candidates.length !== 1) throw new Error("Select exactly one enabled bucket using its peer URL.");
const config = JSON.parse(candidates[0]!.config);
const link = mobileEnrollUrl(config);
decodeEnroll(link); // Fail before publishing an invalid invitation.
const qr = qrcode(0, "M");
qr.addData(link);
qr.make();
const out = resolve(outputDirectory);
await mkdir(out, { mode: 0o700 }); // Exclusive directory; do not overwrite earlier credentials.
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Metahub 手机接入</title><style>body{font:16px system-ui;max-width:580px;margin:48px auto;padding:24px;text-align:center}img{max-width:100%;image-rendering:pixelated}a{display:inline-block;padding:14px 22px;background:#285bdf;color:white;border-radius:10px;text-decoration:none}p{line-height:1.6}</style><h1>连接 Metahub 移动端</h1><p>在已安装 Metahub App 的手机上扫码，或打开下面的接入链接。</p><img src="enrollment.gif" alt="Metahub 存储桶接入二维码"><p><a href="${link}">在 Metahub App 中连接</a></p><p>${config.encrypt !== false ? "进入 App 后输入现有存储桶的解密密码，再点击「连接并同步」。" : "进入 App 后点击「连接并同步」。"}</p><p>二维码包含存储桶接入凭据，请仅供自己的设备使用。</p></html>`;
for (const [name, data] of [
  ["index.html", html],
  ["enrollment.txt", link],
  ["enrollment.gif", Buffer.from(qr.createDataURL(5, 20).split(",")[1]!, "base64")],
] as const) {
  const path = `${out}/${name}`;
  await Bun.write(path, data);
  await chmod(path, 0o600);
}
console.log(JSON.stringify({ directory: out, encrypted: config.encrypt !== false, files: ["index.html", "enrollment.txt", "enrollment.gif"] }));

import { spawn } from "node:child_process";

export function runRecoveryChild(
  command: { cmd: string; args: string[] },
  url: string,
) {
  return new Promise<{ packageId: string; pending: number }>(
    (resolve, reject) => {
      const child = spawn(command.cmd, [...command.args, "--rebuild-replica"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          METAHUB_APP: "desktop",
          METAHUB_REBUILD_PEER: url,
        },
      });
      let output = "",
        error = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output = (output + chunk).slice(-8192);
        if (output.includes("METAHUB_PORT=")) {
          child.kill();
          reject(new Error("桌面同步组件需要升级"));
        }
      });
      child.stderr.on("data", (chunk) => {
        error = (error + chunk).slice(-2048);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        const result = /^METAHUB_REBUILT=(.+)$/m.exec(output);
        if (code !== 0 || !result)
          return reject(new Error(error.trim() || "桌面副本重建未完成"));
        try {
          resolve(JSON.parse(result[1]!));
        } catch (failure) {
          reject(failure);
        }
      });
    },
  );
}

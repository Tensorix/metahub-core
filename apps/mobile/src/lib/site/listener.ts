import { createSiteGate } from "./access";
import Tcp from "react-native-tcp-socket";
import { Buffer } from "buffer";
import { randomUUID } from "expo-crypto";
import { File, FileMode } from "expo-file-system";
import type { LocalReply } from "./gateway";

export async function listenSite(
  mount: string,
  current: () => boolean,
  serve: (method: string, target: string, body: string) => LocalReply,
) {
  const secret = randomUUID();
  const bootstrap = "/_open/" + randomUUID();
  const cookie = "mhsite_session=" + secret;
  const gate = createSiteGate(bootstrap, cookie);
  let active = true,
    host = "";
  const clients = new Set<{ destroy(): unknown }>();
  const server = Tcp.createServer((socket) => {
    if (!active || clients.size >= 32) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(15000, () => socket.destroy());
    let pending = Buffer.alloc(0),
      handled = false;
    socket.on("data", (bytes) => {
      if (handled) return;
      pending = Buffer.concat([pending, Buffer.from(bytes)]);
      const split = pending.indexOf("\r\n\r\n");
      if (
        (split < 0 ? pending.length : split) > 16384 ||
        pending.length > 4 * 1024 * 1024
      ) {
        socket.destroy();
        return;
      }
      if (split < 0) return;
      const [line, ...fields] = pending
        .toString("utf8", 0, split)
        .split("\r\n");
      const match = /^(GET|HEAD|POST|PATCH|DELETE) (\/\S*) HTTP\/1\.[01]$/.exec(
        line!,
      );
      const headers = new Map<string, string>();
      for (const field of fields) {
        const i = field.indexOf(":");
        const key = field.slice(0, i).toLowerCase();
        if (i <= 0 || headers.has(key)) {
          socket.destroy();
          return;
        }
        headers.set(key, field.slice(i + 1).trim());
      }
      const length = headers.get("content-length") ?? "0";
      if (
        !match ||
        !/^\d+$/.test(length) ||
        Number(length) > 4 * 1024 * 1024 ||
        headers.has("transfer-encoding")
      ) {
        socket.destroy();
        return;
      }
      if (pending.length < split + 4 + Number(length)) return;
      handled = true;
      const [, method, target] = match;
      const action = gate(active && current(), host, headers, method!, target!);
      if (action === "bootstrap") {
        socket.end(
          "HTTP/1.1 302 Found\r\nSet-Cookie: " +
            cookie +
            "; HttpOnly; SameSite=Strict; Path=/\r\nLocation: " +
            mount +
            "\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
        return;
      }
      if (action === "deny") {
        socket.end(
          "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
        return;
      }
      try {
        const result = serve(
          method!,
          target!,
          pending.toString("utf8", split + 4, split + 4 + Number(length)),
        );
        const file = result.file ? new File(result.file) : null;
        const payload = Buffer.from(
          result.base64 ?? result.text ?? "",
          result.base64 !== undefined ? "base64" : "utf8",
        );
        const csp =
          "default-src 'self'; script-src 'self' https: 'unsafe-inline' 'unsafe-eval'; style-src 'self' https: 'unsafe-inline'; connect-src 'self' https:; img-src 'self' https: data: blob:; media-src 'self' https: blob:; font-src 'self' https: data:; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'";
        socket.write(
          "HTTP/1.1 " +
            result.status +
            " Response\r\nContent-Type: " +
            result.mime.replace(/[\r\n]/g, "") +
            "\r\nContent-Length: " +
            (file?.size ?? payload.length) +
            "\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: " +
            csp +
            "\r\n\r\n",
        );
        if (method === "HEAD" || !file) {
          socket.end(method === "HEAD" ? undefined : payload);
          return;
        }
        const handle = file.open(FileMode.ReadOnly);
        socket.once("close", () => handle.close());
        let remaining = file.size;
        const next = async () => {
          if (!active || !current()) {
            socket.destroy();
            return;
          }
          if (!remaining) {
            socket.end();
            return;
          }
          try {
            const chunk = await handle.readBytes(Math.min(65536, remaining));
            if (!chunk.length) {
              socket.destroy();
              return;
            }
            remaining -= chunk.length;
            socket.write(chunk, undefined, (err) =>
              err ? socket.destroy() : void next(),
            );
          } catch {
            socket.destroy();
          }
        };
        void next();
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  host = "127.0.0.1:" + server.address()!.port;
  return {
    origin: "http://" + host,
    url: "http://" + host + bootstrap,
    close() {
      active = false;
      for (const socket of clients) socket.destroy();
      server.close();
    },
  };
}

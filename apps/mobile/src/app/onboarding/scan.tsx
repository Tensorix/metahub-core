import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { QrScanner } from "@/components/QrScanner";
import { verifyServer } from "@/lib/api/mobile-api";
import { parseQrPayload } from "@/lib/auth/credentials";
import { useSessionCtx } from "@/lib/auth/session";

export default function ScanScreen() {
  const { connect } = useSessionCtx();
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handled = useRef(false);

  // Scanning is the intent — verify and connect right here; a successful
  // connect flips the session and the Protected stack swaps to the tabs.
  const onScan = async (data: string) => {
    if (handled.current) return;
    const parsed = parseQrPayload(data);
    if (parsed.kind === "enroll") {
      handled.current = true;
      router.replace({ pathname: "/connect", params: { enroll: parsed.code } });
      return;
    }
    if (parsed.kind !== "server") {
      setMessage("无法识别的二维码");
      return;
    }
    handled.current = true;
    setBusy(true);
    try {
      const result = await verifyServer(parsed.baseUrl, parsed.token);
      if (!result.ok) {
        setBusy(false);
        handled.current = false;
        setMessage(
          result.reason === "unreachable"
            ? "连不上服务器——确认手机和服务器在同一网络"
            : "服务器可达，但二维码里的令牌无效或已过期",
        );
        return;
      }
      await connect({ baseUrl: parsed.baseUrl, token: parsed.token });
    } catch {
      setMessage("连接或保存失败，请重试");
    } finally {
      setBusy(false);
      handled.current = false;
    }
  };

  return <QrScanner onScan={onScan} message={message} busy={busy} />;
}

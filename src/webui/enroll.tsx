/** @jsxImportSource preact */
// No-origin bootstrap: the "connect your bucket" gate the data-blind shell
// shows before it has a replica. Scan-first: the default step points the
// camera at the QR the desktop shows (设置 → 同步 → 手机接入), with paste /
// image-pick / manual form as fallbacks. A `#enroll=<token>` deep link (the
// QR opened via the system camera) skips straight to the passphrase step —
// that path is unchanged.
import { useEffect, useRef, useState } from "preact/hooks";
import jsQR from "jsqr";
import { decodeEnroll, type EnrollPayload } from "../core/sync/enroll.ts";
import { enableReplicaFromBucket } from "./data/replica.ts";
import { Icon } from "./icons.tsx";

/** Bucket config carried in a `#enroll=<base64url(JSON)>` deep link (the QR a
 *  desktop shows). The passphrase is never in the link — it's typed here. */
function readEnrollConfig(): EnrollPayload | null {
  const m = /[#&]enroll=([^&]+)/.exec(location.hash);
  if (!m) return null;
  try {
    return decodeEnroll(m[1]!);
  } catch {
    return null;
  }
}

/** Camera scanning is only worth offering in a secure context with
 *  getUserMedia present (http LAN previews and old WebViews lack both). */
function cameraLikely(): boolean {
  return (
    typeof navigator !== "undefined" &&
    window.isSecureContext &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

// ---- QR decoding ---------------------------------------------------------

/** Native BarcodeDetector when it supports QR (Chrome/Android — skips the
 *  canvas sampling), silently null elsewhere (iOS Safari → jsQR path). */
function makeDetector(): { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> } | null {
  const BD = (window as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  if (!BD) return null;
  try {
    return new BD({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

/** jsQR over a downscaled canvas frame. `attemptBoth` is required, not an
 *  option: the desktop QR inverts with the dark theme (--qr-fg/--qr-bg). */
function decodeCanvas(
  canvas: HTMLCanvasElement,
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
  maxEdge: number,
): string | null {
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const hit = jsQR(img.data, w, h, { inversionAttempts: "attemptBoth" });
  return hit?.data ?? null;
}

/** Decode a picked image file (QR screenshot sent over chat). Two passes:
 *  a cheap downscale first, then near-native for tiny codes in big shots. */
async function decodeImageFile(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("image load failed"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    for (const maxEdge of [1000, 1800]) {
      const raw = decodeCanvas(canvas, img, img.naturalWidth, img.naturalHeight, maxEdge);
      if (raw) return raw;
      if (Math.max(img.naturalWidth, img.naturalHeight) <= maxEdge) break;
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---- live camera scanner --------------------------------------------------

/** Generic viewfinder: owns the camera lifecycle + decode loop, emits raw
 *  decoded strings — it knows nothing about enroll semantics. `onDecoded`
 *  returns whether the string was accepted; a rejection keeps scanning. */
function QrScanner({
  onDecoded,
  onError,
}: {
  onDecoded: (raw: string) => boolean;
  onError: (kind: "denied" | "none") => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    let stopped = false;
    let busy = false;
    let last = 0;
    let raf = 0;
    let stream: MediaStream | null = null;
    let detector = makeDetector();
    const canvas = document.createElement("canvas");

    const decodeFrame = async (v: HTMLVideoElement): Promise<string | null> => {
      if (detector) {
        try {
          const codes = await detector.detect(v);
          return codes[0]?.rawValue ?? null;
        } catch {
          detector = null; // detector lied about QR support → jsQR from now on
        }
      }
      return decodeCanvas(canvas, v, v.videoWidth, v.videoHeight, 512);
    };

    const loop = (t: number) => {
      if (stopped || !alive) return;
      raf = requestAnimationFrame(loop);
      if (busy || document.hidden || t - last < 150) return;
      const v = videoRef.current;
      if (!v || v.readyState < v.HAVE_ENOUGH_DATA || !v.videoWidth) return;
      last = t;
      busy = true;
      void decodeFrame(v)
        .then((raw) => {
          busy = false;
          if (!raw || stopped || !alive) return;
          if (onDecoded(raw)) {
            // Accepted: freeze the loop; the stream keeps painting the last
            // frames until the parent transitions and unmounts us.
            stopped = true;
            cancelAnimationFrame(raf);
          }
        })
        .catch(() => {
          busy = false;
        });
    };

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
          audio: false,
        });
        const v = videoRef.current;
        if (!alive || !v) {
          stream?.getTracks().forEach((tr) => tr.stop());
          return;
        }
        v.srcObject = stream;
        await v.play();
        if (!alive) return;
        setReady(true);
        raf = requestAnimationFrame(loop);
      } catch (e) {
        if (!alive) return;
        const name = (e as DOMException | null)?.name;
        onError(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "none");
      }
    })();

    return () => {
      alive = false;
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((tr) => tr.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, []);

  return (
    <>
      {/* playsinline+muted+autoplay: iOS Safari blacks out / fullscreen-hijacks without all three */}
      <video ref={videoRef} playsInline muted autoPlay />
      {!ready && (
        <div class="enroll-scan-wait">
          <Icon name="camera" cls="ico enroll-scan-waitico" />
        </div>
      )}
      <svg class="enroll-scan-frame" viewBox="0 0 100 100" aria-hidden="true">
        <path d="M8 26V14a6 6 0 0 1 6-6h12M74 8h12a6 6 0 0 1 6 6v12M92 74v12a6 6 0 0 1-6 6H74M26 92H14a6 6 0 0 1-6-6V74" />
      </svg>
      {ready && <div class="enroll-scan-beam" />}
    </>
  );
}

// ---- enroll gate ----------------------------------------------------------

type Step = "scan" | "manual" | "unlock";

export function Enroll({ onDone }: { onDone: () => void }) {
  const [pre] = useState(readEnrollConfig);
  const [step, setStep] = useState<Step>(pre ? "unlock" : cameraLikely() ? "scan" : "manual");
  const [config, setConfig] = useState<EnrollPayload | null>(pre);
  const [camErr, setCamErr] = useState<"denied" | null>(null);
  const [camKey, setCamKey] = useState(0); // bump to re-request permission
  const [hit, setHit] = useState(false); // decode success flash
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Manual form state (prefilled when the user drops from unlock to manual).
  const [endpoint, setEndpoint] = useState(pre?.endpoint ?? "");
  const [bucket, setBucket] = useState(pre?.bucket ?? "");
  const [region, setRegion] = useState(pre?.region ?? "auto");
  const [accessKey, setAccessKey] = useState(pre?.accessKeyId ?? "");
  const [secretKey, setSecretKey] = useState(pre?.secretAccessKey ?? "");
  const [prefix, setPrefix] = useState(pre?.prefix ?? "metahub");
  const [passphrase, setPassphrase] = useState("");
  const encrypt = config ? config.encrypt !== false : true; // manual form always encrypts

  const connect = async (cfg: EnrollPayload, pw: string) => {
    if (cfg.encrypt !== false && !pw) {
      setErr("加密口令必填");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await enableReplicaFromBucket(
        {
          endpoint: cfg.endpoint.trim(),
          region: (cfg.region ?? "").trim() || "auto",
          bucket: cfg.bucket.trim(),
          prefix: (cfg.prefix ?? "").trim() || "metahub",
          accessKeyId: cfg.accessKeyId.trim(),
          secretAccessKey: cfg.secretAccessKey.trim(),
          encrypt: cfg.encrypt !== false,
          virtualHostedStyle: cfg.virtualHostedStyle,
        },
        pw,
      );
      // Don't leave the credential-bearing fragment in the URL/history.
      if (/[#&]enroll=/.test(location.hash)) {
        history.replaceState(null, "", location.pathname + location.search);
      }
      onDone();
    } catch (e) {
      const code = (e as { code?: string }).code;
      const msg = (e as Error).message;
      setErr(
        code === "auth"
          ? "加密口令不正确,请输入与其他设备相同的口令。"
          : /failed to fetch|load failed|networkerror|cors/i.test(msg)
            ? "连接被浏览器拦截:请给存储桶配置 CORS,允许此源的 GET/PUT/HEAD/DELETE。"
            : `连接失败:${msg}`,
      );
      setBusy(false);
    }
  };

  /** Shared by the live scanner, the paste box and the image picker: any raw
   *  string that decodeEnroll accepts advances to the unlock step. */
  const tryAdopt = (raw: string, { flash = false } = {}): boolean => {
    let payload: EnrollPayload;
    try {
      payload = decodeEnroll(raw);
    } catch {
      return false;
    }
    setConfig(payload);
    setEndpoint(payload.endpoint);
    setBucket(payload.bucket);
    setRegion(payload.region ?? "auto");
    setAccessKey(payload.accessKeyId);
    setSecretKey(payload.secretAccessKey);
    setPrefix(payload.prefix ?? "metahub");
    setErr("");
    if (flash) {
      setHit(true);
      navigator.vibrate?.(35);
      setTimeout(() => {
        setHit(false);
        setStep("unlock");
      }, 380);
    } else {
      setStep("unlock");
    }
    return true;
  };

  const submitManual = () => {
    if (!endpoint.trim() || !bucket.trim() || !accessKey.trim() || !secretKey.trim()) {
      setErr("endpoint、bucket、access key、secret key 必填");
      return;
    }
    void connect(
      {
        endpoint,
        bucket,
        region,
        prefix,
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
        encrypt: config?.encrypt,
        virtualHostedStyle: config?.virtualHostedStyle,
      },
      passphrase,
    );
  };

  const switchTo = (s: Step) => {
    setErr("");
    setCamErr(null);
    setStep(s);
  };

  const pickImage = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const raw = await decodeImageFile(f).catch(() => null);
      if (!raw || !tryAdopt(raw)) setErr("没有在图片中找到有效的接入二维码");
    };
    input.click();
  };

  return (
    <div class="enroll">
      <div class="enroll-card">
        <div class="enroll-title">连接你的存储桶</div>

        {step === "scan" && (
          <>
            <div class="enroll-sub">
              扫描主设备上的二维码:在桌面端打开 设置 → 同步 → 手机接入。
            </div>
            <div class={`enroll-scan${hit ? " hit" : ""}`}>
              {camErr === "denied" ? (
                <div class="enroll-cam-err">
                  <Icon name="camera" cls="ico enroll-cam-errico" />
                  <div>相机权限被拒绝</div>
                  <div class="muted">允许访问相机,或改用下方粘贴/手动方式。</div>
                  <button
                    class="btn"
                    onClick={() => {
                      setCamErr(null);
                      setCamKey((k) => k + 1);
                    }}
                  >
                    重试授权
                  </button>
                </div>
              ) : (
                <QrScanner
                  key={camKey}
                  onDecoded={(raw) => {
                    const ok = tryAdopt(raw, { flash: true });
                    if (!ok) setErr("这不是有效的接入二维码"); // transient; scanning continues
                    return ok;
                  }}
                  onError={(kind) => {
                    if (kind === "denied") setCamErr("denied");
                    else switchTo("manual"); // no camera at all → manual is the path
                  }}
                />
              )}
            </div>
            <PasteBox onRaw={(raw) => tryAdopt(raw) || setErr("无效的接入链接或代码")} />
            {err && <div class="enroll-err">{err}</div>}
            <div class="enroll-switch">
              <button class="enroll-link" onClick={pickImage}>
                从图片识别
              </button>
              <span class="enroll-switch-dot">·</span>
              <button class="enroll-link" onClick={() => switchTo("manual")}>
                手动填写
              </button>
            </div>
          </>
        )}

        {step === "unlock" && config && (
          <>
            <div class="enroll-sub">
              {encrypt ? "已读取桶信息,输入加密口令即可同步你的数据。" : "已读取桶信息,点击连接即可同步你的数据。"}
            </div>
            <div class="enroll-bucket-card">
              <Icon name="database" cls="ico enroll-bucket-ico" />
              <div class="enroll-bucket-meta">
                <div class="enroll-bucket-name">{config.bucket}</div>
                <div class="enroll-bucket-host muted">{hostOf(config.endpoint)}</div>
              </div>
              {encrypt && (
                <span class="enroll-bucket-badge">
                  <Icon name="lock" cls="ico" />
                  端到端加密
                </span>
              )}
            </div>
            {encrypt && (
              <>
                <div class="field-label">加密口令</div>
                <input
                  class="text-input"
                  type="password"
                  autofocus
                  placeholder="与其他设备相同的口令"
                  value={passphrase}
                  onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => e.key === "Enter" && void connect(config, passphrase)}
                />
              </>
            )}
            {err && <div class="enroll-err">{err}</div>}
            <button class="btn btn-primary enroll-go" disabled={busy} onClick={() => void connect(config, passphrase)}>
              {busy ? "连接中…" : "连接并同步"}
            </button>
            <div class="enroll-switch">
              {cameraLikely() && !pre && (
                <>
                  <button class="enroll-link" onClick={() => switchTo("scan")}>
                    重新扫码
                  </button>
                  <span class="enroll-switch-dot">·</span>
                </>
              )}
              <button class="enroll-link" onClick={() => switchTo("manual")}>
                改为手动填写
              </button>
            </div>
          </>
        )}

        {step === "manual" && (
          <>
            <div class="enroll-sub">
              填入 S3 兼容存储桶(R2/COS/MinIO/S3)的连接信息;数据上传前端到端加密。
            </div>
            <div class="field-label">Endpoint</div>
            <input class="text-input" placeholder="https://<bucket>.cos.<region>.myqcloud.com" value={endpoint} onInput={(e) => setEndpoint((e.target as HTMLInputElement).value)} />
            <div class="field-label">Bucket</div>
            <input class="text-input" value={bucket} onInput={(e) => setBucket((e.target as HTMLInputElement).value)} />
            <div class="field-label">Region</div>
            <input class="text-input" placeholder="auto" value={region} onInput={(e) => setRegion((e.target as HTMLInputElement).value)} />
            <div class="field-label">Access Key ID</div>
            <input class="text-input" value={accessKey} onInput={(e) => setAccessKey((e.target as HTMLInputElement).value)} />
            <div class="field-label">Secret Access Key</div>
            <input class="text-input" type="password" value={secretKey} onInput={(e) => setSecretKey((e.target as HTMLInputElement).value)} />
            <div class="field-label">路径前缀</div>
            <input class="text-input" value={prefix} onInput={(e) => setPrefix((e.target as HTMLInputElement).value)} />
            <div class="field-label">加密口令</div>
            <input
              class="text-input"
              type="password"
              placeholder="与其他设备相同的口令"
              value={passphrase}
              onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === "Enter" && submitManual()}
            />
            {err && <div class="enroll-err">{err}</div>}
            <button class="btn btn-primary enroll-go" disabled={busy} onClick={submitManual}>
              {busy ? "连接中…" : "连接并同步"}
            </button>
            {cameraLikely() && (
              <div class="enroll-switch">
                <button class="enroll-link" onClick={() => switchTo("scan")}>
                  改为扫码
                </button>
              </div>
            )}
          </>
        )}

        <div class="enroll-hint muted">
          提示:iPhone 请用 Safari 的「分享 → 添加到主屏」装成 App,离线与持久存储才生效。
        </div>
      </div>
    </div>
  );
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** One-line paste target for an enroll link/token. A paste that decodes
 *  advances immediately; Enter reports failure for anything else. */
function PasteBox({ onRaw }: { onRaw: (raw: string) => unknown }) {
  const [v, setV] = useState("");
  return (
    <input
      class="text-input enroll-paste"
      placeholder="或粘贴接入链接 / 接入码…"
      value={v}
      onInput={(e) => setV((e.target as HTMLInputElement).value)}
      onPaste={(e) => {
        const raw = e.clipboardData?.getData("text") ?? "";
        if (raw.trim()) setTimeout(() => onRaw(raw), 0); // let the input update first
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && v.trim()) onRaw(v);
      }}
    />
  );
}

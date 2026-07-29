/** @jsxImportSource preact */
// Settings modals, moved verbatim out of settings.tsx (W1 mechanical
// extraction): Edge deploy, bucket connect/activate, add-device enrollment
// (QR / CLI / server pairing), key rotation and the recovery-code card.
import type { ComponentChild } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import type { S3Config } from "../../core/sync/storage.ts";
import { encodeEnroll } from "../../core/sync/enroll.ts";
import { Icon, CUBE_OUTER, CUBE_INNER } from "../icons.tsx";
import {
  api,
  currentToken,
  type S3Peer,
  type EdgeStatus,
  type RotateOutcome,
} from "../api.ts";
import { call as replicaCall } from "../data/replica.ts";
import { Modal, closeModal, toast } from "../ui.tsx";
import { hostOf } from "./shared.ts";

export function EdgeDeployModal({
  status,
  onDone,
  presetR2,
}: {
  status: EdgeStatus | null;
  onDone: () => void;
  /** Pre-check the R2 sync-bucket option (the CloudPanel one-stop CTA). */
  presetR2?: boolean;
}) {
  const defaults = status?.defaults;
  const oauthAvailable = status?.oauthConfigured ?? false;
  // Default to OAuth when available; the API-token inputs stay as an explicit
  // fallback (e.g. OAuth not registered on this build, or the user prefers it).
  const [useToken, setUseToken] = useState(!oauthAvailable);
  const [accountId, setAccountId] = useState(
    status?.pending?.accountId ?? status?.deployment?.accountId ?? "",
  );
  const [apiToken, setApiToken] = useState("");
  // OAuth flow state.
  const [authState, setAuthState] = useState<"idle" | "authing" | "ready" | "error">("idle");
  const [flowId, setFlowId] = useState<string | null>(null);
  // Cleanup must observe the latest flow without re-running whenever authState
  // changes. The previous dependency-based effect cancelled a flow while the
  // modal was still mounted: authing → ready ran the old cleanup and deleted
  // the server-side token immediately before deploy consumed it.
  const flowRef = useRef<string | null>(null);
  const flowConsumedRef = useRef(false);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [authErr, setAuthErr] = useState("");
  const [workerName, setWorkerName] = useState(
    status?.pending?.workerName ??
      status?.deployment?.workerName ??
      defaults?.workerName ??
      "",
  );
  const [d1Name, setD1Name] = useState(
    status?.pending?.d1Name ??
      status?.deployment?.d1Name ??
      defaults?.d1Name ??
      "",
  );
  const [subdomain, setSubdomain] = useState(
    status?.pending?.workersSubdomain ??
      status?.deployment?.workersSubdomain ??
      defaults?.workersSubdomain ??
      "",
  );
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  // One-stop R2: create a sync bucket on the same sign-in. Credentials can't be
  // minted via OAuth (no scope exists) — after creation the modal switches to a
  // paste step pointing at the dashboard's R2 API Tokens page.
  const [withR2, setWithR2] = useState(presetR2 ?? false);
  const [r2Name, setR2Name] = useState(defaults?.r2BucketName ?? "");
  const [r2Result, setR2Result] = useState<{
    bucketName: string;
    endpoint: string;
    credentialsUrl: string;
  } | null>(null);
  const [r2Ak, setR2Ak] = useState("");
  const [r2Sk, setR2Sk] = useState("");
  const [r2Pw, setR2Pw] = useState("");
  const [r2Busy, setR2Busy] = useState(false);

  // Poll the OAuth flow until the redirect is caught + accounts discovered.
  useEffect(() => {
    if (authState !== "authing" || !flowId) return;
    let live = true;
    const timer = setInterval(async () => {
      try {
        const s = await api.edgeOAuthStatus(flowId);
        if (!live) return;
        if (s.state === "ready") {
          setAccounts(s.accounts ?? []);
          if ((s.accounts ?? []).length === 1) setAccountId(s.accounts![0]!.id);
          setAuthState("ready");
        } else if (s.state === "error") {
          setAuthErr(s.error || "Cloudflare 授权失败");
          setAuthState("error");
        }
      } catch (e) {
        if (!live) return;
        setAuthErr((e as Error).message);
        setAuthState("error");
      }
    }, 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [authState, flowId]);

  // Tear down an unconsumed flow if the modal unmounts mid-auth.
  useEffect(
    () => () => {
      const id = flowRef.current;
      if (id && !flowConsumedRef.current) api.cancelEdgeOAuth(id).catch(() => {});
    },
    [],
  );

  const signIn = async () => {
    setAuthErr("");
    try {
      if (flowRef.current && !flowConsumedRef.current)
        await api.cancelEdgeOAuth(flowRef.current).catch(() => {});
      const { flowId: id, authUrl } = await api.beginEdgeOAuth();
      flowRef.current = id;
      flowConsumedRef.current = false;
      setFlowId(id);
      setAuthState("authing");
      // In the desktop app the consent page must open in the real browser (the
      // loopback redirect is caught by the sidecar); in a plain browser a tab is fine.
      if (window.metahubDesktop?.oauth) window.metahubDesktop.oauth.openExternal(authUrl);
      else window.open(authUrl, "_blank", "noopener");
    } catch (e) {
      setAuthErr((e as Error).message);
      setAuthState("error");
    }
  };

  const deploy = async () => {
    if (!confirmed) return toast("请先确认将创建或更新列出的 Cloudflare 资源");
    if (!useToken && authState !== "ready") return toast("请先用 Cloudflare 登录");
    if (!useToken && accounts.length > 1 && !accountId) return toast("请选择要部署到的 Cloudflare 账号");
    setBusy(true);
    try {
      const result = await api.deployEdge(
        useToken
          ? { accountId, apiToken, workerName, d1Name, workersSubdomain: subdomain, confirmed, keepFlow: withR2 }
          : {
              flowId: flowId!,
              accountId: accountId || undefined,
              workerName,
              d1Name,
              workersSubdomain: subdomain,
              confirmed,
              // Keep the sign-in alive for the follow-up R2 creation.
              keepFlow: withR2,
            },
      );
      const failed = result.wired.filter((x) => !x.registered);
      const notes = [
        ...result.warnings,
        ...(failed.length ? [`${failed.length} 个站点重新接线失败：${failed.map((x) => x.site).join("、")}`] : []),
      ];
      let r2Note = "";
      if (withR2) {
        try {
          const r2 = await api.provisionEdgeR2(
            useToken
              ? { accountId, apiToken, bucketName: r2Name || undefined, confirmed }
              : { flowId: flowId!, accountId: accountId || undefined, bucketName: r2Name || undefined, confirmed },
          );
          setR2Result(r2);
        } catch (e) {
          r2Note = `R2 桶创建失败：${(e as Error).message}`;
        }
      }
      setApiToken("");
      // The flow's token was consumed server-side; forget it locally.
      flowConsumedRef.current = true;
      flowRef.current = null;
      setFlowId(null);
      setAuthState("idle");
      toast(
        [notes.length ? `Edge 部署完成；${notes.join("；")}` : "Edge 部署完成", r2Note]
          .filter(Boolean)
          .join(" "),
      );
      // With a bucket created the modal switches to the credentials step;
      // otherwise we're done.
      if (!withR2 || r2Note) onDone();
    } catch (e) {
      setApiToken("");
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const attachR2 = async () => {
    if (!r2Result) return;
    if (!r2Ak.trim() || !r2Sk.trim()) return toast("请填入 Access Key ID 与 Secret");
    if (!r2Pw) return toast("请设置加密口令");
    setR2Busy(true);
    try {
      await api.addServerS3Peer({
        endpoint: r2Result.endpoint,
        bucket: r2Result.bucketName,
        accessKeyId: r2Ak.trim(),
        secretAccessKey: r2Sk.trim(),
        region: "auto",
        encrypt: true,
        passphrase: r2Pw,
        corsOrigins: [location.origin],
      });
      toast("同步桶已接入");
      onDone();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setR2Busy(false);
    }
  };

  if (r2Result) {
    return (
      <Modal
        title="接入同步桶"
        sub={`R2 桶 ${r2Result.bucketName} 已创建。最后一步：Cloudflare 不允许应用代为创建 S3 凭据，请到控制台生成后粘贴到这里。`}
        footer={
          <>
            <button class="btn btn-secondary" onClick={() => { closeModal(); onDone(); }}>稍后再接</button>
            <button class="btn btn-primary" disabled={r2Busy} onClick={attachR2}>
              {r2Busy ? "接入中…" : "接入同步桶"}
            </button>
          </>
        }
      >
        <div class="set-callout warn">
          打开{" "}
          <a href={r2Result.credentialsUrl} target="_blank" rel="noopener">
            R2 → 管理 R2 API 令牌
          </a>
          ，创建一个「对象读和写」令牌（可只勾选 {r2Result.bucketName} 这个桶），把页面显示的
          Access Key ID 与 Secret Access Key 粘贴到下面。
        </div>
        <div class="field-label">Access Key ID</div>
        <input class="text-input" value={r2Ak} onInput={(e) => setR2Ak((e.currentTarget as HTMLInputElement).value)} />
        <div class="field-label">Secret Access Key</div>
        <input class="text-input" type="password" value={r2Sk} onInput={(e) => setR2Sk((e.currentTarget as HTMLInputElement).value)} />
        <div class="field-label">加密口令（新工作区在此设置；其他设备加入时需输入同一口令）</div>
        <input class="text-input" type="password" value={r2Pw} onInput={(e) => setR2Pw((e.currentTarget as HTMLInputElement).value)} autocomplete="new-password" />
        <div class="set-hint">
          口令保护数据机密性，请牢记；接入完成后建议在「设备与授权 → 导出恢复码」打印备份。
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title={status?.configured ? "升级 Edge" : "部署 Edge"}
      sub="将在你自己的 Cloudflare 账户中创建或更新一个 Worker、一个 D1 数据库和 workers.dev 入口。凭据仅用于本次请求，不会保存。"
      footer={
        <>
          <button
            class="btn btn-secondary"
            onClick={() => {
              if (flowRef.current && !flowConsumedRef.current) {
                flowConsumedRef.current = true;
                api.cancelEdgeOAuth(flowRef.current).catch(() => {});
                flowRef.current = null;
              }
              closeModal();
            }}
          >
            取消
          </button>
          <button
            class="btn btn-primary"
            disabled={busy || !confirmed || (!useToken && authState !== "ready")}
            onClick={deploy}
          >
            {busy ? "部署中…" : "确认并部署"}
          </button>
        </>
      }
    >
      {!useToken ? (
        <>
          <div class="field-label">Cloudflare 账号</div>
          {authState === "ready" ? (
            accounts.length > 1 ? (
              <select
                class="text-input"
                value={accountId}
                onChange={(e) => setAccountId((e.currentTarget as HTMLSelectElement).value)}
              >
                <option value="">选择账号…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}（{a.id}）
                  </option>
                ))}
              </select>
            ) : (
              <div class="muted" style={{ fontSize: 13 }}>
                ✅ 已登录：{accounts[0]?.name ?? accountId}
              </div>
            )
          ) : (
            <button class="btn btn-secondary" disabled={authState === "authing"} onClick={signIn}>
              {authState === "authing" ? "等待浏览器授权…" : "用 Cloudflare 登录"}
            </button>
          )}
          <div class="muted" style={{ fontSize: 12, marginTop: 6 }}>
            将打开 Cloudflare 授权页，只申请 Workers 与 D1 的最小权限；令牌仅用于本次部署、不会保存。
            {oauthAvailable && (
              <>
                {" "}
                <a href="#" onClick={(e) => { e.preventDefault(); setUseToken(true); }}>
                  改用 API Token
                </a>
              </>
            )}
          </div>
          {authErr && (
            <div class="muted" style={{ fontSize: 12, marginTop: 4, color: "var(--danger, #c0392b)" }}>
              {authErr}
            </div>
          )}
        </>
      ) : (
        <>
          <div class="field-label">Cloudflare Account ID</div>
          <input class="text-input" value={accountId} onInput={(e) => setAccountId((e.currentTarget as HTMLInputElement).value)} />
          <div class="field-label">临时 API Token</div>
          <input class="text-input" type="password" value={apiToken} onInput={(e) => setApiToken((e.currentTarget as HTMLInputElement).value)} />
          <div class="muted" style={{ fontSize: 12, marginTop: 4 }}>
            需要 Workers Scripts Write 与 D1 Write。Cloudflare Token 是账户级凭据，请仅使用最小权限 Token。
            {oauthAvailable && (
              <>
                {" "}
                <a href="#" onClick={(e) => { e.preventDefault(); setUseToken(false); }}>
                  改用 Cloudflare 登录
                </a>
              </>
            )}
          </div>
        </>
      )}
      <div class="field-label">Worker 名称</div>
      <input class="text-input" value={workerName} onInput={(e) => setWorkerName((e.currentTarget as HTMLInputElement).value)} />
      <div class="field-label">D1 名称</div>
      <input class="text-input" value={d1Name} onInput={(e) => setD1Name((e.currentTarget as HTMLInputElement).value)} />
      <div class="field-label">workers.dev 子域（账户尚未设置时创建）</div>
      <input class="text-input" value={subdomain} onInput={(e) => setSubdomain((e.currentTarget as HTMLInputElement).value)} />
      <div class="muted" style={{ fontSize: 12, marginTop: 4 }}>
        子域属于整个 Cloudflare 账户；如果账户已有子域，将使用现有值并在完成结果中提示。
      </div>
      <label class="set-check-row" style={{ marginTop: 14 }}>
        <input
          type="checkbox"
          checked={withR2}
          onChange={(e) => setWithR2((e.currentTarget as HTMLInputElement).checked)}
        />
        <span>
          同时创建 <b>R2 同步桶</b>（创建桶后仍需单独生成 S3 凭据）
        </span>
      </label>
      {withR2 && (
        <>
          <div class="field-label">R2 桶名称</div>
          <input class="text-input" value={r2Name} onInput={(e) => setR2Name((e.currentTarget as HTMLInputElement).value)} />
          <div class="set-hint">
            创建后还差一步：到 Cloudflare 控制台生成 S3 凭据并粘贴（授权无法代办这一步），本向导会引导你完成。
          </div>
        </>
      )}
      {status?.pending && (
        <div class="set-callout warn" style={{ marginTop: 10 }}>
          检测到未完成部署，当前步骤：{status.pending.step}。使用相同名称可继续，不会自动删除已创建资源。
        </div>
      )}
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 12 }}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed((e.currentTarget as HTMLInputElement).checked)} />
        <span>我确认创建或更新上述 Cloudflare 资源；断开 MetaHub 时不会自动删除它们。</span>
      </label>
    </Modal>
  );
}

/** Mask a credential id for read-only display — keep the head/tail, dot the rest. */
function maskKey(s: string): string {
  return s.length <= 8 ? s.slice(0, 2) + "…" : s.slice(0, 4) + "…" + s.slice(-4);
}

/** origin + replica only: a server bucket is already configured (the server is
 *  its publisher), but the server never sends the secret down to the browser.
 *  Re-enter just the secret (and the shared passphrase, when encrypted) to let
 *  THIS device's replica sync with the bucket directly — its own away-from-
 *  server fallback. Every other field is prefilled from the server's non-secret
 *  view; we attach as a non-publisher (publish:false). */
export function ActivateBucketOnDeviceModal({ peer, onDone }: { peer: S3Peer; onDone: () => void }) {
  const [secretKey, setSecretKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const host = peer.endpoint ? hostOf(peer.endpoint) : "";

  const submit = async () => {
    if (!secretKey.trim()) return toast("密钥必填");
    if (peer.encrypt && !passphrase) return toast("加密口令必填");
    if (!peer.endpoint || !peer.bucket || !peer.accessKeyId) {
      return toast("服务器未提供该桶的完整配置,无法在本设备激活");
    }
    setBusy(true);
    try {
      const config: S3Config = {
        endpoint: peer.endpoint,
        region: peer.region || "auto",
        bucket: peer.bucket,
        prefix: peer.prefix || "metahub",
        accessKeyId: peer.accessKeyId,
        secretAccessKey: secretKey.trim(),
        encrypt: peer.encrypt,
        ...(peer.virtualHostedStyle != null ? { virtualHostedStyle: peer.virtualHostedStyle } : {}),
        publish: false,
      };
      await replicaCall("addStorageReplica", config, passphrase);
      toast("已让本机直连存储桶 · 离线、在外也能直接同步");
      onDone();
    } catch (e) {
      const msg = (e as Error).message;
      toast(
        looksLikeCors(msg)
          ? "连接被浏览器拦截：请给存储桶配置 CORS，允许此源的 GET/PUT/HEAD/DELETE。"
          : `启用失败：${msg}`,
      );
      setBusy(false);
    }
  };

  return (
    <Modal
      title="在本设备启用直连"
      sub="服务器已配置这个存储桶。为保护密钥,服务器不会把它同步到浏览器——再输入一次密钥,这台设备就能与桶直接同步(离线、在外也不中断)。"
      footer={
        <>
          <button class="btn btn-secondary" onClick={closeModal} disabled={busy}>取消</button>
          <button class="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "连接中…" : "启用直连"}
          </button>
        </>
      }
    >
      <div class="activate-id">
        <div class="activate-id-row"><span>存储桶</span><b>{peer.bucket}</b></div>
        {host && <div class="activate-id-row"><span>服务地址</span><b>{host}</b></div>}
        {peer.accessKeyId && (
          <div class="activate-id-row"><span>访问密钥 ID</span><b>{maskKey(peer.accessKeyId)}</b></div>
        )}
      </div>
      <div class="field-label">密钥</div>
      <input
        class="text-input"
        type="password"
        autofocus
        placeholder="重新输入该桶的密钥"
        value={secretKey}
        onInput={(e) => setSecretKey((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => !peer.encrypt && e.key === "Enter" && submit()}
      />
      {peer.encrypt && (
        <>
          <div class="field-label">加密口令</div>
          <input
            class="text-input"
            type="password"
            placeholder="与其它设备相同的加密口令"
            value={passphrase}
            onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <div class="set-hint">跨设备共用的那把加密钥——用它解开桶里别人的数据。</div>
        </>
      )}
    </Modal>
  );
}

// ---- "open on your phone" enroll QR ----------------------------------------

const SHELL_BASE_KEY = "mh_shell_base";

/** Build the deep link a phone opens to enroll this bucket. Carries the bucket
 *  credentials (so the phone can connect) but NOT the passphrase or master key —
 *  the phone types the passphrase. `shellBase` is the static-shell domain
 *  (configurable; defaults to the current origin for LAN/Tailscale setups). */
function enrollUrl(shellBase: string, c: S3Config): string {
  const base = (shellBase || location.origin).replace(/\/+$/, "");
  return `${base}/#enroll=${encodeEnroll(c)}`;
}

type AddTab = "phone" | "cli" | "server";

/** Render `data` as a polished inline QR: rounded-dot data modules, rounded
 *  finder eyes, and a centre cube badge. Foreground/background come from CSS
 *  vars (--qr-fg / --qr-bg on .qr-box) so it adapts to light/dark with zero JS.
 *  ECC "H" (30% recovery) keeps it scannable despite the centre logo cut-out. */
function QrSvg({ data }: { data: string }) {
  const qr = qrcode(0, "H");
  qr.addData(data);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 2; // quiet zone (modules) — .qr-box padding adds the rest
  const mid = n / 2;
  const logo = Math.max(5, Math.floor(n * 0.22)); // centre clear-zone (modules)
  const half = logo / 2;

  // The three 7×7 finder patterns (corners) get drawn as eyes, not dots.
  const inFinder = (r: number, c: number) =>
    (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  // Cleared square behind the centre badge.
  const inLogo = (r: number, c: number) =>
    Math.abs(r + 0.5 - mid) < half && Math.abs(c + 0.5 - mid) < half;

  const dots: ComponentChild[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c) || inFinder(r, c) || inLogo(r, c)) continue;
      dots.push(<circle key={r * n + c} cx={c + 0.5} cy={r + 0.5} r={0.45} fill="var(--qr-fg)" />);
    }
  }

  // A finder eye: rounded outer ring (1-module stroke) + rounded inner square.
  const eye = (fr: number, fc: number) => (
    <>
      <rect x={fc + 0.5} y={fr + 0.5} width={6} height={6} rx={2} ry={2} fill="none" stroke="var(--qr-fg)" stroke-width={1} />
      <rect x={fc + 2} y={fr + 2} width={3} height={3} rx={1} fill="var(--qr-fg)" />
    </>
  );

  const badge = logo + 0.6; // bg rect rounds the square hole + covers its edges
  const s = (logo * 0.62) / 24; // scale the 24-unit cube path to ~62% of clear-zone

  return (
    <div class="qr-box">
      <svg viewBox={`${-margin} ${-margin} ${n + margin * 2} ${n + margin * 2}`} shape-rendering="geometricPrecision">
        {dots}
        {eye(0, 0)}
        {eye(0, n - 7)}
        {eye(n - 7, 0)}
        <rect x={mid - badge / 2} y={mid - badge / 2} width={badge} height={badge} rx={badge * 0.26} ry={badge * 0.26} fill="var(--qr-bg)" />
        <g
          class="qr-cube"
          transform={`translate(${mid} ${mid}) scale(${s}) translate(-12 -12)`}
          fill="none"
          stroke="var(--qr-fg)"
          stroke-width={1.6}
          stroke-linejoin="round"
          stroke-linecap="round"
        >
          <path class="qr-cube-edge qr-cube-outer" pathLength={1} d={CUBE_OUTER} />
          <path class="qr-cube-edge qr-cube-inner" pathLength={1} d={CUBE_INNER} />
          <path class="qr-cube-glint" pathLength={1} d={CUBE_OUTER} />
          <path class="qr-cube-glint" pathLength={1} d={CUBE_INNER} />
        </g>
      </svg>
    </div>
  );
}

/** Full-width copy-to-clipboard button with a toast confirmation. */
function CopyRow({ text, label, done, primary }: { text: string; label: string; done: string; primary?: boolean }) {
  return (
    <button
      class={"btn " + (primary ? "btn-primary" : "btn-secondary")}
      style={{ width: "100%", marginTop: 10 }}
      onClick={() => {
        navigator.clipboard?.writeText(text);
        toast(done);
      }}
    >
      <Icon name="copy" cls="ico sm" /> {label}
    </button>
  );
}

/** Phone tab: a QR (and copyable link) a phone scans to join the bucket. */
function PhoneEnroll({ config }: { config: S3Config }) {
  const [shellBase, setShellBase] = useState(() => {
    try {
      return localStorage.getItem(SHELL_BASE_KEY) || location.origin;
    } catch {
      return location.origin;
    }
  });
  const url = enrollUrl(shellBase, config);
  const onBase = (v: string) => {
    setShellBase(v);
    try {
      v ? localStorage.setItem(SHELL_BASE_KEY, v) : localStorage.removeItem(SHELL_BASE_KEY);
    } catch {
      /* private mode */
    }
  };
  return (
    <>
      <QrSvg data={url} />
      <div class="field-label">壳地址（手机访问的静态站点域名；留空用当前地址）</div>
      <input
        class="text-input"
        placeholder={location.origin}
        value={shellBase}
        onInput={(e) => onBase((e.target as HTMLInputElement).value)}
      />
      <CopyRow text={url} label="复制链接" done="已复制链接" />
      <div class="peer-sub" style="margin-top:8px">手机相机扫码打开,输入加密口令即可同步。</div>
    </>
  );
}

/** Computer/CLI tab: a one-line `mh` command (and the raw code) to join the bucket. */
function CliEnroll({ config }: { config: S3Config }) {
  const token = encodeEnroll(config);
  const cmd = `mh config backup connect --enroll ${token}`;
  return (
    <>
      <div class="field-label">在另一台电脑的终端运行</div>
      <div class="enroll-cmd">{cmd}</div>
      <CopyRow text={cmd} label="复制命令" done="已复制命令" primary />
      <CopyRow text={token} label="复制接入码" done="已复制接入码" />
      <div class="peer-sub" style="margin-top:8px">
        对方运行后会提示输入加密口令。也可在 <code>mh config</code> 向导选「粘贴接入码加入存储」。
      </div>
    </>
  );
}

/** A generated pairing code with a live countdown to expiry. */
function PairCodeView({ code, exp }: { code: string; exp: number }) {
  const [left, setLeft] = useState(Math.max(0, Math.round((exp - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.round((exp - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [exp]);
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  return (
    <>
      <div class="pair-code">{code}</div>
      <div class="muted" style={{ textAlign: "center", marginTop: 8 }}>
        {left > 0 ? `${mm}:${ss} 后过期` : "已过期,请重新生成"}
      </div>
      <CopyRow text={code} label="复制配对码" done="已复制配对码" />
    </>
  );
}

/** Advanced tab: live HTTP pairing against a server (generate / redeem a one-time
 *  code), plus the server-login QR a phone scans to open this server. */
function ServerPairing({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState<{ code: string; exp: number } | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const gen = async () => {
    setGenBusy(true);
    try {
      setCode(await api.newPairingCode());
    } catch (e) {
      toast(`生成失败：${(e as Error).message}`);
    } finally {
      setGenBusy(false);
    }
  };

  const [url, setUrl] = useState("");
  const [rcode, setRcode] = useState("");
  const [selfUrl, setSelfUrl] = useState(location.origin);
  const [busy, setBusy] = useState(false);
  const redeem = async () => {
    if (!url.trim() || !rcode.trim()) return toast("地址和配对码必填");
    setBusy(true);
    try {
      const r = await api.addPeerByPairing({ url: url.trim(), code: rcode.trim(), self_url: selfUrl.trim() || undefined });
      await api.syncPeer(r.url).catch(() => {});
      toast(`已配对 ${r.url}`);
      onPaired();
    } catch (e) {
      toast(`配对失败：${(e as Error).message}`);
      setBusy(false);
    }
  };

  const [base, setBase] = useState(() => {
    try {
      return localStorage.getItem(SERVER_BASE_KEY) || location.origin;
    } catch {
      return location.origin;
    }
  });
  const onBase = (v: string) => {
    setBase(v);
    try {
      v ? localStorage.setItem(SERVER_BASE_KEY, v) : localStorage.removeItem(SERVER_BASE_KEY);
    } catch {
      /* private mode */
    }
  };
  const loginUrl = originEnrollUrl(base, currentToken());

  return (
    <>
      <div class="enroll-section">邀请另一台服务器配对</div>
      {code ? (
        <PairCodeView code={code.code} exp={code.exp} />
      ) : (
        <button class="btn btn-secondary" style={{ width: "100%" }} disabled={genBusy} onClick={gen}>
          <Icon name="link" cls="ico sm" /> {genBusy ? "生成中…" : "生成本机配对码"}
        </button>
      )}

      <div class="enroll-sep" />
      <div class="enroll-section">已有对方的配对码?</div>
      <div class="field-label">对方服务器地址</div>
      <input class="text-input" placeholder="http://192.168.1.10:7777" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
      <div class="field-label">配对码</div>
      <input
        class="text-input"
        placeholder="对方「生成本机配对码」得到的码"
        value={rcode}
        onInput={(e) => setRcode((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === "Enter" && redeem()}
      />
      <div class="field-label">本机可达地址（可选）</div>
      <input class="text-input" placeholder="留空则仅本机主动同步" value={selfUrl} onInput={(e) => setSelfUrl((e.target as HTMLInputElement).value)} />
      <button class="btn btn-primary" style={{ width: "100%", marginTop: 10 }} disabled={busy} onClick={redeem}>
        {busy ? "配对中…" : "配对"}
      </button>

      <div class="enroll-sep" />
      <div class="enroll-section">在手机上打开本服务器</div>
      <QrSvg data={loginUrl} />
      <div class="field-label">服务器地址（手机访问的域名；留空用当前地址）</div>
      <input class="text-input" placeholder={location.origin} value={base} onInput={(e) => onBase((e.target as HTMLInputElement).value)} />
      <CopyRow text={loginUrl} label="复制链接" done="已复制链接" />
      <div class="peer-sub" style="margin-top:8px">⚠ 含访问令牌,请勿公开分享。</div>
    </>
  );
}

/** Unified "添加设备" surface: one modal that brings another device onto the
 *  workspace — a phone (scan/link), a computer/CLI (command/code), or, against a
 *  server, live HTTP pairing. The enroll token carries bucket access only (never
 *  the passphrase); the joining device types that. Replaces the old per-bucket
 *  QrModal, the server-login OriginQrModal, and the pairing add/code modals. */
export function AddDeviceModal({
  buckets,
  getConfig,
  server,
  onPaired,
}: {
  buckets: { url: string; name: string }[];
  getConfig: (url: string) => Promise<S3Config | null>;
  server: boolean;
  onPaired: () => void;
}) {
  const hasBuckets = buckets.length > 0;
  const tabs: { id: AddTab; label: string }[] = [
    ...(hasBuckets
      ? ([
          { id: "phone", label: "手机扫码" },
          { id: "cli", label: "电脑 / 命令行" },
        ] as { id: AddTab; label: string }[])
      : []),
    ...(server ? ([{ id: "server", label: "高级:服务器配对" }] as { id: AddTab; label: string }[]) : []),
  ];
  const [tab, setTab] = useState<AddTab>(tabs[0]?.id ?? "server");
  const [bucketUrl, setBucketUrl] = useState(buckets[0]?.url ?? "");
  const [config, setConfig] = useState<S3Config | null>(null);
  const [loadErr, setLoadErr] = useState("");

  useEffect(() => {
    if (!hasBuckets || !bucketUrl) return;
    let live = true;
    setConfig(null);
    setLoadErr("");
    getConfig(bucketUrl)
      .then((c) => {
        if (!live) return;
        c ? setConfig(c) : setLoadErr("找不到该存储的配置");
      })
      .catch((e) => live && setLoadErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [bucketUrl]);

  return (
    <Modal
      title="添加设备"
      sub="让另一台设备加入同一个工作区——手机扫码,或在电脑上粘贴接入码。"
      footer={<button class="btn btn-primary" onClick={closeModal}>完成</button>}
      width={420}
    >
      {tabs.length > 1 && (
        <div class="add-tabs">
          {tabs.map((t) => (
            <button key={t.id} class={"add-tab" + (tab === t.id ? " on" : "")} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {(tab === "phone" || tab === "cli") && (
        <>
          {buckets.length > 1 && (
            <>
              <div class="field-label">存储桶</div>
              <select
                class="text-input"
                value={bucketUrl}
                onChange={(e) => setBucketUrl((e.target as HTMLSelectElement).value)}
              >
                {buckets.map((b) => (
                  <option key={b.url} value={b.url}>{b.name}</option>
                ))}
              </select>
            </>
          )}
          {loadErr ? (
            <div class="enroll-err">{loadErr}</div>
          ) : !config ? (
            <div class="muted">加载中…</div>
          ) : tab === "phone" ? (
            <PhoneEnroll config={config} />
          ) : (
            <CliEnroll config={config} />
          )}
          {config && (
            <div class="peer-sub" style="margin-top:8px">
              ⚠ 接入码含桶访问密钥,请勿公开分享;不含加密口令——新设备需另输口令。
            </div>
          )}
        </>
      )}

      {tab === "server" && <ServerPairing onPaired={onPaired} />}
    </Modal>
  );
}

/** Heuristic: a fetch that failed at the CORS/network layer (opaque TypeError)
 *  rather than an HTTP error from S3. The bucket almost certainly lacks a CORS
 *  rule for this origin — the one setup step a phone needs. */
function looksLikeCors(message: string): boolean {
  return /failed to fetch|load failed|networkerror|cors/i.test(message);
}

// ---- origin "open on your phone": a `<server>/?token=…` QR -----------------
// The mirror of the no-origin enroll QR, for the server (origin) case: the phone
// scans it to open AND log into the server in one step (auth.ts accepts ?token),
// no typing. The token is a bearer secret, so the QR is treated as sensitive.

const SERVER_BASE_KEY = "mh_server_base";

function originEnrollUrl(base: string, token: string | null): string {
  const b = (base || location.origin).replace(/\/+$/, "");
  return token ? `${b}/?token=${encodeURIComponent(token)}` : b;
}

// The server-login QR ("在手机上打开本服务器") now lives in AddDeviceModal's
// 「高级:服务器配对」 tab (ServerPairing); originEnrollUrl + SERVER_BASE_KEY above
// are shared with it.

/** Provider presets — prefill the right region + endpoint shape + a one-line
 *  hint, so the user isn't staring at a blank "endpoint" field wondering what an
 *  S3 endpoint even is. Purely a convenience over the same underlying S3 fields;
 *  COS uses virtual-hosted addressing (auto-detected when the endpoint host
 *  starts with the bucket name — see storage-s3-bun §13). */
const S3_PROVIDERS = [
  { id: "r2", name: "Cloudflare R2", region: "auto", ph: "https://<账户ID>.r2.cloudflarestorage.com", hint: "R2 控制台 → 管理 R2 API 令牌，创建仅限目标桶的对象读写凭据；区域填 auto。价格与额度以 Cloudflare 控制台为准。" },
  { id: "s3", name: "Amazon S3", region: "us-east-1", ph: "https://s3.<区域>.amazonaws.com", hint: "IAM 用户的访问密钥;区域如 us-east-1。" },
  { id: "minio", name: "MinIO", region: "us-east-1", ph: "https://minio.你的域名", hint: "自建 MinIO 的访问地址与 access / secret key。" },
  { id: "cos", name: "腾讯云 COS", region: "ap-shanghai", ph: "https://<桶名-APPID>.cos.<区域>.myqcloud.com", hint: "桶名须含 APPID,用虚拟主机风格地址(host 以桶名开头)。" },
  { id: "custom", name: "自定义", region: "auto", ph: "https://s3.example.com", hint: "任何 S3 兼容存储桶。" },
] as const;

export function AddStorageModal({
  onDone,
  toServer,
  alsoReplica,
}: {
  onDone: () => void;
  toServer?: boolean;
  alsoReplica?: boolean;
}) {
  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("auto");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [prefix, setPrefix] = useState("metahub");
  const [encrypt, setEncrypt] = useState(true);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<string>("r2");
  const prov = S3_PROVIDERS.find((p) => p.id === provider) ?? S3_PROVIDERS[4];
  // Switch provider → adopt its region, but never clobber a region the user
  // typed (only overwrite when it's still one of the presets' defaults).
  const pickProvider = (id: string) => {
    setProvider(id);
    const p = S3_PROVIDERS.find((x) => x.id === id);
    if (p && S3_PROVIDERS.some((x) => x.region === region)) setRegion(p.region);
  };

  const submit = async () => {
    if (!endpoint.trim() || !bucket.trim() || !accessKey.trim() || !secretKey.trim()) {
      toast("服务地址、桶名称、访问密钥 ID、密钥都要填");
      return;
    }
    if (encrypt && !passphrase) {
      toast("加密口令必填（或关闭加密）");
      return;
    }
    setBusy(true);
    try {
      const config = {
        endpoint: endpoint.trim(),
        region: region.trim() || "auto",
        bucket: bucket.trim(),
        prefix: prefix.trim() || "metahub",
        accessKeyId: accessKey.trim(),
        secretAccessKey: secretKey.trim(),
        encrypt,
      };
      // origin → attach to the server (data home + publisher), opening bucket CORS
      // for this browser's origin; no-origin → this browser's local replica (which
      // is the home). When origin AND this browser keeps an offline replica, ALSO
      // attach the bucket here as a non-publisher (publish:false) so the replica
      // can sync via the bucket when the server is unreachable (away-sync). Server
      // first, so CORS is open before the browser hits the bucket directly.
      if (toServer) {
        await api.addServerS3Peer({ ...config, passphrase, corsOrigins: [location.origin] });
        if (alsoReplica) {
          await replicaCall("addStorageReplica", { ...config, publish: false }, passphrase);
        }
      } else {
        await replicaCall("addStorageReplica", config, passphrase);
      }
      toast(
        toServer
          ? alsoReplica
            ? "已连接存储桶 · 服务器开始同步到桶,这台设备也直接同步"
            : "已连接存储桶 · 服务器开始同步到桶"
          : "已连接存储桶 · 这台设备开始同步到桶",
      );
      onDone();
    } catch (e) {
      const msg = (e as Error).message;
      toast(
        looksLikeCors(msg)
          ? "连接被浏览器拦截：请给存储桶配置 CORS，允许此源的 GET/PUT/HEAD/DELETE（R2 控制台一条规则即可）。"
          : `添加失败：${msg}`,
      );
      setBusy(false);
    }
  };

  return (
    <Modal
      title="连接存储桶"
      sub="连接一个 S3 兼容存储桶,所有设备就能同步——不需要公网服务器。新桶自动初始化;已有桶用相同加密口令即可加入。"
      footer={
        <>
          <button class="btn btn-secondary" onClick={closeModal} disabled={busy}>取消</button>
          <button class="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "连接中…" : "连接"}
          </button>
        </>
      }
    >
      <div class="set-hint" style={{ marginTop: 0, marginBottom: 12 }}>
        {toServer
          ? "连接后，工作区主节点负责把整库同步到这个桶；这台设备和其他设备都从它同步。"
          : "连接后,这台设备(本机)把整库同步到这个桶;新设备扫码加入即可一起用。"}
      </div>
      <div class="field-label">存储服务商</div>
      <div class="provider-grid">
        {S3_PROVIDERS.map((p) => (
          <button
            key={p.id}
            class={"provider-chip" + (provider === p.id ? " sel" : "")}
            aria-pressed={provider === p.id}
            onClick={() => pickProvider(p.id)}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div class="set-hint">{prov.hint}</div>

      <div class="field-label">服务地址</div>
      <input
        class="text-input"
        autofocus
        placeholder={prov.ph}
        value={endpoint}
        onInput={(e) => setEndpoint((e.target as HTMLInputElement).value)}
      />
      <div class="field-label">桶名称</div>
      <input
        class="text-input"
        placeholder="my-metahub"
        value={bucket}
        onInput={(e) => setBucket((e.target as HTMLInputElement).value)}
      />
      <div class="field-label">访问密钥 ID</div>
      <input
        class="text-input"
        placeholder="Access Key ID"
        value={accessKey}
        onInput={(e) => setAccessKey((e.target as HTMLInputElement).value)}
      />
      <div class="field-label">密钥</div>
      <input
        class="text-input"
        type="password"
        placeholder="Secret Access Key"
        value={secretKey}
        onInput={(e) => setSecretKey((e.target as HTMLInputElement).value)}
      />

      <label class="set-check-row" style={{ marginTop: 14 }}>
        <input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt((e.target as HTMLInputElement).checked)} />
        <span>端到端加密(强烈建议;关闭后文件以明文存放,仅限完全信任的存储)</span>
      </label>
      {encrypt && (
        <>
          <div class="field-label">加密口令</div>
          <input
            class="text-input"
            type="password"
            placeholder="新桶以此创建;其它设备用同一口令加入"
            value={passphrase}
            onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <div class="set-hint">这是跨设备共用的一把加密钥——记牢它,换设备 / 加入已有桶时都要用它解开数据。</div>
        </>
      )}

      <details class="set-disclosure" style={{ marginTop: 14 }}>
        <summary>进阶</summary>
        <div class="set-disclosure-body">
          <div class="field-label" style={{ marginTop: 0 }}>区域</div>
          <input
            class="text-input"
            placeholder={prov.region}
            value={region}
            onInput={(e) => setRegion((e.target as HTMLInputElement).value)}
          />
          <div class="set-hint">大多按服务商默认即可(R2 用 auto)。</div>
          <div class="field-label">路径前缀</div>
          <input
            class="text-input"
            placeholder="metahub"
            value={prefix}
            onInput={(e) => setPrefix((e.target as HTMLInputElement).value)}
          />
          <div class="set-hint">同一个桶里隔离多个工作区时用;默认 metahub。</div>
        </div>
      </details>
    </Modal>
  );
}

/** Bucket credential/passphrase rotation — mirrors `mh config backup rotate`
 *  (core rotateStoragePeer state machine; every failure leaves the old keys
 *  working, re-running converges). */
export function RotateModal({ buckets, onDone }: { buckets: S3Peer[]; onDone: () => void }) {
  const [url, setUrl] = useState(buckets[0]?.url ?? "");
  const [ak, setAk] = useState("");
  const [sk, setSk] = useState("");
  const [changePw, setChangePw] = useState(false);
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RotateOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bucket = buckets.find((b) => b.url === url);

  const submit = async () => {
    setError(null);
    const wantCreds = ak.trim() !== "" || sk.trim() !== "";
    if (wantCreds && (!ak.trim() || !sk.trim()))
      return setError("新密钥需要同时填 Access Key ID 和 Secret。");
    if (changePw && (pw1 === "" || pw1 !== pw2)) return setError("两次输入的新口令不一致。");
    if (!wantCreds && !changePw) return setError("没有要更改的内容。");
    setBusy(true);
    try {
      const r = await api.rotateServerS3Peer({
        url,
        accessKeyId: wantCreds ? ak.trim() : undefined,
        secretAccessKey: wantCreds ? sk.trim() : undefined,
        newPassphrase: changePw ? pw1 : undefined,
      });
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Modal
        title="轮换完成"
        footer={<button class="btn btn-primary" onClick={onDone}>完成</button>}
      >
        <div class="set-callout ok">
          {result.rotatedCredentials && <div>✓ 存储密钥已更换 — 现在可以到服务商控制台停用旧密钥了。</div>}
          {result.rotatedPassphrase && <div>✓ 口令已更换 — 已配置设备无需重输，只有新加入的设备需要新口令。</div>}
          {!result.sync.ok && <div>⚠️ 轮换后的首次同步失败：{result.sync.error}（凭据已保存，稍后可在同步页重试）</div>}
        </div>
        <div class="set-hint">
          其他设备用下面的新接入码重新接入（数据与同步进度不受影响）。丢失设备此前已同步的数据无法远程抹除；它只是无法再获取之后的数据。
        </div>
        <div class="enroll-cmd">
          <code>{result.enroll}</code>
          <button
            class="btn btn-secondary"
            onClick={() => { navigator.clipboard?.writeText(result.enroll); toast("已复制"); }}
          >
            复制
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="轮换存储密钥"
      sub="适用于「手机丢了 / 密钥泄露 / 想换口令」。"
      footer={
        <>
          <button class="btn btn-secondary" onClick={closeModal} disabled={busy}>取消</button>
          <button class="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? "轮换中…" : "开始轮换"}
          </button>
        </>
      }
    >
      <div class="set-callout warn">
        请先在存储服务商控制台<b>新建</b>一把 Access Key——<b>先不要删除旧的</b>，完成后再停用。
        中途任何失败，旧钥匙都还能用；重试即可续接。
      </div>
      {buckets.length > 1 && (
        <>
          <div class="field-label">存储桶</div>
          <select class="text-input" value={url} onChange={(e) => setUrl((e.target as HTMLSelectElement).value)}>
            {buckets.map((b) => (
              <option value={b.url}>{b.label || b.bucket || b.url}</option>
            ))}
          </select>
        </>
      )}
      <div class="field-label">新 Access Key ID（留空 = 不更换密钥）</div>
      <input
        class="text-input"
        value={ak}
        autocomplete="off"
        onInput={(e) => setAk((e.target as HTMLInputElement).value)}
      />
      <div class="field-label">新 Secret Access Key</div>
      <input
        class="text-input"
        type="password"
        value={sk}
        autocomplete="new-password"
        onInput={(e) => setSk((e.target as HTMLInputElement).value)}
      />
      {bucket?.encrypt !== false && (
        <>
          <label class="set-check-row" style={{ marginTop: 14 }}>
            <input
              type="checkbox"
              checked={changePw}
              onChange={(e) => setChangePw((e.target as HTMLInputElement).checked)}
            />
            <span>同时更换加密口令（不会重新加密历史数据；已配置设备无需重输）</span>
          </label>
          {changePw && (
            <>
              <div class="field-label">新口令</div>
              <input
                class="text-input"
                type="password"
                value={pw1}
                autocomplete="new-password"
                onInput={(e) => setPw1((e.target as HTMLInputElement).value)}
              />
              <div class="field-label">再输一次确认</div>
              <input
                class="text-input"
                type="password"
                value={pw2}
                autocomplete="new-password"
                onInput={(e) => setPw2((e.target as HTMLInputElement).value)}
              />
            </>
          )}
        </>
      )}
      {error && <div class="set-callout warn">{error}</div>}
    </Modal>
  );
}

/** Printable master-key recovery card (GET /api/peer/s3/recovery). */
export function RecoveryCodeModal({ buckets }: { buckets: S3Peer[] }) {
  const encrypted = buckets.filter((b) => b.encrypt !== false);
  const [url, setUrl] = useState(encrypted[0]?.url ?? "");
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    setCode(null);
    setError(null);
    api.serverS3Recovery(url).then((r) => setCode(r.code)).catch((e) => setError((e as Error).message));
  }, [url]);
  const bucket = encrypted.find((b) => b.url === url);
  return (
    <Modal
      title="导出恢复码"
      footer={
        <>
          <button class="btn btn-secondary" onClick={closeModal}>关闭</button>
          <button class="btn btn-primary" disabled={code == null} onClick={() => window.print()}>
            打印
          </button>
        </>
      }
    >
      {encrypted.length === 0 ? (
        <div class="set-hint">没有加密的存储桶，无需恢复码。</div>
      ) : (
        <>
          {encrypted.length > 1 && (
            <>
              <div class="field-label">存储桶</div>
              <select class="text-input" value={url} onChange={(e) => setUrl((e.target as HTMLSelectElement).value)}>
                {encrypted.map((b) => (
                  <option value={b.url}>{b.label || b.bucket || b.url}</option>
                ))}
              </select>
            </>
          )}
          {error ? (
            <div class="set-callout warn">{error}</div>
          ) : code == null ? (
            <div class="muted">生成中…</div>
          ) : (
            <div class="recovery-card">
              <div class="recovery-card-title">Metahub 恢复码</div>
              <div class="recovery-card-meta">
                存储桶 {bucket?.bucket || url} · 生成于 {new Date().toLocaleDateString()}
              </div>
              <div class="recovery-card-code">
                {code.split("-").slice(1).map((g, i) => (
                  <span key={i} class="recovery-group">{g}</span>
                ))}
              </div>
              <div class="recovery-card-note">
                这串代码等于你全部数据的钥匙。忘记加密口令时，凭它可恢复数据并设置新口令。
                请打印或抄写，放在安全的地方；<b>不要</b>保存在会被同步的笔记里。
                任何拿到它的人都能读取你的全部数据。
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// PairingCodeModal + AddPeerModal folded into AddDeviceModal's 「高级:服务器配对」
// tab (PairCodeView + ServerPairing).

/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import {
  api,
  notifySharesChanged,
  type ShareListItem,
  type ShareCreateResult,
} from "./api.ts";
import type { ShareTarget } from "./share-modal.tsx";
import type { Scope } from "./data/scopes.ts";
import { shareTargetUrl } from "./data/share-targets.ts";
import { isNoOrigin } from "./data/replica.ts";
import { Modal, MenuItem, openMenu } from "./ui.tsx";
import { Icon } from "./icons.tsx";
import { t } from "./i18n/t.ts";
import { fmtDate } from "./i18n/fmt.ts";
import {
  objectShareExpiry,
  objectShareExpiryOptions,
  objectShareState,
} from "./object-share-model.ts";

export function ObjectShareDialog({
  target,
  targets,
  onClose,
}: {
  target: ShareTarget;
  targets: Scope[];
  onClose: () => void;
}) {
  const [shares, setShares] = useState<ShareListItem[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [selectedId, setSelectedId] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [destination, setDestination] = useState("");
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [duration, setDuration] = useState<number | null>(null);
  const [password, setPassword] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<"refresh" | "revoke" | null>(
    null,
  );
  const [copyFailed, setCopyFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState<{ slug: string; url: string } | null>(null);
  const focusPrimary = useRef(false);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const usableTargets = targets.filter(
    (item) => item.kind === "bucket" || !isNoOrigin(),
  );
  const host =
    usableTargets.find((item) => item.id === destination) ?? usableTargets[0];
  const snapshot = host?.kind === "bucket";
  const effectiveDuration = objectShareExpiry(snapshot, duration);
  const selected = shares.find((item) => item.slug === selectedId) ?? shares[0];
  const form = creating || (loadState === "ready" && !selected);
  const shareUrl = (item: ShareListItem) =>
    objectShareState(item) === "active"
      ? link?.slug === item.slug
        ? link.url
        : item.url
      : undefined;
  const resetFeedback = () => {
    setError("");
    setNotice("");
    setCopied(false);
    setCopyFailed(false);
  };

  const load = async (initial = false) => {
    try {
      const rows = await api.listShares({ target: target.ref });
      if (!alive.current) return;
      setShares(rows);
      setLoadState("ready");
    } catch (e) {
      if (!alive.current) return;
      if (initial) setLoadState("error");
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    alive.current = true;
    void load(true);
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (focusPrimary.current && !busy) {
      primaryRef.current?.focus();
      focusPrimary.current = false;
    }
  }, [form, busy, confirmation]);

  const beginCreate = (previous?: ShareListItem) => {
    resetFeedback();
    setCreating(true);
    setPermission(previous?.permission === "edit" ? "edit" : "view");
    setPassword("");
    setDuration(previous?.expiresAt != null ? 86_400_000 : null);
    const hostingContext = previous ?? selected;
    const sameHost =
      hostingContext &&
      usableTargets.find(
        (item) =>
          shareTargetUrl(item, location.origin) === hostingContext.sourceUrl,
      );
    setDestination(
      sameHost?.id ??
        (hostingContext?.transport === "s3"
          ? usableTargets.find((item) => item.kind === "bucket")?.id
          : host?.id) ??
        "",
    );
    setAdvanced(!!previous?.hasPassword);
    if (previous?.hasPassword)
      setNotice(t("原口令无法恢复，请为新链接重新设置口令。"));
  };
  const copyUrl = async (slug: string, value: string) => {
    setLink({ slug, url: value });
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopyFailed(true);
      setNotice(t("链接已准备好。自动复制失败，请选中下方地址手动复制。"));
    }
  };
  const saveResult = (result: ShareCreateResult, previous?: ShareListItem) => {
    const record: ShareListItem = {
      ...previous,
      ...result,
      target_id: target.ref,
      title: target.title ?? target.ref,
      sourceKind: result.transport === "s3" ? "bucket" : "server",
      sourceUrl:
        previous?.sourceUrl ??
        (host
          ? (shareTargetUrl(host, location.origin) ?? undefined)
          : undefined),
      hasPassword: previous?.hasPassword ?? !!password,
      contentUpdatedAt:
        result.transport === "s3"
          ? (previous?.contentUpdatedAt ?? Date.now())
          : undefined,
      lifecycle: "active",
    };
    setShares((rows) => [
      record,
      ...rows.filter((item) => item.slug !== result.slug),
    ]);
    setSelectedId(result.slug);
    setCreating(false);
    setConfirmation(null);
    focusPrimary.current = true;
    notifySharesChanged();
  };
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    resetFeedback();
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const create = () =>
    run(async () => {
      if (!host) return;
      const result = await api.createShare({
        kind: target.kind,
        ref: target.ref,
        transport: snapshot ? "s3" : "server",
        hosting: "server",
        permission: snapshot ? "view" : permission,
        password: password || null,
        expiresMs: effectiveDuration,
        server: snapshot ? null : shareTargetUrl(host, location.origin),
        bucketUrl: snapshot ? shareTargetUrl(host, location.origin) : null,
        grants: null,
      });
      saveResult(result);
      setPassword("");
      await copyUrl(result.slug, result.url);
      await load();
    });
  const copyCurrent = (item: ShareListItem) =>
    run(async () => {
      setSelectedId(item.slug);
      const selected = item;
      const url = shareUrl(item);
      if (selected.transport === "s3" && !url) {
        const result = await api.renewShare(selected.slug);
        saveResult(result, selected);
        await copyUrl(result.slug, result.url);
        await load();
      } else if (url) await copyUrl(selected.slug, url);
    });
  const refreshSnapshot = () =>
    run(async () => {
      if (!selected) return;

      const result = await api.renewShare(selected.slug, {
        refreshContent: true,
      });
      saveResult(result, { ...selected, contentUpdatedAt: Date.now() });
      await copyUrl(result.slug, result.url);
      await load();
    });
  const renew = (selected: ShareListItem) =>
    run(async () => {
      setSelectedId(selected.slug);
      const result = await api.renewShare(selected.slug);
      saveResult(result, selected);
      await copyUrl(result.slug, result.url);
      await load();
    });
  const revoke = () =>
    run(async () => {
      if (!selected) return;

      const result = await api.revokeShare(selected.slug, selected.sourceUrl);
      setLink(null);
      setConfirmation(null);
      focusPrimary.current = true;
      if (result.status === "cleanup_pending") {
        setShares((rows) =>
          rows.map((row) =>
            row.slug === selected.slug
              ? { ...row, lifecycle: "cleanup_pending" }
              : row,
          ),
        );
        setNotice(t("撤销已提交，等待托管端确认。"));
      } else {
        setShares((rows) => rows.filter((row) => row.slug !== selected.slug));
        setNotice(t("链接已撤销。"));
      }
      notifySharesChanged();
      await load();
    });

  const ask = (action: "refresh" | "revoke") => {
    resetFeedback();
    setConfirmation(action);
    focusPrimary.current = true;
  };
  return (
    <Modal
      title={
        confirmation === "revoke"
          ? t("撤销这个分享？")
          : confirmation === "refresh"
            ? t("更新快照内容并续期？")
            : form
              ? t("创建分享链接")
              : t("分享")
      }
      sub={target.title}
      width={560}
      onClose={onClose}
      footer={
        confirmation ? (
          <>
            <button
              class="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                setConfirmation(null);
                resetFeedback();
                focusPrimary.current = true;
              }}
            >
              {t("取消")}
            </button>
            <button
              ref={primaryRef}
              class={
                "btn " +
                (confirmation === "revoke" ? "btn-danger" : "btn-primary")
              }
              disabled={busy}
              onClick={confirmation === "revoke" ? revoke : refreshSnapshot}
            >
              {busy
                ? t("处理中…")
                : confirmation === "revoke"
                  ? t("撤销链接")
                  : t("更新内容并续期")}
            </button>
          </>
        ) : loadState === "ready" ? (
          <>
            {form ? (
              <button
                class="btn btn-ghost"
                disabled={busy}
                onClick={() => {
                  if (selected) {
                    setCreating(false);
                    resetFeedback();
                  } else onClose();
                }}
              >
                {t("取消")}
              </button>
            ) : (
              <button
                ref={primaryRef}
                class="share-secondary"
                disabled={busy}
                onClick={() => beginCreate()}
              >
                <Icon name="plus" cls="ico sm" />
                {t("新建链接")}
              </button>
            )}
            {form && (
              <button
                ref={primaryRef}
                class="btn btn-primary"
                disabled={busy || !host}
                onClick={create}
              >
                <Icon name="link" cls="ico sm" />
                {busy ? t("处理中…") : t("创建并复制链接")}
              </button>
            )}
          </>
        ) : undefined
      }
    >
      <div class="share-dialog" aria-busy={busy}>
        {confirmation ? (
          <p class="share-explanation">
            {confirmation === "revoke"
              ? t("链接立即失效，接收者将无法再打开。")
              : t(
                  "将用当前最新数据覆盖这份快照，接收者会看到更新后的版本；同时生成新的访问链接。",
                )}
          </p>
        ) : loadState === "loading" ? (
          <div
            class="share-loading"
            role="status"
            aria-label={t("正在加载分享链接…")}
          >
            <span />
            <span />
            <span />
          </div>
        ) : loadState === "error" ? (
          <div class="share-load-error">
            <p>{t("无法加载分享状态。请重试后再操作。")}</p>
            <button
              class="btn btn-secondary"
              onClick={() => {
                setLoadState("loading");
                setError("");
                void load(true);
              }}
            >
              {t("重试")}
            </button>
          </div>
        ) : form ? (
          <>
            <section class="share-host" aria-label={t("托管位置")}>
              <label class="share-host-label" for="share-host-destination">
                {t("托管位置")}
              </label>
              <div class="share-host-control">
                <Icon name={snapshot ? "bucket" : "server"} />
                <select
                  id="share-host-destination"
                  value={host?.id ?? ""}
                  disabled={busy || !host}
                  onChange={(e) => {
                    const next = usableTargets.find(
                      (item) => item.id === e.currentTarget.value,
                    );
                    setDestination(e.currentTarget.value);
                    if (next?.kind === "bucket") setPermission("view");
                    setDuration(
                      objectShareExpiry(next?.kind === "bucket", duration),
                    );
                    resetFeedback();
                  }}
                >
                  {!host && <option value="">{t("暂无可用的托管位置")}</option>}
                  <optgroup label={t("设备与服务器")}>
                    {usableTargets
                      .filter((item) => item.kind !== "bucket")
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                          {item.subtitle && item.subtitle !== item.label
                            ? ` · ${item.subtitle}`
                            : ""}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label={t("存储桶")}>
                    {usableTargets
                      .filter((item) => item.kind === "bucket")
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.subtitle || item.label}
                        </option>
                      ))}
                  </optgroup>
                </select>
              </div>
              {host && (
                <div class="share-host-behavior" aria-live="polite">
                  <strong>
                    {snapshot
                      ? t("存储桶托管 · 固定快照")
                      : t("设备托管 · 实时内容")}
                  </strong>
                  <p>
                    {snapshot
                      ? t(
                          "本机离线也可访问。内容固定为创建时的版本，后续修改需手动更新快照。",
                        )
                      : t(
                          "由所选设备提供访问，需保持在线。接收者看到最新内容。",
                        )}
                  </p>
                </div>
              )}
            </section>
            <div class="share-settings">
              <label class="share-setting">
                <span>{t("访问权限")}</span>
                <select
                  value={snapshot ? "view" : permission}
                  disabled={snapshot || busy}
                  onChange={(e) =>
                    setPermission(e.currentTarget.value as "view" | "edit")
                  }
                >
                  <option value="view">{t("可以查看")}</option>
                  <option value="edit">{t("可以编辑")}</option>
                </select>
              </label>
              <label class="share-setting">
                <span>{t("链接有效期")}</span>
                <select
                  value={
                    effectiveDuration == null
                      ? "never"
                      : String(effectiveDuration)
                  }
                  onChange={(e) =>
                    setDuration(
                      e.currentTarget.value === "never"
                        ? null
                        : Number(e.currentTarget.value),
                    )
                  }
                >
                  {objectShareExpiryOptions(snapshot).map((option) => (
                    <option
                      key={String(option.ms)}
                      value={option.ms == null ? "never" : String(option.ms)}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <details
              class="share-details"
              open={advanced}
              onToggle={(e) => setAdvanced(e.currentTarget.open)}
            >
              <summary>
                {t("更多设置")}
                <span>{password ? t("已设口令") : t("设置访问口令")}</span>
              </summary>
              <div>
                <label class="share-setting">
                  <span>{t("访问口令")}</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder={t("可选")}
                    value={password}
                    onInput={(e) => setPassword(e.currentTarget.value)}
                  />
                </label>
              </div>
            </details>
            {!host && (
              <p class="share-message" role="status">
                {t("暂无可用的托管位置，请先在设置中连接存储桶或服务器。")}
              </p>
            )}
          </>
        ) : (
          <div class="share-list-section">
            <div class="share-list-heading">
              <span>{t("托管位置")}</span>
              <span>{shares.length}</span>
            </div>
            <ul class="share-link-list" aria-label={t("分享链接")}>
              {shares.map((item) => {
                const state = objectShareState(item);
                const url = shareUrl(item);
                const expanded = expandedId === item.slug;
                const isCopied = copied && link?.slug === item.slug;
                const activate = () => {
                  setSelectedId(item.slug);
                  if (state === "revoking") ask("revoke");
                  else if (state === "creating") void run(() => load());
                  else if (state === "expired" && item.transport !== "s3")
                    beginCreate(item);
                  else void copyCurrent(item);
                };
                return (
                  <li key={item.slug}>
                    <div class="share-link-row">
                      <Icon
                        name={item.transport === "s3" ? "bucket" : "server"}
                      />
                      <div class="share-link-info">
                        <button
                          class="share-link-name"
                          title={item.source}
                          disabled={busy}
                          aria-expanded={expanded}
                          aria-controls={`share-detail-${item.slug}`}
                          onClick={() =>
                            setExpandedId(expanded ? null : item.slug)
                          }
                        >
                          <span>{item.source}</span>
                          <Icon
                            name={expanded ? "chevronDown" : "chevron"}
                            cls="ico sm"
                          />
                        </button>
                        <div class="share-link-meta">
                          <span>
                            {item.permission === "edit"
                              ? t("可以编辑")
                              : t("可以查看")}
                          </span>
                          <span>
                            {state === "expired"
                              ? t("已过期")
                              : state === "revoking"
                                ? t("正在撤销访问")
                                : state === "creating"
                                  ? t("链接正在创建")
                                  : item.expiresAt
                                    ? t("{date} 到期", {
                                        date: fmtDate(item.expiresAt, "date"),
                                      })
                                    : t("永不过期")}
                          </span>
                          {item.hasPassword && <span>{t("已设口令")}</span>}
                        </div>
                        {state === "revoking" && (
                          <p class="share-link-warning">
                            {t("托管端尚未确认，链接可能仍可访问。")}
                          </p>
                        )}
                      </div>
                      <div class="share-link-actions">
                        <button
                          class="btn btn-secondary"
                          disabled={busy}
                          onClick={activate}
                        >
                          {busy && selectedId === item.slug
                            ? t("处理中…")
                            : isCopied
                              ? t("已复制链接")
                              : state === "revoking"
                                ? t("重试撤销")
                                : state === "creating"
                                  ? t("刷新状态")
                                  : state === "expired"
                                    ? item.transport === "s3"
                                      ? t("续期并复制链接")
                                      : t("重新创建链接")
                                    : t("复制链接")}
                        </button>
                        <button
                          class="iconbtn"
                          disabled={busy}
                          aria-label={t("管理此链接")}
                          title={t("管理此链接")}
                          onClick={(e) => {
                            setSelectedId(item.slug);
                            openMenu(e as unknown as MouseEvent, (close) => (
                              <>
                                <MenuItem
                                  label={t("链接详情")}
                                  onClick={() => {
                                    close();
                                    setExpandedId(expanded ? null : item.slug);
                                  }}
                                />
                                {state !== "revoking" &&
                                  state !== "creating" &&
                                  item.transport === "s3" && (
                                    <>
                                      <MenuItem
                                        label={t("更新快照内容")}
                                        sublabel={t(
                                          "替换为最新版本，并延长链接有效期",
                                        )}
                                        onClick={() => {
                                          close();
                                          ask("refresh");
                                        }}
                                      />
                                      <MenuItem
                                        label={t("仅延长有效期")}
                                        sublabel={t("保留当前快照内容")}
                                        onClick={() => {
                                          close();
                                          void renew(item);
                                        }}
                                      />
                                    </>
                                  )}
                                {url && (
                                  <MenuItem
                                    label={t("打开链接")}
                                    onClick={() => {
                                      close();
                                      window.open(
                                        url,
                                        "_blank",
                                        "noopener,noreferrer",
                                      );
                                    }}
                                  />
                                )}
                                <MenuItem
                                  label={t("撤销链接")}
                                  danger
                                  onClick={() => {
                                    close();
                                    ask("revoke");
                                  }}
                                />
                              </>
                            ));
                          }}
                        >
                          <Icon name="dots" cls="ico sm" />
                        </button>
                      </div>
                    </div>
                    <div
                      id={`share-detail-${item.slug}`}
                      hidden={!expanded}
                      class="share-link-detail"
                    >
                      <p>
                        {item.transport === "s3"
                          ? t(
                              "本机离线也可访问。内容固定为创建时的版本，后续修改需手动更新快照。",
                            )
                          : t(
                              "由所选设备提供访问，需保持在线。接收者看到最新内容。",
                            )}
                      </p>
                      <dl class="share-facts">
                        <div>
                          <dt>{t("访问口令")}</dt>
                          <dd>
                            {item.hasPassword ? t("已设置") : t("未设置")}
                          </dd>
                        </div>
                        {item.expiresAt && (
                          <div>
                            <dt>{t("有效期")}</dt>
                            <dd>{fmtDate(item.expiresAt, "dateTime")}</dd>
                          </div>
                        )}
                        {item.contentUpdatedAt && (
                          <div>
                            <dt>{t("快照时间")}</dt>
                            <dd>
                              {fmtDate(item.contentUpdatedAt, "dateTime")}
                            </dd>
                          </div>
                        )}
                      </dl>
                      {expanded && url && (
                        <input
                          class="share-url"
                          aria-label={t("分享链接")}
                          readOnly
                          value={url}
                          onFocus={(e) => e.currentTarget.select()}
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {error && (
          <p class="share-message error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p class="share-message" role="status">
            {notice}
          </p>
        )}
        {copyFailed && link && (
          <input
            class="share-url"
            aria-label={t("分享链接")}
            readOnly
            value={link.url}
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
        {copied && (
          <span class="share-sr-status" role="status">
            {t("链接已复制")}
          </span>
        )}
      </div>
    </Modal>
  );
}

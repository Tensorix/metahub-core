// Standalone Expo entry for the native offline gate. Uses an isolated fixture DB.
import { registerRootComponent } from "expo";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { WebView } from "react-native-webview";
import { openMobileReplica } from "../../src/lib/replica/open";
import { initializeNativeSyncRuntime } from "../../src/lib/sync/runtime";
import { Platform } from "react-native";
import {
  createSite,
  getSiteByName,
  writeFileRow,
} from "../../../../src/core/sites-core";
import { serveLocalSite } from "../../src/lib/site/gateway";
import { listenSite } from "../../src/lib/site/listener";
import { siteSdk } from "../../src/lib/site/sdk-bundle";

const html =
  '<img id="icon" src="pixel.svg"><script type="module" src="./main.js"></script>';
const script = `
import {api} from "/metahub-sdk.js";
try {
  await api.listDatabases();
  await document.querySelector("img").decode();
  const r = await fetch("/api/documents", {method:"POST",headers:{"Content-Type":"application/json"}, body:JSON.stringify({title:"Native offline smoke",body:"ok"})});
  if (!r.ok) throw Error(await r.text());
  window.ReactNativeWebView.postMessage((await r.json()).id);
} catch (err) {window.ReactNativeWebView.postMessage("FAIL " + err);}
`;
function Smoke() {
  const [url, setUrl] = useState("");
  const [report, setReport] = useState("Starting");
  useEffect(() => {
    let active = true;
    let cleanup: (() => void) | undefined;
    void initializeNativeSyncRuntime()
      .then(async () => {
        if (!active) return;
        const replica = openMobileReplica("site-smoke", {
          platform: Platform.OS === "ios" ? "ios" : "android",
        });
        const site =
          getSiteByName(replica.db, "smoke") ??
          createSite(replica.db, { name: "smoke" });
        writeFileRow(
          replica.db,
          site.id,
          "index.html",
          "text/html",
          "utf8",
          html,
        );
        writeFileRow(
          replica.db,
          site.id,
          "main.js",
          "text/javascript",
          "utf8",
          script,
        );
        writeFileRow(
          replica.db,
          site.id,
          "pixel.svg",
          "image/svg+xml",
          "utf8",
          '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>',
        );
        const pending = listenSite(
          "/sites/smoke/",
          () => active,
          (method, target, body) =>
            serveLocalSite(
              replica.service,
              site.id,
              method,
              target,
              body,
              siteSdk,
              () => null,
            ),
        );
        const server = await pending;
        cleanup = () => {
          server.close();
          replica.close();
        };
        if (active) setUrl(server.url);
        else cleanup();
      })
      .catch((err) => {
        if (active) setReport(String(err));
      });
    return () => {
      active = false;
      cleanup?.();
    };
  }, []);
  return (
    <>
      <Text accessibilityLabel={report}>{report}</Text>
      {url && (
        <WebView
          source={{ uri: url }}
          onMessage={(e) => {
            const result = e.nativeEvent.data;
            setReport(result.startsWith("doc_") ? "SITE SMOKE PASS" : result);
          }}
        />
      )}
    </>
  );
}
registerRootComponent(Smoke);

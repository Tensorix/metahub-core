import { useCallback, useState } from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import { Alert, ScrollView, Text, View } from "react-native";
import { Switch } from "@expo/ui";
import { NativeHost } from "@/components/native/NativeHost";
import { ManagementAction, ManagementInput, ManagementSection } from "@/components/ManagementControls";
import { useSession } from "@/lib/auth/session";
import { useApiData, useLiveInvalidate } from "@/lib/api/hooks";
import { useFormExit } from "@/lib/browse/form-exit";
import { useTheme } from "@/lib/theme";
import { getSite, isSitePublic, listFiles, type SiteRow } from "../../../../../../src/core/sites-core";
import { listSiteChannelRows } from "../../../../../../src/core/site-channel-store";
import { safeSiteUrl } from "@/lib/navigation/sites";

export default function SiteConfiguration() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  const { tokens } = useTheme();
  const fetch = useCallback(async () => ({
    site: getSite(session.replica.db, id),
    files: listFiles(session.replica.db, id),
    channels: listSiteChannelRows(session.replica.db, id),
  }), [session, id]);
  const data = useApiData(fetch);
  useLiveInvalidate(["sites", "site_files", "site_channels"], () => void data.refetch());
  return (
    <ScrollView style={{ flex: 1, backgroundColor: tokens.bg }} contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: 40 }}>
      <Stack.Screen options={{ title: "站点配置" }} />
      {data.data?.site ? <>
        <SiteForm key={id} site={data.data.site} />
        <ManagementSection title="访问与发布">
          <Text style={{ color: tokens.fgSoft }}>{isSitePublic(data.data.site) ? "站点公开访问已开启" : "私有站点 · 仅你和已配对设备可预览"}</Text>
          <Text style={{ color: tokens.muted }}>发布渠道独立控制访问权限；以下为已同步的渠道配置，不代表当前在线状态。</Text>
          {data.data.channels.length ? data.data.channels.map(channel => <View key={channel.id} style={{ gap: 4, paddingVertical: 8 }}>
            <Text style={{ color: tokens.fg }}>{channel.hosting === "edge" ? "云端托管" : "设备托管"} · {channel.audience === "public" ? "公开" : "持链接访问"} · {channel.desired_state === "active" ? "启用" : "已撤销"}</Text>
            <Text selectable style={{ color: tokens.fgSoft }}>{safeSiteUrl(channel.canonical_url) ?? "尚无可用地址"}</Text>
          </View>) : <Text style={{ color: tokens.muted }}>暂无发布渠道</Text>}
        </ManagementSection>
        <ManagementSection title={`站点文件 · ${data.data.files.length}`}>
          {data.data.files.map(file => <View key={file.id} style={{ gap: 4, paddingVertical: 8 }}>
            <Text selectable style={{ color: tokens.fg }}>{file.path}</Text>
            <Text style={{ color: tokens.muted }}>{file.content_type} · {file.size == null ? "大小未知" : `${file.size} B`}</Text>
          </View>)}
          {!data.data.files.length && <Text style={{ color: tokens.muted }}>暂无文件</Text>}
        </ManagementSection>
      </> : <Text style={{ color: tokens.muted }}>{data.loading ? "加载中…" : "站点不存在或已删除"}</Text>}
      {data.error && <>
        <Text accessibilityRole="alert" style={{ color: tokens.danger }}>{data.error.message}</Text>
        <ManagementAction label="重试加载" onPress={() => void data.refetch()} />
      </>}
    </ScrollView>
  );
}

function SiteForm({ site }: { site: SiteRow }) {
  const session = useSession();
  const { tokens } = useTheme();
  const [draft, setDraft] = useState<{ title?: string; name?: string; spa?: boolean }>({});
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const title = draft.title ?? site.title ?? "";
  const name = draft.name ?? site.name;
  const spa = draft.spa ?? (site.spa === 1);
  const dirty = title !== (site.title ?? "") || name !== site.name || spa !== (site.spa === 1);
  useFormExit(() => ({ pending: false, dirty, revision }));
  const edit = (patch: typeof draft) => {
    setDraft(previous => ({ ...previous, ...patch }));
    setRevision(value => value + 1);
    setError("");
  };
  const save = () => {
    if (!session.isCurrent()) return;
    try {
      // Only write edited fields, preserving unrelated changes from other devices.
      session.replica.service.dispatch("updateSiteConfiguration", [site.id, draft]);
      setDraft({});
      setRevision(value => value + 1);
      setError("");
      Alert.alert("已保存", "配置已保存到本机，将随工作区同步。");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return <ManagementSection title="基本配置">
    <ManagementInput label="站点标题" value={title} onChange={value => edit({ title: value })} />
    <ManagementInput label="站点路径（slug）" value={name} onChange={value => edit({ name: value })} />
    <Text style={{ color: tokens.muted }}>修改路径后，原来的 /sites/{site.name}/ 地址将失效。</Text>
    <NativeHost matchContents={{ vertical: true }} style={{ minHeight: 48 }}>
      <Switch label="SPA 模式" value={spa} onValueChange={value => edit({ spa: value })} />
    </NativeHost>
    <Text style={{ color: tokens.muted }}>开启后，无扩展名的页面路径会回落到 index.html，适用于单页应用。</Text>
    <Text selectable style={{ color: tokens.muted }}>ID：{site.id}</Text>
    {error ? <Text accessibilityRole="alert" style={{ color: tokens.danger }}>{error}</Text> : null}
    <ManagementAction label="保存配置" disabled={!dirty || !name.trim()} onPress={() => {
      if (name !== site.name) Alert.alert("修改站点路径？", "旧链接将失效，已分发的地址需要更新。", [
        { text: "取消", style: "cancel" }, { text: "保存", onPress: save },
      ]);
      else save();
    }} />
  </ManagementSection>;
}

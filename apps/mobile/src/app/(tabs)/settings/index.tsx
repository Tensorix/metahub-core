import { useState } from "react";
import { Platform } from "react-native";
import { Stack, useRouter, type Href } from "expo-router";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsRow } from "@/components/settings/SettingsRow";
import { NativeHost } from "@/components/native/NativeHost";
import { SectionSearch } from "@/components/native/SectionSearch";
import { SettingsForm } from "@/components/settings/SettingsForm";
import { EmptyState } from "@/components/EmptyState";
import { useTheme } from "@/lib/theme";
import { useSession } from "@/lib/auth/session";

type Option = { title: string; route?: Href };
type Entry = { title: string; icon: string; route: Href; value?: string; options: Option[] };

export default function SettingsIndex() {
  const router = useRouter();
  const { pref, dynamicAvailable } = useTheme();
  const { creds } = useSession();
  const [query, setQuery] = useState("");
  const sections: { title: string; entries: Entry[] }[] = [
    { title: "此设备", entries: [
      { title: "外观", icon: "sun.max", route: "/settings/appearance",
        value: { system: "跟随系统", light: "浅色", dark: "深色" }[pref],
        options: ["跟随系统", "浅色", "深色", ...(dynamicAvailable ? ["跟随系统壁纸（Material You）"] : [])].map(title => ({ title })) },
      { title: "离线与缓存", icon: "internaldrive", route: "/settings/offline", options: [
        { title: "清理未固定的下载副本" }, { title: "管理附件", route: "/settings/attachments" },
      ] },
    ] },
    { title: "工作区", entries: [
      { title: "当前工作区", icon: "folder", route: "/settings/workspace",
        value: creds.bucket?.bucket ?? creds.baseUrl, options: [
          { title: "添加服务器或存储桶", route: "/add-server" }, { title: "服务端版本" },
          { title: "更新连接凭据", route: "/settings/credentials" }, { title: "断开连接" },
        ] },
      { title: "数据与同步", icon: "arrow.triangle.2.circlepath", route: "/settings/sync",
        options: [
          ...["本地保存", "数据同步", "附件传输", "立即同步数据", "重试全部待上传"].map(title => ({ title })),
          ...(creds.bucket ? [{ title: "同步升级与编辑恢复", route: "/settings/recovery" as const }] : []),
        ] },
    ] },
    { title: "应用", entries: [
      { title: "关于", icon: "info.circle", route: "/settings/about",
        options: ["App 版本", ...(!creds.bucket ? ["Core 版本"] : []), "GitHub 仓库", "更新日志"].map(title => ({ title })) },
    ] },
  ];

  function list(search = "", close?: () => void) {
    const needle = search.trim().toLowerCase();
    const matches = (text: string) => text.toLowerCase().includes(needle);
    const groups = sections.map(section => ({
      title: section.title,
      rows: section.entries.flatMap(entry => {
        if (!needle || matches(section.title) || matches(entry.title)) return [entry];
        return entry.options.filter(option => matches(option.title)).map(option => ({
          ...entry, title: option.title, value: entry.title, route: option.route ?? entry.route,
        }));
      }),
    })).filter(group => group.rows.length);
    if (!groups.length) return <EmptyState title="没有匹配的设置项" hint="试试其他关键词" />;
    return <NativeHost style={{ flex: 1 }}><SettingsForm>
      {groups.map(group => <SettingsSection key={group.title} title={group.title}>
        {group.rows.map(row => <SettingsRow key={row.title} icon={row.icon} title={row.title} value={row.value}
          onPress={() => { close?.(); router.push(row.route); }} />)}
      </SettingsSection>)}
    </SettingsForm></NativeHost>;
  }

  return <>
    {Platform.OS === "android" && <>
      <Stack.Screen options={{ headerShown: false }} />
      <SectionSearch placeholder="搜索设置" value={query} onChangeText={setQuery}>
        {close => list(query, close)}
      </SectionSearch>
    </>}
    {list()}
  </>;
}

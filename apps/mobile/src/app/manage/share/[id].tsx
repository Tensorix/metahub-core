import {
  type ComponentRef,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  ActivityIndicator,
  StyleSheet,
  Platform,
  ScrollView,
  Share,
  Text,
  View,
  findNodeHandle,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
import { useApiData } from "@/lib/api/hooks";
import { Picker } from "@expo/ui";
import { ShareAction } from "@/components/share-action";
import { NativeHost } from "@/components/native/NativeHost";
import { RecordTextInput } from "@/components/RecordTextInput";
import { fs, radii } from "@/lib/theme/tokens";
import { objectSharing, type ObjectShare } from "@/lib/object-sharing";
import { usePreventRemove } from "expo-router/react-navigation";

export default function ShareObject() {
  const { id, kind } = useLocalSearchParams<{ id: string; kind: string }>();
  const session = useSession(),
    { tokens } = useTheme();
  const service = useMemo(
    () => objectSharing(session, kind === "doc" ? "doc" : "database", id),
    [session, kind, id],
  );
  const fetch = useCallback(() => service.list(), [service]);
  const data = useApiData(fetch);
  const [password, setPassword] = useState(""),
    [days, setDays] = useState(7),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [created, setCreated] = useState<ObjectShare | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const running = useRef(false),
    anchor = useRef<ComponentRef<typeof View>>(null);
  usePreventRemove(busy, () =>
    Alert.alert("正在处理分享", "请等待当前操作完成。"),
  );
  const run = async (fn: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      if (session.isCurrent())
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const send = (item: ObjectShare, system: boolean) =>
    void run(async () => {
      const url = await service.url(item);
      if (!session.isCurrent()) return;
      if (system) {
        await Share.share(Platform.OS === "ios" ? { url } : { message: url }, {
          anchor: findNodeHandle(anchor.current) ?? undefined,
        });
      } else {
        await Clipboard.setStringAsync(url);
        setNotice("链接已复制");
      }
    });
  const rows = created
    ? [created, ...(data.data ?? []).filter((s) => s.slug !== created.slug)]
    : (data.data ?? []);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: tokens.bg }}
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: "分享", gestureEnabled: !busy }} />
      <View ref={anchor} collapsable={false}>
        <Text style={{ color: tokens.fg, fontSize: 22, fontWeight: "700" }}>
          分享{kind === "doc" ? "文档" : "数据表"}
        </Text>
      </View>
      <Text style={{ color: tokens.fgSoft, fontSize: fs.ui, lineHeight: 23 }}>
        {service.snapshot
          ? "生成只读快照链接；后续编辑不会自动更新已分享内容。"
          : "生成 Web 链接，接收者可以在浏览器打开。"}
        持有链接{password ? "并知道口令" : ""}的人可以访问。
      </Text>
      <ShareSection title="创建分享链接">
        <View style={{ gap: 8 }}>
          <Text style={{ color: tokens.fg, fontSize: fs.ui }}>
            访问口令（可选）
          </Text>
          <NativeHost
            matchContents={{ vertical: true }}
            style={{
              minHeight: 52,
              backgroundColor: tokens.surface2,
              borderRadius: radii.md,
            }}
          >
            <RecordTextInput
              accessibilityLabel="访问口令（可选）"
              secureTextEntry
              text={password}
              editable={!busy}
              onChangeText={setPassword}
              placeholder="未设置口令"
              style={{ padding: 14, width: "100%" }}
            />
          </NativeHost>
        </View>
        {!service.snapshot && (
          <View style={[styles.option, { borderColor: tokens.line }]}>
            <Text style={{ color: tokens.fg, fontSize: fs.body }}>
              访问权限
            </Text>
            <NativeHost matchContents style={{ minHeight: 48 }}>
              <Picker
                selectedValue={permission}
                onValueChange={setPermission}
                enabled={!busy}
              >
                <Picker.Item label="只读" value="view" />
                <Picker.Item label="可编辑" value="edit" />
              </Picker>
            </NativeHost>
          </View>
        )}
        <View style={[styles.option, { borderColor: tokens.line }]}>
          <Text style={{ color: tokens.fg, fontSize: fs.body }}>有效期</Text>
          <NativeHost matchContents style={{ minHeight: 48 }}>
            <Picker
              selectedValue={days}
              onValueChange={setDays}
              enabled={!busy}
            >
              <Picker.Item label="1 天" value={1} />
              <Picker.Item label="7 天" value={7} />
            </Picker>
          </NativeHost>
        </View>
        <ShareAction
          primary
          label={busy ? "处理中…" : "创建链接"}
          disabled={busy || data.loading || !!data.error}
          onPress={() =>
            void run(async () => {
              const item = await service.create(password, days, permission);
              if (!session.isCurrent()) return;
              setCreated(item);
              setPassword("");
              setNotice("链接已创建，可复制或系统分享");
              await data.refetch();
            })
          }
        />
      </ShareSection>
      {!!notice && (
        <Text
          role="status"
          style={{ color: tokens.success, fontSize: fs.ui, lineHeight: 22 }}
        >
          {notice}
        </Text>
      )}
      {!!(error || data.error) && (
        <Text
          accessibilityRole="alert"
          style={{ color: tokens.danger, fontSize: fs.ui, lineHeight: 22 }}
        >
          {error || String(data.error)}
        </Text>
      )}
      {data.loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={tokens.accent} />
          <Text style={{ color: tokens.muted }}>正在加载分享…</Text>
        </View>
      ) : null}
      {data.error ? (
        <ShareAction
          label="重试加载"
          disabled={busy}
          onPress={() => void data.refetch()}
        />
      ) : null}
      {!data.loading && !data.error && rows.length === 0 && (
        <Text style={{ color: tokens.fgSoft, fontSize: fs.ui, lineHeight: 23 }}>
          还没有分享链接
        </Text>
      )}
      {rows.map((item) => (
        <ShareSection
          key={item.slug}
          title={
            item.expiresAt && item.expiresAt < now ? "已过期链接" : "分享链接"
          }
        >
          <Text
            selectable
            style={{ color: tokens.fgSoft, fontSize: fs.sm, lineHeight: 20 }}
          >
            {item.expiresAt
              ? `有效期至 ${new Date(item.expiresAt).toLocaleString()}`
              : "长期有效"}
            {item.hasPassword ? " · 需要口令" : ""}
          </Text>
          <ShareAction
            label={service.snapshot ? "复制链接／续期" : "复制链接"}
            disabled={
              busy ||
              (!service.snapshot && !!item.expiresAt && item.expiresAt < now)
            }
            onPress={() => send(item, false)}
          />
          <ShareAction
            label="系统分享"
            disabled={
              busy ||
              (!service.snapshot && !!item.expiresAt && item.expiresAt < now)
            }
            onPress={() => send(item, true)}
          />
          <ShareAction
            danger
            label="撤销分享"
            disabled={busy}
            onPress={() =>
              Alert.alert("撤销分享？", "接收者将无法继续通过此链接访问。", [
                { text: "取消", style: "cancel" },
                {
                  text: "撤销",
                  style: "destructive",
                  onPress: () =>
                    void run(async () => {
                      await service.revoke(item);
                      if (!session.isCurrent()) return;
                      if (created?.slug === item.slug) setCreated(null);
                      await data.refetch();
                      setNotice("分享已撤销");
                    }),
                },
              ])
            }
          />
        </ShareSection>
      ))}
    </ScrollView>
  );
}

function ShareSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const { tokens } = useTheme();
  return (
    <View style={{ gap: 16, paddingTop: 12 }}>
      <Text
        accessibilityRole="header"
        style={{ color: tokens.fg, fontSize: 17, fontWeight: "600" }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}
const styles = StyleSheet.create({
  content: {
    padding: 20,
    paddingBottom: 48,
    gap: 20,
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
  },
  option: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  loading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
  },
});

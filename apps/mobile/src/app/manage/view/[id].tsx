import { NativeToolbarAction } from "@/components/native/NativeToolbarAction";
import { createMutationGate } from "@/lib/browse/form-guard";
import { useFormExit } from "@/lib/browse/form-exit";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState, useRef } from "react";
import { View, Text } from "react-native";
import { ViewSettingsSheet } from "@/components/ViewSettingsSheet";
import { ManagementAction } from "@/components/ManagementControls";
import { useApiData } from "@/lib/api/hooks";
import { useSession } from "@/lib/auth/session";
import { mergeView } from "@/lib/browse/management";
import { useTheme } from "@/lib/theme";
import {
  emptyView,
  normalizeViews,
  type ViewDef,
} from "../../../../../../src/shared/views/model.ts";
export default function ManageView() {
  const [saving, setSaving] = useState(false);
  const { id, viewId } = useLocalSearchParams<{ id: string; viewId: string }>(),
    router = useRouter(),
    session = useSession(),
    { client } = session,
    { tokens } = useTheme();
  const [gate] = useState(createMutationGate);
  const dirty = useRef(viewId === "new"),
    revision = useRef(0);
  const onDirtyChange = useCallback((value: boolean) => {
    dirty.current = value;
    revision.current++;
  }, []);
  const exit = useFormExit(() => ({
    pending: gate.isPending(),
    dirty: dirty.current,
    revision: revision.current,
  }));
  const fetch = useCallback(async () => {
    const [dbs, props] = await Promise.all([
      client.listDatabases(),
      client.listProperties(id),
    ]);
    const database = dbs.find((d) => d.id === id);
    if (!database) throw new Error("数据库不存在");
    const views = normalizeViews(database.meta?.views);
    return {
      database,
      props,
      views,
      view:
        viewId === "new"
          ? emptyView("table", "新视图")
          : views.find((v) => v.id === viewId),
    };
  }, [client, id, viewId]);
  const data = useApiData(fetch);
  const save = async (next: ViewDef) => {
    const release = gate.begin();
    if (!release) throw new Error("正在保存，请稍候");
    setSaving(true);
    try {
      const database = (await client.listDatabases()).find((d) => d.id === id);
      if (!database || !session.isCurrent())
        throw new Error("数据库已关闭，请重新打开");
      await client.updateDatabase(id, {
        meta: {
          views: mergeView(database.meta?.views, data.data?.views ?? [], next),
        },
      });
    } catch (error) {
      dirty.current = true;
      revision.current++;
      throw error;
    } finally {
      release();
      setSaving(false);
    }
  };
  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <Stack.Screen
        options={{
          title: "视图设置",
          gestureEnabled: false,
          headerBackVisible: false,
        }}
      />
      <NativeToolbarAction
        placement="left"
        tintColor={tokens.accent}
        label="取消"
        disabled={saving}
        onPress={() => exit(() => router.back())}
      />
      {data.data?.view ? (
        <ViewSettingsSheet
          view={data.data.view}
          props={data.data.props}
          onDirtyChange={onDirtyChange}
          onSaved={() => {
            dirty.current = false;
            revision.current++;
            exit(() => router.back());
          }}
          onClose={() => exit(() => router.back())}
          onSave={save}
        />
      ) : (
        <Text style={{ color: tokens.muted }}>
          {data.loading ? "加载中…" : "视图不存在"}
        </Text>
      )}
      {data.error ? (
        <>
          <Text
            selectable
            accessibilityRole="alert"
            style={{ color: tokens.danger }}
          >
            {String(data.error)}
          </Text>
          <ManagementAction label="重试" onPress={() => void data.refetch()} />
        </>
      ) : null}
    </View>
  );
}

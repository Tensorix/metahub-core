import { createMutationGate } from "@/lib/browse/form-guard";
import { useFormExit } from "@/lib/browse/form-exit";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ScrollView, Text } from "react-native";
import { DatabaseManageSheet } from "@/components/DatabaseManageSheet";
import {
  ManagementAction,
  ManagementInput,
} from "@/components/ManagementControls";
import { useApiData, useLiveInvalidate } from "@/lib/api/hooks";
import { useSession } from "@/lib/auth/session";
import { useTheme } from "@/lib/theme";
export default function ManageDatabase() {
  const { id } = useLocalSearchParams<{ id: string }>(),
    router = useRouter(),
    session = useSession(),
    { client } = session,
    { tokens } = useTheme();
  const [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [childBusy, setChildBusy] = useState(false);
  const createdId = useRef<string | null>(null);
  const latestName = useRef("");
  const childPending = useRef(false),
    childDirty = useRef(false),
    revision = useRef(0);
  const [gate] = useState(createMutationGate);
  const onChildBusy = useCallback((value: boolean) => {
    childPending.current = value;
    setChildBusy(value);
  }, []);
  const onChildDirty = useCallback((value: boolean) => {
    childDirty.current = value;
    revision.current++;
  }, []);
  const exit = useFormExit(() => ({
    pending: gate.isPending() || childPending.current,
    dirty:
      id === "new"
        ? !!latestName.current.trim() || createdId.current !== null
        : childDirty.current,
    revision: revision.current,
  }));
  const fetch = useCallback(async () => {
    if (id === "new") return null;
    const [dbs, props] = await Promise.all([
      client.listDatabases(),
      client.listProperties(id),
    ]);
    return {
      database: dbs.find((d) => d.id === id),
      props: props.slice().sort((a, b) => a.position - b.position),
    };
  }, [client, id]);
  const data = useApiData(fetch);
  useLiveInvalidate(["databases", "properties"], () => void data.refetch());
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        padding: 20,
        paddingBottom: 40,
        gap: 12,
        backgroundColor: tokens.bg,
      }}
    >
      <Stack.Screen
        options={{
          title: id === "new" ? "新建数据库" : "管理数据库",
          gestureEnabled: false,
          headerBackVisible: false,
        }}
      />
      <Stack.Toolbar placement="left" tintColor={tokens.accent}>
        <Stack.Toolbar.Button
          disabled={busy || childBusy}
          onPress={() => exit(() => router.back())}
        >
          关闭
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      {id === "new" ? (
        <>
          <ManagementInput
            disabled={busy}
            label="数据库名称"
            value={name}
            onChange={(text) => {
              latestName.current = text;
              revision.current++;
              setName(text);
            }}
          />
          <ManagementAction
            label={busy ? "创建中…" : "创建"}
            disabled={busy || !name.trim()}
            onPress={() => {
              const release = gate.begin();
              if (!release) return;
              const snapshot = latestName.current.trim();
              if (!snapshot) {
                release();
                return;
              }
              setBusy(true);
              setError("");
              void (async () => {
                const existing = createdId.current;
                const dbId =
                  existing ??
                  (await client.createDatabase({ name: snapshot })).id;
                createdId.current = dbId;
                if (existing)
                  await client.updateDatabase(dbId, { name: snapshot });
                if (!(await client.listProperties(dbId)).length)
                  await client.createProperty({
                    db: dbId,
                    name: "名称",
                    type: "text",
                  });
                if (
                  !session.isCurrent() ||
                  latestName.current.trim() !== snapshot
                )
                  return null;
                latestName.current = "";
                createdId.current = null;
                revision.current++;
                setName("");
                return dbId;
              })()
                .catch((e) => {
                  setError(String(e));
                  return null;
                })
                .finally(() => {
                  release();
                  setBusy(false);
                })
                .then((dbId) => {
                  if (dbId && session.isCurrent())
                    exit(() => router.replace(`/db/${dbId}`));
                });
            }}
          />
        </>
      ) : data.data?.database ? (
        <DatabaseManageSheet
          onBusyChange={onChildBusy}
          onDirtyChange={onChildDirty}
          database={data.data.database}
          props={data.data.props}
          onClose={() => exit(() => router.back())}
        />
      ) : (
        <Text style={{ color: tokens.muted }}>
          {data.loading ? "加载中…" : "数据库不存在"}
        </Text>
      )}
      {error || data.error ? (
        <>
          <Text
            selectable
            accessibilityRole="alert"
            style={{ color: tokens.danger }}
          >
            {error || String(data.error)}
          </Text>
          <ManagementAction
            label="重试加载"
            onPress={() => void data.refetch()}
          />
        </>
      ) : null}
    </ScrollView>
  );
}

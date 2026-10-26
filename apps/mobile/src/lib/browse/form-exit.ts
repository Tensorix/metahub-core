import { useNavigation, usePreventRemove } from "expo-router/react-navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import {
  createFormExitGuard,
  type ExitDecision,
  type FormExitState,
} from "./form-guard";

export function useFormExit(read: () => FormExitState) {
  const navigation = useNavigation();
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  }, [read]);
  const [guard] = useState(() => createFormExitGuard(() => readRef.current()));
  const [allow, setAllow] = useState(false);
  const handle = useCallback(function consume(decision: ExitDecision) {
    if (decision.kind === "blocked") {
      setAllow(false);
      Alert.alert("正在保存", "请等保存完成后再离开。");
    } else if (decision.kind === "confirm") {
      setAllow(false);
      Alert.alert("放弃未保存的修改？", "草稿将被丢弃，已保存的内容会保留。", [
        { text: "继续编辑", style: "cancel" },
        {
          text: "放弃修改",
          style: "destructive",
          onPress: () => consume(decision.confirm()),
        },
      ]);
    } else if (decision.kind === "ready") setAllow(true);
  }, []);
  usePreventRemove(!allow, ({ data }) =>
    handle(guard.request(() => navigation.dispatch(data.action))),
  );
  useEffect(() => {
    if (allow) {
      const result = guard.commit();
      if (result.kind !== "ready" && result.kind !== "idle") handle(result);
    }
  }, [allow, guard, handle]);
  return (action: () => void) => handle(guard.request(action));
}

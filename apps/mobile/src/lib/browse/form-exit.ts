import { useNavigation, usePreventRemove } from "expo-router/react-navigation";
import { useEffect, useRef } from "react";
import { Alert } from "react-native";
import { createFormExitController } from "./form-exit-controller";
import type { FormExitState } from "./form-guard";

export function useFormExit(read: () => FormExitState) {
  const navigation = useNavigation();
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  }, [read]);
  const controllerRef = useRef<ReturnType<
    typeof createFormExitController
  > | null>(null);
  useEffect(() => {
    const controller = createFormExitController(() => readRef.current(), {
      blocked: () => Alert.alert("正在保存", "请等保存完成后再离开。"),
      confirm: (discard, cancel) =>
        Alert.alert(
          "放弃未保存的修改？",
          "草稿将被丢弃，已保存的内容会保留。",
          [
            { text: "继续编辑", style: "cancel", onPress: cancel },
            { text: "放弃修改", style: "destructive", onPress: discard },
          ],
          { cancelable: true, onDismiss: cancel },
        ),
    });
    controllerRef.current = controller;
    return () => {
      controller.deactivate();
      controllerRef.current = null;
    };
  }, []);
  // Replay data.action unchanged: Router marks this route visited, so the replay
  // bypasses its listener while other routes remain protected. Toggling this flag
  // before pop also changes native header props during the removal transition.
  usePreventRemove(true, ({ data }) =>
    controllerRef.current?.beforeRemove(() => navigation.dispatch(data.action)),
  );
}

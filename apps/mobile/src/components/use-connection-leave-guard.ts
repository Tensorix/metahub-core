import { useNavigation } from "expo-router";
import {
  usePreventRemove,
  type NavigationAction,
} from "expo-router/react-navigation";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";

/** Credentials remain only in memory; ask before discarding an unfinished connection. */
export function useConnectionLeaveGuard(dirty: boolean, busy: boolean) {
  const navigation = useNavigation();
  const committing = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const pending = useRef<NavigationAction | null>(null);
  const leave = (action: NavigationAction) => {
    pending.current = action;
    setLeaving(true);
  };
  usePreventRemove(!leaving && (dirty || busy), ({ data }) => {
    if (committing.current) {
      leave(data.action);
      return;
    }
    if (busy) {
      Alert.alert("正在连接", "请等待连接完成后再离开。");
      return;
    }
    Alert.alert(
      "放弃连接配置？",
      "输入的连接信息尚未保存，离开后需要重新填写。",
      [
        { text: "继续填写", style: "cancel" },
        {
          text: "放弃",
          style: "destructive",
          onPress: () => leave(data.action),
        },
      ],
    );
  });
  useEffect(() => {
    if (leaving && pending.current) navigation.dispatch(pending.current);
  }, [leaving, navigation]);
  return committing;
}

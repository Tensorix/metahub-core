import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsRow } from "@/components/settings/SettingsRow";
import { useRouter } from "expo-router";
import { NativeHost } from "@/components/native/NativeHost";
import { SettingsForm } from "@/components/settings/SettingsForm";
import { useTheme } from "@/lib/theme";
import { useSession } from "@/lib/auth/session";
export default function SettingsIndex() {
 const router = useRouter();
 const { pref } = useTheme();
 const { creds } = useSession();
 return <NativeHost style={{ flex: 1 }}><SettingsForm>
 <SettingsSection title="此设备">
 <SettingsRow icon="sun.max" title="外观" value={{system:"跟随系统",light:"浅色",dark:"深色"}[pref]} onPress={() => router.push("/settings/appearance")} />
 <SettingsRow icon="internaldrive" title="离线与缓存" onPress={() => router.push("/settings/offline")} />
 </SettingsSection>
 <SettingsSection title="工作区">
 <SettingsRow icon="folder" title="当前工作区" value={creds.bucket?.bucket ?? creds.baseUrl} onPress={() => router.push("/settings/workspace")} />
 <SettingsRow icon="arrow.triangle.2.circlepath" title="数据与同步" onPress={() => router.push("/settings/sync")} />
 </SettingsSection>
 <SettingsSection title="应用"><SettingsRow icon="info.circle" title="关于" onPress={() => router.push("/settings/about")} /></SettingsSection>
 </SettingsForm></NativeHost>;
}

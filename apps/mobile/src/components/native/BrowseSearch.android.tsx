import { useRouter } from "expo-router";
import { AndroidSearchHeader } from "./AndroidSearchHeader";

export function BrowseSearch() {
  const router = useRouter();
  return <AndroidSearchHeader placeholder="搜索文档与记录"
    openSearch={(q) => router.push({ pathname: "/find", params: { q: q ?? "" } })} />;
}

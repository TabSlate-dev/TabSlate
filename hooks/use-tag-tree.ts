import * as React from "react";
import { buildTagTree, type TagTree } from "@/lib/tag-tree";
import { useWorkspaceStore } from "@/store/workspace-store";
import { resolveAcceptLanguage, useI18nStore } from "@/store/i18n-store";

export function useTagTree(): TagTree {
  const tags = useWorkspaceStore((s) => s.tags);
  const language = useI18nStore((s) => s.language);
  const locale = React.useMemo(() => resolveAcceptLanguage(language), [language]);
  return React.useMemo(() => buildTagTree(tags, locale), [tags, locale]);
}

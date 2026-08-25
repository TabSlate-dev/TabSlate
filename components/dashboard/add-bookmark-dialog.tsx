import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronDown, FolderPlus } from "lucide-react";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import { CollectionDialog } from "@/components/dashboard/sidebar/collection-dialog";
import { useTranslation } from "@/hooks/use-translation";
import {
  getActiveWorkspaceCollections,
  isActiveWorkspace,
  resolveActiveWorkspaceCollectionTarget,
} from "@/lib/workspace-visibility";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";

interface AddBookmarkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddBookmarkDialog({ open, onOpenChange }: AddBookmarkDialogProps) {
  const { t } = useTranslation();
  const addBookmark = useBookmarksStore(s => s.addBookmark);
  const collections = useWorkspaceStore(s => s.collections);
  const workspaces = useWorkspaceStore(s => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
  const createCollection = useWorkspaceStore(s => s.createCollection);
  const tags = useWorkspaceStore(s => s.tags);

  const activeCollections = React.useMemo(
    () => getActiveWorkspaceCollections(activeWorkspaceId, workspaces, collections),
    [activeWorkspaceId, workspaces, collections]
  );

  const defaultCollectionId = React.useMemo(
    () => activeCollections.find(c => c.isDefault)?.id ?? activeCollections[0]?.id ?? "",
    [activeCollections]
  );

  const [collectionId, setCollectionId] = React.useState(defaultCollectionId);
  const [selectedTags, setSelectedTags] = React.useState<string[]>([]);
  const [newCollectionOpen, setNewCollectionOpen] = React.useState(false);
  const [collectionMenuOpen, setCollectionMenuOpen] = React.useState(false);
  const [targetUnavailable, setTargetUnavailable] = React.useState(false);

  // Reset form when dialog opens
  React.useEffect(() => {
    if (open) {
      setCollectionId(defaultCollectionId);
      setSelectedTags([]);
      setTargetUnavailable(false);
    }
  }, [open, defaultCollectionId]);

  const selectedCollectionName = React.useMemo(
    () => activeCollections.find(c => c.id === collectionId)?.name ?? t("addBookmark_selectCollection"),
    [activeCollections, collectionId, t]
  );

  const toggleTag = (tagId: string) => {
    setSelectedTags(prev =>
      prev.includes(tagId) ? prev.filter(t => t !== tagId) : [...prev, tagId]
    );
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const title = (formData.get("title") as string)?.trim();
    const url = (formData.get("url") as string)?.trim();
    const description = (formData.get("description") as string)?.trim() ?? "";

    if (!title || !url) { return; }

    const state = useWorkspaceStore.getState();
    const targetId = collectionId || defaultCollectionId;
    const currentTarget = resolveActiveWorkspaceCollectionTarget(
      targetId,
      state.activeWorkspaceId,
      state.workspaces,
      state.collections,
    );
    if (!currentTarget) {
      const refreshed = getActiveWorkspaceCollections(
        state.activeWorkspaceId,
        state.workspaces,
        state.collections,
      );
      setCollectionId(refreshed.find((collection) => collection.isDefault)?.id ?? refreshed[0]?.id ?? "");
      setTargetUnavailable(true);
      return;
    }

    // Ensure URL has protocol
    let finalUrl = url;
    if (!/^https?:\/\//i.test(finalUrl)) {
      finalUrl = `https://${finalUrl}`;
    }

    addBookmark({
      title,
      url: finalUrl,
      description,
      favicon: "",
      collectionId: currentTarget.id,
      tags: selectedTags,
      seq: 0,
    });

    onOpenChange(false);
  };

  const handleNewCollection = (name: string, icon: string) => {
    const state = useWorkspaceStore.getState();
    const activeWorkspace = state.workspaces.find(
      (workspace) => workspace.id === state.activeWorkspaceId,
    );
    if (!isActiveWorkspace(activeWorkspace)) {
      setTargetUnavailable(true);
      return;
    }
    const col = createCollection(state.activeWorkspaceId, name, icon);
    setCollectionId(col.id);
    setTargetUnavailable(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("addBookmark_title")}</DialogTitle>
            <DialogDescription>
              {t("addBookmark_desc")}
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4 pt-1" onSubmit={handleSubmit}>
            {targetUnavailable && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertDescription>{t("workspaceVisibility_targetUnavailable")}</AlertDescription>
              </Alert>
            )}
            <Field>
              <FieldLabel htmlFor="bm-title">{t("addBookmark_fieldTitle")}</FieldLabel>
              <Input
                id="bm-title"
                name="title"
                placeholder={t("addBookmark_placeholderTitle")}
                autoFocus
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="bm-url">{t("addBookmark_fieldUrl")}</FieldLabel>
              <Input
                id="bm-url"
                name="url"
                placeholder={t("addBookmark_placeholderUrl")}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="bm-description">{t("addBookmark_fieldDesc")}</FieldLabel>
              <Input
                id="bm-description"
                name="description"
                placeholder={t("addBookmark_placeholderDesc")}
              />
            </Field>
            <Field>
              <FieldLabel>{t("addBookmark_fieldCollection")}</FieldLabel>
              <div className="flex items-center gap-2">
                <DropdownMenu open={collectionMenuOpen} onOpenChange={setCollectionMenuOpen}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1 justify-between font-normal"
                    >
                      <span className="truncate">{selectedCollectionName}</span>
                      <ChevronDown className="size-4 shrink-0 opacity-50" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] max-h-64 overflow-y-auto">
                    {activeCollections.map((c) => (
                      <DropdownMenuItem
                        key={c.id}
                        onClick={() => {
                          setCollectionId(c.id);
                          setCollectionMenuOpen(false);
                        }}
                      >
                        <span className="truncate">{c.name}</span>
                      </DropdownMenuItem>
                    ))}
                    {activeCollections.length > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      onClick={() => {
                        setCollectionMenuOpen(false);
                        setNewCollectionOpen(true);
                      }}
                    >
                      <FolderPlus className="size-3.5 mr-2" />
                      {t("groupsPanel_newCollection")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </Field>
            {tags.length > 0 && (
              <Field>
                <FieldLabel>{t("addBookmark_fieldTags")}</FieldLabel>
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((tag) => {
                    const isActive = selectedTags.includes(tag.id);
                    // Extract solid color from tag.color (e.g. "bg-blue-500/10 text-blue-500" → "bg-blue-500")
                    const solidBg = tag.color.split(" ")[0]?.replace("/10", "") ?? "bg-muted";
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        onClick={() => toggleTag(tag.id)}
                        className={cn(
                          "px-2.5 py-1 rounded-full text-xs font-medium transition-all",
                          isActive
                            ? `${solidBg} text-white`
                            : `${tag.color} hover:opacity-80`
                        )}
                      >
                        {tag.name}
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                {t("settings_cancel")}
              </Button>
              <Button type="submit" size="sm">
                {t("addBookmark_btnSubmit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <CollectionDialog
        open={newCollectionOpen}
        onOpenChange={setNewCollectionOpen}
        onSubmit={handleNewCollection}
      />
    </>
  );
}

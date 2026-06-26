import { useEffect, useState } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { storageService, getWorkspaceState, type BookmarkInput } from "@/lib/storage";
import { authStorageAdapter } from "@/lib/auth-storage-adapter";
import {
  Bookmark,
  Check,
  ChevronDown,
  ExternalLink,
  Folder,
  Loader2,
  LogIn,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Collection, Tag } from "@/lib/types";
import { useTranslation } from "@/hooks/use-translation";

interface TabInfo {
  title: string;
  url: string;
  favIconUrl: string;
}

type SaveState = "idle" | "saving" | "saved" | "error";

function PopupContent() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveableCollections, setSaveableCollections] = useState<Collection[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [selectedTags, setSelectedTags] = useState<Tag[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [pageInfo, setPageInfo] = useState<{ ogTitle: string; metaDescription: string } | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);

  useEffect(() => {
    Promise.all([
      new Promise<void>((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
          if (activeTab) {
            setTab({
              title: activeTab.title ?? activeTab.url ?? "Untitled",
              url: activeTab.url ?? "",
              favIconUrl: activeTab.favIconUrl ?? "",
            });
          }
          if (activeTab?.id) {
            chrome.tabs.sendMessage(activeTab.id, { type: "GET_PAGE_INFO" })
              .then((info: { ogTitle?: string; metaDescription?: string }) => {
                setPageInfo({ ogTitle: info.ogTitle ?? "", metaDescription: info.metaDescription ?? "" });
              })
              .catch(() => {});
          }
          resolve();
        });
      }),
      authStorageAdapter.getItem("tabslate-auth").then((result) => {
        let loggedIn = false;
        if (result) {
          try {
            const blob = JSON.parse(result);
            if (blob.state?.refreshToken) {
              loggedIn = true;
            }
          } catch { }
        }
        setIsLoggedIn(loggedIn);
      }),
      getWorkspaceState().then((state) => {
        const cols = state.collections.filter(
          (c) => c.workspaceId === state.activeWorkspaceId
        );
        setSaveableCollections(cols);
        setAvailableTags(state.tags);
        if (cols.length > 0) { setSelectedCollectionId(cols[0].id); }
      })
    ]).finally(() => {
      setLoading(false);
    });
  }, []);

  const selectedCollection = saveableCollections.find(
    (c) => c.id === selectedCollectionId
  );

  const handleSave = async () => {
    if (!tab?.url || saveState === "saving" || saveState === "saved") { return; }

    setSaveState("saving");
    try {
      const bookmarkData: BookmarkInput & { tags: string[]; seq: number } = {
        title: pageInfo?.ogTitle || tab.title,
        url: tab.url,
        favicon: tab.favIconUrl,
        description: pageInfo?.metaDescription || "",
        collectionId: selectedCollectionId,
        tags: selectedTags.map((t) => t.id),
        seq: 0,
      };

      // Primary path: send to newtab so syncEngine picks it up immediately
      const [newtabTab] = await chrome.tabs.query({ url: chrome.runtime.getURL("newtab.html") });
      if (newtabTab?.id) {
        try {
          await chrome.tabs.sendMessage(newtabTab.id, { type: "ADD_BOOKMARK", data: bookmarkData });
          setSaveState("saved");
          return;
        } catch { /* newtab not ready, fall through to storage */ }
      }

      // Fallback: write directly to storage (seq=0 sweep will sync on next newtab open)
      await storageService.addBookmark(bookmarkData);
      setSaveState("saved");
    } catch {
      setSaveState("error");
      setTimeout(() => setSaveState("idle"), 2000);
    }
  };

  const openTabSlate = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("newtab.html") });
    window.close();
  };

  if (loading || isLoggedIn === null) {
    return (
      <div className="flex items-center justify-center h-32 w-[360px]">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isNewTabPage =
    !tab?.url ||
    tab.url.startsWith("chrome://") ||
    tab.url.startsWith("chrome-extension://") ||
    tab.url === "";

  return (
    <div className="flex flex-col h-full min-w-[360px]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-2">
          <img src="/wxt.svg" alt="TabSlate" className="size-6" />
          <span className="font-semibold text-sm">TabSlate</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={openTabSlate}>
            <ExternalLink className="size-4" />
          </Button>
          <ThemeToggle />
        </div>
      </div>

      {!isLoggedIn ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 px-6 py-8 text-center">
          <div className="size-12 rounded-full bg-muted flex items-center justify-center">
            <LogIn className="size-5 text-muted-foreground" />
          </div>
          <div>
            <p className="font-medium text-sm">{t("popup_notLoggedIn") || "You are not logged in"}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {t("popup_loginHint") || "Please login to use TabSlate"}
            </p>
          </div>
          <Button size="sm" onClick={openTabSlate}>
            {t("auth_loginBtn") || "Login"}
          </Button>
        </div>
      ) : isNewTabPage ? (
        /* Can't save new tab / extension pages */
        <div className="flex flex-col items-center justify-center flex-1 gap-3 px-6 py-8 text-center">
          <div className="size-12 rounded-full bg-muted flex items-center justify-center">
            <Bookmark className="size-5 text-muted-foreground" />
          </div>
          <div>
            <p className="font-medium text-sm">{t("popup_nothingToSave")}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {t("popup_navigateHint")}
            </p>
          </div>
          <Button size="sm" onClick={openTabSlate}>
            {t("popup_openTabSlate")}
          </Button>
        </div>
      ) : saveState === "saved" ? (
        /* Success state */
        <div className="flex flex-col items-center justify-center flex-1 gap-3 px-6 py-8 text-center">
          <div className="size-12 rounded-full bg-green-500/10 flex items-center justify-center">
            <Check className="size-6 text-green-500" />
          </div>
          <div>
            <p className="font-medium text-sm">{t("popup_saved")}</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-[200px] truncate">
              {tab?.title}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={openTabSlate}>
            {t("popup_viewInTabSlate")}
          </Button>
        </div>
      ) : (
        /* Save form */
        <div className="flex flex-col gap-4 p-4">
          {/* Current page preview */}
          <div className="flex items-start gap-3 p-3 rounded-lg border bg-muted/40">
            {tab?.favIconUrl ? (
              <img
                src={tab.favIconUrl}
                alt=""
                className="size-8 rounded-md shrink-0 mt-0.5"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            ) : (
              <div className="size-8 rounded-md bg-muted shrink-0 mt-0.5 flex items-center justify-center">
                <Bookmark className="size-4 text-muted-foreground" />
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium line-clamp-2 leading-snug">
                {tab?.title}
              </p>
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                {tab?.url}
              </p>
            </div>
          </div>

          {/* Collection selector */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t("popup_collection")}
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="w-full justify-between font-normal"
                >
                  <div className="flex items-center gap-2">
                    <Folder className="size-4 text-muted-foreground" />
                    {selectedCollection?.name ?? t("popup_selectCollection")}
                  </div>
                  <ChevronDown className="size-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-[--radix-dropdown-menu-trigger-width]">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {t("popup_saveTo")}
                </DropdownMenuLabel>
                {saveableCollections.map((col) => (
                  <DropdownMenuItem
                    key={col.id}
                    onClick={() => setSelectedCollectionId(col.id)}
                    className="flex items-center justify-between"
                  >
                    {col.name}
                    {col.id === selectedCollectionId && (
                      <Check className="size-4" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Tags field */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t("popup_tags") || "Tags"}
            </label>
            <div className="relative">
              {selectedTags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {selectedTags.map((tag) => (
                    <span
                      key={tag.id}
                      className={cn(
                        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium cursor-pointer",
                        tag.color
                      )}
                      onClick={() =>
                        setSelectedTags((prev) => prev.filter((t) => t.id !== tag.id))
                      }
                    >
                      {tag.name}
                    </span>
                  ))}
                </div>
              )}
              <Input
                placeholder={t("popup_addTag") || "Add a tag..."}
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const val = tagInput.trim();
                    if (!val) {
                      handleSave();
                      return;
                    }
                    let existing = availableTags.find(
                      (t) => t.name.toLowerCase() === val.toLowerCase()
                    );
                    if (!existing) {
                      const TAG_COLORS = [
                        "bg-blue-500/10 text-blue-500",
                        "bg-emerald-500/10 text-emerald-500",
                        "bg-violet-500/10 text-violet-500",
                        "bg-amber-500/10 text-amber-500",
                        "bg-rose-500/10 text-rose-500",
                        "bg-cyan-500/10 text-cyan-500",
                        "bg-orange-500/10 text-orange-500",
                        "bg-pink-500/10 text-pink-500",
                      ];
                      const color = TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)];
                      existing = await storageService.addTag(val, color);
                      setAvailableTags((prev) => [...prev, existing!]);
                      chrome.tabs.query({ url: chrome.runtime.getURL("newtab.html") }, (tabs) => {
                        tabs.forEach((t) => {
                          if (t.id) {
                            try { chrome.tabs.sendMessage(t.id, { type: "WORKSPACE_CHANGED" }); } catch {}
                          }
                        });
                      });
                    }
                    if (!selectedTags.find((t) => t.id === existing!.id)) {
                      setSelectedTags((prev) => [...prev, existing!]);
                    }
                    setTagInput("");
                  }
                }}
                className="h-9 text-sm"
              />
              {tagInput.trim() && (
                <div className="absolute top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-popover border rounded-md shadow-md z-10 p-1">
                  {availableTags.filter(
                    (t) =>
                      t.name.toLowerCase().includes(tagInput.toLowerCase()) &&
                      !selectedTags.find((st) => st.id === t.id)
                  ).length > 0 ? (
                    availableTags
                      .filter(
                        (t) =>
                          t.name.toLowerCase().includes(tagInput.toLowerCase()) &&
                          !selectedTags.find((st) => st.id === t.id)
                      )
                      .map((tag) => (
                        <div
                          key={tag.id}
                          className="px-2 py-1.5 text-sm cursor-pointer hover:bg-accent rounded-sm flex items-center gap-2"
                          onClick={() => {
                            setSelectedTags((prev) => [...prev, tag]);
                            setTagInput("");
                          }}
                        >
                          <span
                            className={cn(
                              "inline-block size-3 rounded-full",
                              tag.color.split(" ")[0].replace("/10", "")
                            )}
                          />
                          {tag.name}
                        </div>
                      ))
                  ) : (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      Press Enter to create "{tagInput}"
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Save button */}
          <Button
            onClick={handleSave}
            disabled={saveState === "saving"}
            className="w-full"
          >
            {saveState === "saving" ? (
              <>
                <Loader2 className="size-4 animate-spin mr-2" />
                {t("popup_saving")}
              </>
            ) : saveState === "error" ? (
              t("popup_failedTryAgain")
            ) : (
              <>
                <Bookmark className="size-4 mr-2" />
                {t("popup_saveBookmark")}
              </>
            )}
          </Button>

          <p
            className={cn(
              "text-xs text-center text-muted-foreground",
              saveState === "error" && "text-destructive"
            )}
          >
            {saveState === "error"
              ? t("popup_somethingWentWrong")
              : t("popup_pressEnter")}
          </p>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <PopupContent />
    </ThemeProvider>
  );
}

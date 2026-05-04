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
import {
  Bookmark,
  Check,
  ChevronDown,
  ExternalLink,
  Folder,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Collection } from "@/lib/types";

interface TabInfo {
  title: string;
  url: string;
  favIconUrl: string;
}

type SaveState = "idle" | "saving" | "saved" | "error";

function PopupContent() {
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveableCollections, setSaveableCollections] = useState<Collection[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [note, setNote] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");

  useEffect(() => {
    // Load current tab
    chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
      if (activeTab) {
        setTab({
          title: activeTab.title ?? activeTab.url ?? "Untitled",
          url: activeTab.url ?? "",
          favIconUrl: activeTab.favIconUrl ?? "",
        });
      }
      setLoading(false);
    });

    // Load collections from workspace store
    getWorkspaceState().then((state) => {
      const cols = state.collections.filter(
        (c) => c.workspaceId === state.activeWorkspaceId
      );
      setSaveableCollections(cols);
      if (cols.length > 0) { setSelectedCollectionId(cols[0].id); }
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
        title: tab.title,
        url: tab.url,
        favicon: tab.favIconUrl,
        description: note,
        collectionId: selectedCollectionId,
        tags: [],
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
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
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-2">
          <div className="size-6 rounded-full bg-linear-to-br from-blue-400 via-indigo-500 to-violet-500" />
          <span className="font-semibold text-sm">TabSlate</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={openTabSlate}>
            <ExternalLink className="size-4" />
          </Button>
          <ThemeToggle />
        </div>
      </div>

      {isNewTabPage ? (
        /* Can't save new tab / extension pages */
        <div className="flex flex-col items-center justify-center flex-1 gap-3 px-6 py-8 text-center">
          <div className="size-12 rounded-full bg-muted flex items-center justify-center">
            <Bookmark className="size-5 text-muted-foreground" />
          </div>
          <div>
            <p className="font-medium text-sm">Nothing to save here</p>
            <p className="text-xs text-muted-foreground mt-1">
              Navigate to a webpage to save it as a bookmark.
            </p>
          </div>
          <Button size="sm" onClick={openTabSlate}>
            Open TabSlate
          </Button>
        </div>
      ) : saveState === "saved" ? (
        /* Success state */
        <div className="flex flex-col items-center justify-center flex-1 gap-3 px-6 py-8 text-center">
          <div className="size-12 rounded-full bg-green-500/10 flex items-center justify-center">
            <Check className="size-6 text-green-500" />
          </div>
          <div>
            <p className="font-medium text-sm">Saved!</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-[200px] truncate">
              {tab?.title}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={openTabSlate}>
            View in TabSlate
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
              Collection
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="w-full justify-between font-normal"
                >
                  <div className="flex items-center gap-2">
                    <Folder className="size-4 text-muted-foreground" />
                    {selectedCollection?.name ?? "Select collection"}
                  </div>
                  <ChevronDown className="size-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-[--radix-dropdown-menu-trigger-width]">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Save to
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

          {/* Note field */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Note{" "}
              <span className="text-muted-foreground/60 font-normal">
                (optional)
              </span>
            </label>
            <Input
              placeholder="Add a note..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
              className="h-9 text-sm"
            />
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
                Saving...
              </>
            ) : saveState === "error" ? (
              "Failed — try again"
            ) : (
              <>
                <Bookmark className="size-4 mr-2" />
                Save Bookmark
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
              ? "Something went wrong."
              : "Press Enter to save quickly"}
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

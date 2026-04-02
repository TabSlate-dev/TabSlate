import * as React from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, Loader2, ExternalLink, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { FaviconImage } from "@/components/ui/favicon-image";

interface WindowTab {
  id: number;
  title: string;
  url: string;
  favIconUrl: string;
  active: boolean;
  windowId: number;
}

interface BrowserWindow {
  id: number;
  focused: boolean;
  tabs: WindowTab[];
}

function isUserUrl(url: string) {
  return (
    !!url &&
    !url.startsWith("chrome://") &&
    !url.startsWith("chrome-extension://") &&
    !url.startsWith("about:") &&
    !url.startsWith("edge://")
  );
}

async function loadWindows(): Promise<BrowserWindow[]> {
  return new Promise((resolve) => {
    chrome.windows.getAll({ populate: true }, (wins) => {
      resolve(
        (wins ?? []).map((w) => ({
          id: w.id!,
          focused: w.focused ?? false,
          tabs: (w.tabs ?? [])
            .filter((t) => t.url && isUserUrl(t.url))
            .map((t) => ({
              id: t.id!,
              title: t.title ?? t.url ?? "Untitled",
              url: t.url ?? "",
              favIconUrl: t.favIconUrl ?? "",
              active: t.active,
              windowId: t.windowId,
            })),
        }))
      );
    });
  });
}

async function focusTab(tabId: number, windowId: number) {
  await new Promise<void>((r) =>
    chrome.windows.update(windowId, { focused: true }, () =>
      chrome.tabs.update(tabId, { active: true }, () => r())
    )
  );
}

export function TabsRail() {
  const [windows, setWindows] = React.useState<BrowserWindow[]>([]);
  const [selectedWindowId, setSelectedWindowId] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(true);

  async function refresh() {
    const wins = await loadWindows();
    setWindows(wins);
    // auto-select focused window if not already selected
    setSelectedWindowId((prev) => {
      if (prev && wins.some((w) => w.id === prev)) return prev;
      return wins.find((w) => w.focused)?.id ?? wins[0]?.id ?? null;
    });
    setLoading(false);
  }

  React.useEffect(() => {
    refresh();
    const handler = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ("tabslate-tabs-changed" in changes) refresh();
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, []);

  const selectedWindow = windows.find((w) => w.id === selectedWindowId);
  const tabs = selectedWindow?.tabs ?? [];

  const windowLabel = (w: BrowserWindow, idx: number) => {
    const label = `Window ${idx + 1}`;
    return w.focused ? `${label} (this)` : label;
  };

  return (
    <div className="w-64 shrink-0 flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b shrink-0">
        <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          Open Tabs
        </span>
        {windows.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground outline-none">
              {windows.findIndex((w) => w.id === selectedWindowId) >= 0
                ? windowLabel(
                    selectedWindow!,
                    windows.findIndex((w) => w.id === selectedWindowId)
                  )
                : "Window"}
              <ChevronDown className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {windows.map((w, idx) => (
                <DropdownMenuItem
                  key={w.id}
                  onClick={() => setSelectedWindowId(w.id)}
                  className={cn(
                    selectedWindowId === w.id && "bg-muted font-medium"
                  )}
                >
                  <Globe className="size-3.5 mr-2 text-muted-foreground" />
                  {windowLabel(w, idx)}
                  <span className="ml-auto text-muted-foreground text-xs">
                    {w.tabs.length}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Tab list */}
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1.5">
        {loading && (
          <div className="flex justify-center py-8">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {!loading && tabs.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8 px-3">
            No open tabs
          </p>
        )}
        {!loading &&
          tabs.map((tab) => (
            <button
              key={tab.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "copy";
                e.dataTransfer.setData(
                  "application/tabslate-tab",
                  JSON.stringify({
                    title: tab.title,
                    url: tab.url,
                    favIconUrl: tab.favIconUrl,
                  })
                );
              }}
              onClick={() => focusTab(tab.id, tab.windowId)}
              className={cn(
                "w-full flex items-start gap-2 px-2.5 py-2 rounded-md border bg-card text-left transition-colors group hover:bg-accent hover:border-accent cursor-grab active:cursor-grabbing",
                tab.active && "border-primary/30 bg-primary/5"
              )}
            >
              <div className="relative shrink-0 mt-0.5">
                <FaviconImage src={tab.favIconUrl} className="size-4 rounded-sm" />
                {tab.active && (
                  <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-green-500 ring-1 ring-background" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate leading-tight">
                  {tab.title}
                </p>
                <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                  {new URL(tab.url).hostname}
                </p>
              </div>
              <ExternalLink className="size-3 shrink-0 opacity-0 group-hover:opacity-60 mt-0.5 text-muted-foreground" />
            </button>
          ))}
      </div>

      {/* Footer */}
      {!loading && (
        <div className="px-3 py-2 border-t shrink-0">
          <p className="text-[10px] text-muted-foreground">
            {tabs.length} tab{tabs.length !== 1 ? "s" : ""} open
            {windows.length > 1 && ` · ${windows.length} windows`}
          </p>
        </div>
      )}
    </div>
  );
}

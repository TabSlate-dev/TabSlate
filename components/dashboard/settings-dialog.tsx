import * as React from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ImportDialog } from "@/components/dashboard/import-dialog";
import { useSettingsStore, SearchEngine } from "@/store/settings-store";
import { usePlanStore } from "@/store/plan-store";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { GripVertical, Trash2, Plus, Bookmark, Layers, Tag, Folder, ShieldCheck, Loader2, Sparkles } from "lucide-react";
import { Input } from "@/components/ui/input";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";

function SortableSearchEngineItem({
  engine,
  onToggle,
  onDelete,
}: {
  engine: SearchEngine;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: engine.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : 0,
  };

  function getEngineIconSrc(engine: { iconUrl?: string; siteUrl: string }): string {
    if (engine.iconUrl && typeof chrome !== "undefined" && chrome.runtime?.id) {
      return chrome.runtime.getURL(engine.iconUrl);
    }
    try {
      const domain = new URL(engine.siteUrl).hostname;
      return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
    } catch {
      return "";
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center justify-between p-3 rounded-lg border bg-card ${isDragging ? 'shadow-md ring-1 ring-primary/20' : ''}`}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing p-1"
        >
          <GripVertical className="size-4" />
        </button>
        <img src={getEngineIconSrc(engine)} alt={engine.name} className="size-5 rounded-sm" />
        <span className="font-medium text-sm">{engine.name}</span>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          checked={engine.enabled}
          onCheckedChange={(checked) => onToggle(engine.id, checked)}
        />
        {engine.custom && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Delete ${engine.name}`}
            className="size-7 text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(engine.id)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

interface QuotaRowProps {
  label: string;
  usage: number;
  limit: number;
  icon: React.ElementType;
}

function QuotaRow({ label, usage, limit, icon: Icon }: QuotaRowProps) {
  const isUnlimited = limit === -1;
  const percentage = isUnlimited ? 0 : Math.min(100, (usage / limit) * 100);

  let barColor = "bg-emerald-500 dark:bg-emerald-600";
  if (percentage >= 90) {
    barColor = "bg-rose-500 dark:bg-rose-600";
  } else if (percentage >= 70) {
    barColor = "bg-amber-500 dark:bg-amber-600";
  }

  return (
    <div className="flex flex-col gap-2 p-3.5 rounded-xl border border-muted/60 bg-muted/10 backdrop-blur-xs select-none">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <Icon className="size-3.5 text-muted-foreground" />
          <span className="font-semibold text-muted-foreground">{label}</span>
        </div>
        <span className="font-mono font-bold text-foreground">
          {usage} <span className="text-muted-foreground/40 font-sans">/</span> {isUnlimited ? "∞" : limit}
        </span>
      </div>
      <div className="relative w-full h-2 rounded-full bg-muted/60 overflow-hidden">
        {isUnlimited ? (
          <div className="absolute inset-0 bg-gradient-to-r from-violet-500/20 via-pink-500/20 to-violet-500/20 animate-pulse rounded-full" />
        ) : (
          <div
            className={cn("h-full rounded-full transition-all duration-500 ease-out", barColor)}
            style={{ width: `${percentage}%` }}
          />
        )}
      </div>
    </div>
  );
}

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: "general" | "engines" | "plan";
}

export function SettingsDialog({ open, onOpenChange, initialTab = "general" }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = React.useState<"general" | "engines" | "plan">("general");

  React.useEffect(() => {
    if (open) {
      setActiveTab(initialTab);
    }
  }, [open, initialTab]);

  const searchEngines = useSettingsStore(s => s.searchEngines);
  const updateSearchEngines = useSettingsStore(s => s.updateSearchEngines);

  const subscription = usePlanStore(s => s.subscription);
  const limits = usePlanStore(s => s.limits);
  const usage = usePlanStore(s => s.usage);
  const isPlanFetching = usePlanStore(s => s.isFetching);
  const fetchPlan = usePlanStore(s => s.fetchPlan);

  React.useEffect(() => {
    if (open && activeTab === "plan") {
      fetchPlan();
    }
  }, [open, activeTab, fetchPlan]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: any) => {
    const { active, over } = event;
    if (!over || active.id === over.id) { return; }
    const oldIndex = searchEngines.findIndex((e) => e.id === active.id);
    const newIndex = searchEngines.findIndex((e) => e.id === over.id);
    updateSearchEngines(arrayMove(searchEngines, oldIndex, newIndex));
  };

  const handleToggle = (id: string, enabled: boolean) => {
    updateSearchEngines(
      searchEngines.map((e) => (e.id === id ? { ...e, enabled } : e))
    );
  };

  const handleDelete = (id: string) => {
    updateSearchEngines(searchEngines.filter((e) => e.id !== id));
  };

  const [importDialogOpen, setImportDialogOpen] = React.useState(false);
  const [showForm, setShowForm] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newUrl, setNewUrl] = React.useState("");

  React.useEffect(() => {
    if (!open) {
      setShowForm(false);
      setNewName("");
      setNewUrl("");
    }
  }, [open]);

  const canAdd = (() => {
    if (!newName.trim() || !newUrl.trim().includes("%s")) { return false; }
    try {
      new URL(newUrl.trim().replace("%s", "x"));
      return true;
    } catch {
      return false;
    }
  })();

  const [searchOverlayEnabled, setSearchOverlayEnabled] = React.useState(false);

  React.useEffect(() => {
    if (open && typeof chrome !== "undefined" && chrome.permissions) {
      chrome.permissions.contains({ origins: ["<all_urls>"] }).then(setSearchOverlayEnabled);
    }
  }, [open]);

  const handleToggleSearchOverlay = async (checked: boolean) => {
    if (typeof chrome === "undefined" || !chrome.permissions) return;
    
    if (checked) {
      const granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
      setSearchOverlayEnabled(granted);
    } else {
      const removed = await chrome.permissions.remove({ origins: ["<all_urls>"] });
      if (removed) {
        setSearchOverlayEnabled(false);
      }
    }
  };

  const handleAdd = () => {
    const siteUrl = (() => {
      try {
        return new URL(newUrl.trim().replace("%s", "x")).origin;
      } catch {
        return "";
      }
    })();
    const engine: SearchEngine = {
      id: crypto.randomUUID(),
      name: newName.trim(),
      url: newUrl.trim(),
      siteUrl,
      custom: true,
      enabled: true,
    };
    updateSearchEngines([...searchEngines, engine]);
    setNewName("");
    setNewUrl("");
    setShowForm(false);
  };

  // Plan Premium styling resolving
  const planName = subscription?.plan || "free";
  let cardStyle = "bg-muted/10 border-muted text-foreground";
  let glowStyle = "bg-primary/5";
  let badgeText = "FREE PLAN";
  let badgeStyle = "bg-muted/40 text-muted-foreground border-muted-foreground/10";

  if (planName === "pro") {
    cardStyle = "bg-linear-to-br from-violet-500/10 via-pink-500/5 to-background border-violet-500/20 shadow-lg shadow-violet-500/5 relative overflow-hidden";
    glowStyle = "bg-violet-500/15 animate-pulse duration-5000";
    badgeText = "PRO PLAN";
    badgeStyle = "bg-linear-to-r from-violet-500/10 to-pink-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20 font-extrabold tracking-wider";
  } else if (planName === "premium") {
    cardStyle = "bg-linear-to-br from-amber-500/10 via-orange-500/5 to-background border-amber-500/20 shadow-lg shadow-amber-500/5 relative overflow-hidden";
    glowStyle = "bg-amber-500/15 animate-pulse duration-5000";
    badgeText = "PREMIUM PLAN";
    badgeStyle = "bg-linear-to-r from-amber-500/10 to-orange-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 font-extrabold tracking-wider";
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="sr-only">Configure TabSlate settings</DialogDescription>
        </DialogHeader>

        {/* Tab switcher */}
        <div className="flex border border-muted/80 bg-muted/20 p-1 rounded-xl gap-0.5 mb-5 select-none shrink-0">
          <button
            onClick={() => setActiveTab("general")}
            className={cn(
              "flex-1 py-1.5 px-3 text-xs font-semibold rounded-lg transition-all text-center cursor-pointer",
              activeTab === "general"
                ? "bg-background text-foreground shadow-xs font-bold"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            General
          </button>
          <button
            onClick={() => setActiveTab("engines")}
            className={cn(
              "flex-1 py-1.5 px-3 text-xs font-semibold rounded-lg transition-all text-center cursor-pointer",
              activeTab === "engines"
                ? "bg-background text-foreground shadow-xs font-bold"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Search Engines
          </button>
          <button
            onClick={() => setActiveTab("plan")}
            className={cn(
              "flex-1 py-1.5 px-3 text-xs font-semibold rounded-lg transition-all text-center cursor-pointer",
              activeTab === "plan"
                ? "bg-background text-foreground shadow-xs font-bold"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Plan & Quotas
          </button>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 -mr-2 min-h-0">
          {activeTab === "general" && (
            <div className="space-y-6 animate-in fade-in duration-200">
              <div className="rounded-lg border p-3 shadow-sm bg-card/20">
                <div className="flex flex-row items-center justify-between">
                  <div className="space-y-0.5">
                    <h3 className="text-sm font-semibold">Global Search Overlay</h3>
                    <p className="text-xs text-muted-foreground mr-4 mt-0.5">
                      Press <kbd className="px-1 py-0.5 rounded-md bg-muted border font-sans text-[10px]">Ctrl+Shift+K</kbd> to search your tabs and bookmarks on any website.
                    </p>
                  </div>
                  <Switch
                    checked={searchOverlayEnabled}
                    onCheckedChange={handleToggleSearchOverlay}
                  />
                </div>
              </div>

              <div className="space-y-2.5">
                <h3 className="text-sm font-semibold">Data Import</h3>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  Import your saved tabs and collections from other extensions, or synchronize from browser bookmarks database.
                </p>
                <Button variant="outline" size="sm" onClick={() => setImportDialogOpen(true)} className="cursor-pointer">
                  Import Bookmarks
                </Button>
              </div>
            </div>
          )}

          {activeTab === "engines" && (
            <div className="space-y-6 animate-in fade-in duration-200">
              <div>
                <h3 className="text-sm font-semibold">Search Engines</h3>
                <p className="text-xs text-muted-foreground mb-4 mt-0.5">
                  Enable or disable search engines and drag to reorder them. The first enabled engine is the default.
                </p>
                
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={searchEngines.map((e) => e.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-2">
                      {searchEngines.map((engine) => (
                        <SortableSearchEngineItem
                          key={engine.id}
                          engine={engine}
                          onToggle={handleToggle}
                          onDelete={handleDelete}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>

                {showForm ? (
                  <div className="mt-3 space-y-2 rounded-lg border bg-card p-3">
                    <Input
                      placeholder="Name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      autoFocus
                    />
                    <Input
                      placeholder="https://example.com/search?q=%s"
                      value={newUrl}
                      onChange={(e) => setNewUrl(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Use <code className="font-mono">%s</code> as the search term placeholder
                    </p>
                    <div className="flex justify-end gap-2 pt-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setShowForm(false);
                          setNewName("");
                          setNewUrl("");
                        }}
                      >
                        Cancel
                      </Button>
                      <Button size="sm" disabled={!canAdd} onClick={handleAdd}>
                        Add
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 w-full text-muted-foreground hover:text-foreground cursor-pointer"
                    onClick={() => setShowForm(true)}
                  >
                    <Plus className="size-3.5 mr-1" />
                    Add engine
                  </Button>
                )}
              </div>
            </div>
          )}

          {activeTab === "plan" && (
            <div className="space-y-5 animate-in fade-in duration-200">
              {/* Premium Plan Glow card */}
              <div className={cn("p-5 border rounded-2xl flex flex-col gap-4 relative overflow-hidden", cardStyle)}>
                <div className={cn("absolute -right-8 -top-8 size-32 rounded-full blur-2xl transition-all duration-700", glowStyle)} />

                <div className="relative flex items-center justify-between">
                  <div className="flex flex-col gap-1">
                    <span className={cn("text-[9px] uppercase font-black px-2 py-0.5 rounded-md border w-fit tracking-wider", badgeStyle)}>
                      {badgeText}
                    </span>
                    <h3 className="text-lg font-bold tracking-tight mt-2 capitalize">
                      {planName} Account
                    </h3>
                    {subscription && subscription.plan !== "free" && subscription.expires_at && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {subscription.status === "ACTIVE" ? "Renews" : "Expires"} on {new Date(subscription.expires_at * 1000).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </p>
                    )}
                    {(!subscription || subscription.plan === "free") && (
                      <p className="text-xs text-muted-foreground mt-1 leading-relaxed max-w-[340px]">
                        Get unlimited workspaces, unlimited bookmarks, custom categories, and seamless premium cloud integrations.
                      </p>
                    )}
                  </div>
                  
                  {planName === "free" && (
                    <Button
                      size="sm"
                      className="bg-linear-to-r from-violet-600 to-pink-600 hover:from-violet-700 hover:to-pink-700 text-white shadow-md shadow-violet-500/20 font-bold tracking-wide border-0 cursor-pointer rounded-xl shrink-0"
                      onClick={() => {
                        alert("Upgrade Option: TabSlate Cloud plans are managed via the web platform checkout or subscription portal. Please navigate to the portal to upgrade.");
                      }}
                    >
                      Upgrade Plan
                    </Button>
                  )}
                </div>
              </div>

              {/* Resource quota status trackers */}
              <div className="space-y-3 mt-4">
                <div className="flex items-center justify-between select-none">
                  <h4 className="text-xs font-bold text-muted-foreground tracking-wider uppercase">Resource Quotas & Usage</h4>
                  {isPlanFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <QuotaRow
                    label="Workspaces"
                    usage={usage?.workspaces ?? 0}
                    limit={limits?.max_workspaces ?? -1}
                    icon={Layers}
                  />
                  <QuotaRow
                    label="Bookmarks"
                    usage={usage?.bookmarks ?? 0}
                    limit={limits?.max_bookmarks ?? -1}
                    icon={Bookmark}
                  />
                  <QuotaRow
                    label="Collections"
                    usage={usage?.collections ?? 0}
                    limit={limits?.max_collections ?? -1}
                    icon={Folder}
                  />
                  <QuotaRow
                    label="Tags"
                    usage={usage?.tags ?? 0}
                    limit={limits?.max_tags ?? -1}
                    icon={Tag}
                  />
                  <QuotaRow
                    label="Saved Groups"
                    usage={usage?.saved_groups ?? 0}
                    limit={limits?.max_saved_groups ?? -1}
                    icon={Sparkles}
                  />
                </div>

                {limits && limits.trash_grace_days !== -1 && (
                  <div className="flex items-center gap-2 p-3 text-xs rounded-xl border border-muted bg-muted/5 text-muted-foreground mt-1 select-none">
                    <ShieldCheck className="size-4 text-emerald-500 shrink-0" />
                    <span>Your trash retention policy holds deleted items safely for <strong>{limits.trash_grace_days} days</strong> before automatic permanent deletion.</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="pt-4 border-t mt-auto flex justify-end shrink-0">
          <Button onClick={() => onOpenChange(false)} className="cursor-pointer">Done</Button>
        </div>
      </DialogContent>
    </Dialog>
    <ImportDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} />
    </>
  );
}

import * as React from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/use-translation";
import type { PlanLimits, PlanUsage } from "@/lib/api";
import {
  calculateGuestQuotaUsage,
  type QuotaUsageBreakdown,
} from "@/lib/quota-usage";
import type { Workspace } from "@/lib/types";
import { readWorkspaceLifecycleCapability } from "@/lib/workspace-lifecycle-state";
import type { SyncStatus } from "@/lib/sync-engine";
import { useAuthStore } from "@/store/auth-store";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { useGroupsStore } from "@/store/groups-store";
import { usePlanStore } from "@/store/plan-store";
import {
  useWorkspaceStore,
  WORKSPACE_COLORS,
  WORKSPACE_GRADIENTS,
  type WorkspaceColor,
} from "@/store/workspace-store";
import { DeleteWorkspaceDialog } from "./delete-workspace-dialog";
import {
  createWorkspaceManagerActionGate,
  createWorkspaceManagerLoaderFence,
  createWorkspaceManagerLoaderSingleFlight,
  createDeleteWorkspaceConfirmation,
  createWorkspaceManagerViewModel,
  executeSerializedWorkspaceManagerAction,
  getWorkspaceLifecycleActionAvailability,
  resolveWorkspaceManagerOnlineStatus,
  type WorkspaceManagerCardModel,
  type WorkspaceManagerViewModel,
  type WorkspaceRetention,
} from "./model";
import { PermanentDeleteWorkspaceDialog } from "./permanent-delete-dialog";
import { WorkspaceCard } from "./workspace-card";

export type WorkspaceManagerTab = "in_use" | "deleted";

interface WorkspaceManagerAvailability {
  isGuest: boolean;
  isOnline: boolean;
  capabilitySupported: boolean;
  dataReady: boolean;
}

export interface WorkspaceManagerContentProps {
  model: WorkspaceManagerViewModel;
  selectedTab: WorkspaceManagerTab;
  activeWorkspaceId?: string;
  availability?: WorkspaceManagerAvailability;
  lifecyclePending?: boolean;
  quotaBreakdown?: QuotaUsageBreakdown | null;
  quotaLimits?: PlanLimits | null;
  onTabChange(tab: WorkspaceManagerTab): void;
  onCreate(): void;
  onSwitch(workspaceId: string): void;
  onRename(workspaceId: string): void;
  onRecolor(workspaceId: string): void;
  onDelete(workspaceId: string): void;
  onRestore(workspaceId: string): void;
  onPermanentlyDelete(workspaceId: string): void;
}

function formatRetention(
  retention: WorkspaceRetention,
  t: (key: string, substitutions?: string | string[]) => string,
): string {
  if (retention.kind === "guest") {
    return t("workspaceManager_retentionGuest");
  }
  if (retention.kind === "unlimited") {
    return t("workspaceManager_retentionUnlimited");
  }
  if (retention.kind === "expired") {
    return t("workspaceManager_retentionExpired");
  }
  return t(
    retention.days === 1
      ? "workspaceManager_retentionRemaining_one"
      : "workspaceManager_retentionRemaining_other",
    [retention.days.toString()],
  );
}

export function WorkspaceManagerContent({
  model,
  selectedTab,
  activeWorkspaceId,
  availability = {
    isGuest: true,
    isOnline: true,
    capabilitySupported: true,
    dataReady: true,
  },
  lifecyclePending = false,
  quotaBreakdown = null,
  quotaLimits = null,
  onTabChange,
  onCreate,
  onSwitch,
  onRename,
  onRecolor,
  onDelete,
  onRestore,
  onPermanentlyDelete,
}: WorkspaceManagerContentProps) {
  const { t } = useTranslation();
  const activeWorkspaceCount = model.inUse.length;

  const handleTabKeyDown = React.useCallback((
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    let nextTab: WorkspaceManagerTab | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      nextTab = selectedTab === "in_use" ? "deleted" : "in_use";
    } else if (event.key === "Home") {
      nextTab = "in_use";
    } else if (event.key === "End") {
      nextTab = "deleted";
    }
    if (!nextTab) {
      return;
    }
    event.preventDefault();
    onTabChange(nextTab);
    const tabId = nextTab === "in_use"
      ? "workspace-manager-tab-in-use"
      : "workspace-manager-tab-deleted";
    document.getElementById(tabId)?.focus();
  }, [onTabChange, selectedTab]);

  const renderCards = (cards: readonly WorkspaceManagerCardModel[]) => cards.map((card) => {
    const deleteAvailability = getWorkspaceLifecycleActionAvailability({
      action: "delete",
      activeWorkspaceCount,
      ...availability,
    });
    const restoreAvailability = getWorkspaceLifecycleActionAvailability({
      action: "restore",
      activeWorkspaceCount,
      ...availability,
    });
    const purgeAvailability = getWorkspaceLifecycleActionAvailability({
      action: "purge",
      activeWorkspaceCount,
      ...availability,
    });
    const deleteReason = deleteAvailability.messageKey
      ? t(deleteAvailability.messageKey)
      : undefined;
    const restoreReason = restoreAvailability.messageKey
      ? t(restoreAvailability.messageKey)
      : undefined;
    const purgeReason = purgeAvailability.messageKey
      ? t(purgeAvailability.messageKey)
      : undefined;
    const pendingReason = lifecyclePending
      ? t("workspaceManager_actionInProgress")
      : undefined;
    return (
      <WorkspaceCard
        key={card.workspace.id}
        workspace={card.workspace}
        counts={card.counts}
        retentionLabel={formatRetention(card.retention, t)}
        canDelete={card.canDelete && deleteAvailability.enabled}
        isActive={card.workspace.id === activeWorkspaceId}
        lifecyclePending={lifecyclePending}
        deleteDisabledReason={pendingReason ?? (
          card.canDelete ? deleteReason : t("workspaceManager_lastActiveGuard")
        )}
        restoreDisabledReason={pendingReason ?? restoreReason}
        purgeDisabledReason={pendingReason ?? purgeReason}
        onSwitch={onSwitch}
        onRename={onRename}
        onRecolor={onRecolor}
        onDelete={onDelete}
        onRestore={onRestore}
        onPermanentlyDelete={onPermanentlyDelete}
      />
    );
  });

  const loadingMessage = (
    <p className="py-8 text-center text-sm text-muted-foreground" role="status">
      {t("workspaceManager_loadingData")}
    </p>
  );
  const quotaRows: Array<{
    key: keyof PlanUsage;
    label: string;
    limit: number | null;
  }> = [
    { key: "workspaces", label: t("quota_workspaces"), limit: quotaLimits?.max_workspaces ?? null },
    { key: "collections", label: t("quota_collections"), limit: quotaLimits?.max_collections ?? null },
    { key: "bookmarks", label: t("quota_bookmarks"), limit: quotaLimits?.max_bookmarks ?? null },
    { key: "saved_groups", label: t("quota_savedGroups"), limit: quotaLimits?.max_saved_groups ?? null },
    { key: "tags", label: t("quota_tags"), limit: quotaLimits?.max_tags ?? null },
  ];

  return (
    <div className="space-y-4">
      {quotaBreakdown && (
        <section
          aria-label={t("workspaceManager_quotaTitle")}
          className="rounded-lg border bg-muted/20 p-3"
        >
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("workspaceManager_quotaTitle")}
          </h3>
          <div className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
            {quotaRows.map((row) => {
              const limit = row.limit === -1 ? "∞" : row.limit?.toString();
              return (
                <div key={row.key} className="text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">{row.label}</span>
                    <span className="font-medium text-foreground">
                      {limit === undefined
                        ? t("quota_total", [quotaBreakdown.total[row.key].toString()])
                        : `${quotaBreakdown.total[row.key]}/${limit}`}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground/75">
                    {t("quota_breakdown", [
                      quotaBreakdown.inUse[row.key].toString(),
                      quotaBreakdown.trash[row.key].toString(),
                    ])}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      )}
      <div
        role="tablist"
        aria-label={t("workspaceManager_tabsLabel")}
        className="grid grid-cols-2 rounded-lg bg-muted p-1"
      >
        <button
          id="workspace-manager-tab-in-use"
          type="button"
          role="tab"
          aria-selected={selectedTab === "in_use"}
          aria-controls="workspace-manager-panel-in-use"
          tabIndex={selectedTab === "in_use" ? 0 : -1}
          className={cn(
            "rounded-md px-3 py-2 text-sm font-medium",
            selectedTab === "in_use" && "bg-background shadow-sm",
          )}
          onClick={() => onTabChange("in_use")}
          onKeyDown={handleTabKeyDown}
        >
          {t("workspaceManager_inUseTab")}
        </button>
        <button
          id="workspace-manager-tab-deleted"
          type="button"
          role="tab"
          aria-selected={selectedTab === "deleted"}
          aria-controls="workspace-manager-panel-deleted"
          tabIndex={selectedTab === "deleted" ? 0 : -1}
          className={cn(
            "rounded-md px-3 py-2 text-sm font-medium",
            selectedTab === "deleted" && "bg-background shadow-sm",
          )}
          onClick={() => onTabChange("deleted")}
          onKeyDown={handleTabKeyDown}
        >
          {t("workspaceManager_deletedTab")}
        </button>
      </div>

      <section
        id="workspace-manager-panel-in-use"
        role="tabpanel"
        aria-labelledby="workspace-manager-tab-in-use"
        hidden={selectedTab !== "in_use"}
        inert={selectedTab !== "in_use"}
        tabIndex={selectedTab === "in_use" ? 0 : -1}
        className="space-y-3"
      >
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={onCreate}>
            <Plus className="size-4" />
            {t("workspaceManager_create")}
          </Button>
        </div>
        {!availability.dataReady && loadingMessage}
        {availability.dataReady && model.inUse.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("workspaceManager_noActive")}
          </p>
        )}
        {availability.dataReady && renderCards(model.inUse)}
      </section>

      <section
        id="workspace-manager-panel-deleted"
        role="tabpanel"
        aria-labelledby="workspace-manager-tab-deleted"
        hidden={selectedTab !== "deleted"}
        inert={selectedTab !== "deleted"}
        tabIndex={selectedTab === "deleted" ? 0 : -1}
        className="space-y-3"
      >
        {!availability.dataReady && loadingMessage}
        {availability.dataReady && model.deleted.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("workspaceManager_noDeleted")}
          </p>
        )}
        {availability.dataReady && renderCards(model.deleted)}
      </section>
    </div>
  );
}

type WorkspaceFormMode = "create" | "rename" | "recolor";

interface WorkspaceFormDialogProps {
  open: boolean;
  mode: WorkspaceFormMode;
  workspace: Workspace | null;
  errorMessage: string | null;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  onOpenChange(open: boolean): void;
  onSubmit(name: string, color: WorkspaceColor): void;
}

function WorkspaceFormDialog({
  open,
  mode,
  workspace,
  errorMessage,
  returnFocusRef,
  onOpenChange,
  onSubmit,
}: WorkspaceFormDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState<WorkspaceColor>("blue");

  React.useEffect(() => {
    if (!open) {
      return;
    }
    setName(workspace?.name ?? "");
    setColor(
      WORKSPACE_COLORS.find((candidate) => candidate === workspace?.color) ?? "blue",
    );
  }, [open, workspace]);

  const handleSubmit = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    onSubmit(trimmedName, color);
  }, [color, name, onSubmit]);

  const titleKey = mode === "create"
    ? "workspaceManager_createDialogTitle"
    : mode === "rename"
      ? "workspaceManager_renameDialogTitle"
      : "workspaceManager_recolorDialogTitle";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-sm"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocusRef.current?.isConnected) {
            returnFocusRef.current.focus();
            return;
          }
          document.getElementById("workspace-manager-tab-in-use")?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t(titleKey)}</DialogTitle>
          <DialogDescription>{t("workspaceManager_formDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {mode !== "recolor" && (
            <Field>
              <FieldLabel htmlFor="workspace-manager-name">
                {t("workspaceManager_name")}
              </FieldLabel>
              <Input
                id="workspace-manager-name"
                value={name}
                autoFocus
                placeholder={t("workspaceManager_namePlaceholder")}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          )}
          {mode !== "rename" && (
            <Field>
              <FieldLabel>{t("workspaceManager_color")}</FieldLabel>
              <div className="flex flex-wrap gap-2">
                {WORKSPACE_COLORS.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    aria-label={t("workspaceManager_chooseColor", [candidate])}
                    aria-pressed={color === candidate}
                    autoFocus={mode === "recolor" && candidate === color}
                    className={cn(
                      "size-8 rounded-full bg-linear-to-br transition-all",
                      WORKSPACE_GRADIENTS[candidate],
                      color === candidate
                        ? "ring-2 ring-primary ring-offset-2"
                        : "opacity-50 hover:opacity-100",
                    )}
                    onClick={() => setColor(candidate)}
                  />
                ))}
              </div>
            </Field>
          )}
          {errorMessage && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("workspaceManager_cancel")}
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              {mode === "create"
                ? t("workspaceManager_create")
                : t("workspaceManager_save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface WorkspaceManagerProps {
  open: boolean;
  syncStatus: SyncStatus;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  onOpenChange(open: boolean): void;
}

export function WorkspaceManager({
  open,
  syncStatus,
  returnFocusRef,
  onOpenChange,
}: WorkspaceManagerProps) {
  const { t } = useTranslation();
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const collections = useWorkspaceStore((state) => state.collections);
  const tags = useWorkspaceStore((state) => state.tags);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const setActiveWorkspaceId = useWorkspaceStore((state) => state.setActiveWorkspaceId);
  const createWorkspace = useWorkspaceStore((state) => state.createWorkspace);
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);
  const deleteWorkspace = useWorkspaceStore((state) => state.deleteWorkspace);
  const restoreWorkspace = useWorkspaceStore((state) => state.restoreWorkspace);
  const permanentlyDeleteWorkspace = useWorkspaceStore(
    (state) => state.permanentlyDeleteWorkspace,
  );
  const bookmarks = useBookmarksStore((state) => state.bookmarks);
  const archivedBookmarks = useBookmarksStore((state) => state.archivedBookmarks);
  const trashedBookmarks = useBookmarksStore((state) => state.trashedBookmarks);
  const archivedLoaded = useBookmarksStore((state) => state._archivedLoaded);
  const trashedLoaded = useBookmarksStore((state) => state._trashedLoaded);
  const loadArchivedBookmarks = useBookmarksStore((state) => state.loadArchivedBookmarks);
  const loadTrashedBookmarks = useBookmarksStore((state) => state.loadTrashedBookmarks);
  const groups = useGroupsStore((state) => state.groups);
  const user = useAuthStore((state) => state.user);
  const serverUrl = useAuthStore((state) => state.serverUrl);
  const trashGraceDays = usePlanStore(
    (state) => state.limits?.trash_grace_days ?? 30,
  );
  const planLimits = usePlanStore((state) => state.limits);
  const planUsage = usePlanStore((state) => state.usage);
  const planTrashUsage = usePlanStore((state) => state.trashUsage);
  const planInUseUsage = usePlanStore((state) => state.inUseUsage);
  const setGuestUsage = usePlanStore((state) => state.setGuestUsage);
  const ensurePlanFresh = usePlanStore((state) => state.ensureFresh);

  const [selectedTab, setSelectedTab] = React.useState<WorkspaceManagerTab>("in_use");
  const [capabilitySupported, setCapabilitySupported] = React.useState(user === null);
  const [formState, setFormState] = React.useState<{
    mode: WorkspaceFormMode;
    workspace: Workspace | null;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<WorkspaceManagerCardModel | null>(null);
  const [purgeTarget, setPurgeTarget] = React.useState<WorkspaceManagerCardModel | null>(null);
  const [actionErrorKey, setActionErrorKey] = React.useState<string | null>(null);
  const [loaderState, setLoaderState] = React.useState({
    loading: false,
    error: false,
  });
  const [loaderFence] = React.useState(() => (
    createWorkspaceManagerLoaderFence(setLoaderState)
  ));
  const [loaderSingleFlight] = React.useState(
    createWorkspaceManagerLoaderSingleFlight,
  );
  const [actionGate] = React.useState(createWorkspaceManagerActionGate);
  const [lifecyclePending, setLifecyclePending] = React.useState(false);
  const [browserOnline, setBrowserOnline] = React.useState(() => navigator.onLine);
  const subdialogReturnFocusRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const generation = loaderFence.begin();
    void loaderSingleFlight.run(async () => {
      await Promise.all([loadArchivedBookmarks(), loadTrashedBookmarks()]);
    }).then(() => {
      loaderFence.succeed(generation);
    }).catch(() => {
      loaderFence.fail(generation);
    });
    return () => {
      loaderFence.invalidate(generation);
    };
  }, [
    loadArchivedBookmarks,
    loadTrashedBookmarks,
    loaderFence,
    loaderSingleFlight,
    open,
  ]);

  React.useEffect(() => {
    if (open && user !== null) {
      ensurePlanFresh();
    }
  }, [ensurePlanFresh, open, user]);

  React.useEffect(() => {
    const handleOnline = () => {
      setBrowserOnline(true);
    };
    const handleOffline = () => {
      setBrowserOnline(false);
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  React.useEffect(() => {
    let current = true;
    if (!open) {
      return () => {
        current = false;
      };
    }
    if (!user) {
      setCapabilitySupported(true);
      return () => {
        current = false;
      };
    }
    setCapabilitySupported(false);
    void readWorkspaceLifecycleCapability(serverUrl, user.id).then((supported) => {
      if (current) {
        setCapabilitySupported(Boolean(supported));
      }
    }).catch(() => {
      if (current) {
        setCapabilitySupported(false);
      }
    });
    return () => {
      current = false;
    };
  }, [open, serverUrl, user]);

  const model = React.useMemo(() => createWorkspaceManagerViewModel({
    workspaces,
    collections,
    bookmarks: {
      active: Array.from(bookmarks.values()),
      archived: archivedBookmarks,
      trashed: trashedBookmarks,
    },
    groups,
    now: Date.now(),
    trashGraceDays,
    isGuest: user === null,
  }), [
    archivedBookmarks,
    bookmarks,
    collections,
    groups,
    trashGraceDays,
    trashedBookmarks,
    user,
    workspaces,
  ]);

  const guestQuotaBreakdown = React.useMemo(() => {
    if (user !== null || !archivedLoaded || !trashedLoaded) {
      return null;
    }
    return calculateGuestQuotaUsage({
      workspaces,
      collections,
      bookmarks: Array.from(bookmarks.values()),
      archivedBookmarks,
      trashedBookmarks,
      groups,
      tags,
    });
  }, [
    archivedBookmarks,
    archivedLoaded,
    bookmarks,
    collections,
    groups,
    tags,
    trashedBookmarks,
    trashedLoaded,
    user,
    workspaces,
  ]);

  React.useEffect(() => {
    if (open && guestQuotaBreakdown) {
      setGuestUsage(guestQuotaBreakdown);
    }
  }, [guestQuotaBreakdown, open, setGuestUsage]);

  const authenticatedQuotaBreakdown = React.useMemo<QuotaUsageBreakdown | null>(() => {
    if (!planLimits || !planUsage || !planTrashUsage || !planInUseUsage) {
      return null;
    }
    return {
      total: planUsage,
      trash: planTrashUsage,
      inUse: planInUseUsage,
    };
  }, [planInUseUsage, planLimits, planTrashUsage, planUsage]);
  const quotaBreakdown = user === null
    ? guestQuotaBreakdown
    : authenticatedQuotaBreakdown;

  const availability = React.useMemo(() => ({
    isGuest: user === null,
    isOnline: resolveWorkspaceManagerOnlineStatus(browserOnline, syncStatus),
    capabilitySupported,
    dataReady: archivedLoaded && trashedLoaded && !loaderState.loading,
  }), [
    archivedLoaded,
    browserOnline,
    capabilitySupported,
    loaderState.loading,
    syncStatus,
    trashedLoaded,
    user,
  ]);

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    if (!nextOpen && lifecyclePending) {
      return;
    }
    if (!nextOpen) {
      setActionErrorKey(null);
      setDeleteTarget(null);
      setPurgeTarget(null);
      setFormState(null);
    }
    onOpenChange(nextOpen);
  }, [lifecyclePending, onOpenChange]);

  const handleCreate = React.useCallback(() => {
    subdialogReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setActionErrorKey(null);
    setFormState({ mode: "create", workspace: null });
  }, []);

  const handleRename = React.useCallback((workspaceId: string) => {
    const workspace = model.inUse.find((candidate) => candidate.workspace.id === workspaceId)?.workspace;
    if (workspace) {
      subdialogReturnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      setActionErrorKey(null);
      setFormState({ mode: "rename", workspace });
    }
  }, [model.inUse]);

  const handleRecolor = React.useCallback((workspaceId: string) => {
    const workspace = model.inUse.find((candidate) => candidate.workspace.id === workspaceId)?.workspace;
    if (workspace) {
      subdialogReturnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      setActionErrorKey(null);
      setFormState({ mode: "recolor", workspace });
    }
  }, [model.inUse]);

  const handleFormSubmit = React.useCallback((name: string, color: WorkspaceColor) => {
    if (!formState) {
      return;
    }
    if (formState.mode === "create") {
      const created = createWorkspace(name, color);
      if (!created.id) {
        setActionErrorKey("workspaceManager_createFailed");
        return;
      }
    } else if (formState.workspace) {
      updateWorkspace(
        formState.workspace.id,
        formState.mode === "rename" ? { name } : { color },
      );
    }
    setActionErrorKey(null);
    setFormState(null);
  }, [createWorkspace, formState, updateWorkspace]);

  const handleDeleteRequest = React.useCallback((workspaceId: string) => {
    if (actionGate.isPending()) {
      return;
    }
    const target = model.inUse.find((candidate) => candidate.workspace.id === workspaceId);
    if (target) {
      subdialogReturnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      setActionErrorKey(null);
      setDeleteTarget(target);
    }
  }, [actionGate, model.inUse]);

  const handleConfirmDelete = React.useCallback(async () => {
    if (!deleteTarget || actionGate.isPending()) {
      return;
    }
    const outcome = await executeSerializedWorkspaceManagerAction({
      action: "delete",
      operation: () => deleteWorkspace(deleteTarget.workspace.id),
      gate: actionGate,
      setPending: setLifecyclePending,
    });
    if (!outcome) {
      return;
    }
    if (outcome.shouldClose) {
      setDeleteTarget(null);
      setActionErrorKey(null);
      setSelectedTab("deleted");
      return;
    }
    setActionErrorKey(outcome.messageKey ?? "workspaceManager_actionFailed");
  }, [actionGate, deleteTarget, deleteWorkspace]);

  const handleRestore = React.useCallback(async (workspaceId: string) => {
    if (actionGate.isPending()) {
      return;
    }
    setActionErrorKey(null);
    const outcome = await executeSerializedWorkspaceManagerAction({
      action: "restore",
      operation: () => restoreWorkspace(workspaceId),
      gate: actionGate,
      setPending: setLifecyclePending,
    });
    if (!outcome) {
      return;
    }
    if (outcome.shouldClose) {
      setSelectedTab("in_use");
      requestAnimationFrame(() => {
        document.getElementById("workspace-manager-tab-in-use")?.focus();
      });
      return;
    }
    setActionErrorKey(outcome.messageKey ?? "workspaceManager_actionFailed");
  }, [actionGate, restoreWorkspace]);

  const handlePurgeRequest = React.useCallback((workspaceId: string) => {
    if (actionGate.isPending()) {
      return;
    }
    const target = model.deleted.find((candidate) => candidate.workspace.id === workspaceId);
    if (target) {
      subdialogReturnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      setActionErrorKey(null);
      setPurgeTarget(target);
    }
  }, [actionGate, model.deleted]);

  const handleConfirmPurge = React.useCallback(async () => {
    if (!purgeTarget || actionGate.isPending()) {
      return;
    }
    const outcome = await executeSerializedWorkspaceManagerAction({
      action: "purge",
      operation: () => permanentlyDeleteWorkspace(purgeTarget.workspace.id),
      gate: actionGate,
      setPending: setLifecyclePending,
    });
    if (!outcome) {
      return;
    }
    if (outcome.shouldClose) {
      setPurgeTarget(null);
      setActionErrorKey(null);
      return;
    }
    setActionErrorKey(outcome.messageKey ?? "workspaceManager_actionFailed");
  }, [actionGate, permanentlyDeleteWorkspace, purgeTarget]);

  const purgeAvailability = getWorkspaceLifecycleActionAvailability({
    action: "purge",
    activeWorkspaceCount: model.inUse.length,
    ...availability,
  });
  const errorMessage = actionErrorKey ? t(actionErrorKey) : null;
  const purgeDisabledReason = purgeAvailability.messageKey
    ? t(purgeAvailability.messageKey)
    : null;

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocusRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("workspaceManager_title")}</DialogTitle>
            <DialogDescription>{t("workspaceManager_description")}</DialogDescription>
          </DialogHeader>

          {actionErrorKey && !deleteTarget && !purgeTarget && !formState && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}

          {loaderState.error && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>
                {t("workspaceManager_loadingFailed")}
              </AlertDescription>
            </Alert>
          )}

          <WorkspaceManagerContent
            model={model}
            selectedTab={selectedTab}
            activeWorkspaceId={activeWorkspaceId}
            availability={availability}
            lifecyclePending={lifecyclePending}
            quotaBreakdown={quotaBreakdown}
            quotaLimits={user === null ? null : planLimits}
            onTabChange={setSelectedTab}
            onCreate={handleCreate}
            onSwitch={setActiveWorkspaceId}
            onRename={handleRename}
            onRecolor={handleRecolor}
            onDelete={handleDeleteRequest}
            onRestore={handleRestore}
            onPermanentlyDelete={handlePurgeRequest}
          />
        </DialogContent>
      </Dialog>

      <WorkspaceFormDialog
        open={formState !== null}
        mode={formState?.mode ?? "create"}
        workspace={formState?.workspace ?? null}
        errorMessage={formState ? errorMessage : null}
        returnFocusRef={subdialogReturnFocusRef}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setFormState(null);
            setActionErrorKey(null);
          }
        }}
        onSubmit={handleFormSubmit}
      />

      <DeleteWorkspaceDialog
        open={deleteTarget !== null}
        confirmation={deleteTarget
          ? createDeleteWorkspaceConfirmation(deleteTarget)
          : null}
        retentionLabel={deleteTarget
          ? formatRetention(deleteTarget.retention, t)
          : ""}
        errorMessage={deleteTarget ? errorMessage : null}
        busy={lifecyclePending}
        returnFocusRef={subdialogReturnFocusRef}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !lifecyclePending) {
            setDeleteTarget(null);
            setActionErrorKey(null);
          }
        }}
        onConfirm={() => {
          void handleConfirmDelete();
        }}
      />

      <PermanentDeleteWorkspaceDialog
        open={purgeTarget !== null}
        workspace={purgeTarget?.workspace ?? null}
        errorMessage={purgeTarget ? errorMessage : null}
        disabledReason={purgeDisabledReason}
        busy={lifecyclePending}
        returnFocusRef={subdialogReturnFocusRef}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !lifecyclePending) {
            setPurgeTarget(null);
            setActionErrorKey(null);
          }
        }}
        onConfirm={() => {
          void handleConfirmPurge();
        }}
      />
    </>
  );
}

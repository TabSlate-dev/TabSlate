import * as React from "react";
import { AlertCircle, ArrowLeft, CheckCircle2, FileJson, FileText, Loader2, Upload } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { buildChromeImportPlan, parseChromeHTML, validateChromeFile } from "@/lib/import-chrome";
import { buildTobyImportPlan, parseTobyJSON, validateTobyFile } from "@/lib/import-toby";
import type { ImportPlan, ValidationResult } from "@/lib/import-types";
import { cn } from "@/lib/utils";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { usePlanStore } from "@/store/plan-store";
import { useWorkspaceStore } from "@/store/workspace-store";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "@/hooks/use-translation";

type ImportStep = 0 | 1 | 2 | 3;
type ImportSource = "toby" | "chrome";
type ValidationPhase = "idle" | "validating" | "complete";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ImportSuccessResult {
  status: "success";
  collectionsCreated: number;
  bookmarksImported: number;
  tagsCreated: number;
  duplicatesSkipped: number;
  rejectedUrls: string[];
}

interface ImportErrorResult {
  status: "error";
  message: string;
}

type ImportResultState = ImportSuccessResult | ImportErrorResult | null;

const EMPTY_IMPORT_PLAN: ImportPlan = {
  collections: [],
  bookmarks: [],
  tags: [],
  duplicatesSkipped: 0,
  rejectedUrls: [],
};

const SOURCE_LABEL: Record<ImportSource, string> = {
  toby: "Toby",
  chrome: "Chrome Bookmarks",
};

const SOURCE_ACCEPT: Record<ImportSource, string> = {
  toby: ".json",
  chrome: ".html,.htm",
};

const SOURCE_FILE_HINT: Record<ImportSource, string> = {
  toby: "Upload a Toby JSON export.",
  chrome: "Upload a Chrome bookmarks HTML export.",
};

function detectMismatchSource(source: ImportSource, file: File): ImportSource | null {
  const lowerName = file.name.toLowerCase();

  if (source === "toby" && (lowerName.endsWith(".html") || lowerName.endsWith(".htm"))) {
    return "chrome";
  }

  if (source === "chrome" && lowerName.endsWith(".json")) {
    return "toby";
  }

  return null;
}

function getStepDescription(step: ImportStep, source: ImportSource | null, t: any): string {
  if (step === 0) {
    return t("import_step0_desc");
  }

  if (step === 1 && source) {
    return t("import_step1_desc", [SOURCE_LABEL[source]]);
  }

  if (step === 2) {
    return t("import_step2_desc");
  }

  return t("import_step3_desc");
}

function getDialogTitle(
  step: ImportStep,
  source: ImportSource | null,
  resultStatus: "success" | "error" | null,
  t: any,
): string {
  if (step === 0) { return t("import_title"); }
  if (step === 1) { return source ? t("import_titleSource", [SOURCE_LABEL[source]]) : t("import_title"); }
  if (step === 2) { return t("import_titleConfig"); }
  return resultStatus === "error" ? t("import_titleFailed") : t("import_titleComplete");
}

function SourceCard({
  description,
  icon,
  title,
  onClick,
}: {
  description: string;
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="mt-0.5 rounded-md bg-muted p-2 text-muted-foreground">
        {icon}
      </div>
      <div className="space-y-1">
        <div className="font-medium">{title}</div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}

function SummaryStat({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export function ImportDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const collections = useWorkspaceStore((state) => state.collections);
  const tags = useWorkspaceStore((state) => state.tags);
  const importFromPlan = useWorkspaceStore((state) => state.importFromPlan);
  const bookmarks = useBookmarksStore((state) => state.bookmarks);
  const checkQuota = usePlanStore((state) => state.checkQuota);

  const activeWorkspaces = React.useMemo(
    () =>
      workspaces
        .filter((workspace) => !workspace.deletedAt)
        .sort((left, right) => left.position - right.position),
    [workspaces],
  );

  const activeCollections = React.useMemo(
    () =>
      collections
        .filter((collection) => !collection.deletedAt && !collection.archivedAt)
        .sort((left, right) => {
          if (left.isDefault) return -1;
          if (right.isDefault) return 1;
          return right.position - left.position;
        }),
    [collections],
  );

  const existingBookmarkUrls = React.useMemo(() => {
    const urls = new Set<string>();

    for (const bookmark of bookmarks) {
      const url = bookmark.url.trim();
      if (url.length === 0) {
        continue;
      }

      urls.add(url);
    }

    return urls;
  }, [bookmarks]);

  const existingTagsForPlan = React.useMemo(
    () => tags.map((tag) => ({ id: tag.id, name: tag.name })),
    [tags],
  );

  const [step, setStep] = React.useState<ImportStep>(0);
  const [source, setSource] = React.useState<ImportSource | null>(null);
  const [workspaceId, setWorkspaceId] = React.useState("");
  const [skipDuplicates, setSkipDuplicates] = React.useState(true);
  const [rawContent, setRawContent] = React.useState("");
  const [validation, setValidation] = React.useState<ValidationResult | null>(null);
  const [validationPhase, setValidationPhase] = React.useState<ValidationPhase>("idle");
  const [mismatchSource, setMismatchSource] = React.useState<ImportSource | null>(null);
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null);
  const [selectedFileName, setSelectedFileName] = React.useState("");
  const [isDragging, setIsDragging] = React.useState(false);
  const [isImporting, setIsImporting] = React.useState(false);
  const [result, setResult] = React.useState<ImportResultState>(null);

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const validationRequestRef = React.useRef(0);

  const resetState = React.useCallback(() => {
    validationRequestRef.current += 1;
    setStep(0);
    setSource(null);
    setWorkspaceId("");
    setSkipDuplicates(true);
    setRawContent("");
    setValidation(null);
    setValidationPhase("idle");
    setMismatchSource(null);
    setSelectedFile(null);
    setSelectedFileName("");
    setIsDragging(false);
    setIsImporting(false);
    setResult(null);
  }, []);

  const wasOpenRef = React.useRef(false);

  React.useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      resetState();
      return;
    }

    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      setWorkspaceId(activeWorkspaceId ?? "");
    }
  }, [activeWorkspaceId, open, resetState]);

  const startPosition = React.useMemo(() => {
    const wsCollections = activeCollections.filter((c) => c.workspaceId === workspaceId);
    return wsCollections.reduce((max, c) => Math.max(max, c.position), -1) + 1;
  }, [activeCollections, workspaceId]);

  const importPlan = React.useMemo(() => {
    if (!source || !workspaceId || !validation?.valid || rawContent.length === 0) {
      return EMPTY_IMPORT_PLAN;
    }

    if (source === "toby") {
      try {
        return buildTobyImportPlan(
          parseTobyJSON(JSON.parse(rawContent)),
          workspaceId,
          existingBookmarkUrls,
          existingTagsForPlan,
          skipDuplicates,
          startPosition,
        );
      } catch {
        return EMPTY_IMPORT_PLAN;
      }
    }

    return buildChromeImportPlan(
      parseChromeHTML(rawContent),
      workspaceId,
      existingBookmarkUrls,
      skipDuplicates,
      startPosition,
    );
  }, [
    existingBookmarkUrls,
    existingTagsForPlan,
    rawContent,
    skipDuplicates,
    source,
    startPosition,
    validation?.valid,
    workspaceId,
  ]);

  const hasValidPlan = React.useMemo(
    () => importPlan.bookmarks.length > 0,
    [importPlan.bookmarks.length],
  );

  const bookmarkQuotaOk = React.useMemo(() => {
    if (importPlan.bookmarks.length === 0) {
      return true;
    }

    return checkQuota("bookmark", bookmarks.length + importPlan.bookmarks.length - 1);
  }, [bookmarks.length, checkQuota, importPlan.bookmarks.length]);

  const collectionQuotaOk = React.useMemo(() => {
    if (importPlan.collections.length === 0) {
      return true;
    }

    return checkQuota("collection", activeCollections.length + importPlan.collections.length - 1);
  }, [activeCollections.length, checkQuota, importPlan.collections.length]);

  const importBlockedMessage = React.useMemo(() => {
    if (!workspaceId) {
      return t("import_blockedWorkspace");
    }

    if (!validation?.valid || rawContent.length === 0) {
      return t("import_blockedValid");
    }

    if (!hasValidPlan) {
      return t("import_blockedNew");
    }

    if (!collectionQuotaOk) {
      return t("import_blockedCollectionQuota");
    }

    if (!bookmarkQuotaOk) {
      return t("import_blockedBookmarkQuota");
    }

    return null;
  }, [
    bookmarkQuotaOk,
    collectionQuotaOk,
    hasValidPlan,
    rawContent.length,
    validation?.valid,
    workspaceId,
  ]);

  const canProceedFromUpload = validation?.valid === true && rawContent.length > 0;
  const canImport = !isImporting && importBlockedMessage === null;
  const stepDescription = getStepDescription(step, source, t);
  const dialogTitle = getDialogTitle(step, source, result?.status ?? null, t);

  const handleSourceSelect = React.useCallback((nextSource: ImportSource) => {
    setSource(nextSource);
    setStep(1);
    setRawContent("");
    setValidation(null);
    setValidationPhase("idle");
    setMismatchSource(null);
    setSelectedFile(null);
    setSelectedFileName("");
    setResult(null);
  }, []);

  const handleBrowse = React.useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const validateFile = React.useCallback(
    async (file: File, nextSource: ImportSource) => {
      const requestId = validationRequestRef.current + 1;
      validationRequestRef.current = requestId;

      setSelectedFile(file);
      setSelectedFileName(file.name);
      setValidationPhase("validating");
      setValidation(null);
      setRawContent("");
      setMismatchSource(null);
      setResult(null);

      const nextValidation = nextSource === "toby"
        ? await validateTobyFile(file)
        : await validateChromeFile(file);

      if (validationRequestRef.current !== requestId) {
        return;
      }

      const nextMismatchSource = nextValidation.valid ? null : detectMismatchSource(nextSource, file);
      setMismatchSource(nextMismatchSource);
      setValidation(nextValidation);
      setValidationPhase("complete");

      if (!nextValidation.valid) {
        return;
      }

      const text = await file.text();
      if (validationRequestRef.current !== requestId) {
        return;
      }

      setRawContent(text);
    },
    [],
  );

  const handleFileSelection = React.useCallback(async (file: File) => {
    if (!source) {
      return;
    }

    await validateFile(file, source);
  }, [source, validateFile]);

  const handleFileInputChange = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";

      if (!file) {
        return;
      }

      await handleFileSelection(file);
    },
    [handleFileSelection],
  );

  const handleDrop = React.useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);

      const file = event.dataTransfer.files?.[0];
      if (!file) {
        return;
      }

      await handleFileSelection(file);
    },
    [handleFileSelection],
  );

  const handleDropZoneKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    handleBrowse();
  }, [handleBrowse]);

  const handleSwitchSource = React.useCallback(async () => {
    if (!mismatchSource) {
      return;
    }

    setSource(mismatchSource);
    setStep(1);

    if (selectedFile) {
      await validateFile(selectedFile, mismatchSource);
      return;
    }

    setValidation(null);
    setValidationPhase("idle");
    setMismatchSource(null);
    setRawContent("");
  }, [mismatchSource, selectedFile, validateFile]);

  const handleImport = React.useCallback(() => {
    if (!canImport) {
      return;
    }

    setIsImporting(true);

    // Yield to browser so the spinner renders before the synchronous import runs.
    setTimeout(() => {
      try {
        const imported = importFromPlan(importPlan);
        if (!imported) {
          setResult({
            status: "error",
            message: "Import could not start because the current quota no longer allows it.",
          });
          setStep(3);
          return;
        }

        setResult({
          status: "success",
          collectionsCreated: importPlan.collections.length,
          bookmarksImported: importPlan.bookmarks.length,
          tagsCreated: importPlan.tags.length,
          duplicatesSkipped: importPlan.duplicatesSkipped,
          rejectedUrls: importPlan.rejectedUrls,
        });
        setStep(3);
      } catch {
        setResult({
          status: "error",
          message: "Import failed unexpectedly. Try again with the same file.",
        });
        setStep(3);
      } finally {
        setIsImporting(false);
      }
    }, 0);
  }, [canImport, importFromPlan, importPlan]);

  const handleRetry = React.useCallback(() => {
    setResult(null);
    setStep(1);
  }, []);

  const selectedSourceLabel = source ? SOURCE_LABEL[source] : "";
  const selectedSourceHint = source ? t(source === "toby" ? "import_tobyHint" : "import_chromeHint") : "";
  const selectedAccept = source ? SOURCE_ACCEPT[source] : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>
            <span className="mr-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Step {step + 1} of 4
            </span>
            {stepDescription}
          </DialogDescription>
        </DialogHeader>

        {step === 0 && (
          <div className="space-y-3">
            <SourceCard
              title="Toby"
              description={t("import_tobyDesc")}
              icon={<FileJson className="size-4" />}
              onClick={() => handleSourceSelect("toby")}
            />
            <SourceCard
              title="Chrome Bookmarks"
              description={t("import_chromeDesc")}
              icon={<FileText className="size-4" />}
              onClick={() => handleSourceSelect("chrome")}
            />
          </div>
        )}

        {step === 1 && source && (
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="text-sm font-medium">{selectedSourceLabel}</div>
              <p className="text-xs text-muted-foreground">{selectedSourceHint}</p>
            </div>

            <div
              role="button"
              tabIndex={0}
              onClick={handleBrowse}
              onKeyDown={handleDropZoneKeyDown}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => {
                setIsDragging(false);
              }}
              onDrop={handleDrop}
              className={cn(
                "rounded-lg border border-dashed p-6 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isDragging ? "border-primary bg-primary/5" : "border-border hover:bg-accent/40",
              )}
            >
              <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Upload className="size-4" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">{t("import_dragDrop")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("import_accepts", [selectedAccept])}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={(event) => {
                  event.stopPropagation();
                  handleBrowse();
                }}
              >
                {t("import_chooseFile")}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept={selectedAccept}
                className="sr-only"
                onChange={(event) => {
                  void handleFileInputChange(event);
                }}
              />
            </div>

            {selectedFileName && (
              <p className="text-xs text-muted-foreground">
                {t("import_selectedFile")} <span className="font-medium text-foreground">{selectedFileName}</span>
              </p>
            )}

            {validationPhase === "validating" && (
              <Alert variant="info">
                <Loader2 className="animate-spin" />
                <AlertTitle>{t("import_validating")}</AlertTitle>
                <AlertDescription>
                  {t("import_validatingDesc")}
                </AlertDescription>
              </Alert>
            )}

            {validationPhase === "complete" && validation?.valid && validation.preview && (
              <Alert variant="info">
                <CheckCircle2 />
                <AlertTitle>{t("import_looksGood")}</AlertTitle>
                <AlertDescription>
                  <p>
                    {t("import_looksGoodDesc", [
                      validation.preview.bookmarks.toString(),
                      validation.preview.collections.toString()
                    ])}
                  </p>
                </AlertDescription>
              </Alert>
            )}

            {validationPhase === "complete" && validation && !validation.valid && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>{t("import_validationFailed")}</AlertTitle>
                <AlertDescription>
                  <p>{validation.error}</p>
                  {mismatchSource && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto px-0 text-current"
                      onClick={() => {
                        void handleSwitchSource();
                      }}
                    >
                      {t("import_switchTo", [SOURCE_LABEL[mismatchSource]])}
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setStep(0)}>
                <ArrowLeft className="size-4" />
                {t("import_back")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!canProceedFromUpload}
                onClick={() => setStep(2)}
              >
                {t("import_next")}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 2 && source && (
          <div className="space-y-4">
            <Field>
              <FieldLabel htmlFor="import-workspace">{t("import_workspace")}</FieldLabel>
              <Select value={workspaceId} onValueChange={setWorkspaceId}>
                <SelectTrigger id="import-workspace">
                  <SelectValue placeholder={t("import_selectWorkspace")} />
                </SelectTrigger>
                <SelectContent>
                  {activeWorkspaces.map((workspace) => (
                    <SelectItem key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {t("import_workspaceDesc")}
              </FieldDescription>
            </Field>

            <Field orientation="horizontal">
              <div className="space-y-1">
                <FieldLabel htmlFor="skip-duplicates">{t("import_skipDuplicates")}</FieldLabel>
                <FieldDescription>
                  {t("import_skipDuplicatesDesc")}
                </FieldDescription>
              </div>
              <Switch
                id="skip-duplicates"
                checked={skipDuplicates}
                onCheckedChange={setSkipDuplicates}
              />
            </Field>

            <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
              <div className="text-sm font-medium">{t("import_summary")}</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <SummaryStat label={t("import_statCollections")} value={importPlan.collections.length} />
                <SummaryStat label={t("import_statBookmarks")} value={importPlan.bookmarks.length} />
                {source === "toby" && (
                  <SummaryStat label={t("import_statTags")} value={importPlan.tags.length} />
                )}
                <SummaryStat label={t("import_statDuplicates")} value={importPlan.duplicatesSkipped} />
              </div>
              {importPlan.rejectedUrls.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("import_rejectedUrlsDesc", [importPlan.rejectedUrls.length.toString()])}
                </p>
              )}
            </div>

            {importBlockedMessage && (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>{t("import_unavailable")}</AlertTitle>
                <AlertDescription>{importBlockedMessage}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setStep(1)}>
                <ArrowLeft className="size-4" />
                {t("import_back")}
              </Button>
              <Button type="button" size="sm" disabled={!canImport} onClick={handleImport}>
                {isImporting && <Loader2 className="size-4 animate-spin" />}
                {t("import_btnImport")}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 3 && result && (
          <div className="space-y-4">
            {result.status === "success" ? (
              <>
                <Alert variant="success">
                  <CheckCircle2 />
                  <AlertTitle>{t("import_titleComplete")}</AlertTitle>
                  <AlertDescription>
                    {t("import_completeDesc")}
                  </AlertDescription>
                </Alert>

                <div className="grid grid-cols-2 gap-3">
                  <SummaryStat label={t("import_statCollectionsCreated")} value={result.collectionsCreated} />
                  <SummaryStat label={t("import_statBookmarksImported")} value={result.bookmarksImported} />
                  <SummaryStat label={t("import_statTagsCreated")} value={result.tagsCreated} />
                  <SummaryStat label={t("import_statDuplicates")} value={result.duplicatesSkipped} />
                </div>

                {result.rejectedUrls.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">{t("import_rejectedUrls")}</div>
                    <div className="max-h-40 overflow-y-auto rounded-md border bg-muted/20 p-3">
                      <ul className="space-y-1 text-xs text-muted-foreground">
                        {result.rejectedUrls.map((url) => (
                          <li key={url} className="break-all font-mono">
                            {url}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}

                <DialogFooter>
                  <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
                    {t("import_close")}
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertTitle>{t("import_titleFailed")}</AlertTitle>
                  <AlertDescription>{result.message}</AlertDescription>
                </Alert>

                <DialogFooter>
                  <Button type="button" variant="outline" size="sm" onClick={handleRetry}>
                    {t("import_tryAgain")}
                  </Button>
                  <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
                    {t("import_close")}
                  </Button>
                </DialogFooter>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

# Bookmark Import Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified import dialog in Settings that lets users import bookmarks from Toby (JSON) or Chrome Bookmarks (HTML) into a chosen workspace.

**Architecture:** All parsing is client-side only — raw files never reach the server. Pure parser functions in `lib/` produce a shared `ImportPlan` shape; a new `importFromPlan` store action in `workspace-store` bulk-writes to IDB and enqueues sync. A four-step `ImportDialog` component handles source selection, file upload, configuration, and result display.

**Tech Stack:** TypeScript, React, Zustand, IndexedDB (`lib/idb.ts`), WXT Chrome extension. No test infrastructure exists — use `bun run compile` to verify TypeScript after each task and `bun run build` to verify final integration.

**Verification commands:**
- `bun run compile` — TypeScript type check only, no output artifact
- `bun run build` — full build, confirms everything wires up

---

## File Map

| Status | File | Change |
|---|---|---|
| Create | `lib/import-types.ts` | Shared `ImportPlan`, `ValidationResult` types |
| Create | `lib/import-toby.ts` | Toby JSON parser + plan builder |
| Create | `lib/import-chrome.ts` | Chrome HTML parser + plan builder |
| Modify | `store/bookmarks-store.ts` | Add `_bulkAddBookmarks` action (no quota check) |
| Modify | `store/workspace-store.ts` | Add `importFromPlan` action |
| Create | `components/dashboard/import-dialog.tsx` | Unified 4-step import dialog |
| Modify | `components/dashboard/settings-dialog.tsx` | Add "Import Bookmarks" button |

---

## Task 1: Shared types (`lib/import-types.ts`)

**Files:**
- Create: `lib/import-types.ts`

- [ ] **Step 1: Create the file**

```ts
import type { Bookmark, Collection, Tag } from "@/lib/types";

export interface ValidationResult {
  valid: boolean;
  error?: string;
  preview?: { collections: number; bookmarks: number };
}

export interface ImportPlan {
  collections: Omit<Collection, "seq">[];
  bookmarks: Omit<Bookmark, "seq">[];
  tags: Omit<Tag, "seq">[];
  duplicatesSkipped: number;
  rejectedUrls: string[];
}
```

- [ ] **Step 2: Type-check**

```bash
bun run compile
```
Expected: no errors.

---

## Task 2: Toby parser (`lib/import-toby.ts`)

**Files:**
- Create: `lib/import-toby.ts`

- [ ] **Step 1: Create the file**

```ts
import type { Bookmark, Collection, Tag } from "@/lib/types";
import { generateId } from "@/lib/id";
import type { ImportPlan, ValidationResult } from "@/lib/import-types";

const SAFE_SCHEMES = new Set(["http:", "https:", "ftp:", "ftps:"]);
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 500;
const MAX_DESC_LENGTH = 2000;

interface TobyCard {
  title?: string;
  url?: string;
  customTitle?: string;
  customDescription?: string;
}

interface TobyList {
  title?: string;
  cards?: TobyCard[];
  labels?: string[];
}

interface TobyImport {
  version: number;
  lists: TobyList[];
}

export function parseTobyJSON(raw: unknown): TobyImport | null {
  if (typeof raw !== "object" || raw === null) { return null; }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== "number") { return null; }
  if (!Array.isArray(obj.lists)) { return null; }
  return obj as unknown as TobyImport;
}

function isSafeUrl(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) { return false; }
  try {
    return SAFE_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export async function validateTobyFile(file: File): Promise<ValidationResult> {
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: "File too large. Toby exports are typically under 5 MB." };
  }
  if (!file.name.toLowerCase().endsWith(".json")) {
    return { valid: false, error: "Unrecognized format. Please export from Toby as JSON (not HTML)." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return { valid: false, error: "This doesn't look like a Toby export file." };
  }
  const toby = parseTobyJSON(parsed);
  if (!toby) {
    return { valid: false, error: "Unrecognized format. Please export from Toby as JSON (not HTML)." };
  }
  if (toby.version !== 3) {
    return { valid: false, error: "Unsupported Toby format version. Only v3 is supported." };
  }
  const nonEmpty = toby.lists.filter(l => (l.cards ?? []).length > 0);
  if (nonEmpty.length === 0) {
    return { valid: false, error: "This export file contains no collections to import." };
  }
  const bookmarkCount = toby.lists.reduce((n, l) => n + (l.cards ?? []).length, 0);
  return { valid: true, preview: { collections: nonEmpty.length, bookmarks: bookmarkCount } };
}

export function buildTobyImportPlan(
  raw: unknown,
  workspaceId: string,
  existingBookmarkUrls: Set<string>,
  existingTags: { id: string; name: string }[],
  skipDuplicates: boolean,
): ImportPlan {
  const toby = parseTobyJSON(raw)!;
  const tagMap = new Map<string, string>();
  for (const t of existingTags) {
    tagMap.set(t.name.toLowerCase(), t.id);
  }
  const newTags: Omit<Tag, "seq">[] = [];
  const collections: Omit<Collection, "seq">[] = [];
  const bookmarks: Omit<Bookmark, "seq">[] = [];
  const rejectedUrls: string[] = [];
  let duplicatesSkipped = 0;
  let position = 0;

  for (const list of toby.lists) {
    const cards = list.cards ?? [];
    if (cards.length === 0) { continue; }

    const tagIds: string[] = [];
    for (const label of (list.labels ?? [])) {
      const key = label.toLowerCase();
      if (tagMap.has(key)) {
        tagIds.push(tagMap.get(key)!);
      } else {
        const id = generateId();
        tagMap.set(key, id);
        newTags.push({ id, name: label, color: "bg-blue-500/10 text-blue-500" });
        tagIds.push(id);
      }
    }

    const colId = generateId();
    collections.push({
      id: colId,
      workspaceId,
      name: (list.title ?? "Untitled").slice(0, MAX_TITLE_LENGTH),
      icon: "",
      position: position++,
    });

    for (const card of cards) {
      const url = (card.url ?? "").trim();
      if (!isSafeUrl(url)) {
        if (url) { rejectedUrls.push(url); }
        continue;
      }
      if (skipDuplicates && existingBookmarkUrls.has(url)) {
        duplicatesSkipped++;
        continue;
      }
      bookmarks.push({
        id: generateId(),
        title: (card.customTitle || card.title || url).slice(0, MAX_TITLE_LENGTH),
        url,
        description: (card.customDescription ?? "").slice(0, MAX_DESC_LENGTH),
        favicon: "",
        collectionId: colId,
        tags: tagIds,
        createdAt: new Date().toISOString(),
        isFavorite: false,
      });
    }
  }

  return { collections, bookmarks, tags: newTags, duplicatesSkipped, rejectedUrls };
}
```

- [ ] **Step 2: Type-check**

```bash
bun run compile
```
Expected: no errors.

---

## Task 3: Chrome parser (`lib/import-chrome.ts`)

**Files:**
- Create: `lib/import-chrome.ts`

- [ ] **Step 1: Create the file**

```ts
import type { Bookmark, Collection } from "@/lib/types";
import { generateId } from "@/lib/id";
import type { ImportPlan, ValidationResult } from "@/lib/import-types";

const SAFE_SCHEMES = new Set(["http:", "https:", "ftp:", "ftps:"]);
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 500;
const NETSCAPE_DOCTYPE = "NETSCAPE-Bookmark-file-1";
const SKIP_ROOT_FOLDERS = new Set(["mobile bookmarks"]);

function isSafeUrl(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) { return false; }
  try {
    return SAFE_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

interface ParsedCollection {
  name: string;
  items: { title: string; url: string }[];
}

export function parseChromeHTML(html: string): ParsedCollection[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const result: ParsedCollection[] = [];
  const usedNames = new Set<string>();

  function allocateName(preferred: string): string {
    if (!usedNames.has(preferred)) { usedNames.add(preferred); return preferred; }
    let i = 2;
    while (usedNames.has(`${preferred} (${i})`)) { i++; }
    const name = `${preferred} (${i})`;
    usedNames.add(name);
    return name;
  }

  function collectBookmarks(dlEl: Element, target: ParsedCollection) {
    for (const dt of Array.from(dlEl.children)) {
      if (dt.tagName !== "DT") { continue; }
      const anchor = dt.querySelector(":scope > a");
      if (anchor) {
        target.items.push({
          title: anchor.textContent?.trim() ?? "",
          url: anchor.getAttribute("href") ?? "",
        });
      } else {
        const nestedDL = dt.querySelector(":scope > dl");
        if (nestedDL) { collectBookmarks(nestedDL, target); }
      }
    }
  }

  const rootDL = doc.querySelector("dl");
  if (!rootDL) { return result; }

  for (const rootDT of Array.from(rootDL.children)) {
    if (rootDT.tagName !== "DT") { continue; }
    const rootH3 = rootDT.querySelector(":scope > h3");
    if (!rootH3) { continue; }
    const rootFolderName = rootH3.textContent?.trim() ?? "";
    if (SKIP_ROOT_FOLDERS.has(rootFolderName.toLowerCase())) { continue; }

    const rootDLEl = rootDT.querySelector(":scope > dl");
    if (!rootDLEl) { continue; }

    let rootCol: ParsedCollection | null = null;

    for (const dt of Array.from(rootDLEl.children)) {
      if (dt.tagName !== "DT") { continue; }
      const anchor = dt.querySelector(":scope > a");
      const h3 = dt.querySelector(":scope > h3");

      if (anchor) {
        if (rootCol === null) {
          rootCol = { name: allocateName(rootFolderName), items: [] };
          result.push(rootCol);
        }
        rootCol.items.push({
          title: anchor.textContent?.trim() ?? "",
          url: anchor.getAttribute("href") ?? "",
        });
      } else if (h3) {
        const subName = h3.textContent?.trim() ?? "";
        const col: ParsedCollection = { name: allocateName(subName), items: [] };
        result.push(col);
        const subDL = dt.querySelector(":scope > dl");
        if (subDL) { collectBookmarks(subDL, col); }
      }
    }
  }

  return result;
}

export async function validateChromeFile(file: File): Promise<ValidationResult> {
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: "File too large. Chrome bookmark exports are typically under 10 MB." };
  }
  const ext = file.name.toLowerCase();
  if (!ext.endsWith(".html") && !ext.endsWith(".htm")) {
    return {
      valid: false,
      error: "Please upload an HTML file. Export from Chrome: Bookmarks Manager → ⋮ → Export bookmarks.",
    };
  }
  const text = await file.text();
  if (!text.slice(0, 256).includes(NETSCAPE_DOCTYPE)) {
    return { valid: false, error: "This doesn't look like a Chrome bookmarks export file." };
  }
  const collections = parseChromeHTML(text).filter(c => c.items.length > 0);
  const bookmarkCount = collections.reduce((n, c) => n + c.items.length, 0);
  if (bookmarkCount === 0) {
    return { valid: false, error: "This export file contains no bookmarks to import." };
  }
  return { valid: true, preview: { collections: collections.length, bookmarks: bookmarkCount } };
}

export function buildChromeImportPlan(
  html: string,
  workspaceId: string,
  existingBookmarkUrls: Set<string>,
  skipDuplicates: boolean,
): ImportPlan {
  const parsed = parseChromeHTML(html);
  const collections: Omit<Collection, "seq">[] = [];
  const bookmarks: Omit<Bookmark, "seq">[] = [];
  const rejectedUrls: string[] = [];
  let duplicatesSkipped = 0;
  let position = 0;

  for (const col of parsed) {
    if (col.items.length === 0) { continue; }
    const colId = generateId();
    collections.push({ id: colId, workspaceId, name: col.name, icon: "", position: position++ });

    for (const item of col.items) {
      const url = item.url.trim();
      if (!isSafeUrl(url)) {
        if (url) { rejectedUrls.push(url); }
        continue;
      }
      if (skipDuplicates && existingBookmarkUrls.has(url)) {
        duplicatesSkipped++;
        continue;
      }
      bookmarks.push({
        id: generateId(),
        title: (item.title || url).slice(0, MAX_TITLE_LENGTH),
        url,
        description: "",
        favicon: "",
        collectionId: colId,
        tags: [],
        createdAt: new Date().toISOString(),
        isFavorite: false,
      });
    }
  }

  return { collections, bookmarks, tags: [], duplicatesSkipped, rejectedUrls };
}
```

- [ ] **Step 2: Type-check**

```bash
bun run compile
```
Expected: no errors.

---

## Task 4: Add `_bulkAddBookmarks` to bookmarks store

**Files:**
- Modify: `store/bookmarks-store.ts`

This action bypasses quota checks — quota is verified once upstream in `importFromPlan`. It mirrors the write pattern of `addBookmarks` but skips `planStore` calls.

- [ ] **Step 1: Add to the `BookmarksState` interface** (after `addBookmarks` at line ~100)

```ts
_bulkAddBookmarks: (bookmarks: Bookmark[]) => void;
```

The interface block to edit is at `store/bookmarks-store.ts:100`. Add the new line directly after `addBookmarks: (bookmarks: Bookmark[]) => void;`:

```ts
  addBookmarks: (bookmarks: Bookmark[]) => void;
  _bulkAddBookmarks: (bookmarks: Bookmark[]) => void;   // ← add this line
```

- [ ] **Step 2: Add the implementation** after the `addBookmarks` implementation in the store body

Find the `addBookmarks` implementation (ends around the `planStore.incrementUsage` call). Add `_bulkAddBookmarks` immediately after it:

```ts
_bulkAddBookmarks: (newBookmarks) => {
  if (newBookmarks.length === 0) { return; }
  set((s) => ({ bookmarks: [...newBookmarks, ...s.bookmarks] }));
  for (const b of newBookmarks) { idbPut("bookmarks", b); }
  syncEngine?.enqueue({ bookmarks: newBookmarks.map(b => toServerBookmark(b)) });
},
```

- [ ] **Step 3: Type-check**

```bash
bun run compile
```
Expected: no errors.

---

## Task 5: Add `importFromPlan` to workspace store

**Files:**
- Modify: `store/workspace-store.ts`

- [ ] **Step 1: Add `ImportPlan` import** at the top of the file, after the existing imports:

```ts
import type { ImportPlan } from "@/lib/import-types";
```

- [ ] **Step 2: Add to the `WorkspaceState` interface** (after `deleteTag` around line ~155)

```ts
  deleteTag: (id: string) => void;
  importFromPlan: (plan: ImportPlan) => boolean;   // ← add this line
```

- [ ] **Step 3: Add the implementation** in the store body, after `deleteTag`:

```ts
importFromPlan: (plan) => {
  const planStore = usePlanStore.getState();
  planStore.ensureFresh();

  const bookmarkCount = useBookmarksStore.getState().bookmarks.length;
  const activeCollectionCount = get().collections.filter(c => !c.deletedAt && !c.archivedAt).length;

  if (!planStore.checkQuota("bookmark", bookmarkCount + plan.bookmarks.length)) {
    planStore.showQuotaAlert("bookmark");
    return false;
  }
  if (!planStore.checkQuota("collection", activeCollectionCount + plan.collections.length)) {
    planStore.showQuotaAlert("collection");
    return false;
  }

  const newTags = plan.tags.map(t => ({ ...t, seq: 0 as const }));
  if (newTags.length > 0) {
    set((s) => ({ tags: [...s.tags, ...newTags] }));
    for (const t of newTags) { idbPut("tags", t); }
    syncEngine?.enqueue({ tags: newTags.map(t => toServerTag(t)) });
    planStore.incrementUsage("tag", newTags.length);
  }

  const newCols = plan.collections.map(c => ({ ...c, seq: 0 as const }));
  if (newCols.length > 0) {
    set((s) => ({ collections: [...s.collections, ...newCols] }));
    for (const c of newCols) { idbPut("collections", c); }
    syncEngine?.enqueue({ collections: newCols.map(c => toServerCollection(c)) });
    planStore.incrementUsage("collection", newCols.length);
  }

  const newBookmarks = plan.bookmarks.map(b => ({ ...b, seq: 0 as const }));
  if (newBookmarks.length > 0) {
    useBookmarksStore.getState()._bulkAddBookmarks(newBookmarks);
    planStore.incrementUsage("bookmark", newBookmarks.length);
  }

  return true;
},
```

- [ ] **Step 4: Type-check**

```bash
bun run compile
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/import-types.ts lib/import-toby.ts lib/import-chrome.ts store/bookmarks-store.ts store/workspace-store.ts
git commit -m "feat: add bookmark import parsers and importFromPlan store action"
```

---

## Task 6: Create `ImportDialog` component

**Files:**
- Create: `components/dashboard/import-dialog.tsx`

- [ ] **Step 1: Create the full component**

```tsx
import { useState, useEffect, useMemo, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useWorkspaceStore } from "@/store/workspace-store";
import { useBookmarksStore } from "@/store/bookmarks-store";
import { usePlanStore } from "@/store/plan-store";
import { validateTobyFile, buildTobyImportPlan, parseTobyJSON } from "@/lib/import-toby";
import { validateChromeFile, buildChromeImportPlan } from "@/lib/import-chrome";
import type { ValidationResult, ImportPlan } from "@/lib/import-types";

type ImportSource = "toby" | "chrome";
type Step = 0 | 1 | 2 | 3;

interface ImportResult {
  collections: number;
  bookmarks: number;
  tags: number;
  duplicatesSkipped: number;
  rejectedUrls: string[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportDialog({ open, onOpenChange }: Props) {
  const [step, setStep] = useState<Step>(0);
  const [source, setSource] = useState<ImportSource | null>(null);
  const [rawContent, setRawContent] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [skipDuplicates, setSkipDuplicates] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [mismatchSource, setMismatchSource] = useState<ImportSource | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const workspaces = useWorkspaceStore(s => s.workspaces.filter(w => !w.deletedAt));
  const activeWorkspaceId = useWorkspaceStore(s => s.activeWorkspaceId);
  const storeTags = useWorkspaceStore(s => s.tags);
  const activeCollections = useWorkspaceStore(s => s.collections.filter(c => !c.deletedAt && !c.archivedAt));
  const importFromPlan = useWorkspaceStore(s => s.importFromPlan);
  const bookmarks = useBookmarksStore(s => s.bookmarks);
  const checkQuota = usePlanStore(s => s.checkQuota);

  useEffect(() => {
    if (open && activeWorkspaceId) {
      setWorkspaceId(activeWorkspaceId);
    }
  }, [open, activeWorkspaceId]);

  useEffect(() => {
    if (!open) {
      setStep(0);
      setSource(null);
      setRawContent(null);
      setValidation(null);
      setWorkspaceId("");
      setSkipDuplicates(false);
      setImportResult(null);
      setImportError(null);
      setMismatchSource(null);
    }
  }, [open]);

  const existingBookmarkUrls = useMemo(
    () => new Set(bookmarks.map(b => b.url)),
    [bookmarks],
  );

  const existingTagsForPlan = useMemo(
    () => storeTags.map(t => ({ id: t.id, name: t.name })),
    [storeTags],
  );

  const importPlan = useMemo<ImportPlan | null>(() => {
    if (!rawContent || !workspaceId || !validation?.valid || !source) { return null; }
    try {
      if (source === "toby") {
        return buildTobyImportPlan(
          parseTobyJSON(JSON.parse(rawContent)),
          workspaceId,
          existingBookmarkUrls,
          existingTagsForPlan,
          skipDuplicates,
        );
      }
      return buildChromeImportPlan(rawContent, workspaceId, existingBookmarkUrls, skipDuplicates);
    } catch {
      return null;
    }
  }, [rawContent, workspaceId, skipDuplicates, source, validation?.valid, existingBookmarkUrls, existingTagsForPlan]);

  const importDisabled =
    !importPlan ||
    importing ||
    !checkQuota("bookmark", bookmarks.length + (importPlan?.bookmarks.length ?? 0)) ||
    !checkQuota("collection", activeCollections.length + (importPlan?.collections.length ?? 0));

  async function handleFile(file: File) {
    setValidating(true);
    setValidation(null);
    setMismatchSource(null);
    setRawContent(null);
    try {
      let result: ValidationResult;
      if (source === "toby") {
        result = await validateTobyFile(file);
        if (!result.valid) {
          const ext = file.name.toLowerCase();
          if (ext.endsWith(".html") || ext.endsWith(".htm")) { setMismatchSource("chrome"); }
        }
      } else {
        result = await validateChromeFile(file);
        if (!result.valid && file.name.toLowerCase().endsWith(".json")) {
          setMismatchSource("toby");
        }
      }
      setValidation(result);
      if (result.valid) { setRawContent(await file.text()); }
    } finally {
      setValidating(false);
    }
  }

  async function handleImport() {
    if (!importPlan) { return; }
    setImporting(true);
    setImportError(null);
    try {
      const success = importFromPlan(importPlan);
      if (!success) { return; }
      setImportResult({
        collections: importPlan.collections.length,
        bookmarks: importPlan.bookmarks.length,
        tags: importPlan.tags.length,
        duplicatesSkipped: importPlan.duplicatesSkipped,
        rejectedUrls: importPlan.rejectedUrls,
      });
      setStep(3);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "Import failed. Please try again.");
      setStep(3);
    } finally {
      setImporting(false);
    }
  }

  function renderStep0() {
    return (
      <div className="space-y-4 py-4">
        <p className="text-sm text-muted-foreground">Choose the source of your bookmarks:</p>
        <div className="grid grid-cols-2 gap-3">
          {(["toby", "chrome"] as ImportSource[]).map(src => (
            <button
              key={src}
              onClick={() => { setSource(src); setStep(1); }}
              className="flex flex-col items-center gap-1 rounded-lg border p-4 hover:bg-accent transition-colors"
            >
              <span className="font-medium text-sm">
                {src === "toby" ? "Toby" : "Chrome Bookmarks"}
              </span>
              <span className="text-xs text-muted-foreground">
                {src === "toby" ? "JSON export" : "HTML export"}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  function renderStep1() {
    const hint = source === "toby" ? ".json file" : ".html file";
    const accept = source === "toby" ? ".json,application/json" : ".html,.htm,text/html";

    return (
      <div className="space-y-4 py-4">
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) { void handleFile(f); }
          }}
          onClick={() => fileInputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 transition-colors ${
            isDragging
              ? "border-primary bg-accent"
              : "border-muted-foreground/25 hover:border-muted-foreground/50"
          }`}
        >
          <p className="text-sm font-medium">Drop your file here or click to browse</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) { void handleFile(f); } }}
        />

        {validating && <p className="text-xs text-muted-foreground">Validating…</p>}

        {validation && !validation.valid && (
          <div className="space-y-1">
            <p className="text-xs text-destructive">{validation.error}</p>
            {mismatchSource && (
              <button
                onClick={() => {
                  setSource(mismatchSource);
                  setMismatchSource(null);
                  setValidation(null);
                  setRawContent(null);
                }}
                className="text-xs text-primary underline"
              >
                Switch to {mismatchSource === "chrome" ? "Chrome Bookmarks" : "Toby"} import
              </button>
            )}
          </div>
        )}

        {validation?.valid && validation.preview && (
          <p className="text-xs text-emerald-600">
            ✓ {validation.preview.bookmarks} bookmarks across {validation.preview.collections} collections
          </p>
        )}

        <div className="flex justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setStep(0); setSource(null); setValidation(null); setRawContent(null); }}
          >
            Back
          </Button>
          <Button size="sm" disabled={!validation?.valid} onClick={() => setStep(2)}>
            Next
          </Button>
        </div>
      </div>
    );
  }

  function renderStep2() {
    return (
      <div className="space-y-4 py-4">
        <div className="space-y-2">
          <Label htmlFor="import-workspace-select">Import into workspace</Label>
          <Select value={workspaceId} onValueChange={setWorkspaceId}>
            <SelectTrigger id="import-workspace-select">
              <SelectValue placeholder="Select workspace" />
            </SelectTrigger>
            <SelectContent>
              {workspaces.map(w => (
                <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor="skip-duplicates">Skip duplicate URLs</Label>
          <Switch
            id="skip-duplicates"
            checked={skipDuplicates}
            onCheckedChange={setSkipDuplicates}
          />
        </div>

        {importPlan && (
          <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {importPlan.collections.length} collections · {importPlan.bookmarks.length} bookmarks
            {source === "toby" && importPlan.tags.length > 0 && ` · ${importPlan.tags.length} tags`}
            {importPlan.duplicatesSkipped > 0 &&
              ` · ${importPlan.duplicatesSkipped} duplicate${importPlan.duplicatesSkipped === 1 ? "" : "s"} will be skipped`}
          </div>
        )}

        <div className="flex justify-between">
          <Button variant="ghost" size="sm" onClick={() => setStep(1)}>
            Back
          </Button>
          <Button size="sm" disabled={importDisabled} onClick={() => void handleImport()}>
            {importing ? "Importing…" : "Import"}
          </Button>
        </div>
      </div>
    );
  }

  function renderStep3() {
    if (importError) {
      return (
        <div className="space-y-4 py-4">
          <p className="text-sm text-destructive">{importError}</p>
          <div className="flex justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setStep(1); setImportError(null); }}
            >
              Try again
            </Button>
            <Button size="sm" onClick={() => onOpenChange(false)}>Close</Button>
          </div>
        </div>
      );
    }
    if (!importResult) { return null; }
    return (
      <div className="space-y-4 py-4">
        <p className="text-sm font-medium text-emerald-600">Import complete</p>
        <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground space-y-0.5">
          <p>{importResult.collections} collection{importResult.collections === 1 ? "" : "s"} created</p>
          <p>{importResult.bookmarks} bookmark{importResult.bookmarks === 1 ? "" : "s"} imported</p>
          {importResult.tags > 0 && <p>{importResult.tags} tag{importResult.tags === 1 ? "" : "s"} created</p>}
          {importResult.duplicatesSkipped > 0 && (
            <p>{importResult.duplicatesSkipped} duplicate{importResult.duplicatesSkipped === 1 ? "" : "s"} skipped</p>
          )}
        </div>
        {importResult.rejectedUrls.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              {importResult.rejectedUrls.length} URL{importResult.rejectedUrls.length === 1 ? "" : "s"} skipped (unsafe scheme):
            </p>
            <div className="max-h-24 overflow-y-auto rounded border px-2 py-1">
              {importResult.rejectedUrls.map((url, i) => (
                <p key={i} className="text-xs text-muted-foreground break-all">{url}</p>
              ))}
            </div>
          </div>
        )}
        <div className="flex justify-end">
          <Button size="sm" onClick={() => onOpenChange(false)}>Close</Button>
        </div>
      </div>
    );
  }

  const titles: Record<Step, string> = {
    0: "Import Bookmarks",
    1: source === "toby" ? "Import from Toby" : "Import Chrome Bookmarks",
    2: "Configure Import",
    3: importError ? "Import Failed" : "Import Complete",
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{titles[step]}</DialogTitle>
        </DialogHeader>
        {step === 0 && renderStep0()}
        {step === 1 && renderStep1()}
        {step === 2 && renderStep2()}
        {step === 3 && renderStep3()}
      </DialogContent>
    </Dialog>
  );
}
```

Note: `buildTobyImportPlan` accepts `unknown` as first arg (the parsed JSON). The `useMemo` passes `parseTobyJSON(JSON.parse(rawContent))` which returns `TobyImport | null`. Update the `buildTobyImportPlan` signature in `lib/import-toby.ts` to accept `TobyImport | null` and guard at the top:

```ts
export function buildTobyImportPlan(
  toby: TobyImport | null,   // ← change from `raw: unknown`
  workspaceId: string,
  existingBookmarkUrls: Set<string>,
  existingTags: { id: string; name: string }[],
  skipDuplicates: boolean,
): ImportPlan {
  if (!toby) { return { collections: [], bookmarks: [], tags: [], duplicatesSkipped: 0, rejectedUrls: [] }; }
  // ... rest of function unchanged, remove the parseTobyJSON(raw)! call at the top
```

Also export `TobyImport` from `lib/import-toby.ts` so the dialog can reference it if needed. Add `export` to the interface declaration:

```ts
export interface TobyImport {
  version: number;
  lists: TobyList[];
}
```

- [ ] **Step 2: Type-check**

```bash
bun run compile
```
Expected: no errors. If there are import errors for Select/Switch/Label components, verify they exist in `components/ui/` — they are standard shadcn components already present in the project.

- [ ] **Step 3: Build**

```bash
bun run build
```
Expected: build succeeds with no TypeScript errors.

---

## Task 7: Wire up in settings dialog

**Files:**
- Modify: `components/dashboard/settings-dialog.tsx`

- [ ] **Step 1: Add `importDialogOpen` state and import `ImportDialog`**

At the top of `settings-dialog.tsx`, add the import:

```ts
import { ImportDialog } from "@/components/dashboard/import-dialog";
```

Inside the `SettingsDialog` component body, add state (alongside existing state declarations):

```ts
const [importDialogOpen, setImportDialogOpen] = useState(false);
```

- [ ] **Step 2: Add the "Data Import" section and `ImportDialog` mount**

At the end of the dialog's scrollable content area (after the search engines section, before the closing `</DialogContent>` or its wrapping div), add:

```tsx
<div className="space-y-2 pt-2">
  <h3 className="text-sm font-medium">Data Import</h3>
  <p className="text-xs text-muted-foreground">
    Import your saved tabs from other extensions.
  </p>
  <Button variant="outline" size="sm" onClick={() => setImportDialogOpen(true)}>
    Import Bookmarks
  </Button>
</div>
<ImportDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} />
```

- [ ] **Step 3: Build and verify**

```bash
bun run build
```
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add components/dashboard/import-dialog.tsx components/dashboard/settings-dialog.tsx
git commit -m "feat: add unified bookmark import dialog (Toby + Chrome)"
```

---

## Self-review checklist

- [x] **Spec § Format Decision** → Task 2 validates JSON-only for Toby; Task 3 validates HTML-only for Chrome
- [x] **Spec § Data Mapping (Toby)** → `buildTobyImportPlan` maps list→collection, card→bookmark, labels→tags, `customTitle||title`→title
- [x] **Spec § Data Mapping (Chrome)** → `buildChromeImportPlan` maps sub-folders→collections, depth>1 collapses up, Mobile Bookmarks skipped, ICON ignored
- [x] **Spec § Security** → size cap, extension check, DOCTYPE check, `isSafeUrl` rejects `javascript:`/`data:`/`vbscript:`, text trimmed
- [x] **Spec § Step 0** → `renderStep0` with Toby and Chrome source cards
- [x] **Spec § Step 1 mismatch nudge** → `mismatchSource` state + switch button in `renderStep1`
- [x] **Spec § Step 2** → workspace picker, deduplicate toggle, summary card, quota-disabled Import button
- [x] **Spec § Step 3** → success counts, rejected URLs list, error state with Try again
- [x] **Spec § Quota** → `importFromPlan` checks both bookmark and collection quota before any writes
- [x] **Spec § Edge cases (empty lists)** → both parsers skip lists/folders with zero items
- [x] **Spec § Tag deduplication** → `buildTobyImportPlan` uses case-insensitive `tagMap`
- [x] **Spec § Chrome name collision** → `allocateName` in `parseChromeHTML` suffixes colliding names
- [x] **Spec § IDB write order** → tags → collections → bookmarks in `importFromPlan`

# Bookmark Import Feature — Design Spec

**Date:** 2026-05-15
**Status:** Approved
**Sources:** Toby (JSON), Chrome Bookmarks (HTML)

---

## Overview

Allow users to import saved bookmarks/tabs from Toby and Chrome into TabSlate via a unified import dialog in Settings. All processing is entirely client-side — the raw file never leaves the browser. Parsed data is written to IndexedDB via existing store actions and enqueued for sync normally.

---

## Format Decisions

### Toby

Toby supports JSON and HTML export. **JSON only is supported.**

| | JSON | HTML |
|---|---|---|
| Parsing | `JSON.parse()` — trivial | Requires `DOMParser` / regex — fragile |
| XSS risk | None | Parsing HTML in-browser creates injection surface |
| Validation | Schema + version check | No schema, attribute parsing is error-prone |
| Data richness | `customTitle`, `customDescription`, `labels` | Title + href only |
| Format stability | Versioned (`"version": 3`) | Unversioned Netscape legacy |

A clear error message directs the user to use JSON if they upload the HTML format.

### Chrome Bookmarks

Chrome exports the standard Netscape Bookmark HTML format. This is the **only** Chrome export format — HTML is supported directly.

Parsing uses `DOMParser.parseFromString(text, 'text/html')` — safe, never executes scripts. The resulting DOM is traversed with standard DOM APIs; `innerHTML` on a live document element is never used.

---

## Data Mapping

### Toby → TabSlate

| Toby | TabSlate |
|---|---|
| `list` | `Collection` (in selected workspace) |
| `card` | `Bookmark` |
| `card.customTitle \|\| card.title` | `Bookmark.title` |
| `card.url` | `Bookmark.url` |
| `card.customDescription` | `Bookmark.description` |
| `list.labels[]` | `Tag[]` (reuse existing by name, create new if absent) |

### Chrome → TabSlate

Chrome's folder hierarchy maps to flat collections with these rules:

```
Bookmarks Bar                    → collection "Bookmarks Bar"
  ├── direct bookmark            → collectionId = "Bookmarks Bar"
  ├── security/ (sub-folder)     → collection "security"
  │   ├── bookmark               → collectionId = "security"
  │   └── tools/ (deeper folder) → NOT a collection (depth > 1)
  │       └── bookmark           → collectionId = "security"  ← collapses up
Other Bookmarks                  → collection "Other Bookmarks"
  ├── direct bookmark            → collectionId = "Other Bookmarks"
  └── misc/ (sub-folder)         → collection "misc"
Mobile Bookmarks                 → skipped entirely (Chrome sync artifact)
```

- **Favicons:** `ICON` attribute base64 data is ignored — `FaviconImage` loads favicons by URL at render time
- **Tags:** Chrome has no label concept — `tags: []` on all imported bookmarks
- **Collection name collision:** if a sub-folder name collides with a root container name, suffix with `" (2)"`

---

## Architecture

All processing happens in the browser. No server involvement beyond the normal sync push of created entities.

```
SettingsDialog
  └── "Import Bookmarks" button
        └── ImportDialog
              ├── Step 0: SourcePicker (Toby | Chrome Bookmarks)
              ├── Step 1: FileUpload + validation  (file hint varies per source)
              ├── Step 2: WorkspacePicker + DeduplicateToggle + ImportSummary
              └── Step 3: ImportResult

lib/import-toby.ts   (pure functions, no React, no store imports)
  ├── validateTobyFile(file: File) → ValidationResult
  ├── parseTobyJSON(raw: unknown) → TobyImport
  └── buildImportPlan(toby, workspaceId, existingBookmarks, existingTags, skipDuplicates) → ImportPlan

lib/import-chrome.ts  (pure functions, no React, no store imports)
  ├── validateChromeFile(file: File) → ValidationResult
  ├── parseChromeHTML(doc: Document) → ChromeImport
  └── buildImportPlan(chrome, workspaceId, existingBookmarks, skipDuplicates) → ImportPlan

bookmarksStore.importFromPlan(plan: ImportPlan) → bulk IDB writes + sync enqueue
```

Both parsers produce the same `ImportPlan` shape — the dialog and store action are source-agnostic from Step 1 onwards.

---

## Security Boundaries

### Toby (enforced in `validateTobyFile`)

- **Size cap:** 20 MB hard limit — reject before parsing
- **Extension:** must be `.json`
- **Schema validation:** must have `version === 3` and a `lists` array — rejects all other shapes including the Toby HTML format
- **URL sanitization:** reject `javascript:`, `data:`, `vbscript:` schemes; max URL length 2048 chars
- **Text fields:** stored as plain text, never rendered as HTML; title trimmed to 500 chars, description to 2000 chars

### Chrome (enforced in `validateChromeFile`)

- **Size cap:** 20 MB hard limit — reject before parsing
- **Extension:** must be `.html` or `.htm`
- **Format detection:** must contain `DOCTYPE NETSCAPE-Bookmark-file-1` within first 256 bytes
- **Parsing:** `DOMParser` only — no `eval`, no `innerHTML` on live document elements
- Same URL sanitization and text field limits as Toby

---

## Components

### Entry Point — `settings-dialog.tsx`

New "Data Import" section added below the search engines section:

```tsx
<div className="space-y-2">
  <h3 className="text-sm font-medium">Data Import</h3>
  <p className="text-xs text-muted-foreground">Import your saved tabs from other extensions.</p>
  <Button variant="outline" size="sm" onClick={() => setImportDialogOpen(true)}>
    Import Bookmarks
  </Button>
</div>
<ImportDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} />
```

### `ImportDialog` — `components/dashboard/import-dialog.tsx`

Single `Dialog` (`sm:max-w-lg`, standard shadcn structure) with local `useState<0|1|2|3>` step state and `useState<'toby'|'chrome'|null>` source state.

**Step 0 — Source picker**
- Two selectable cards: "Toby" (subtitle: "JSON export") and "Chrome Bookmarks" (subtitle: "HTML export")
- Selecting a source immediately advances to Step 1

**Step 1 — Upload**
- Drag-drop zone + file picker button
- File hint text: `".json file"` (Toby) or `".html file"` (Chrome)
- Real-time inline validation feedback (error or green "✓ 847 bookmarks across 12 collections")
- Mismatch detection: if wrong file type uploaded, show nudge — "Looks like a Chrome bookmarks file. Switch to Chrome Bookmarks import?" with one-click correction
- "Next" enabled only on valid file

**Step 2 — Configure**
- Workspace `<Select>` (all active workspaces)
- Deduplicate toggle switch: "Skip duplicate URLs"
- Summary card: `X collections · Y bookmarks · Z tags · N duplicates will be skipped`
- Tags row omitted for Chrome imports (always zero)
- "Import" button (disabled and shows quota message if quota would be exceeded)

**Step 3 — Result**
- Success: counts of collections, bookmarks, tags created
- Rejected URLs (bad scheme) shown in scrollable detail area if any
- "Close" button
- On error: error message + "Try again" link (resets to Step 1, preserving source selection)

### `lib/import-toby.ts`

```ts
interface TobyCard {
  title: string;
  url: string;
  customTitle: string;
  customDescription: string;
}

interface TobyList {
  title: string;
  cards: TobyCard[];
  labels: string[];
}

interface TobyImport {
  version: 3;
  lists: TobyList[];
}
```

### `lib/import-chrome.ts`

```ts
interface ChromeBookmark {
  title: string;
  url: string;
}

interface ChromeCollection {
  name: string;
  bookmarks: ChromeBookmark[];
}

interface ChromeImport {
  collections: ChromeCollection[];
}
```

### Shared `ImportPlan` type — `lib/import-types.ts`

```ts
interface ImportPlan {
  collections: Omit<Collection, 'seq'>[];
  bookmarks: Omit<Bookmark, 'seq'>[];
  tags: Omit<Tag, 'seq'>[];
  duplicatesSkipped: number;
  rejectedUrls: string[];
}

interface ValidationResult {
  valid: boolean;
  error?: string;
  preview?: { collections: number; bookmarks: number };
}
```

### Store Action — `bookmarksStore.importFromPlan(plan)`

- Quota check at entry: `checkQuota('collection', localCount + plan.collections.length)` and `checkQuota('bookmark', localCount + plan.bookmarks.length)`
- Write order: tags → collections → bookmarks (referential integrity)
- Each entity gets `seq: 0` and is enqueued via `syncEngine.enqueue()` only after all IDB writes complete
- On IDB error: throw immediately; sync enqueue is never reached, but already-written entities may persist in IDB (acceptable — they will sync on next push as `seq: 0` orphans)

---

## Error Handling

### Step 1 — Toby validation errors (inline)

| Condition | Message |
|---|---|
| File > 20 MB | "File too large. Toby exports are typically under 5 MB." |
| Not valid JSON | "This doesn't look like a Toby export file." |
| Missing `version` or `lists` | "Unrecognized format. Please export from Toby as JSON (not HTML)." |
| `version !== 3` | "Unsupported Toby format version. Only v3 is supported." |
| Zero lists | "This export file contains no collections to import." |

### Step 1 — Chrome validation errors (inline)

| Condition | Message |
|---|---|
| File > 20 MB | "File too large. Chrome bookmark exports are typically under 10 MB." |
| Not `.html` / `.htm` | "Please upload an HTML file. Export from Chrome: Bookmarks Manager → ⋮ → Export bookmarks." |
| Missing Netscape DOCTYPE | "This doesn't look like a Chrome bookmarks export file." |
| No bookmarks found | "This export file contains no bookmarks to import." |

### Step 1 — Mismatch nudge

If the user selects "Toby" but uploads an HTML file (or "Chrome" but uploads a JSON file):
> "Looks like a [Chrome bookmarks / Toby] file. Switch to [Chrome Bookmarks / Toby] import?"
with a one-click correction button.

### Step 2 — Quota exceeded

Inline quota error on the Import button using the existing `QuotaAlert` pattern. Import blocked before any writes.

### Step 3 — Partial URL rejection

Unsafe-scheme URLs are silently dropped during `buildImportPlan`. Count shown in result screen only — does not interrupt the import flow.

### Edge Cases

- **Empty folders/lists:** Skipped — no empty collections created
- **Tag name collisions (Toby):** Case-insensitive match against existing tags; reuse existing ID if found
- **Duplicate labels within one list (Toby):** Deduplicated to one tag before processing
- **Chrome collection name collision:** Sub-folder name matching a root container name gets `" (2)"` suffix
- **Import failure:** Step 3 error state with "Try again" link back to Step 1; sync enqueue is not reached

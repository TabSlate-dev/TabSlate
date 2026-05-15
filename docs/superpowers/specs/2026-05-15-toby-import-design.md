# Toby Import Feature — Design Spec

**Date:** 2026-05-15
**Status:** Approved

---

## Overview

Allow users to import their saved tab collections from Toby (a tab manager Chrome extension) into TabSlate. The import is entirely client-side — the raw file never leaves the browser. Parsed data is written to IndexedDB via existing store actions and enqueued for sync normally.

---

## Format Decision

Toby supports two export formats: JSON and HTML. **JSON is the only supported format.**

| | JSON | HTML |
|---|---|---|
| Parsing | `JSON.parse()` — trivial | Requires `DOMParser` / regex — fragile |
| XSS risk | None | Parsing HTML in-browser creates injection surface |
| Validation | Schema + version check | No schema, attribute parsing is error-prone |
| Data richness | `customTitle`, `customDescription`, `labels` | Title + href only |
| Format stability | Versioned (`"version": 3`) | Unversioned Netscape legacy |

A clear error message is shown if the user uploads the HTML format.

---

## Data Mapping

| Toby | TabSlate |
|---|---|
| `list` | `Collection` (in selected workspace) |
| `card` | `Bookmark` |
| `card.customTitle \|\| card.title` | `Bookmark.title` |
| `card.url` | `Bookmark.url` |
| `card.customDescription` | `Bookmark.description` |
| `list.labels[]` | `Tag[]` (reuse existing by name, create new if absent) |

---

## Architecture

All processing happens in the browser. No server involvement beyond the normal sync push of created entities.

```
SettingsDialog
  └── "Import from Toby" button
        └── ImportTobyDialog
              ├── Step 1: FileUpload + validation
              ├── Step 2: WorkspacePicker + DeduplicateToggle + ImportSummary
              └── Step 3: ImportResult

lib/import-toby.ts  (pure functions, no React, no store imports)
  ├── validateTobyFile(file) → ValidationResult
  ├── parseTobyJSON(raw) → TobyImport
  └── buildImportPlan(toby, workspaceId, existingBookmarks, existingTags, skipDuplicates) → ImportPlan

bookmarksStore.importFromToby(plan) → bulk IDB writes + sync enqueue
```

---

## Security Boundaries

All enforced inside `validateTobyFile` before any data is processed:

- **Size cap:** 20 MB hard limit — reject before parsing
- **MIME + extension:** must be `application/json` or `.json`
- **Schema validation:** must have `version === 3` and a `lists` array
- **URL sanitization:** reject `javascript:`, `data:`, `vbscript:` schemes; max URL length 2048 chars
- **Text fields:** stored as plain text, never rendered as HTML; title trimmed to 500 chars, description to 2000 chars

---

## Components

### Entry Point — `settings-dialog.tsx`

New "Data Import" section added below the search engines section:

```tsx
<div className="space-y-2">
  <h3 className="text-sm font-medium">Data Import</h3>
  <p className="text-xs text-muted-foreground">Import your saved tabs from other extensions.</p>
  <Button variant="outline" size="sm" onClick={() => setImportDialogOpen(true)}>
    Import from Toby
  </Button>
</div>
<ImportTobyDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} />
```

### `ImportTobyDialog` — `components/dashboard/import-toby-dialog.tsx`

Single `Dialog` (standard shadcn structure, `sm:max-w-lg`) with local `useState<1|2|3>` step state.

**Step 1 — Upload**
- Drag-drop zone + file picker button
- Real-time inline validation feedback (error message or green "✓ 847 bookmarks across 12 lists")
- "Next" enabled only on valid file

**Step 2 — Configure**
- Workspace `<Select>` (all active workspaces)
- Deduplicate toggle switch: "Skip duplicate URLs"
- Summary card: `X collections · Y bookmarks · Z tags · N duplicates will be skipped`
- "Import" button (disabled if quota would be exceeded)

**Step 3 — Result**
- Success: counts of collections, bookmarks, tags created
- Rejected URLs (bad scheme) shown in scrollable detail area if any
- "Close" button
- On error: error message + "Try again" (back to Step 1)

### `lib/import-toby.ts`

Pure functions with no side effects:

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

interface ImportPlan {
  collections: Omit<Collection, 'seq'>[];
  bookmarks: Omit<Bookmark, 'seq'>[];
  tags: Omit<Tag, 'seq'>[];
  duplicatesSkipped: number;
  rejectedUrls: string[];
}
```

### Store Action — `bookmarksStore.importFromToby(plan)`

- Quota check at entry: `checkQuota('collection', localCount + plan.collections.length)` and `checkQuota('bookmark', localCount + plan.bookmarks.length)`
- Write order: tags → collections → bookmarks (referential integrity)
- Each entity gets `seq: 0` and is enqueued via `syncEngine.enqueue()` only after all IDB writes complete
- On IDB error: throw immediately; sync enqueue is never reached, but already-written entities may persist in IDB (acceptable — they will sync on next push as `seq: 0` orphans)

---

## Error Handling

### Step 1 — Validation errors (inline)

| Condition | Message |
|---|---|
| File > 20 MB | "File too large. Toby exports are typically under 5 MB." |
| Not valid JSON | "This doesn't look like a Toby export file." |
| Missing `version` or `lists` | "Unrecognized format. Please export from Toby as JSON (not HTML)." |
| `version !== 3` | "Unsupported Toby format version. Only v3 is supported." |
| Zero lists | "This export file contains no collections to import." |

### Step 2 — Quota exceeded

Inline quota error on the Import button using the existing `QuotaAlert` pattern. Import blocked before any writes.

### Step 3 — Partial URL rejection

Unsafe-scheme URLs are silently dropped during `buildImportPlan`. Count shown in result screen only — does not interrupt the import flow.

### Edge Cases

- **Empty lists:** Toby lists with zero cards are skipped (no empty collections created)
- **Tag name collisions:** Case-insensitive match against existing tags; reuse existing ID if found
- **Duplicate labels within one list:** Deduplicated to one tag before processing
- **Import failure:** Step 3 error state with "Try again" link back to Step 1; no partial state committed

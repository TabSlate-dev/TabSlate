# Custom Search Engines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to add and delete custom search engines from the Settings dialog.

**Architecture:** Three-step change — update the data model to add a `custom` flag and migrate URLs to `%s` template format, patch the search execution logic, then extend the Settings dialog with a delete button for custom engines and an inline add-engine form.

**Tech Stack:** TypeScript, React, Zustand, shadcn/ui (Input, Button), lucide-react (Trash2, Plus, X)

---

## File Map

| File | Change |
|---|---|
| `store/settings-store.ts` | Add `custom?` to `SearchEngine`; migrate built-in URLs to `%s` format |
| `components/dashboard/hero-section.tsx` | Replace URL concatenation with `%s` substitution (2 sites) |
| `components/dashboard/settings-dialog.tsx` | Delete button on custom rows; inline add-engine form |

---

## Task 1: Update data model and URL format

**Files:**
- Modify: `store/settings-store.ts`

- [ ] **Step 1: Add `custom?` field and migrate built-in URLs**

Replace the `SearchEngine` interface and `DEFAULT_SEARCH_ENGINES` array in `store/settings-store.ts`:

```ts
export interface SearchEngine {
  id: string;
  name: string;
  url: string;       // %s placeholder, e.g. "https://example.com/search?q=%s"
  siteUrl: string;
  iconUrl?: string;
  custom?: boolean;  // true for user-created engines
  enabled: boolean;
}

export const DEFAULT_SEARCH_ENGINES: SearchEngine[] = [
  { id: "google", name: "Google", url: "https://www.google.com/search?q=%s", siteUrl: "https://www.google.com", iconUrl: "search-engine-icon/brand-google.svg", enabled: true },
  { id: "bing", name: "Bing", url: "https://www.bing.com/search?q=%s", siteUrl: "https://www.bing.com", iconUrl: "search-engine-icon/brand-bing.svg", enabled: true },
  { id: "duckduckgo", name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s", siteUrl: "https://duckduckgo.com", iconUrl: "search-engine-icon/brand-duckduckgo.svg", enabled: true },
  { id: "yahoo", name: "Yahoo", url: "https://search.yahoo.com/search?p=%s", siteUrl: "https://www.yahoo.com", iconUrl: "search-engine-icon/brand-yahoo.svg", enabled: true },
  { id: "yandex", name: "Yandex", url: "https://yandex.com/search/?text=%s", siteUrl: "https://yandex.com", iconUrl: "search-engine-icon/brand-yandex.svg", enabled: true },
  { id: "github", name: "GitHub", url: "https://github.com/search?q=%s", siteUrl: "https://github.com", iconUrl: "search-engine-icon/brand-github.svg", enabled: true },
];
```

- [ ] **Step 2: Type-check**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add store/settings-store.ts
git commit -m "feat(search): add custom field to SearchEngine, migrate URLs to %s format"
```

---

## Task 2: Update search URL construction in hero-section

**Files:**
- Modify: `components/dashboard/hero-section.tsx`

- [ ] **Step 1: Replace concatenation with %s substitution**

In `hero-section.tsx` there are two spots that build the search URL. Both currently use template-literal concatenation. Replace both with `.replace()`:

`handleSelect` (around line 108):
```ts
// Before
window.location.href = `${engine.url}${encodeURIComponent(query.trim())}`;

// After
window.location.href = engine.url.replace("%s", encodeURIComponent(query.trim()));
```

`handleSearch` (around line 132):
```ts
// Before
window.location.href = `${engine.url}${encodeURIComponent(query.trim())}`;

// After
window.location.href = engine.url.replace("%s", encodeURIComponent(query.trim()));
```

- [ ] **Step 2: Type-check**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/dashboard/hero-section.tsx
git commit -m "feat(search): use %s substitution for search URL construction"
```

---

## Task 3: Add delete button for custom engines in settings-dialog

**Files:**
- Modify: `components/dashboard/settings-dialog.tsx`

- [ ] **Step 1: Add Trash2 import and onDelete prop to SortableSearchEngineItem**

Update imports at the top of the file:
```ts
import { GripVertical, Trash2 } from "lucide-react";
```

Update the `SortableSearchEngineItem` component signature and its row to show a delete button only for custom engines:

```tsx
function SortableSearchEngineItem({
  engine,
  onToggle,
  onDelete,
}: {
  engine: SearchEngine;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  // ... existing useSortable and getEngineIconSrc code unchanged ...

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
```

- [ ] **Step 2: Add handleDelete in SettingsDialog and wire up the prop**

Inside `SettingsDialog`, add the handler and pass it to the list item:

```ts
const handleDelete = (id: string) => {
  updateSearchEngines(searchEngines.filter((e) => e.id !== id));
};
```

Update the `SortableSearchEngineItem` usage in the JSX:
```tsx
<SortableSearchEngineItem
  key={engine.id}
  engine={engine}
  onToggle={handleToggle}
  onDelete={handleDelete}
/>
```

- [ ] **Step 3: Type-check**

```bash
bun run compile
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/dashboard/settings-dialog.tsx
git commit -m "feat(settings): add delete button for custom search engines"
```

---

## Task 4: Add inline add-engine form

**Files:**
- Modify: `components/dashboard/settings-dialog.tsx`

- [ ] **Step 1: Add Plus and X imports**

```ts
import { GripVertical, Trash2, Plus, X } from "lucide-react";
```

- [ ] **Step 2: Add form state and Input import**

Add `Input` to the component imports at the top of the file:
```ts
import { Input } from "@/components/ui/input";
```

Add form state inside `SettingsDialog`:
```ts
const [showForm, setShowForm] = React.useState(false);
const [newName, setNewName] = React.useState("");
const [newUrl, setNewUrl] = React.useState("");

const canAdd = newName.trim().length > 0 && newUrl.trim().includes("%s");
```

- [ ] **Step 3: Add handleAdd**

```ts
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
```

- [ ] **Step 4: Render the add button and inline form below the engine list**

Replace the closing `</div>` of the `space-y-2` list container with:

```tsx
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
                      <X className="size-3.5 mr-1" />
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
                  className="mt-2 w-full text-muted-foreground hover:text-foreground"
                  onClick={() => setShowForm(true)}
                >
                  <Plus className="size-3.5 mr-1" />
                  Add engine
                </Button>
              )}
```

- [ ] **Step 5: Type-check and build**

```bash
bun run compile && bun run build
```

Expected: no errors, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add components/dashboard/settings-dialog.tsx
git commit -m "feat(settings): add inline form to create custom search engines"
```

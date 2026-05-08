# Custom Search Engines — Design Spec

**Date:** 2026-05-08
**Scope:** Allow users to add and delete custom search engines in the Settings dialog.

---

## Overview

Users can add their own search engines to the hero section search bar. Built-in engines (Google, Bing, DuckDuckGo, Yahoo, Yandex, GitHub) can be toggled and reordered but not deleted. Custom engines can be toggled, reordered, and deleted.

---

## Data Model

### `SearchEngine` interface (`store/settings-store.ts`)

Add `custom?: boolean` field:

```ts
export interface SearchEngine {
  id: string;
  name: string;
  url: string;       // %s placeholder template, e.g. "https://example.com/search?q=%s"
  siteUrl: string;   // origin URL, used for favicon fallback
  iconUrl?: string;  // local asset path for bundled icons; undefined for custom engines
  custom?: boolean;  // true for user-created engines
  enabled: boolean;
}
```

### URL format migration

All built-in engine `url` fields switch from suffix concatenation to `%s` template:

```ts
// Before
url: "https://www.google.com/search?q="

// After
url: "https://www.google.com/search?q=%s"
```

### Custom engine creation

When a user saves a new engine:
- `id`: `crypto.randomUUID()`
- `siteUrl`: origin extracted from the URL template (e.g. `new URL(url.replace("%s", "")).origin`)
- `iconUrl`: undefined (falls back to DuckDuckGo favicon service)
- `custom`: `true`
- `enabled`: `true`

---

## Search Logic (`hero-section.tsx`)

Replace string concatenation with `%s` substitution:

```ts
// Before
window.open(engine.url + encodeURIComponent(query), "_blank");

// After
window.open(engine.url.replace("%s", encodeURIComponent(query)), "_blank");
```

---

## UI — Settings Dialog (`settings-dialog.tsx`)

### Engine list rows

| Engine type | Row contents |
|---|---|
| Built-in | drag handle · icon · name · Switch |
| Custom | drag handle · icon · name · Switch · Trash2 (text-destructive) |

Delete is immediate, no confirmation dialog.

### Add engine form

Located below the engine list. Collapsed by default, toggled by an `+ Add engine` button.

**Fields:**
- **Name** — `<Input>` text field
- **Search URL** — `<Input>` text field, placeholder `https://example.com/search?q=%s`, helper text below: `Use %s as the search term placeholder`

**Buttons (right-aligned):**
- **Cancel** — collapses form, clears fields
- **Add** — saves engine; disabled unless both fields are non-empty and URL contains `%s`

Form state is local (`React.useState`), not persisted to the store until Add is clicked.

---

## Validation

| Rule | Enforcement |
|---|---|
| Name non-empty | `Add` button disabled |
| URL non-empty | `Add` button disabled |
| URL contains `%s` | `Add` button disabled |

No inline error messages — disabled button is sufficient signal for this simple form.

---

## Affected Files

| File | Change |
|---|---|
| `store/settings-store.ts` | Add `custom?` field to interface; update built-in engine URLs to `%s` format |
| `components/dashboard/settings-dialog.tsx` | Add inline form; delete button on custom engine rows |
| `components/dashboard/hero-section.tsx` | Update search URL construction to use `.replace("%s", ...)` |

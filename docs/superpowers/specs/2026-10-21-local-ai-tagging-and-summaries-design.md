# Local AI Tagging and Summaries (Sub-project H)

## Summary

Karakeep and faved.to's cloud version suggest tags and write summaries with AI. This sub-project brings both to TabSlate without involving TabSlate's server: users enter their own OpenAI-compatible endpoint, API key, and model in the extension, and the extension calls that endpoint directly. The AI settings are stored only on the device, are never synced or exported, and survive logout. The settings page tells users exactly that.

AI tags are suggestions that the user accepts one by one, so the tag tree never changes without the user's say. Summaries are a new synced bookmark field, handled like B's notes: the generated text syncs, while the key and the requests never reach TabSlate's server.

Request parameters and prompts follow Karakeep and Linkwarden, two open-source bookmark managers with the same features.

## Roadmap Context

The faved.to comparison (see `docs/superpowers/specs/2026-10-15-library-management-basics-design.md`) produced sub-projects A to E; a review against that comparison and Karakeep added F, G, and H.

| Sub-project | Scope | Repositories |
|---|---|---|
| A — Library management basics | View preferences, tag and collection editing, counts, tag search, clickable tags, save shortcut, duplicate detection | Frontend |
| B — Bulk operations and unified form | Multi-select and bulk bar, unified add/edit form, notes, edit time, more sort options | Frontend + server |
| C1 — Image card view | Small and large card views, `og:image` covers, "Fetch details" in the form | Frontend + server (one field) |
| C2 — Web snapshots | Server and browser page capture, snapshot viewer, full-page archives, possibly broken links, storage quota | Server + cloud + frontend |
| D — Nested tags and import hierarchy | Tag hierarchy, tag tree, folder hierarchy on import, merging and cleaning up tags | Frontend + server |
| E — Onboarding | First-run checklist | Frontend |
| F — Export, restore, and imports | JSON and HTML export, restore, snapshot zip, nine new import sources | Frontend + server |
| G — Search syntax and smart collections | Query syntax in both search boxes, local results in the new tab search box, smart collections | Frontend + server |
| **H — Local AI tagging and summaries** (this spec) | AI tag suggestions and summaries through the user's own endpoint and key | Frontend + server (one field) |

**Depends on B, C1, and D.** H uses B's bookmark form, bulk bar, `updateBookmarks`, and notes popover; C1's `activeTab` injection and "Fetch details" fetching; and D's tag paths and tag creation. It uses C2's reader text when available, F's export must exclude the AI settings, and G's plain-text search covers summaries.

## Goals

- Suggest tags and write summaries with an AI service the user chooses and pays for.
- Keep the AI endpoint, key, and model on the device only, and tell users so.
- Never change tags without the user accepting them.
- Sync summaries like notes, so they appear on every device.
- Keep costs predictable: no background processing of the library.

## Non-goals

- AI on TabSlate's server, or a TabSlate-provided model.
- Applying tags automatically, or AI for context-menu saves, which have no interface to confirm suggestions.
- Processing existing bookmarks in the background.
- Sending notes to the AI.
- Custom prompts, embeddings, semantic search, and image tagging or OCR.
- Encrypting the key beyond the browser profile's own protection.
- Using several AI providers at once.

## Decisions

| Question | Decision |
|---|---|
| Protocol | OpenAI-compatible Chat Completions, which OpenAI, DeepSeek, OpenRouter, Ollama, and LM Studio offer, and Gemini and Anthropic offer through compatibility endpoints. |
| Settings storage | A separate IndexedDB database, `tabslate-local`, on the device only: never synced, never exported, never sent to TabSlate's server, and not cleared by logout. The settings page says so. |
| Tags | Suggestions the user accepts. |
| Summaries | A new synced `summary` field, like notes. |
| Request parameters | Taken from Karakeep and Linkwarden (section 4), not chosen independently. |
| Entry points | The popup, the bookmark form, the card menu, and the bulk bar. |

## Design

### 1. Settings

The settings dialog gains an **AI** tab:

- **Enable AI** switch.
- **Base URL**, with examples: `https://api.openai.com/v1`, `https://api.deepseek.com/v1`, `http://localhost:11434/v1` (Ollama).
- **API key**, a password field with a show toggle. It can be empty for local models.
- **Model**, such as `gpt-4o-mini`, `deepseek-chat`, or `qwen2.5`.
- **Advanced** (collapsed), with Karakeep's defaults:
  - Context length: 2048 tokens.
  - Maximum output tokens: 2048.
  - Use `max_completion_tokens` instead of `max_tokens`: off. GPT-5 and o-series models require it on.
  - Output format: JSON Schema (default), JSON mode, or plain text.
- **Test connection** sends a minimal request and reports a wrong key (401), an unreachable address, or Ollama refusing the extension's origin (it may need `OLLAMA_ORIGINS`).
- **Clear AI settings** deletes everything AI-related from the device.
- **Notice**, always visible on the tab: "These settings are saved only on this device. They are never synced to the TabSlate server or included in exports, and logging out does not clear them. Use 'Clear AI settings' to remove them." The same notice appears in the confirmation the first time the user saves the settings.
- A short privacy note says what is sent (section 4) and that it goes straight to the configured service.

### 2. Storage on the device

- The settings live in a separate IndexedDB database, `tabslate-local`, in a `settings` store under the key `ai`: `{ enabled, baseUrl, apiKey, model, contextLength, maxOutputTokens, useMaxCompletionTokens, outputFormat, updatedAt }`.
- `clearDB()` deletes only `tabslate-db`, so logout leaves the AI settings in place, as the notice says.
- Only the extension's own pages (the new tab page and the popup) read them. Content scripts run in web pages' origins and cannot read the extension's IndexedDB.
- They are never synced, never written to `/preferences`, never included in F's exports, and never sent in any request to TabSlate's server.
- Browsers offer extensions no system keychain, so the key is stored like other extension data in the browser profile. The privacy note says so and suggests a key with a spending limit.
- `lib/ai/settings.ts` owns reading, writing, and clearing them.

### 3. Permissions

Saving the settings makes **one** permission request inside the click handler, before any `await`:

- host access to the Base URL's origin, so the extension can call it without CORS restrictions;
- on Firefox, the optional data-collection categories `bookmarksInfo` and `websiteContent`. `bookmarksInfo` is added to the manifest's `optional` list; adding an optional category does not affect existing users' consent.

If either is refused, AI stays off and the settings page says why.

### 4. Requests

Both Karakeep and Linkwarden send a single user message, leave `temperature` unset, and parse JSON out of the reply. H does the same.

**Tag suggestions** — `POST {baseUrl}/chat/completions`:

- `model` from the settings; `messages: [{ role: "user", content: prompt }]`; no `temperature`.
- `max_tokens: 2048`, or `max_completion_tokens: 2048` when the advanced option is on (Karakeep's `INFERENCE_MAX_OUTPUT_TOKENS` and `INFERENCE_USE_MAX_COMPLETION_TOKENS`).
- `response_format` by the output format setting (Karakeep's `INFERENCE_OUTPUT_SCHEMA`): a JSON schema for `{ "tags": string[] }`, `{ "type": "json_object" }`, or none.
- The prompt follows Karakeep's text-tagging rules:
  - suggest 3–5 concrete, durable topic tags that help find the page again;
  - ignore page chrome;
  - return an empty array for error, sign-in, or interstitial pages;
  - write the tags in the interface language.
  It adds TabSlate's own instructions:
  - prefer the user's existing tags, given as the 50 most-used tag paths (as Linkwarden does);
  - new tags may use `/` to sit under an existing parent (D).
- The content goes inside `<TEXT_CONTENT>` tags: the title, URL, description, and page text when available (section 5). Notes are never sent.
- The reply is parsed as the JSON object, or, in plain-text mode, from a fenced ```json block or the first JSON value in the text (as Linkwarden does). At most 5 tags are kept. Paths deeper than five levels, empty segments, and names containing commas are dropped.

**Summaries** — a separate request with the same parameters and no `response_format`. The prompt follows Karakeep's summary prompt: respond only with the summary, in 3–4 sentences, in the interface language.

**Content length.** As Karakeep does, whitespace runs are collapsed, the text is first cut to 8 characters per allowed token, then tokenized with `js-tiktoken` (loaded lazily) and truncated to the context length (2048 tokens by default).

**Timeouts and retries.**

- Each request times out after 30 seconds (Karakeep's `INFERENCE_JOB_TIMEOUT_SEC`).
- Connection errors and responses 408, 409, 429, and 5xx are retried up to 2 times, with exponential backoff that honors `Retry-After`. This is the OpenAI SDK's default behavior, which Karakeep relies on.
- Other errors stop the request and show their message.

**Concurrency.** Bulk runs send one request at a time (Karakeep's `INFERENCE_NUM_WORKERS` default).

The client lives in `lib/ai/` (settings, prompts, request, parsing). It imports no stores, so the popup and the new tab page can both use it.

### 5. Page content

- **Popup:** the page text comes from the open tab. Mozilla's Readability (Apache-2.0) is injected under `activeTab` (C1) and returns the article text.
- **Bookmark form and card menu,** in order of preference:
  1. C2's reader version, when the bookmark has a snapshot;
  2. the page fetched the way C1's "Fetch details" does, then parsed with Readability in the extension;
  3. only the title, URL, and description.
- **Bulk runs:** the same order, except that pages are fetched only when the optional all-sites permission is granted, because a bulk run cannot ask for each site.

### 6. Tag suggestions in the interface

- Suggestions appear as chips under the tag field. Existing tags show their path; new ones are marked "New".
- Clicking a chip adds the tag. A new tag is created with D's path rules and the tag quota; if the quota blocks it, the quota alert appears and the chip stays.
- Suggestions never apply themselves.

### 7. Summaries

- **Data.** `Bookmark` gains `summary?: string`, at most `MAX_BOOKMARK_SUMMARY_LENGTH = 2000` characters. A missing value means `""`, so no IndexedDB migration is needed.
- **Sync**, following B's notes:
  - `toServerBookmark` always sends `summary`.
  - `mergeFromServer` uses `serverBookmark.summary ?? existing?.summary ?? ""`, so an older server never clears a summary.
  - Both sync confirmation comparisons include it.
  - On Firefox, summaries are synced under the account-data consent's `websiteContent` category.
- **Server** (TabSlate-server):
  - `ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';`
  - `model.Bookmark.Summary *string json:"summary,omitempty"`, and `BookmarkRequest.Summary` with `max=2000`.
  - Over-long summaries are rejected per bookmark with `invalid_field`. A push without the field keeps the stored summary.
  - Pull and REST return it, and MeiliSearch indexes it after notes.
- **Interface.**
  - B's bookmark form gains a **Summary** field (a textarea) that users can edit or clear by hand.
  - The card's notes popover gains a "Summary" section. A bookmark with a summary but no notes still shows the button.
  - G's plain-text search matches summaries, and F's exports include them.

| Combination | Behavior |
|---|---|
| New extension, old server | The server ignores `summary`. Summaries stay on the device that wrote them, and pulls never clear them. |
| Old extension, new server | Its pushes omit `summary`, so stored summaries are kept. It does not show them. |
| New extension, new server | Summaries sync. |

### 8. Entry points

- **Popup.** With AI enabled, opening the popup requests suggestions right away.
  - It shows tag chips, and a summary preview with "Save summary", checked by default.
  - Closing the popup aborts the requests.
  - The summary travels in the `ADD_BOOKMARK` message and the IndexedDB fallback (`BookmarkInput.summary`).
- **Bookmark form.** An "AI suggestions" button fills the tag suggestions and the Summary field.
- **Card menu.** "AI suggestions…" opens the bookmark form and starts the request.
- **Bulk bar.** "AI organize…" works on up to 100 selected bookmarks.
  - It shows progress, one request at a time, and can be cancelled.
  - It then lists each bookmark with its suggested tags and summary, each of which can be unchecked.
  - "Apply" writes everything through one `updateBookmarks` call.
- **Not covered:** context-menu saves, and background processing of the library.

### 9. Privacy, README, and privacy policy

- AI requests go straight from the extension to the configured endpoint; TabSlate's server never sees the key or the requests.
- What is sent: the title, URL, description, the 50 most-used tag paths, and page text when available. Notes are never sent.
- What syncs: only tags the user accepts and summaries the user saves, like any other bookmark content.
- The extension's `README.md` gains an "AI features" section.
- The privacy policy, in the TabSlate-Landing repository (`legal.privacyPolicy` in `src/messages/en.json` and `src/messages/zh.json`), updates its data collection, data sharing, and data storage sections, in English and Chinese. Both say that:
  - the AI address, key, and model are stored only on the device and are never synced to TabSlate's server;
  - logging out does not clear them;
  - AI requests go directly to the service the user chose, under that service's privacy policy;
  - TabSlate's server never sees the key or the requests.

## Components and Files

Frontend, new:

- `lib/ai/settings.ts` — the `tabslate-local` database and the AI settings.
- `lib/ai/prompts.ts`, `lib/ai/client.ts`, `lib/ai/parse.ts` — prompts, requests with timeouts and retries, and reply parsing.
- `lib/ai/content.ts` — page text from Readability, snapshots, or fetched pages, with token truncation.
- `components/dashboard/settings/ai-tab.tsx` — the AI tab.
- `components/dashboard/shared/ai-tag-suggestions.tsx` — the suggestion chips.
- `components/dashboard/bulk-actions/ai-organize-dialog.tsx` — the bulk run, progress, and review.
- Dependencies: `@mozilla/readability` (Apache-2.0) and `js-tiktoken` (MIT).

Frontend, modified:

- `lib/types.ts` (`summary`), `lib/storage.ts` (`BookmarkInput.summary`), `lib/api.ts`, `store/bookmarks-store.ts` (sync mapping, merge, confirmation), `lib/sync-confirmation.ts`.
- `components/dashboard/shared/bookmark-form.tsx` (Summary field, AI suggestions), `bookmark-notes-popover.tsx`, `bookmark-menu-items.tsx`, the bulk action bar.
- `entrypoints/popup/App.tsx`.
- `components/dashboard/settings-dialog.tsx` (the AI tab).
- `lib/browser/data-collection-permissions.ts` (`bookmarksInfo` optional, the AI category list), `wxt.config.ts`, `test/wxt-config.test.ts`.
- F's export modules (summary included, AI settings excluded), G's matching (summary as plain text).
- `README.md`, both `messages.json`, `CLAUDE.md` (`tabslate-local`, the AI data flow, the Firefox categories), `ARCHITECTURE.md`.

TabSlate-server: `db/schema.pg.sql`, `internal/model/model.go`, `internal/handler/sync.go`, `internal/handler/bookmarks.go`, `internal/search/`, `cmd/reindex`, their tests, and the server's `CLAUDE.md` and `ARCHITECTURE.md`.

TabSlate-cloud: none (build and test only).

TabSlate-Landing: the privacy policy messages.

## Error Handling

- A refused permission keeps AI off and explains which permission is missing.
- A wrong key, an unreachable endpoint, a timeout, or an unparseable reply shows a message and writes nothing.
- Bulk runs record each bookmark's failure and continue; the review lists failures separately.
- Closing the popup or cancelling a bulk run aborts in-flight requests.
- Clearing the AI settings stops any running request.

## Testing

Each behavior is implemented test-first, with the happy-dom helpers and module save-and-restore pattern from A.

- **Unit tests:**
  - **Settings:** they live in `tabslate-local`, survive `clearDB()`, and never appear in exports or in requests to TabSlate's server.
  - **Permissions:** the single request on Chromium and Firefox.
  - **Request bodies:** single user message; no temperature; `max_tokens` vs `max_completion_tokens`; the three output formats; no notes.
  - **Prompts:** the top-50 tag paths; truncation with `js-tiktoken`.
  - **Parsing:** JSON objects, fenced blocks, JSON inside text, more than five tags, and invalid paths.
  - **Retries:** for retryable statuses and `Retry-After`; none for other errors; the 30-second timeout.
  - **Summary sync:** mapping, merge, and the old-server fallback.
- **Component tests:**
  - **Settings tab:** the always-visible notice, the first-save confirmation, test connection results, and clearing.
  - **Popup:** suggestions, the summary checkbox, and aborting on close.
  - **Form and menus:** the form's AI button and Summary field; the card menu entry.
  - **Bulk:** progress, cancel, review, and apply in one update.
- **Server tests:** the summary column through push, pull, and REST; the length limit; keeping the summary when the field is absent; indexing.
- **Manual check:**
  - Run each entry point against OpenAI and against a local Ollama.
  - In the browser's network panel, confirm that no request to TabSlate's server carries any AI setting.
  - Confirm that the AI settings remain after logging out.

## Accessibility and Internationalization

- Suggestion chips are buttons labeled "Add tag «path»" and announce "New" for new tags.
- Bulk progress uses `role="progressbar"` and announces completion through `role="status"`.
- The key field has a labeled show toggle.
- Every new string is translated in English and Simplified Chinese with `[component]_[description]` keys. Prompts ask for output in the interface language.

## Resolved During Design

- **Local only.** The user's own endpoint and key keep TabSlate's server and costs out of AI entirely; the separate database keeps the settings out of sync, exports, and logout.
- **Suggestions, not automatic tags.** Automatic tags would grow the tag tree without the user's input; suggestions keep D's hierarchy under the user's control.
- **Parameters from reference projects.** Karakeep and Linkwarden leave `temperature` unset and bound output with `max_tokens` (Karakeep); H copies their defaults, including Karakeep's context length, output limit, output formats, timeout, and concurrency, and Linkwarden's 50 existing tags and five-tag cap.

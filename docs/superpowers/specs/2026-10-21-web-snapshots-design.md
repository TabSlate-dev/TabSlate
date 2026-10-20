# Web Snapshots (Sub-project C2)

## Summary

Bookmarks point at pages that change, move, or disappear. This sub-project gives signed-in users a server-side copy of their saved pages, so a bookmark stays readable after its site is gone. Each snapshot holds a reader version of the page, a screenshot, and a copy of the page's cover image. Users can also save a full-page archive of a single bookmark on demand, and snapshot text becomes searchable.

Snapshots are the paid feature of the faved.to-derived roadmap. Their quota is storage space. The design follows Karakeep, an open-source bookmark manager that archives pages the same way: a headless browser renders each page, every saved file is an asset with a recorded size, and the viewer switches between the reader version, the screenshot, and the archive.

Pages are rendered by obscura, a lightweight headless browser that runs in its own container. A new Go worker (`cmd/fetcher`) runs the capture jobs. Jobs go through Hatchet on TabSlate Cloud and through a Redis queue (Asynq) on self-hosted servers. Files live in a local directory or in S3-compatible storage.

## Roadmap Context

This is the fourth sub-project derived from the faved.to comparison (see `docs/superpowers/specs/2026-10-15-library-management-basics-design.md`). Each has its own spec, plan, and implementation cycle.

| Sub-project | Scope | Repositories |
|---|---|---|
| A — Library management basics | View preferences, tag and collection editing, counts, tag search, clickable tags, save shortcut, duplicate detection | Frontend |
| B — Bulk operations and unified form | Multi-select and bulk bar, unified add/edit form, notes, edit time, more sort options | Frontend + server |
| C1 — Image card view | Small and large card views, `og:image` covers read at save time, placeholders | Frontend + server (one field) |
| **C2 — Web snapshots** (this spec) | Server-side page capture, snapshot viewer, full-page archives on demand, snapshot full-text search, storage quota | Server + cloud + frontend |
| D — Nested tags and import hierarchy | Tag hierarchy, parent rollups, folder hierarchy preserved on import | Frontend + server |
| E — Onboarding | Seed content and guided first-run steps | Frontend |

C1 explains how the original sub-project C split in two. AI summaries are deferred until after C2; they can use the snapshot's reader text.

**Depends on B and C1.** The extension work starts after C1 is merged. It extends B's bookmark menu items, bulk action bar, and bookmark form, and C1's large card cover. The server work does not depend on either and can start earlier.

## Goals

- Keep a readable copy of saved pages after their sites change or disappear.
- Take snapshots automatically for new bookmarks and gradually for existing ones, without surprising users with storage they did not expect to use.
- Let users save or update snapshots of single bookmarks and of selections, and save full-page archives on demand.
- Show snapshots inside the new tab page, isolated from the extension's privileges.
- Charge snapshots against a per-plan storage quota that counts only saved files.
- Keep the service safe to run against arbitrary URLs: no access to internal networks, bounded work per page, and no abuse through failed attempts.
- Run the same open-source code on self-hosted servers and on TabSlate Cloud, with Cloud adding only its queue and billing.

## Non-goals

- AI summaries and AI tagging.
- Viewing snapshots offline. Snapshot files are never stored in the extension.
- Copies of the images inside the reader version. Like Karakeep, the reader version keeps the original image URLs; the full-page archive is the way to keep images.
- Snapshot history. Each bookmark has one snapshot.
- Detecting dead links.
- Snapshots for guests, unverified users, or Firefox users without account-data consent.
- Saving videos, PDF exports of web pages, or archives uploaded from the browser (such as SingleFile).
- Sharing snapshots with other people.
- Highlights or annotations on snapshots.
- Screenshots as card covers.

## Decisions

| Question | Decision |
|---|---|
| What sells | Web snapshots ("the page stays readable after the site is gone"), not preview images. |
| Browser | obscura, as its own container, driven over the Chrome DevTools Protocol (CDP). |
| Queue | Hatchet on Cloud, injected the way Flexprice billing is; Asynq on Redis as the open-source fallback; snapshots are off without either. |
| Storage | Local directory, S3, or S3-compatible storage. |
| Snapshot contents | Reader version, screenshot, and cover copy. Image links and PDFs store the file itself. |
| Full-page archive | On demand, for one bookmark at a time. |
| Reader images | Not stored, like Karakeep. They load from the original site. |
| Quota | Storage space: the total size of a user's snapshot files. Failed captures cost nothing. |
| Timing | Automatic for new bookmarks, automatic backfill for existing ones, and manual at any time. A setting turns the automatic parts off. |
| Updates | One snapshot per bookmark. A new capture replaces it only when the page returns HTTP 2xx. |
| Viewer | A page inside the new tab app, `#/snapshot/<bookmarkId>`. |
| File access | Capability URLs signed with an HMAC of the asset ID. They do not expire. |

## Design

### 1. Components

| Component | Form | Responsibility |
|---|---|---|
| API server (existing) | Go, `cmd/server` | Decides what to capture, enforces the quota, enqueues jobs, serves snapshot files and metadata |
| Snapshot worker (new) | Go, `cmd/fetcher`, separate image `tabslate-fetcher` | Runs capture jobs: preflight, rendering, extraction, image processing, archives, storage, results |
| Browser (new) | Official obscura image, separate container | Renders pages with JavaScript and takes screenshots |
| Queue | Hatchet (Cloud) or Asynq on Redis (fallback) | Delivers jobs, retries, and concurrency limits |
| Storage | Local directory, S3, or S3-compatible | Holds snapshot files |

The worker contains no billing logic, so Cloud runs the open-source worker unchanged except for the injected queue.

**Queue interface.** The server defines a small job queue interface: the API enqueues a snapshot job, and the worker implements a handler for one job. The open-source build implements it with Asynq on the existing `REDIS_URL`. `app` gains an option to inject another implementation, and Cloud's `cmd/server` and its new `cmd/fetcher` pass a Hatchet implementation, the same way Cloud injects Flexprice today. With neither queue available, snapshots are off.

**obscura.** obscura is an independent browser engine written in Rust (Apache-2.0) that runs JavaScript on V8 and speaks CDP. The worker connects to it with a CDP token. Each job gets its own browser context, which is closed afterwards. obscura's worker processes are recycled by memory use and connection count. Its rendering differs from Chromium in places, so screenshots are a fallback view rather than the main one, and because the worker uses only standard CDP, a headless Chrome image can replace obscura if needed. The first implementation task verifies that the Go CDP client can navigate, read metadata, take screenshots, and intercept requests on obscura, and how obscura handles download links and video pages.

### 2. When snapshots are taken

- **New bookmarks.** After a sync push or a REST write stores an active bookmark that has no snapshot, the API enqueues it. A request enqueues at most 50 bookmarks this way; the rest wait for the backfill.
- **Backfill.** Every 5 minutes the API enqueues up to 20 bookmarks per user that have no snapshot, newest first. It only considers users who synced in the last 30 days and only while more than 20% of the user's storage quota is free, which keeps room for new bookmarks; unlimited plans have no such reserve. With several API instances, a Postgres advisory lock lets only one run the backfill.
- **Manual.** "Save snapshot" and "Update snapshot" work on one bookmark from its menus and on a selection from the bulk bar. One request carries at most 100 bookmarks.
- **Full-page archive.** Only on demand, for one bookmark that already has a page snapshot.
- **Setting.** "Save snapshots automatically" is on by default. Turning it off stops the new-bookmark and backfill triggers; manual actions keep working. The setting is stored on the server (`users.snapshot_auto`), because the server decides whether to capture, and is shared by all of the user's devices. It is also the opt-out for users who do not want the server to visit their bookmarked URLs.
- **URL changes.** When a bookmark's URL changes, its snapshot belongs to the old page. The API deletes it, frees its space, and enqueues the bookmark again.

Automatic triggers cover active bookmarks in active collections and workspaces only. Manual requests also accept archived bookmarks.

### 3. Capture pipeline

**Preflight.** Before using the browser, the worker sends a GET request and reads only the response headers:

| Response | Handling |
|---|---|
| HTML (`text/html`, `application/xhtml+xml`) | Rendered by obscura. A declared size over 5 MB fails with `too_large`. |
| Image or PDF, at most 20 MB | The file itself is the snapshot. The browser is not used. |
| Video, audio, archives, installers, `Content-Disposition: attachment`, and other types | Marked `unsupported`. Nothing is downloaded or stored. |

The worker's own requests (preflight, cover and file downloads) use an HTTP client from an existing SSRF-protection library. It connects only to public IP addresses and checks every connection, so redirects and DNS rebinding cannot reach internal networks. Requests carry a recognizable user agent, follow at most 5 redirects, and accept only `http` and `https` URLs without embedded credentials.

**Rendering.**

- Time limits: 15 seconds for navigation, 10 seconds for page scripts, and 30 seconds for the whole job.
- Viewport: 1280×800. Screenshots cover the viewport only, never the full page.
- The worker intercepts and fails video, audio, and font requests, and stops a page after 300 sub-requests or 25 MB transferred. Where obscura's interception falls short, the time limits, the container's CPU and memory limits, and obscura's process recycling bound the work.
- After the page's scripts run, the worker reads the rendered HTML and the `og:image` and `twitter:image` URLs.

**What a page snapshot stores.**

- **Reader version.** `codeberg.org/readeck/go-readability/v2` extracts the main content from the rendered HTML. bluemonday then sanitizes it with an allowlist that removes scripts, event attributes, styles, forms, and frames. The result is stored as HTML, at most 2 MB. Images keep their original URLs. Pages without readable content (apps, home pages) get no reader version.
- **Screenshot.** A JPEG (quality 80) of the viewport.
- **Cover copy.** The `og:image`, or the `twitter:image` when `og:image` is missing, downloaded (at most 5 MB, `image/*`, pixel count checked before decoding), scaled to 640 px wide, and stored as a JPEG. Formats the pure-Go decoders cannot read (such as AVIF and SVG) get no cover copy.
- **Metadata.** The final URL, the HTTP status, and the reader version's title and excerpt.

**Full-page archive (on demand).** The worker renders the page again and passes the rendered HTML to monolith (CC0), which inlines images, CSS, and fonts, removes JavaScript, and isolates the document from the network (`-I -j -e`, with the final URL as the base). monolith downloads assets itself, so its traffic goes through a local proxy inside the worker (built on goproxy) that dials only through the same SSRF-protected dialer. An archive larger than 20 MB is discarded, and the user is told.

**Replacing a snapshot.**

- A new capture replaces the reader version, screenshot, and cover copy together, and only when the page returned HTTP 2xx.
- When the page fails (an error status, a timeout, or a dead domain), the old snapshot stays and the failure is recorded. The viewer then says that the original page may be gone and that the earlier snapshot was kept. A page that returns 200 for a parked domain cannot be told apart.
- A full-page archive is replaced only by a newer archive that was saved successfully.

**Statuses.** A bookmark's snapshot is `queued`, `ready`, `failed` (with a reason code such as `timeout`, `blocked`, `http_error`, `too_large`, or `storage_full`), or `unsupported`. When an update fails, a `ready` snapshot stays `ready` and records the last failure.

**Retries and stale jobs.**

- Timeouts, 5xx and 429 responses, and a busy browser are retried by the queue, at most 3 times. Other errors fail the job with a reason code.
- Each job carries the snapshot's generation number. A result for an older generation, or for a bookmark that no longer exists or has a different URL, is discarded.
- Postgres, not the queue, is the source of truth. A `queued` snapshot without a result after 15 minutes is enqueued again; after 24 hours it fails and uses no space.

**Limits and abuse.**

- Each worker sends at most 2 concurrent requests to one site.
- Each user runs at most 2 jobs at a time. Hatchet enforces this; the Redis fallback does not, which matters little on self-hosted servers.
- Failed captures cost no storage, so attempts are limited separately: at most `SNAPSHOT_MAX_ATTEMPTS_PER_DAY` attempts per user per day (unlimited by default; Cloud sets 1,000).
- A bookmark whose capture finally failed is not retried automatically. Manual updates of the same bookmark are at least 10 minutes apart.
- Automatic captures are skipped when the user's free space is insufficient. Manual requests return `403 quota_exceeded` when storage is full. Before saving, the worker checks the actual size again and gives up the whole capture (`storage_full`) if it does not fit.

**Network isolation.** obscura runs on its own network, with internet access but no route to the API, Redis, or the database. Page scripts can request internal addresses on their own, so this complements obscura's built-in blocking of private addresses.

### 4. Data and storage

**Tables** (`db/schema.pg.sql`, idempotent):

- `bookmark_snapshots`, one row per bookmark:
  - `bookmark_id` (primary key, cascades with the bookmark), `user_id`;
  - the captured URL, `status`, `kind` (`page`, `image`, or `pdf`), `captured_at`, the HTTP status, the final URL, and the reader title and excerpt;
  - asset references for the reader version, screenshot, cover copy, and file;
  - the full-page archive's asset, status, time, and last error;
  - the last failure's reason and time, the last manual request time, the generation number, and the sync `seq`.
- `snapshot_assets`, one row per stored file, modeled on Karakeep's asset table: asset ID (UUID), user, bookmark, type, content type, size, and creation time.
- `snapshot_attempts`: attempts per user per day.
- `users.snapshot_auto BOOLEAN NOT NULL DEFAULT TRUE`.
- `subscription_capacity.max_snapshot_storage_mb INTEGER NOT NULL DEFAULT -1`.

**Files.**

- Every file is stored at `snapshots/<userId>/<assetId>`, in the local directory and in S3 alike. Content types and other metadata live in the database, not in sidecar files.
- The reader version is stored only as HTML. Search derives plain text from it when indexing.
- Replacing files: the worker writes the new files, updates the database in one transaction, and deletes the old files after the commit.
- A daily cleanup job deletes files that no database row references, modeled on Karakeep's asset tidying.

**Deletion.**

- Permanently deleting a bookmark, purging its workspace, or deleting the account deletes its snapshot and files. The server keeps permanently deleted bookmarks as tombstones (`is_trashed = 2`) for a while, so the sync push and the cleanup job delete the snapshot explicitly when a bookmark reaches that state; the foreign-key cascade covers rows that are physically removed.
- A URL change deletes the snapshot (section 2).
- Users can delete a snapshot, or only its archive, from the viewer.
- Archived and trashed bookmarks keep their snapshots, which keep counting against the quota. This matches the bookmark quota, which is released only by permanent deletion.

**Quota.**

- `billing.Limits` gains `MaxSnapshotStorageMB`: `-1` is unlimited, `0` means the plan has no snapshots.
- Open source: the new `subscription_capacity` column, `-1` by default.
- Cloud: an optional Flexprice feature, `feat-max-snapshot-storage-mb`. A plan without it counts as `0`, so the server can be deployed before the plans are configured, and `parseEntitlements` keeps accepting existing plans.
- Usage is the total size of the user's snapshot files; only saved files count.
- Saving takes a per-user lock inside the transaction before computing usage, so concurrent workers cannot exceed the quota.
- After a downgrade below current usage, existing snapshots stay viewable and are never deleted automatically; no new snapshots are taken until usage is back under the limit.
- `GET /api/plan` returns the storage limit and usage.

### 5. Sync and API

**Sync (read only).**

- The pull response gains `entities.snapshots`, returned by sequence number like the other entities. The extension never pushes snapshots.
- Each row carries the bookmark ID, status, kind, capture time, title, excerpt, size, the file URLs (cover copy, screenshot, reader version, file, archive), the archive's status and time, and the last failure's reason and time.
- Deleting a snapshot keeps a row with status `deleted` and a new sequence number, so other devices drop it. When a bookmark is permanently deleted, the extension drops its snapshot row as well.
- `capabilities.snapshots` is true when the server has both storage and a queue configured. When it is false, the extension hides every snapshot entry point.
- The worker allocates a new sequence number for every result and notifies clients through the existing Redis pub/sub and SSE stream.

**Endpoints** (verified users only, behind the existing per-user rate limiter):

| Endpoint | Purpose |
|---|---|
| `POST /snapshots` | Save or update snapshots, `{ "bookmark_ids": [...] }`, at most 100. Returns the queued IDs and the skipped ones with reasons (not found, requested less than 10 minutes ago, unsupported). `403 quota_exceeded` when storage is full. |
| `POST /snapshots/:bookmarkId/archive` | Save a full-page archive. |
| `DELETE /snapshots/:bookmarkId` | Delete the snapshot, including its archive, and free its space. |
| `DELETE /snapshots/:bookmarkId/archive` | Delete only the archive. |
| `GET /snapshots/settings`, `PUT /snapshots/settings` | Read and change `{ "auto": boolean }`. |

These endpoints return `503` when snapshots are not configured.

**File access.**

- A file URL is `/snapshot-assets/<assetId>?sig=<hex>`, relative to the server URL. The signature is an HMAC of the asset ID with the server's snapshot signing key. `<img>` and `<iframe>` requests cannot carry an Authorization header, so the URL itself is the credential.
- URLs appear only in the owner's pull responses. A replaced or deleted file's asset ID stops existing, so its URL returns 404.
- Signatures do not expire. A file at a URL never changes, so responses use `Cache-Control: private, max-age=31536000, immutable`.
- Key rotation: `SNAPSHOT_URL_SECRET` is separate from the login secret. During a rotation the old key moves to `SNAPSHOT_URL_SECRET_PREVIOUS`, and both are accepted. On startup the API compares a fingerprint of the current key with the one stored in `server_config`; when they differ, it gives every snapshot row a new sequence number so clients pull fresh URLs. The old key can be removed once clients have synced.
- Responses send `X-Content-Type-Options: nosniff` and, following Karakeep, a strict CSP: `sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; img-src https: data: blob:; style-src 'unsafe-inline' https: data:; font-src https: data:; media-src https: data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'`. PDFs get only `nosniff`, because browsers do not open PDFs in sandboxed documents.
- Range requests are supported, and `download=1` serves the file as an attachment.
- Files are always served through the API (from disk, or read from S3), so the API controls these headers.

**Extension data.**

- IndexedDB moves to v4 with a new `bookmark-snapshots` store, keyed by bookmark ID, that holds only the metadata rows. Logout clears it with the rest of the database.
- `store/snapshots-store.ts` keeps the rows in memory, hydrates from IndexedDB, and merges pull results. `StoreGate` waits for it, and `onPullSuccess` merges snapshots before it writes `localSeq`. Like the other data stores, it is never imported by the popup or the background.

### 6. Extension interface

**Cards.**

- When a bookmark has a `ready` snapshot, its small and large cards show a camera icon next to B's notes button. Clicking it opens the snapshot viewer without opening the page. Queued and failed snapshots show no icon.
- A large card's cover uses the snapshot's cover copy first, then C1's `og:image` URL, then the placeholder.
- The bookmark menu items (⋯ and right-click) gain:
  - "View snapshot", when a snapshot exists. Cmd/Ctrl+click opens it in a new tab.
  - "Save snapshot", or "Update snapshot" when one exists.
  - "Save full-page archive", or "Update full-page archive", for page snapshots.
- The bulk bar's ⋯ menu gains "Save snapshots". It sends batches of 100 and then shows "Queued N, skipped M".
- Cards on the Archive page get "View snapshot", since old links are the most likely to break. The Trash page is unchanged.

**Snapshot viewer** (`#/snapshot/:bookmarkId`, a route inside the new tab app that fills the content area):

- Toolbar: back, favicon and title, the original URL (opens in a new tab), and "Snapshot from «date»".
- When the last update failed: "The original page may be gone. Kept the snapshot from «date»."
- A view dropdown, as in Karakeep: Reader, Screenshot, and Full-page archive for pages; File for images and PDFs. Unavailable views are disabled. The default is Reader, or Screenshot when there is no reader version. The selected view is kept in the URL (`?view=`).
- A ⋯ menu: update the snapshot; save, update, download, or delete the full-page archive; delete the snapshot (confirmed, with the space it frees); edit the bookmark (B's form).
- States: queued (a progress notice; the view refreshes when the result arrives), no snapshot (a "Save snapshot" button), failed (the reason and a retry button), unsupported (why, for example "This link is a video file"), and storage full (upgrade or delete snapshots).
- Rendering:
  - Reader: the extension fetches the reader HTML and shows it in an `<iframe sandbox srcdoc>` that allows popups but not scripts. A stylesheet in the `srcdoc` sets a reading width of about 720 px and follows the dark theme. Links open in new tabs, and images that fail to load are hidden. Third-party HTML never runs in the extension's origin.
  - Screenshot and image files: `<img>`.
  - Full-page archive: `<iframe sandbox="">`, as in Karakeep.
  - PDF: a plain `<iframe>` using the browser's PDF viewer.
- A file that returns 404, usually because another device just replaced the snapshot, triggers one pull and one retry with the new URL.

**Settings.** A "Web snapshots" section, shown to signed-in users on servers that support snapshots:

- the "Save snapshots automatically" switch (`/snapshots/settings`);
- a storage bar with usage and limit, or an upgrade hint when the plan has no snapshots;
- "Snapshots: N of M bookmarks", which shows the backfill's progress.

Guests see no snapshot entry points; the settings section says snapshots are available after signing in.

**Quota alerts.** Manual actions that hit `403 quota_exceeded` show `QuotaAlert` with a new message: "Snapshot storage is full", or "Your plan doesn't include web snapshots" when the plan's limit is 0. The snapshot actions stay visible on such plans, so they work as an upgrade prompt. Automatic captures skipped for lack of space show no alert; the settings bar and the viewer show the state.

### 7. Search

- MeiliSearch's bookmark document gains `content`: plain text from the reader version, at most 50,000 characters. The searchable attributes become title, URL, description, notes, then content.
- The worker updates the document when it saves or replaces a snapshot, and the API does when a snapshot is deleted. `cmd/reindex` includes content, reading reader versions from storage.
- `GET /search` never returns content. When a match is in the content, the result adds a `snippet` of about 30 words around it, produced by MeiliSearch's cropping.
- The new tab's `SearchBox` adds a "Snapshot text" group after the local bookmark results when the user is signed in, the server supports snapshots, and the query has at least 2 characters. The request is debounced by 300 ms. The group lists only bookmarks missing from the local results, with their title and snippet, and opens the snapshot viewer.
- The search overlay on web pages already uses server search, so content matches appear there automatically. It shows the snippet and keeps opening the page itself.
- Without MeiliSearch there is no full-text search, and the group never appears.

### 8. Deployment

**Self-hosted (`docker-compose.yml`).** Today the file has `api` and `caddy`; the database, Redis, and MeiliSearch are external. It gains:

- `fetcher`: the new `tabslate-fetcher` image, built from the same repository, with a pinned monolith release;
- `obscura`: the official image at a pinned version, running `obscura serve` with several worker processes recycled by memory and connection count, protected by a CDP token, and not published to the host;
- `redis`, for installations without an external Redis.

`obscura` is only on a separate `browser` network with internet access; `fetcher` joins both networks. Local storage uses a shared volume that `fetcher` writes and `api` reads; S3 needs no volume.

**New environment variables.** Storage (`SNAPSHOT_STORAGE=local|s3`, the local directory, and the S3 endpoint, region, bucket, keys, and path-style flag), the browser (CDP URL and token), the URL signing keys (current and previous), worker concurrency, and `SNAPSHOT_MAX_ATTEMPTS_PER_DAY`. Snapshots turn on only when storage and a queue are configured. Without them the server behaves exactly as today, so existing self-hosted servers are unaffected by the upgrade.

**Cloud.** Cloud's `cmd/server` and new `cmd/fetcher` inject the Hatchet queue. Plans get `feat-max-snapshot-storage-mb`; plans without it have no snapshots. `fetcher` and `obscura` scale independently, and Hatchet provides per-user fair scheduling and the 2-job limit per user.

**Deployment order.** TabSlate-server, then TabSlate-cloud, then the extension.

| Combination | Behavior |
|---|---|
| New extension, old server | No `snapshots` capability, so snapshot features stay hidden. |
| Old extension, new server | Snapshots are taken for eligible users but not shown until they update the extension. |
| New extension, new server | Snapshots work. |

### 9. Privacy and Firefox data collection

- Snapshot requests send only bookmark IDs, which the server already has, and the extension loads snapshot files from the user's own sync server under the existing account-data consent. The declared Firefox data-collection categories do not change.
- The server visits bookmarked URLs from its own IP address. The privacy policy, the README, and the self-hosting documentation say so. The "Save snapshots automatically" switch is the opt-out.

## Components and Files

TabSlate-server, new:

- `cmd/fetcher/main.go` — the worker binary.
- `internal/jobqueue/` — the job queue interface and its Asynq implementation.
- `internal/blobstore/` — the storage interface with local and S3 implementations.
- `internal/netguard/` — the SSRF-protected HTTP client and the local egress proxy for monolith.
- `internal/browser/` — the CDP client for obscura.
- `internal/snapshots/` — triggers, backfill, quota, and the capture pipeline (preflight, rendering, reader extraction, images, archives, results).
- `internal/handler/snapshots.go` — snapshot endpoints and file serving.

TabSlate-server, modified: `app/` (configuration, wiring, the queue injection option, startup key check), `billing/types.go` and `billing/local/provider.go` (`MaxSnapshotStorageMB`), `db/schema.pg.sql`, `internal/handler/sync.go` (pull, capability, triggers, URL changes, deletion), `internal/handler/bookmarks.go` (REST triggers), `internal/handler/billing.go` (plan usage), `internal/handler/cleanup.go` (snapshot deletion on purge), `internal/search/` and `cmd/reindex` (content and snippets), `Dockerfile` (fetcher image), `docker-compose.yml`, `.env.example`, `README.md`, `CLAUDE.md`, `ARCHITECTURE.md`.

TabSlate-cloud: `cmd/server/main.go` (inject Hatchet), `cmd/fetcher/main.go` (new), a Hatchet queue implementation, `internal/flexprice/provider.go` (optional storage feature), deployment files.

Frontend, new:

- `store/snapshots-store.ts`
- `lib/snapshots.ts` — types, API calls, and URL helpers
- `components/dashboard/snapshot/` — the viewer page, view components, and states, plus `snapshot-settings.tsx`, the settings section that `settings-dialog.tsx` renders

Frontend, modified: `lib/idb.ts` (v4), `lib/api.ts` (snapshot endpoints, pull types, search snippets), `entrypoints/newtab/App.tsx` (route, `StoreGate`, `onPullSuccess`), `components/dashboard/bookmark-card.tsx` and C1's `bookmark-cover.tsx`, `shared/bookmark-menu-items.tsx`, the bulk action bar, `archive-content.tsx`, `settings-dialog.tsx`, `store/plan-store.ts`, `components/ui/quota-alert.tsx`, `search-box.tsx`, the search overlay, both `messages.json`, `CLAUDE.md`, `ARCHITECTURE.md`.

## Error Handling

- **Queue unavailable.** The snapshot stays `queued`, is enqueued again after 15 minutes, and fails after 24 hours without using space.
- **Storage write failures.** The job is retried. Files written without a committed database row are removed by the daily cleanup.
- **Browser failures.** Busy or crashed browser processes are retried by the queue. Pages that cannot be rendered fail with a reason code.
- **Endpoint errors.** `403 quota_exceeded` shows the quota alert, and `429` shows a "too many requests" notice. `503` does not reach the interface, because the capability flag hides the entry points.
- **Stale file URLs.** A 404 in the viewer triggers one pull and one retry.
- **Failed updates.** An existing snapshot is never replaced by a failed capture.

## Testing

Each behavior is implemented test-first.

- **Go unit tests:**
  - capture: the preflight classification (content types, `Content-Disposition`, sizes); the SSRF dialer (private ranges, IPv4-mapped IPv6, link-local, CGNAT); reader extraction and sanitizing against fixed HTML samples; image scaling; the monolith invocation, with a fake binary;
  - storage and quota: local and S3 storage (S3 with an in-memory fake); the storage quota with two concurrent saves near the limit; replacement only on 2xx; deletion on URL changes;
  - API and sync: file serving (signature checks, headers, Range, the PDF exception); pull rows and `deleted` rows; endpoint validation, the 10-minute rule, and `403`; the key-rotation sequence bump;
  - queue: backfill selection and the free-space reserve; re-enqueuing stuck jobs; the Asynq queue with miniredis.
- **Integration tests** (tagged, need Docker): obscura against a local test site, covering navigation, metadata, screenshots, request interception, download links, and video pages. This is also the plan's first task.
- **Cloud:** the Hatchet queue implementation against a fake client; `go test ./...`.
- **Extension tests:** merging pulled snapshot rows; the IndexedDB v4 upgrade; card icons and menu items; bulk "Save snapshots"; the viewer's states and views, including the iframes' `sandbox` attributes and `srcdoc`; the settings section (switch and storage bar); the storage-full alert; the large card's cover order; the "Snapshot text" search group.
- **Manual check:** a full docker-compose setup; snapshots of an article, a single-page app, a YouTube page, a PDF link, an image link, and an archive download link; the reader, screenshot, and full-page archive views; Firefox; MinIO as S3-compatible storage; a full quota; a URL change; and an update after the original site went offline, which must keep the earlier snapshot.

## Accessibility and Internationalization

- The camera icon is a button labeled "View snapshot".
- The view dropdown is labeled, and every iframe has a `title`.
- Status notices use `role="status"`.
- The storage bar exposes its value with `role="progressbar"` or a text equivalent.
- Every new string is translated in English and Simplified Chinese with `[component]_[description]` keys.

## Resolved During Design

- **Snapshots instead of preview images.** A server pipeline that only produces card images is heavy to run and hard to sell. Keeping pages readable after link rot is easy to understand, and it is how Karakeep and Raindrop sell archiving.
- **Separate worker and dedicated queue.** Rendering arbitrary pages needs isolation and independent scaling. Hatchet has a Go SDK, per-key fair scheduling, and dynamic rate limits, while trigger.dev only supports TypeScript tasks. Asynq keeps self-hosted servers on the Redis they may already run.
- **Reader images.** Karakeep keeps the original image URLs in its reader version and relies on full-page archives for images. Storing reader images would make every automatic snapshot several times larger, so C2 does the same.
- **Storage quota.** Archives vary from kilobytes to megabytes, so storage tracks cost better than a snapshot count, and users already understand storage plans.
- **No URL expiry.** Expiring URLs would need a signing request for every view and would defeat caching of covers in card grids. Replacing or deleting a snapshot invalidates its URLs, and key rotation invalidates all of them.
- **Deleting on URL change.** A snapshot of the old URL would be misleading for the new one, so it is deleted rather than kept as a fallback.

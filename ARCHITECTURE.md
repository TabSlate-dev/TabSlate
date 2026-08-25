# ARCHITECTURE.md

## 总体结构

TabSlate 是一个 Chrome MV3 扩展，由三个独立入口点组成，通过 `chrome.storage.local` 共享数据。

```
┌─────────────────────────────────────────────────────┐
│  newtab (主应用)                                      │
│  React 19 + Zustand + React Router + dnd-kit        │
│  覆盖 chrome://newtab                                 │
├──────────────┬──────────────────────────────────────┤
│  popup       │  background (Service Worker)          │
│  快速保存当前 │  监听 tab/group 事件                    │
│  页为书签     │  处理右键菜单保存                        │
└──────────────┴──────────────────────────────────────┘
              共享: chrome.storage.local
```

## 目录结构

```
TabSlate/
├── entrypoints/
│   ├── newtab/          # 主应用入口
│   │   ├── main.tsx     # ReactDOM.createRoot
│   │   └── App.tsx      # 路由、布局、StoreGate → SyncProvider → HashRouter/dashboard；AuthDialog 覆盖在 dashboard 之上
│   ├── popup/           # 快速保存 popup
│   │   └── App.tsx      # 独立 React 树，不使用 Zustand；保存时调用 GET_PAGE_INFO 获取 ogTitle/metaDescription
│   ├── background.ts    # Service Worker：tab 事件广播 + 右键菜单 + open-search 快捷键监听 + 动态内容脚本注册（syncContentScriptRegistration）
│   └── content.ts       # 注入页面：GET_PAGE_INFO 响应 + 挂载全局 SearchOverlay (Shadow DOM)；配置为 runtime 注册以支持可选权限
│
├── components/
│   ├── auth/
│   │   ├── auth-dialog.tsx          # 覆盖 dashboard 的认证 Dialog；guest 可关闭，未验证用户强制显示 OTP
│   │   └── verify-email-screen.tsx  # AuthDialog 内的 OTP 邮箱验证内容（未验证用户不可关闭）
│   ├── login-form.tsx          # login/register/forgot-password/reset-password 四模式 + Prosopo 验证码 + 密码强度提示
│   ├── procaptcha.tsx          # Prosopo iframe 包装组件（绕过 MV3 CSP 限制；通过 postMessage 接收 token）
│   ├── search/
│   │   ├── search-panel.tsx    # 内联搜索 UI：输入框 + 书签/标签/搜索引擎三栏下拉；键盘导航；已归档 badge；从 useSettingsStore 读取默认引擎
│   │   └── search-overlay.tsx  # 全局搜索浮层（供 content.ts 注入 Shadow DOM）；从 chrome.storage.local["tabslate-search-engines"] 读取用户引擎（content script 无法用 Zustand）
│   ├── ui/              # shadcn/ui 基础组件 + 自定义共享组件
│   │   ├── alert.tsx           # 标准 shadcn Alert（内联提示 + 浮动通知）
│   │   ├── color-picker.tsx    # Tab group 颜色选择器（共享）
│   │   ├── favicon-image.tsx   # 带 fallback 的 favicon 图片
│   │   ├── input-otp.tsx       # 6 格 OTP 输入框（基于 input-otp 包）
│   │   ├── quota-alert.tsx     # 配额上限浮动通知（fixed 定位，订阅 usePlanStore.quotaAlert，3s 自动消失）
│   │   └── select.tsx          # 标准 shadcn Select（基于 @radix-ui/react-select）
│   └── dashboard/
│       ├── sidebar/            # 左侧书签导航栏
│       │   ├── index.tsx       # BookmarksSidebar（主组件，接收 syncStatus + onForceSync）
│       │   ├── sync-status.tsx # SyncStatusIndicator 按钮（idle/syncing/error/offline 四色指示）
│       │   ├── collection-dialog.tsx
│       │   ├── tag-dialog.tsx
│       │   └── group-dialog.tsx
│       ├── tabs-panel/         # /tabs 路由：当前标签页管理
│       │   ├── index.tsx       # TabsPanel（主组件）
│       │   ├── group-card.tsx  # 单个 Chrome tab group 卡片
│       │   ├── ungrouped-section.tsx
│       │   ├── draggable-tab.tsx
│       │   ├── save-collection-dialog.tsx
│       │   └── join-group-dialog.tsx
│       ├── groups-panel/       # /tabs 路由右侧：保存的标签组
│       │   ├── index.tsx       # GroupsPanel（主组件，独立 DnD context）
│       │   ├── droppable-group-card.tsx
│       │   ├── draggable-tab-row.tsx
│       │   └── create-group-bar.tsx
│       ├── group-detail/       # /groups/:groupId 路由：单个保存组详情
│       │   └── index.tsx       # GroupDetail（标签列表、内联编辑、拖拽支持）
│       ├── tabs-dnd-provider.tsx # 全局 DnD context（tab → collection/saved-group）
│       ├── tab-row.tsx         # 单行 tab 组件（React.memo）
│       ├── stats-cards.tsx     # 书签统计卡片
│       ├── search-box.tsx      # 统一搜索栏（新标签页英雄区 + 集合内联）；open tabs / 书签 / 引擎三段下拉；size="sm|lg"；collectionId 过滤
│       ├── hero-section.tsx    # 新标签页英雄区：时钟 + SearchBox（lg）+ AdBanner
│       ├── content.tsx         # / 路由：书签网格/列表；集合视图内嵌 SearchBox（sm）；顶部嵌入 SearchPanel（smartOpen 模式）
│       ├── header.tsx          # 顶部搜索/过滤栏
│       ├── workspace-rail.tsx  # 最左侧工作区切换轨道
│       ├── tabs-rail.tsx       # 最右侧标签页快速预览轨道
│       ├── settings-dialog.tsx # 设置对话框：搜索引擎管理（启用/禁用/拖拽排序/添加/删除）
│       ├── bookmark-card.tsx   # 单个书签卡片/列表项
│       ├── favorites-content.tsx
│       ├── archive-content.tsx
│       └── trash-content.tsx
│
├── store/
│   ├── auth-store.ts       # 认证状态（user、accessToken、refreshToken、serverUrl）— 持久化；login/register/resendVerification/forgotPassword 均调 resolveAcceptLanguage 并将结果作为 Accept-Language 传给 api.*
│   ├── bookmarks-store.ts  # 书签数据 + UI 过滤状态；含 mergeFromServer（同步合并）
│   ├── workspace-store.ts  # 工作区/集合/标签配置；含 localSeq、mergeFromServer、setLocalSeq
│   ├── groups-store.ts     # 保存的标签组（含 dnd-kit 排序数据）
│   ├── plan-store.ts       # 套餐配额状态；fetchPlan (GET /api/plan)，5 分钟 TTL；checkQuota(resource, localCount)/showQuotaAlert/incrementUsage/decrementUsage；持久化到 chrome.storage.local (key "tabslate-plan")
│   ├── settings-store.ts   # 搜索引擎列表（启用状态、顺序、自定义引擎）；持久化到 IDB kv["searchEngines"]；pullFromServer 从服务端拉取偏好
│   └── tabs-store.ts       # Chrome 当前窗口标签页（非持久化）
│
├── types/
│   └── prosopo.d.ts        # window.procaptcha 全局类型声明（captcha widget 页面使用）
│
├── lib/
│   ├── api.ts              # TabSlate-server HTTP 客户端（auth + sync + search）；ApiError 携带 status/captchaRequired/retryAfter；searchBookmarks() 调用 GET /search；register/login/resendVerification/forgotPassword 接受可选 lang 参数，非空时注入 Accept-Language 请求头
│   ├── types.ts            # Workspace, Collection, Tag, Bookmark 接口定义（含 seq, deletedAt 同步字段）
│   ├── sync-engine.ts      # SyncEngine：协调 SyncQueue + SSEClient + 定期拉取；模块单例 syncEngine
│   ├── sync-queue.ts       # SyncQueue：按实体 ID 去重、2s 防抖、指数退避推送（2s→60s）
│   ├── sse-client.ts       # SSEClient：leader election via chrome.storage + EventSource 自动重连（1s→30s）
│   ├── utils.ts            # cn() 等工具函数
│   ├── storage.ts          # popup 用的轻量 chrome.storage 读写工具
│   ├── auth-storage-adapter.ts    # Zustand persist 适配器：accessToken → session storage，其余 → local storage；含旧版迁移路径
│   ├── sync-recovery.ts           # 401 时保存同步快照；内存缓冲区 + chrome.storage.session 双层持久化（页面重载后仍可恢复）；SyncQueue 构造时通过 `loadSyncRecoverySnapshot()` 异步读取并重入队列
│   ├── chrome-storage-adapter.ts  # 通用 Zustand persist 的 chrome.storage 适配器（非 auth 用）
│   ├── id.ts               # generateId()
│   ├── bookmark-utils.ts   # normalizeFavicon()、findDuplicateBookmark()、normalizeUrl()、getNormalizedUrlSet()
│   ├── analytics.ts        # 匿名分析模块；`analytics.init()` + `analytics.track(name, props?)`；fire-and-forget POST 到自部署 OpenPanel `/api/track`；两个 env var 均为空时 no-op；session ID 存 `chrome.storage.local["tabslate-analytics-id"]`
│   └── chrome/
│       ├── tabs.ts         # Chrome tabs API 封装
│       └── tab-groups.ts   # Chrome tabGroups API 封装 + 颜色常量
│
├── hooks/
│   ├── use-tab-drag-drop.ts   # 原生 HTML drag-and-drop（tab → 书签内容区）
│   ├── use-group-drag-drop.ts # 原生 HTML drag-and-drop（tab → 保存组详情页）
│   └── use-mobile.ts          # 响应式断点检测
│
└── wxt.config.ts            # 扩展 manifest、权限配置
```

## 状态管理

### Store 设计原则

所有 store 使用 Zustand。持久化分为两层：

```
useAuthStore       ──Zustand persist──▶  chrome.storage.session  "tabslate-auth-token"  (accessToken)
                                    ──▶  chrome.storage.local   "tabslate-auth"  (user, refreshToken, serverUrl, otpSentAt)
useBookmarksStore  ──手动 idbPut/Get──▶  IndexedDB  bookmarks / archived-bookmarks / trashed-bookmarks
useWorkspaceStore  ──手动 idbPut/Get──▶  IndexedDB  workspaces / collections / tags / kv
useGroupsStore     ──手动 idbPut/Get──▶  IndexedDB  groups / group-tabs
usePlanStore       (不持久化，GET /api/plan 内存缓存，5 分钟 TTL)
useSettingsStore   ──手动 idbPut/Get──▶  IndexedDB  kv["searchEngines"]
                   ──StoreGate 镜像──▶  chrome.storage.local  "tabslate-search-engines"（供 content script 读取）
useTabsStore       (不持久化，运行时从 Chrome API 加载)
SSE leader         ──idbPut("kv")──▶    IndexedDB  kv["sync-leader"]  （30s TTL）
```

`lib/idb.ts` 封装 `indexedDB.open("tabslate-db", 3)`，暴露：
- `idbGet/idbPut/idbDelete/idbGetAll/idbGetByIndex` — 基础单键操作
- `idbGetMany(store, keys)` — **批量读取**，在单个 IDB 事务内并发发起 N 个 `get` 请求，性能远优于 `Promise.all(keys.map(idbGet))`（后者会创建 N 个独立事务）
- `idbBulkWrite(ops)` — **跨 store 原子写**，在单个 readwrite 事务中执行若干 `put` / `delete`，用于 `mergeFromServer` 同步落盘
- `idbTransaction` — 底层事务包装，供需要自定义逻辑的场景使用
- `idbCommitWorkspaceDeleteLifecycleIntent` / `idbCommitWorkspaceLifecycleIntent` — 工作区生命周期专用的原子读写事务；前者在同一 `readwrite` 事务内校验并提交软删除（含"最后一个活跃工作区"拒绝判定），后者提交任意 workspace 快照 + intent 组合（如 restore）
- `idbTryAcquireLock` / `idbRenewLock` / `idbReleaseLock` — 基于 `kv` 的租约互斥锁，`navigator.locks` 不可用时的 IndexedDB 回退（见下）

**v3 迁移**（`oldVersion < 3`）：为 `groups` 添加 `workspaceId` 索引（`unique: false`），支持按工作区高效过滤 saved group 聚合。v2 迁移（`oldVersion >= 1 && < 2`）为 `trashed-bookmarks` 添加 `collectionId` 索引。新安装直接在 v1 建表时包含全部索引。

各 store 的 `hydrate()` 在挂载时调用 `idbGetAll` 批量读取；`archived-bookmarks` 和 `trashed-bookmarks` 延迟加载（仅在进入对应路由时触发），以减少启动内存峰值。

### Store 职责

| Store | 持久化后端 | 职责 |
|---|---|---|
| `useAuthStore` | chrome.storage.session（accessToken）+ chrome.storage.local（其余） | 登录用户信息（含 `is_verified`）、access/refresh token、server URL；actions：login/register/resendVerification/verifyEmailOTP/forgotPassword/resetPassword/logout/silentRefresh；`silentRefresh` 在 rehydrate 时自动触发（refreshToken 存在但 accessToken 缺失），支持指数退避重试（2s→60s），仅在确切 401/403 时清除 token |
| `useBookmarksStore` | IndexedDB | 书签数据（active/archived/trashed）+ 过滤/排序/视图 UI 状态；`mergeFromServer` 执行 LWW 合并；`is_trashed===2` 时从所有 bucket 清除；`permanentlyDelete`（单条）/ `permanentlyDeleteBatch`（批量，≤900/请求）在线时采用 push-first 模式（`forcePush` → `idbBulkWrite` → `decrementUsage`），失败时回滚乐观 UI；**离线时（`syncEngine===null`）写 `isTrashed:2、seq:0` 墓碑到 IDB、从 state 过滤，`sweepUnsynced` 在下次在线时推送**；`permanentlyDeleteCollectionBookmarks` 不再 forcePush（服务端 cascade 已处理），仅执行本地 IDB 清理 |
| `useWorkspaceStore` | IndexedDB | 工作区、集合、标签、高亮状态；`localSeq` 同步游标；`mergeFromServer` 执行 LWW 合并，工作区 `is_deleted∈{0,1}` 时 update+keep（保留墓碑供恢复），`is_deleted===2` 才从 state+IDB 删除；`deleteWorkspace`/`restoreWorkspace`/`permanentlyDeleteWorkspace` 通过工作区生命周期协议实现（见下方专节），不再是普通字段更新；`permanentlyDeleteCollection` 采用 push-first 模式（`forcePush` → `idbDelete` → `decrementUsage`），失败时回滚；书签 tombstone 同步由服务端级联兜底（集合 `is_deleted=2` 被接受时，服务端将其书签自动升级为 `is_trashed=2`） |
| `useGroupsStore` | IndexedDB | 保存的标签组（含同步字段 seq、deletedAt）及其 tab；`permanentlyDeleteGroup` 采用 push-first 模式（`forcePush` → `idbDelete`），失败时回滚；`mergeFromServer` 中 state=2 records 被过滤出 state+IDB |
| `usePlanStore` | chrome.storage.local | 套餐配额数据：subscription、limits、usage；`fetchPlan` 调用 `GET /api/plan`，5 分钟 TTL；书签配额以 `is_trashed < 2` 计（active + trashed），仅 `permanentlyDelete` 时 `decrementUsage`；`checkQuota(resource)` 在 create 类 action 中使用；`showQuotaAlert` 触发 `<QuotaAlert />` 显示；`incrementUsage`/`decrementUsage` 维护本地计数；`clear` 在登出时调用 |
| `useSettingsStore` | IndexedDB (kv) + chrome.storage.local | 搜索引擎列表（`SearchEngine[]`）：启用状态、顺序、自定义引擎；`updateSearchEngines` 写 IDB 并推服务端；`pullFromServer` 从服务端拉取偏好；`StoreGate` 将变更镜像到 `chrome.storage.local["tabslate-search-engines"]` 供 content script 读取 |
| `useTabsStore` | 不持久化（tab-group-titles + kv 写 IDB） | Chrome 当前窗口的实时标签页和 tab group 数据；`fullTitles: Record<number, string>` 维护 compact group 的完整标题，`loadTabs` 通过两层恢复逻辑（孤儿条目对账 + kv 稳定回退）在重启后重新关联（详见 CLAUDE.md Compact group title） |

### 跨进程通知

chrome.storage.local 不再用于跨页面数据同步。各进程通过 `chrome.runtime.sendMessage` 传递轻量信号：

| 消息 | 发送方 | 接收方 | 说明 |
|---|---|---|---|
| `TABS_CHANGED` | background | newtab | tab/group 有变化，触发 `loadTabs()` |
| `BOOKMARKS_CHANGED` | background | newtab | background 回退写 IDB 后通知刷新 |
| `ADD_BOOKMARK` | popup / background | newtab | 直接投递书签数据（优先路径） |
| `OPEN_SEARCH` | background | active tab | 触发全局搜索快捷键，挂载 SearchOverlay |
| `GET_OPEN_TABS` | active tab | background | SearchOverlay 请求打开的标签页列表 |
| `FOCUS_TAB` | active tab | background | SearchOverlay 请求切换到指定标签页 |
| `OPEN_TAB` | active tab | background | SearchOverlay 请求打开新标签页（content script 无法直接调用 `chrome.tabs.create`） |
| `SEARCH_BOOKMARKS` | active tab | background | SearchOverlay 代理发起搜索请求（绕过跨域限制） |

## 路由

使用 `HashRouter`（避免扩展 URL 与 HTML5 History 冲突）：

| 路径 | 组件 | 说明 |
|---|---|---|
| `/` | `BookmarksContent` | 书签主界面（grid/list）；顶部搜索栏（书签 + open tabs + Google 回退） |
| `/favorites` | `FavoritesContent` | 收藏夹 |
| `/archive` | `ArchiveContent` | 已归档集合卡片（含一键还原）+ 已归档单个书签 |
| `/trash` | `TrashContent` | 已删除集合 + 已删除保存组（含还原 + 永久删除）+ 已删除单个书签 |
| `/tabs` | `TabsPanel` | 当前标签页管理 |
| `/groups/:groupId` | `GroupDetail` | 保存组详情（标签列表、内联编辑、删除、从 TabsRail 拖入） |

## 布局结构

```
┌──────┬──────────┬────────────────────────┬──────────┐
│ Work │ Bookmark │                        │  Tabs    │
│ space│ Sidebar  │   Content Area         │  Rail    │
│ Rail │          │  (route-dependent)     │ (右侧预览)│
│      │          │                        │          │
│ 52px │ 240px    │   flex-1               │ 240px    │
└──────┴──────────┴────────────────────────┴──────────┘
```

- `WorkspaceRail`：最左侧，工作区切换 + 主题切换
- `BookmarksSidebar`：左侧，集合/分组/标签导航，同时是 DnD drop target
- 内容区：响应路由
- `TabsRail`：右侧，当前标签页快速浏览（仅桌面端 lg+）

## DnD（拖拽）系统

项目存在两套独立的拖拽系统：

### 1. TabsDndProvider（主 DnD context）
- 范围：整个 newtab 应用（`tabs-dnd-provider.tsx`）
- 用途：从 `TabsPanel` 拖 tab/tab-group → 到 `BookmarksSidebar`（保存为书签/保存组）
- 技术：dnd-kit `DndContext`
- Drop targets：`sidebar-collection-{id}`、`sidebar-groups`

### 2. GroupsPanel 内部 DnD
- 范围：仅 `GroupsPanel` 组件内部
- 用途：从左侧 open tabs 列表拖 tab → 到右侧 saved groups
- 技术：独立的 dnd-kit `DndContext`（不与外层 context 共享）

### 3. HTML5 原生拖拽（use-tab-drag-drop）
- 范围：`TabsRail` → `BookmarksContent`
- 用途：从右侧标签页轨道拖 tab 到书签内容区，含重复检测与高亮
- 技术：原生 `draggable` + `dragover` 事件，MIME type `application/tabslate-tab`

### 4. HTML5 原生拖拽（use-group-drag-drop）
- 范围：`TabsRail` → `GroupDetail`
- 用途：从右侧标签页轨道拖 tab 到保存组详情页
- 技术：与 system 3 相同 MIME type，drop 后调用 `addTabToGroup()`（自动去重）

## Chrome 扩展事件流

```
Chrome tab 变化
    │
    ▼
background.ts
  └── broadcastTabChange()
        └── chrome.runtime.sendMessage({ type: "TABS_CHANGED" })
              │
              ▼
        chrome.runtime.onMessage
              │
    ┌─────────┴──────────────────────┐
    ▼                                ▼
App.tsx（监听）               TabsRail（独立本地 state）
  └── useTabsStore.loadTabs()    └── refresh()（监听自己的 onMessage）
        │
  ┌─────┴──────┐
  ▼             ▼
TabsPanel   GroupsPanel
（useTabsStore 订阅者，自动更新）
```

```
popup / background（右键菜单）
    │  chrome.tabs.sendMessage(newtabTabId, { type: "ADD_BOOKMARK", data })
    │  （newtab 不存在时回退到直接写 chrome.storage，seq=0）
    ▼
newtab App（chrome.runtime.onMessage）
  └── useBookmarksStore.getState().addBookmark(data)
        └── syncEngine?.enqueue(...)  ← 立即推送到服务器
```

## 跨设备同步系统

### 架构概览

```
Device A                               Server                         Device B
────────                              ────────                        ────────
SyncEngine
  ├── SyncQueue ──POST /sync/push──▶  Push Handler                      ▲
  │   (debounce 2s, LWW upsert)       (tx, incrementSeq,              SSE
  │                                    Broadcast to Hub)              event
  ├── SSEClient ◀──GET /sync/stream── SSE Hub ◀─── broadcasts ───────────┤
  │   (leader election,               (in-memory pub/sub)             Pull
  │    1 window per user)              per-user connID map            ─────▶
  │                                                                   GET /sync/pull
  └── periodic pull (5 min fallback)
```

### 同步流程

**推送（本地变更 → 服务器）：**
1. 任意 store action 调用 `syncEngine?.enqueue({ bookmarks: [...] })` 等
2. `SyncQueue` 以实体 ID 为 key 去重合并，等待 2s 防抖窗口
3. `POST /sync/push` 发送 snapshot；大负载（>900 实体）由 `splitPayload` 自动切成多个顺序请求（非书签在前保证 FK，书签在后），每个请求服务端在单事务内 LWW upsert，`incrementSeq` 并广播新 seq 到 Hub
4. 失败时将 snapshot 重新入队，指数退避重试（2s → 4s → … → 60s）

**拉取（服务器变更 → 本地）：**
1. SSE leader 收到 `{seq: N}` 事件 → `serverSeq > localSeq` 时触发 `GET /sync/pull?after_seq=localSeq`
2. 或每 5 分钟定期拉取（SSE 离线时使用）
3. 响应中的 workspaces/collections/tags 经 `mergeFromServer`（workspace-store）LWW 合并；`sc.is_deleted===2` 的 collection 记录直接从 state+IDB 删除，不参与 LWW
4. bookmarks 经 `mergeFromServer`（bookmarks-store）LWW 合并（含 `tag_ids`）；`sb.is_trashed===2` 的记录从 active/archived/trashed 三个 bucket 全部清除
5. groups 经 `mergeFromServer`（groups-store）LWW 合并；`sg.is_deleted===2` 的 group 及其 tabs 从 state+IDB 删除；软删除组 update+keep（供回收站过滤），活跃组整体替换 tab 快照
6. App.tsx 的 `onPullSuccess` 回调更新 `localSeq`；若非首次推送，调用 `sweepUnsynced()` 将所有 `seq=0` 实体补推；末尾调用 `usePlanStore.getState().ensureFresh()` 刷新用量展示（TTL 内 no-op）

**SSE 连接（实时通知）：**
- `POST /auth/sse-token` 获取 30s 单次使用令牌（EventSource 无法携带 Authorization header）
- `GET /sync/stream?token=<token>` 建立 SSE 连接
- 多窗口 leader election：`chrome.storage.local["tabslate-sync-leader"]` TTL 30s，leader 每 25s 续约；非 leader 每 25s 竞选
- `SyncEngine` 在 SSE 连续失败 3 次后切换到 `"offline"` 状态，纯依赖定期拉取

### App.tsx 中的 SyncProvider

```
StoreGate → SyncProvider（render-prop） → HashRouter/dashboard
               ├── verified 会话才 new SyncEngine(getCredentials, getLocalSeq, onPullSuccess, onPushSuccess, onStatusChange)
               ├── syncStatus: "idle" | "syncing" | "error" | "offline"
               ├── syncErrorMessage: string | null  (error 状态下的错误原因，传递给 SyncStatusIndicator tooltip)
               └── onForceSync → syncEngine.forceSync()

AuthDialog 覆盖在 dashboard 之上；guest 可从 Sidebar 进入，未验证用户强制显示不可关闭的 VerifyEmailScreen OTP 内容。
```

`SyncProvider` deps `[syncEnabled, serverUrl]`：验证状态或 server URL 变更时销毁旧引擎再创建新引擎；引擎通过 `getCredentials` 实时读取已刷新的 token，不会因 token 刷新而重建。
cleanup 函数依次调用 `engine.forceSync()`（fire-and-forget）、`engine.destroy()`、`releaseSyncEngine(engine)`，销毁当前引擎实例且不会误销毁已重建的新引擎；fire-and-forget push 不保证 logout 前的持久化数据同步。
`onPushSuccess` 处理 `quota_exceeded` 拒绝：调用 `showQuotaAlert(type)` 展示配额提示，并触发 `fetchPlan()` 刷新用量。  
`SyncStatusIndicator` 在 error 状态下悬停时通过 Tooltip 展示 `syncErrorMessage`。  
`SyncEngine.forcePush(entities)` — 直接、非防抖的单次推送，供 `permanentlyDeleteCollection` / `permanentlyDeleteGroup` / `permanentlyDelete`（单条书签）/ `permanentlyDeleteBatch`（批量书签，≤900 条/请求）在确认服务端落库后再清理本地 IDB 使用；push 失败时调用方回滚乐观 UI。离线路径（`syncEngine === null`）下两者改为写 `isTrashed:2、seq:0` 墓碑到 IDB 并从 state 过滤；`sweepUnsynced` 恢复在线后以 `isTrashed:2` 推送墓碑。

### 冲突解决（LWW）

- 实体级别：`updated_at`（Unix ms）较大者胜出
- `ON CONFLICT (id) DO UPDATE ... WHERE updated_at < EXCLUDED.updated_at`（服务端）
- 客户端 `mergeFromServer` 同样按 `updatedAt` 比较，忽略旧值

## 工作区生命周期管理（Workspace Lifecycle）

普通实体（collection/bookmark/tag/group）遵循上面的 LWW 字段合并；Workspace 作为聚合根走一套独立的、显式状态机 + 有序阶段推送协议，避免父级墓碑与仍在同步的子内容产生竞态。核心文件：`lib/workspace-lifecycle-state.ts`（版本化 KV 记录）、`lib/workspace-aggregate.ts`（原子聚合发现/清理）、`lib/workspace-lifecycle-coordinator.ts`（协调器，本节主要描述对象）、`lib/sync-confirmation.ts`（推送确认）、`lib/sync-engine.ts`（串行化执行、`purgeWorkspace`）、`store/workspace-store.ts`（`deleteWorkspace`/`restoreWorkspace`/`permanentlyDeleteWorkspace`）。

### 最终状态表

| `is_deleted` | 含义 | `deletion_model` | 子内容可见性 | 触发方式 |
|---|---|---|---|---|
| `0` | 活跃 | `1`（新协议）或 `0`（遗留） | 正常显示 | 默认状态 / 成功 restore |
| `1` | 软删除（父级墓碑，可恢复） | `1` | 本地 IDB 仍持有（供恢复/回收站聚合），但 REST/搜索/普通 UI 一律过滤 | `lifecycle_action: "delete"` 被接受 |
| `2` | 永久删除（终态，不可逆） | 沿用删除时的值 | 本地聚合被彻底清除（`clearWorkspaceAggregate`） | `lifecycle_action: "purge"` 被接受，或遗留级联删除路径 |

`deletion_model` 由服务端记录：`1` = 使用本节描述的父级墓碑（parent-tombstone）协议删除；`0` = 由不支持该协议的遗留客户端触发的级联删除（旧协议），仅供迁移期兼容判断，不影响客户端读取逻辑本身。

### Protocol Version 2 动作契约

所有 `POST /sync/push` 请求携带 `protocol_version: 2`（`lib/api.ts` 的 `api.syncPush` 固定注入，见 `SyncPushPayload`）。Workspace 推送分两类：

- **普通字段更新**：省略 `lifecycle_action`，仅更新 `name`/`color`/`position` 等元数据，**从不**改变生命周期状态。状态 `1` 拒绝这类请求（`workspace_deleted`），状态 `2` 拒绝一切非 purge 请求（`permanently_deleted`）——这可防止一个持有旧本地状态的客户端在编辑名称时意外把已删除的工作区复活。
- **生命周期动作**：`SyncWorkspaceMutation.lifecycle_action ∈ { "delete", "restore", "purge" }`（`lib/api.ts`）。
  - `"delete"`：`is_deleted: 0 → 1`，写入 `deleted_at`。
  - `"restore"`：`is_deleted: 1 → 0`，清除 `deleted_at`；只把父级恢复为活跃态，**不会**触碰任何子实体各自的 `deletedAt`/`archivedAt`（子级生命周期状态与父级独立，见下方"合并行为"）。
  - `"purge"`：`is_deleted: * → 2`，终态、幂等（对同一个已是状态 `2` 的根重复发送会被接受为 no-op，确保丢失首次响应的客户端仍能安全完成本地清理）。

`GET /sync/pull` 响应新增可选字段 `capabilities.workspace_parent_tombstone`（`lib/api.ts` 的 `SyncCapabilities`）。**Workspace 列表在每次 pull 中都是全量返回**（不像 collection/bookmark/tag/group 按 `seq > after_seq` 增量返回）——协调器据此才能在任意时刻拿到每个根的可靠 `is_deleted` 视图来安全推进阶段化推送；这一契约是本节其余机制成立的前提。

### Capability 与 full-pull 迁移

新工作区生命周期动作（delete/restore/permanent-delete）只有在服务端于 `SyncPullResponse.capabilities.workspace_parent_tombstone === true` 时才启用；未启用能力的自托管服务端会在 UI 上显示"需要升级服务端"，而不是回退到不安全的级联删除。

- **缓存位置**：`kv["workspace-parent-tombstone-capability-v1:${encodeURIComponent(origin)}:${encodeURIComponent(userId)}"]`，按 **服务器 origin + 用户 ID** 精确限定（`lib/workspace-lifecycle-state.ts` 的 `workspaceLifecycleCapabilityKey`）。切换账号、切换自托管服务器、清空数据库，或后续一次已认证响应省略/关闭该能力，都会使已缓存的值失效（`invalidateWorkspaceLifecycleCapability`）——绝不会把 A 账号或 A 服务器观测到的能力误用到 B。
- **一次性 full-pull 迁移标记**：`kv["workspace-parent-tombstone-full-pull-v1:${origin}:${userId}"]`。首次确认能力为 `true` 且尚无该标记时，`resolveAuthoritativeWorkspacePull`（`lib/workspace-lifecycle-coordinator.ts`）会额外发起一次 `after_seq=0` 的权威全量 pull，因为升级前的旧客户端可能已经把 `localSeq` 推进到了它当时看不懂、随后又在本地删除的父级墓碑之后。迁移标记与 `localSeq`/`kv["localSeq"]` 一起，在 `commitWorkspacePullCheckpoint` 的**同一个** IndexedDB 事务中提交，因此中断的 pull 不会留下标记已写但 `localSeq` 未推进（或反之）的不一致状态，下次会重试。
- 离线场景：曾经确认为 `true` 的能力允许浏览器重启后在离线状态下继续本地软删除/恢复（写入 lifecycle intent），但永久删除始终要求一个存活的、已认证的 `SyncEngine`（需要服务端在场确认状态 `2`）。

### 有序生命周期推送（Serialized Lifecycle Order）

Offline 的 delete/restore 先在本地一个 IndexedDB 事务内提交：写工作区快照（`deletedAt`/`seq=0`）+ 版本化 intent 记录 `kv["workspace-lifecycle-intents-v1"]`（`{ workspaceId, action, baseSeq, previousActiveWorkspaceId, createdAt }`，见 `idbCommitWorkspaceDeleteLifecycleIntent`/`idbCommitWorkspaceLifecycleIntent`）。intent 存活于重启之间，且携带足够信息用来在 `last_active_workspace` 迟到拒绝时确定性回滚。

`SyncEngine` 拥有一条**串行化**的执行链（`resolutionChain`），生命周期协调、push 确认、pull 合并全部在同一个"currentness"边界上排队——同一时刻只有一个在跑，`isCurrent()` 保证被 retire 的引擎不会误写已被替换的新引擎的状态。`reconcileWorkspaceLifecycleIntents`（`lib/workspace-lifecycle-coordinator.ts`）按 `createdAt` 升序逐个处理 intent：

**Delete（服务端尚未确认，或本地待推送）：**
1. `capture` — 把 live queue 与 session-recovery 快照中匹配的实体抽取进耐久的 `kv["workspace-lifecycle-deferred-sync-v1"]` 记录（按 workspaceId 保存），保证离线期间在其它地方排队的编辑不会丢失或绕过阶段顺序。
2. `push:root` — 推送工作区的普通字段快照（**不带** `lifecycle_action`，服务端此时若还没有该工作区会以状态 `0` 创建它）。
3. `push:children` — 推送该工作区下的 collections/groups/tags（各自已有的 `deletedAt`/`archivedAt` 原样携带，protocol 层面它们仍是普通更新）。
4. `push:bookmarks` — 推送 bookmarks。
5. `push:delete` — 最后才发送 `lifecycle_action: "delete"`，把服务端父级转为状态 `1`。

每一个被接受的阶段都在**开始下一阶段之前**通过 `confirmSyncPayload` 落盘确认（把返回的 `server_seq` 写回本地实体、清理对应 deferred 引用），任何一阶段被拒绝都会把 intent 保持为"待重试"并阻止后续阶段（尤其是绝不会在子内容还没确认前发送父级删除）。

**Restore：** 先 `push:restore`（父级转回状态 `0`），随后按同样的子级阶段顺序把子实体重新纳入同步——但**不会**改写它们各自的 `deletedAt`/`archivedAt`；子级恢复必须由用户对每个子内容单独触发。全部阶段确认后清除 intent 并清理该根的冲突树（`clearConflictTree`）。

**Purge（`SyncEngine.purgeWorkspace`）：** 前置条件是 delete 已被服务端确认（`isWorkspaceDeleteConfirmed`；未确认则先 `requestPull()` 重试一次，仍未确认则拒绝）且本地 ordinary queue 已排空。随后：`queue.flush()` → 推送 `{ workspaces: [{ id, lifecycle_action: "purge" }] }`（不重发任何子实体，服务端已持有它们的最新状态）→ `confirmPayload` → `blockEntities`（阻止聚合中的实体重新进入队列）→ `pruneEntities`（清理 live queue 与 recovery 快照）→ `clearWorkspaceAggregate`（见下）。

若客户端在阶段之间崩溃：已确认的阶段不会被重发，第一个未确认阶段在下次 reconciliation 时可安全重启。若一次子级/根级推送被服务端拒绝（`quota_exceeded`/`parent_rejected`/`last_active_workspace`），协调器把已聚合的实体快照 quarantine 进 deferred 记录、记录冲突（`syncConflictRegistry`），intent 本身保留以便配额恢复或用户手动重试后继续；`last_active_workspace` 额外触发 `rollbackLastActive`，把本地工作区/intent 精确还原到 `baseSeq` 状态。

### 合并行为（`mergeFromServer`）

- 状态 `1`：`workspace-store.mergeFromServer` 插入或更新，**保留** `deletedAt`，绝不删除该 IDB 行；若当前活跃工作区被远端标记为已保留，客户端自动切换到另一个活跃工作区（`chooseActiveWorkspace`：取 position 最小的活跃项）。
- 状态 `2`：直接从 state + IDB 删除该行（`terminalWorkspaceIds` → `blockPruneAndCleanTerminalAggregates` → `clearWorkspaceAggregate`）。
- 本地 `seq=0` 的删除/恢复是"待定"的乐观修改：一个较旧的服务端状态 `0` 不能覆盖本地待定删除，一个较旧的服务端状态 `1` 也不能覆盖本地待定恢复；状态 `2` 永远覆盖任何本地待定状态（终态优先）。
- 状态 `1 → 0`（restore 被确认）时，pull 协调器在常规 sweep 之前清理该根的 `parent_deleted` 子级冲突树，让此前被服务端拒绝（因为父级已删除）的本地子级修改可以在父级重新活跃后正常继续同步。

### 清理归属（Cleanup Ownership）

- **状态 1→2（永久删除）**：只能由客户端显式触发的 `lifecycle_action: "purge"`（人工操作，通过 Workspace Manager）或服务端自动的回收站到期清理（`trash_grace_days`，来自 `GET /api/plan` 的套餐限额）产生。客户端**从不**运行本地过期计时器——服务端是唯一的清理权威，离线设备通过下一次 delta pull 得知结果（一个状态 `2` 的行本身会作为最小的"防复活墓碑"被服务端保留至账号删除为止，不参与配额或普通读取）。
- **本地 IndexedDB 聚合清理**：仅 `lib/workspace-aggregate.ts` 的 `clearWorkspaceAggregate`/`permanentlyDeleteWorkspaceAggregate` 执行，且只在服务端已确认状态 `2`（正常流程）或识别为终态（`cleanTerminal`）之后才调用；它在**同一个** IndexedDB 事务中原子地：删除 workspace/collections/bookmarks(active+archived+trashed)/groups/group-tabs、选出新的 `activeWorkspaceId`（就近 position）、清除该工作区在 `workspace-lifecycle-intents-v1` / `workspace-lifecycle-deferred-sync-v1` / guest 溯源记录 / legacy orphan-recovery 记录中的条目、清理该根在 `syncConflictRegistry` 中的记录。Guest（无账号）场景下 `permanentlyDeleteWorkspace` 直接调用同一套本地清理，无需服务端确认。
- **Zustand state 清理**：`useWorkspaceStore`/`useBookmarksStore`/`useGroupsStore` 各自的 `removeWorkspaceAggregateFromState(ids)` 由聚合清理成功后统一调用，保证三个 store 与 IDB 在同一时刻保持一致，不存在"IDB 已删但 state 还在"的窗口。

### 配额方程

`usage = in_use + trash_usage`（每种资源独立成立），由 `lib/quota-usage.ts` 的 `createQuotaBreakdown(total, trash)` 强制保证：`inUse[key] = total[key] - trash[key]`，且两者都先各自 clamp 到 `[0, total]` 区间。Guest／OSS／Cloud 三种模式共用同一等式：
- **Guest**（无账号）：`total`/`trash` 由 `calculateGuestQuotaUsage` 在本地聚合计算（保留工作区及其后代计入 `trash`，其余计入 `in_use`）。
- **OSS/Cloud**（已认证）：`GET /api/plan` 返回 `usage`（= `total`）与可选的 `trash_usage`；服务端配额判定条件与此一致——workspace/collection 以 `is_deleted < 2` 计（active + 已软删除 + 已归档都占配额，只有永久删除才释放），bookmark 以 `is_trashed < 2` 计。软删除/归档只把资源从 `in_use` 移到 `trash`，两者之和（=服务端计费的 `usage`）不变；只有永久删除才会真正减少 `usage`（`decrementUsage`）。

## 核心数据模型

```ts
// lib/types.ts（同步字段已包含）
Workspace { id, name, color, position, seq, deletedAt?, deletionModel? }  // deletionModel: 1=父级墓碑协议, 0=遗留级联删除迁移标记
  └── Collection[] { id, workspaceId, name, icon, position, isDefault?, seq, deletedAt?, archivedAt? }
         └── Bookmark[] { id, title, url, favicon, description, collectionId, tags[], createdAt, isFavorite, seq, deletedAt? }
Tag { id, name, color, seq, deletedAt? }

// store/groups-store.ts
SavedGroup { id, name, color: TabGroupColor, isCompact, createdAt, seq, deletedAt? }
  └── GroupTab[] { id, groupId, title, url, favicon, position }  // tab 列表整体替换（无单独 seq）

// lib/chrome/tab-groups.ts
BrowserTabGroup { id, title, color, collapsed, windowId }  // Chrome 实时数据
BrowserTab { id, title, url, favIconUrl, groupId, active, windowId }
```

## 权限

| 权限 | 用途 |
|---|---|
| `tabs` | 读取当前窗口 tab 列表、focus/close tab |
| `tabGroups` | 读取/创建/更新/删除 Chrome tab group |
| `storage` | chrome.storage.local 读写 |
| `bookmarks` | （暂未使用 Chrome 原生书签 API） |
| `contextMenus` | 右键菜单"Save to TabSlate" |
| `scripting` | 配合 `optional_host_permissions` 实现 SearchOverlay 的动态注入 |
| `optional_host_permissions: <all_urls>` | 用户在设置中手动开启后，用于读取任意页面的 favicon 及挂载搜索浮层；规避安装时的全站权限警告 |
| `host_permissions: [VITE_OPENPANEL_URL origin]` | 由 `wxt.config.ts` 的 `build:manifestGenerated` hook 在构建时按 env var 动态注入；让扩展页面（newtab/popup/background）可直接 fetch 分析接口而无 CORS 限制；env var 未设置时此项不存在 |
| `web_accessible_resources: search-engine-icon/*` | 允许 Shadow DOM（content script 上下文）加载扩展内置的搜索引擎 SVG 图标 |
| `commands` | `Ctrl+Shift+K` / `Cmd+Shift+K` 全局快捷键（open-search）→ background 发送 `OPEN_SEARCH` 唤起当前页搜索层 |

### 动态内容脚本注册流程

为了实现合规的可选权限，Search Overlay 的注入流程如下：

1. **设置触发**：用户在 `SettingsDialog` 切换开关。
2. **权限请求**：调用 `chrome.permissions.request({ origins: ["<all_urls>"] })`。
3. **事件响应**：`background.ts` 监听 `chrome.permissions.onAdded` 事件。
4. **动态注册**：调用 `chrome.scripting.registerContentScripts` 将 `content.ts` 注册到所有站点。
5. **持久化**：由于内容脚本已持久化，后续浏览器重启会自动注入（只要权限仍被授予）。
6. **权限移除**：开关关闭时调用 `chrome.permissions.remove`，触发 `onRemoved` 事件，调用 `unregisterContentScripts` 停止注入。

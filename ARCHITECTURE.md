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
│   │   │   └── App.tsx      # 路由、布局、StoreGate → AuthGate → SyncProvider → HashRouter
│   ├── popup/           # 快速保存 popup
│   │   └── App.tsx      # 独立 React 树，不使用 Zustand
│   ├── background.ts    # Service Worker：tab 事件广播 + 右键菜单
│   └── content.ts       # 注入页面：提供 GET_PAGE_INFO 给 background
│
├── components/
│   ├── auth/
│   │   ├── auth-page.tsx            # 全屏认证页，居中渲染 LoginForm
│   │   └── verify-email-screen.tsx  # 全屏 OTP 邮箱验证页（AuthGate 拦截未验证用户时显示）
│   ├── login-form.tsx          # login/register/forgot-password/reset-password 四模式 + Prosopo 验证码 + 密码强度提示
│   ├── procaptcha.tsx          # Prosopo iframe 包装组件（绕过 MV3 CSP 限制；通过 postMessage 接收 token）
│   ├── ui/              # shadcn/ui 基础组件 + 自定义共享组件
│   │   ├── alert.tsx           # 标准 shadcn Alert（内联提示 + 浮动通知）
│   │   ├── color-picker.tsx    # Tab group 颜色选择器（共享）
│   │   ├── favicon-image.tsx   # 带 fallback 的 favicon 图片
│   │   └── input-otp.tsx       # 6 格 OTP 输入框（基于 input-otp 包）
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
│       ├── content.tsx         # / 路由：书签网格/列表
│       ├── header.tsx          # 顶部搜索/过滤栏
│       ├── workspace-rail.tsx  # 最左侧工作区切换轨道
│       ├── tabs-rail.tsx       # 最右侧标签页快速预览轨道
│       ├── bookmark-card.tsx   # 单个书签卡片/列表项
│       ├── favorites-content.tsx
│       ├── archive-content.tsx
│       └── trash-content.tsx
│
├── store/
│   ├── auth-store.ts       # 认证状态（user、accessToken、refreshToken、serverUrl）— 持久化
│   ├── bookmarks-store.ts  # 书签数据 + UI 过滤状态；含 mergeFromServer（同步合并）
│   ├── workspace-store.ts  # 工作区/集合/标签配置；含 localSeq、mergeFromServer、setLocalSeq
│   ├── groups-store.ts     # 保存的标签组（含 dnd-kit 排序数据）
│   └── tabs-store.ts       # Chrome 当前窗口标签页（非持久化）
│
├── types/
│   └── prosopo.d.ts        # window.procaptcha 全局类型声明（captcha widget 页面使用）
│
├── lib/
│   ├── api.ts              # TabSlate-server HTTP 客户端（auth + sync: issueSSEToken/syncPush/syncPull）；ApiError 携带 status/captchaRequired/retryAfter
│   ├── types.ts            # Workspace, Collection, Tag, Bookmark 接口定义（含 seq, deletedAt 同步字段）
│   ├── sync-engine.ts      # SyncEngine：协调 SyncQueue + SSEClient + 定期拉取；模块单例 syncEngine
│   ├── sync-queue.ts       # SyncQueue：按实体 ID 去重、2s 防抖、指数退避推送（2s→60s）
│   ├── sse-client.ts       # SSEClient：leader election via chrome.storage + EventSource 自动重连（1s→30s）
│   ├── utils.ts            # cn() 等工具函数
│   ├── storage.ts          # popup 用的轻量 chrome.storage 读写工具
│   ├── chrome-storage-adapter.ts  # Zustand persist 的 chrome.storage 适配器
│   ├── id.ts               # generateId()
│   ├── bookmark-utils.ts   # findDuplicateBookmark()
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

所有 store 使用 Zustand，持久化通过 `chromeStorageAdapter` 写入 `chrome.storage.local`。

```
useAuthStore       ──persist──▶  "tabslate-auth"
useBookmarksStore  ──persist──▶  "tabslate-bookmarks"
useWorkspaceStore  ──persist──▶  "tabslate-workspace"     （含 localSeq 同步游标）
useGroupsStore     ──persist──▶  "tabslate-groups"
useTabsStore       (不持久化，运行时从 Chrome API 加载)
SSE leader         ──共享──▶  "tabslate-sync-leader"      （30s TTL，多窗口 leader election）
```

### Store 职责

| Store | 持久化 | 职责 |
|---|---|---|
| `useAuthStore` | ✅ | 登录用户信息（含 `is_verified`）、access/refresh token、server URL；actions：login/register/resendVerification/verifyEmailOTP/forgotPassword/resetPassword/logout |
| `useBookmarksStore` | ✅ | 书签数据（active/archived/trashed）+ 过滤/排序/视图 UI 状态；`mergeFromServer` 执行 LWW 合并 |
| `useWorkspaceStore` | ✅ | 工作区、集合、标签、高亮状态；`localSeq` 同步游标（持久化在 `"tabslate-workspace"`）；`mergeFromServer` 执行 LWW 合并；`sweepUnsynced` 补推 `seq=0` 的实体 |
| `useGroupsStore` | ✅ | 用户手动保存的标签组及其包含的 tab URL |
| `useTabsStore` | ❌ | Chrome 当前窗口的实时标签页和 tab group 数据 |

### 跨页面同步

```
newtab (Zustand)  ──写入──▶  chrome.storage.local
                                    │
                              onChanged 事件
                                    │
                  ◀──读取──  newtab (另一窗口) / background / popup
```

各 store 文件底部都注册了 `chrome.storage.onChanged` 监听器，用 JSON.stringify 对比变更内容，有差异才 `setState`。

## 路由

使用 `HashRouter`（避免扩展 URL 与 HTML5 History 冲突）：

| 路径 | 组件 | 说明 |
|---|---|---|
| `/` | `BookmarksContent` | 书签主界面（grid/list） |
| `/favorites` | `FavoritesContent` | 收藏夹 |
| `/archive` | `ArchiveContent` | 已归档集合卡片（含一键还原）+ 已归档单个书签 |
| `/trash` | `TrashContent` | 已删除集合卡片（含还原 + 永久删除）+ 已删除单个书签 |
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
3. `POST /sync/push` 发送 snapshot；服务端在单事务内 LWW upsert 所有实体，`incrementSeq` 并广播新 seq 到 Hub
4. 失败时将 snapshot 重新入队，指数退避重试（2s → 4s → … → 60s）

**拉取（服务器变更 → 本地）：**
1. SSE leader 收到 `{seq: N}` 事件 → `serverSeq > localSeq` 时触发 `GET /sync/pull?after_seq=localSeq`
2. 或每 5 分钟定期拉取（SSE 离线时使用）
3. 响应中的 workspaces/collections/tags 经 `mergeFromServer`（workspace-store）LWW 合并
4. bookmarks 经 `mergeFromServer`（bookmarks-store）LWW 合并（含 `tag_ids`）
5. App.tsx 的 `onPullSuccess` 回调更新 `localSeq`；若非首次推送，调用 `sweepUnsynced()` 将所有 `seq=0` 实体补推（处理 popup/background 在 newtab 关闭时直接写 storage 的情况）

**SSE 连接（实时通知）：**
- `POST /auth/sse-token` 获取 30s 单次使用令牌（EventSource 无法携带 Authorization header）
- `GET /sync/stream?token=<token>` 建立 SSE 连接
- 多窗口 leader election：`chrome.storage.local["tabslate-sync-leader"]` TTL 30s，leader 每 25s 续约；非 leader 每 25s 竞选
- `SyncEngine` 在 SSE 连续失败 3 次后切换到 `"offline"` 状态，纯依赖定期拉取

### App.tsx 中的 SyncProvider

```
StoreGate → AuthGate → SyncProvider（render-prop）
                         ├── new SyncEngine(getCredentials, getLocalSeq, onPullSuccess, ...)
                         ├── syncStatus: "idle" | "syncing" | "error" | "offline"
                         └── onForceSync → syncEngine.forceSync()
```

`SyncProvider` deps `[accessToken, serverUrl]`：token 刷新或 server URL 变更时销毁旧引擎再创建新引擎。  
cleanup 函数调用 `engine.forceSync()` 后再 `destroySyncEngine()`，确保登出前推送最后一次变更。

### 冲突解决（LWW）

- 实体级别：`updated_at`（Unix ms）较大者胜出
- `ON CONFLICT (id) DO UPDATE ... WHERE updated_at < EXCLUDED.updated_at`（服务端）
- 客户端 `mergeFromServer` 同样按 `updatedAt` 比较，忽略旧值

## 核心数据模型

```ts
// lib/types.ts（同步字段已包含）
Workspace { id, name, color, position, seq, deletedAt? }
  └── Collection[] { id, workspaceId, name, icon, position, isDefault?, seq, deletedAt?, archivedAt? }
         └── Bookmark[] { id, title, url, favicon, description, collectionId, tags[], createdAt, isFavorite, seq, deletedAt? }
Tag { id, name, color, seq, deletedAt? }

// store/groups-store.ts
SavedGroup { id, name, color: TabGroupColor, isCompact, createdAt }
  └── GroupTab[] { id, groupId, title, url, favicon, position }

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
| `host_permissions: <all_urls>` | 读取任意页面的 favicon |

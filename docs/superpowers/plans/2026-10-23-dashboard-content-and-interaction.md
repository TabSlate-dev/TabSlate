# Dashboard Content and Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用 Minimal Neutral 重整 Dashboard 内容布局、180px 起宽的紧凑卡片与拖放反馈，完整保留工作区、侧栏及其他现有功能与业务数据。

**Architecture:** 保留 React/Zustand、现有路由、按行虚拟化和 dnd-kit；展示层拆分页面框架、路由页头、收藏集行模型与网格。拖放由纯 policy、复用现有 action 的 executor、provider 会话及独立反馈层组成，逻辑目标与屏幕展示 surface 分开。

**Tech Stack:** TypeScript strict、React 19、React Router、Zustand、WXT、Tailwind CSS 4、shadcn/Radix、@tanstack/react-virtual、@dnd-kit/core 6.x、CSS/WAAPI、Bun test、happy-dom。

**Spec:** [Dashboard 内容区与拖拽交互整体设计](../specs/2026-10-23-dashboard-content-and-interaction-design.md) 为主；[拖拽与微交互设计](../specs/2026-10-23-dashboard-drag-and-motion-design.md) 为未覆盖细节的补充。旧拖拽计划不与本计划并行执行，冲突以整体设计及本计划为准。

**Status:** 2026-10-23 编写，待用户评审与选择执行方式。checkbox 均为未来步骤；本次未修改产品代码，未运行实施测试。

## Global Constraints

- “保留全部现有功能和展示数据”；效果图省略的 sidebar 用户、套餐、配额、同步等内容必须保留，不能把效果图当作删减功能的依据。
- 只修改 TabSlate 前端；不改服务端、API、IndexedDB schema、同步协议、配额定义或权限授予流程。
- 保留 @dnd-kit/core 6.x、TanStack Virtual、shadcn/Radix；不新增 Motion 或拖放依赖，包管理仅 Bun。
- TypeScript strict、具名组件、interface 对象形状、无新增 any、避免断言、if 有花括号；Zustand 使用细粒度 selector，派生 filter/sort/map 放 useMemo，memo 列表回调用 useCallback。
- favicon 使用 FaviconImage；通知 Alert/QuotaAlert；编辑使用 BookmarkDialog；保留共享 TagList、ActiveFilterChips、SelectionOrdersProvider 和标签树能力。
- 配色精确采用主设计 §8.2 的浅/深 OKLCH 快照；不引入主题附带字体、1rem 圆角或阴影，不从图片取色。
- grid：最小宽 180px、常规高约 88px、padding 10px、圆角 8px、gap 12px、最多 6 列、标题单行；gallery：最小宽 280px、gap 16px、最多 4 列、封面 1.91:1、标题最多两行。
- 88px 不是裁剪上限；触摸目标 44px、文字放大及缩放可以增高并重测。不能为列数或高度删除操作/数据。
- 无大时钟模式；全部书签初始只展开排序后的前 3 个收藏集；紧凑首页广告位于工具栏下并随内容滚动。
- viewMode 保持 grid/gallery，sortBy 与现有本机偏好及同步不变；面板/展开状态只在本页内存，不写同步偏好。
- Default 第一，其余 position 降序；保留现有可见性、严格去重、配额、原始 URL 的 saved-group 去重规则。
- 无手动排序、插入线、批量拖放、标签树拖放、跨工作区拖放、外部拖入；FavoritesContent 不新增拖动来源；归档/回收站不成为目标；未挂载的 GroupsPanel 不改。
- 虚拟行定位 transform、droppable 测量与反馈动画分层；不整组挂载，不在 pointermove 中扫描全库/写业务 store。
- 新文本通过 useTranslation；布局键 dashboard_，拖放键 dashboardDnd_；维护 public/_locales/en/messages.json 与 zh_CN/messages.json 及 placeholders。
- `/output/design/` 的图片、提示词、录制和本地生成记录不进入 Git；只提交各任务明确文件，不夹带并行修改，不推送或创建 PR。

## Review Focus

1. 游客/未验证/已验证账号、Free/Pro/Premium、无限额度、套餐加载失败：原用户字段、五项额度、明细、同步与授权入口必须完整且不假报 0；Task 4 的保留测试与 Task 12 浏览器矩阵负责。
2. 数据迟到、收藏集重排/退休、第四个收藏集的深链、折叠组中的已选项：初始化不能覆盖用户选择，定位与范围选择仍正确；Task 3、10 测试负责。
3. 笔记本侧栏同时展开、coarse pointer、200% 缩放和广告晚加载：按钮/标签不能因 88px 或列数被裁切，滚动锚点不跳；Task 1、2、5、6 测试与 Task 12 实测负责。
4. 跨窗口 Tab、组在 await 期间关闭、配额提前返回、部分重复、浏览器已写成功但刷新失败：必须复验并显示真实本地结果，迟到操作不得写入新工作区；Task 7–9 测试负责。
5. portal 菜单/输入控件、多选 Esc、键盘 Tab 取消、源卸载、连续手势和动画中切换 reduce：不误拖、不打开网页、不遗留监听/预览，焦点可恢复；Task 9–11 测试负责。

## 文件结构、接口约定与实施顺序

此改版的布局、虚拟列表和拖放 surface 互相依赖，使用一个计划顺序实施。执行前使用 using-git-worktrees 检查当前 checkout/附件并按需隔离；从当前实际代码开始，保留并行的标签树工作。先记录当前 git 状态与基线测试失败，不能通过重置他人改动取得干净目录。

| 单元 | 文件与责任 |
|---|---|
| 网格/卡片 | 新增 lib/bookmark-grid-layout.ts、hooks/use-bookmark-grid.ts、shared/bookmark-grid.tsx；修改 bookmark-card.tsx：列数、容器测量、紧凑密度和操作槽位 |
| 页面框架 | 新增 components/dashboard/layout/{dashboard-topbar,compact-clock,page-header,page-frame,dashboard-ui-state}.tsx；修改 App.tsx/header.tsx：全局与路由操作分开、面板/展开内存状态 |
| 收藏集内容 | content.tsx 拆为 content/{index,collection-header,draggable-bookmark-card,collection-band}.tsx 与 content/row-model.ts、use-collection-expansion.ts、use-scroll-anchor.ts；保持原导入路径 |
| 侧栏 | 原 sidebar/index.tsx、user-profile.tsx、quota-card.tsx、sync-status.tsx、collection-row.tsx、section-header.tsx、tags-section.tsx；只处理必要视觉/目标接入，不重写数据逻辑 |
| 右栏/广告 | tabs-rail.tsx、ad-banner.tsx、tabs-panel/tabs-ad-strip.tsx；右栏状态与窗口数据分开，广告不变更来源分类 |
| 拖放领域 | 新增 lib/drag-and-drop/{types,drop-policy,execute-drop,keyboard-coordinates}.ts；修改 lib/drop-ids.ts、drag-sensors.ts |
| 拖放展示 | 新增 components/dashboard/drag-and-drop/{drag-preview,drop-feedback,collection-drop-highlight,ungroup-drop-zone}.tsx；provider 统一会话、命中与执行 |
| 其他路由 | favorites-content.tsx、tabs-panel/index.tsx、group-detail/index.tsx、archive-content.tsx、trash-content.tsx 接入共同页头/间距；专用操作保留 |
| 资源与测试 | assets/globals.css、两份 messages.json；沿用 test/helpers/{dom-environment,module-replacer,virtualizer,library-fixtures,isolated-run}，每任务列出具体测试 |

文件表中 dashboard 组件路径均相对于 `components/dashboard/`。不预定修改 store 公共 action 返回类型、package.json 或锁文件；执行器用已有 action 的真实后置条件确认结果。

**测试约定：** 每个行为任务先写下列测试，再运行至预期断言失败，实施后运行同一命令至 0 fail。测试使用现有 setupDom/installAppModules/createModuleReplacer 并清理；不增加测试框架。仅有 CSS/间距的改动使用浏览器检查，不编写 Tailwind 类名/实现镜像测试。Bun mock 污染才使用已有 runsInIsolatedProcess。

测试文件中的核心用例采用下列固定名称，后续可按列出的条件拆分补充；代码片段只规定关键断言，DOM/store 初始化使用本节已有 helper。

**本页 UI 状态：** Task 2 定义 DashboardUiStateProvider，生命周期为 Layout，包含右栏用户选择和按 workspace 的展开映射；不含业务数据。Task 3 维护收藏集展开，Task 5 使用面板状态。布局控件在修改布局前派发 `DASHBOARD_LAYOUT_CHANGE_EVENT = "tabslate-before-layout-change"`，Task 9 的 provider 同步结束活动 sensor；ResizeObserver 只在列数/断点实际变化时派发，禁止每像素取消。

开始任何产品修改前，用当前生产构建记录同一设备/浏览器、1,000 条临时书签、10 秒滚动与连续拖动的基线（首屏、mounted rows、React commits、布局/绘制/长任务）。录制放被忽略的 output/design，本计划不把“待采集”当成性能证据。

---

### Task 1: 紧凑卡片与按容器宽度排列的共享网格

**Files:** Create `lib/bookmark-grid-layout.ts`、`lib/dashboard-layout-events.ts`、`hooks/use-bookmark-grid.ts`、`components/dashboard/shared/bookmark-grid.tsx`；Modify `components/dashboard/bookmark-card.tsx`、`content.tsx`、`favorites-content.tsx`、`components/ui/tag-list.tsx`、`assets/globals.css`、`public/_locales/{en,zh_CN}/messages.json`；Test `test/bookmark-grid-layout.test.ts`、`test/bookmark-grid-resize.test.tsx`、`test/tag-list-overflow.test.tsx`；Extend `test/bookmark-card-menu.test.tsx`、`bookmark-card-gallery.test.tsx`、`bookmark-selection.test.tsx`。

**Interfaces:**
- `getBookmarkGridLayout(width: number, viewMode: BookmarkViewMode): BookmarkGridLayout`，结果 interface 为 `{ columns: number; gap: number; columnWidth: number }`。width 是不含 padding/border/scrollbar 的网格可用宽度，未知/负宽度按 0，至少 1 列。
- `useBookmarkGrid(ref: RefObject<HTMLElement | null>, viewMode: BookmarkViewMode): BookmarkGridLayout`，ResizeObserver 观察无 padding 的网格 content box；首帧读实际尺寸，cleanup disconnect。
- `BookmarkGrid({layout, children}: {layout: BookmarkGridLayout; children: ReactNode})` 具名组件，供 favorites 使用；content 的虚拟行直接使用同一 layout。
- `notifyDashboardLayoutChange(): void` 派发上述事件；交互布局改变之前调用。持久化字段与书签数据完全沿用。
- TagList 新增 `overflowMode?: "count" | "popover"`，默认 count 保持其他调用方兼容。卡片使用 popover：+N 为可聚焦具名按钮，展示完整标签列表，沿用 onTagClick/selectedTagIds/pathByTagId，不新建第二份标签状态。现有实现的 +N 只是 span，必须在共享组件中补齐访问能力，不能假定它已有弹层。

- [ ] **Step 1: 写网格和卡片交互失败测试。** 固定边界断言：`getBookmarkGridLayout(755,"grid").columns === 3`、756→4、947→4、948→5、1139→5、1140→6、1920→6；0/负宽度→1；gallery 575→1、576→2、1168→4。ResizeObserver fake 断言相同列数的尺寸变更不派发布局取消、跨列数派发一次、unmount 后无回调。卡片断言 footer 收藏/复制/备注/更多/完整标签入口仍调用原 action，网址复制与打开使用完整 URL；无 dragHandleProps 的 favorites 不出现伪手柄；缩略域名遇到非法 URL 不抛错。

```ts
test("compact columns change at 756, 948 and 1140 CSS pixels", () => {
  expect([755, 756, 947, 948, 1139, 1140].map(width =>
    getBookmarkGridLayout(width, "grid").columns)).toEqual([3, 4, 4, 5, 5, 6]);
});
```

- [ ] **Step 2: 运行新测试及卡片/选择测试。** `bun test test/bookmark-grid-layout.test.ts test/bookmark-grid-resize.test.tsx test/tag-list-overflow.test.tsx test/bookmark-card-menu.test.tsx test/bookmark-card-gallery.test.tsx test/bookmark-selection.test.tsx`；记录新增断言失败，原有失败独立记录。溢出测试名 `overflow tags remain keyboard accessible and filterable`，断言 +N 的 Enter/Space 可打开、全部真实标签/路径可读且可筛选、Esc 关闭/归焦、不会打开或拖动书签；默认 count 模式继续显示原数量。
- [ ] **Step 3: 实现网格函数/hook并接入两处网格。** 计算 `max(1,min(cap,floor((W+gap)/(minWidth+gap))))`；列宽按剩余空间均分，部分行保留空位。grid 估算行高 88+12，gallery 按 columnWidth/1.91+160+16 起估，实际 measureElement 为准；不沿用旧的 156px 紧凑估算。
- [ ] **Step 4: 调整 BookmarkCard。** 紧凑尺寸严格采用 Global Constraints；顶部标题/更多、host 行备注、footer 手柄/标签/收藏/复制。为窄列保留 +N 与操作宽度，在 TagList 内复用标准 Popover 实现溢出能力；所有标签可访问且不改标签数据。操作仅 opacity/背景变化，隐藏项不抢指针、focus-within 显示；替换手柄 props 为 `ButtonHTMLAttributes<HTMLButtonElement>` 并提供独立 `dragHandleRef?: Ref<HTMLButtonElement>`，同步改调用方。保留正文打开、修饰键选择、checkbox 与菜单；卡片不包成大 button/link。
- [ ] **Step 5: 重跑 Step 2 和 `bun run compile`。** 预期 0 fail/类型检查通过；在 180px 宽、浅深色、长中英文标题、长标签及 200% 缩放下实测按钮无重叠；触摸 44px 目标允许增高而非裁切。
- [ ] **Step 6: 只提交本任务明确文件。** `feat(dashboard): compact bookmark cards and container grids`。

### Task 2: 紧凑框架、唯一页头与原搜索能力

**Files:** Create `components/dashboard/layout/{dashboard-topbar,compact-clock,page-header,page-frame,dashboard-ui-state}.tsx`；Modify `entrypoints/newtab/App.tsx`、`components/dashboard/header.tsx`、`hero-section.tsx`、`content.tsx`、`search-box.tsx`、`favorites-content.tsx`、`tabs-panel/index.tsx`、`group-detail/index.tsx`、`archive-content.tsx`、`trash-content.tsx`；Test `test/dashboard-layout.test.tsx`、`test/search-box-navigation.test.tsx`；Extend `test/bookmarks-header-subscription.test.tsx`；对应两份 messages.json。

**Interfaces:**
- `DashboardPageHeaderProps`：`title: string; count?: ReactNode; primaryAction?: ReactNode; search?: ReactNode; toolbar?: ReactNode; filters?: ReactNode`；页面提供内容，不由 header 按 pathname 读取业务 store。
- `DashboardPageFrameProps`：`header: ReactNode; prefix?: ReactNode; bottom?: ReactNode; children: ReactNode; scrollRef?: Ref<HTMLDivElement>; onPrefixHeightChange?: (height: number) => void`。内部一个中央滚动容器；常规 header 在外，短高度 <600px 时 header 加入非虚拟 prefix，回调提供整个 prefix 实测高度。
- `DashboardUiStateProvider({children}: {children: ReactNode})` 与 `useDashboardUiState()`；存 `rightPanelPreference: "expanded" | "collapsed"`、setter、`expansionByWorkspace: ReadonlyMap<string, ReadonlyMap<string, boolean>>`、`setWorkspaceExpansion(workspaceId: string, expansion: ReadonlyMap<string, boolean>): void`；Map 不可原地修改。
- `BookmarksToolbar({includeTypeFilter}: {includeTypeFilter:boolean})` 从 header.tsx 具名导出，替代 BookmarksHeader；迁移全部导入和原订阅测试，测试中的原操作断言保留。全局 topbar 不订阅书签 Map；时钟自己按分钟更新，紧凑显示原时间/日期信息。

- [ ] **Step 1: 写失败的路由与搜索测试。** 核心用例名 `each dashboard route keeps one title and navigation search`、`empty collection id still scopes bookmark results`、`short-height layout preserves search query and focus`。对所有六个实际路由断言恰好一个 h1、一个 SearchBox；tabs/group/archive/trash 各自已有动作可达，只有适用路由出现书签视图/类型筛选。搜索断言 Tabs→bookmarks→web 顺序、跨窗口 Tab 可切换、普通书签在当前页打开、web 使用 CURRENT_TAB、collectionId="" 仍过滤；导航 query 不修改列表 searchQuery；派发 tabslate-focus-search 后唯一输入获得焦点。
- [ ] **Step 2: 运行 `bun test test/dashboard-layout.test.tsx test/search-box-navigation.test.tsx test/bookmarks-header-subscription.test.tsx`。** 预期布局/新接口断言失败。
- [ ] **Step 3: 实现通用框架与路由页头。** App Layout 挂一个 UI state provider，平面分隔替换双悬浮外框；全局 topbar 约40px，保留侧栏触发器、主题、语言、项目链接等入口。路由标题约24px；提取既有排序/过滤/视图为 toolbar，仍调用原 setter。删除 HeroSection 的运行时引用，不保留大时钟开关；无其他引用后才删除 hero-section.tsx。不要顺便更改 StoreGate、认证/同步 effect 或 WorkspaceRail 的 Dialog 宿主。
- [ ] **Step 4: 迁移中央滚动结构。** 从 content 虚拟行移除 hero_and_title 及其索引分支，页头交给 PageFrame，原广告移为 prefix；其余行模型先保持现有语义，Task 3 再拆分。所有路由用 PageFrame 接入专用内容和底部批量栏，保留归档/回收站恢复/清空/确认和 saved group 操作。PageFrame 用稳定 portal host 承载同一 header 子树；短高切换只移动 host 到固定/滚动前缀容器，不能重建 SearchBox 或丢失输入/焦点。短窗口 prefix 用 ResizeObserver 实测并传给 virtualizer scrollMargin，绘制偏移与 scrollToIndex 使用同一坐标系；常规页头不能被列表裁剪。
- [ ] **Step 5: 调整 SearchBox 展示并验证。** 高36–40px，保留原数据/结果点击语义；其他路由不传 collectionId，集合页传实际 ID。通过 chrome.commands.getAll 读取真正的搜索绑定，失败不显示，不能硬编码图中 ⌘K。BookmarksToolbar 的 viewMode handler 在原 setter 前调用 notifyDashboardLayoutChange。运行 Step 2、`bun run compile`，实测搜索下拉不受 overflow 裁切、短窗口可滚动、全局工具与页内操作均可达。
- [ ] **Step 6: 提交本任务明确文件。** `feat(dashboard): introduce compact route headers and page frame`。

### Task 3: 前三个收藏集、行模型与稳定定位

**Files:** Replace `components/dashboard/content.tsx` with `components/dashboard/content/index.tsx`；Create 同目录 `row-model.ts`、`use-collection-expansion.ts`、`use-scroll-anchor.ts`、`collection-header.tsx`、`collection-band.tsx`、`draggable-bookmark-card.tsx`；Test `test/dashboard-content-model.test.ts`、`test/dashboard-content-expansion.test.tsx`；Extend `test/library-selection.test.tsx`、`library-visible-filters.test.tsx`、`highlight-deep-link.test.tsx`、`helpers/virtualizer.ts`；修改硬编码旧文件地址的相关测试 importFresh。

**Interfaces:**
- `BookmarkGroup`：`collectionId, collectionName, icon: string; isDefault: boolean; bookmarks: readonly Bookmark[]`。
- `buildContentRows({groups, bookmarks, selectedCollection, columns, isExpanded}: ContentRowsInput): ContentRowModel`；input 的 groups 为 `readonly BookmarkGroup[] | null`，bookmarks 为 readonly Bookmark[]，selectedCollection 为 string，columns 为 number，isExpanded 为 `(collectionId: string) => boolean`。
- 输出 `rows: readonly ContentRow[]; ranges: ReadonlyMap<string, CollectionRowRange>`；CollectionRowRange 为 `{collectionId: string; firstIndex: number; lastIndex: number}`。ContentRow 以 type 区分：collection_header（collectionId/collectionName/icon:string、count:number、bookmarkIds:readonly string[]）、bookmarks_row（collectionId:string、rowIndex:number、bookmarks:readonly Bookmark[]）、collection_dropzone（collectionId:string）或 empty_state（无业务字段）；无 hero/title/广告行。UI 根据空数据/筛选状态提供对应本地化文案。
- `useCollectionExpansion(workspaceId: string, collections: readonly Collection[], filterKey: string | null): {isExpanded: (collectionId: string) => boolean; toggle: (collectionId: string) => void; reveal: (collectionId: string) => void}`；使用 Task 2 UI state，未分类合成 key 单独处理。
- `useBookmarkScrollAnchor({scrollElement, rows, prefixHeight, layoutKey, virtualizer}: BookmarkScrollAnchorOptions): void`；scrollElement 为 HTMLElement|null，rows 为 readonly ContentRow[]，prefixHeight number，layoutKey string，virtualizer 为 TanStack `Virtualizer<HTMLDivElement, Element>`。仅布局变化恢复首个可见 bookmark ID 与偏移；导航/筛选仍走现有重置逻辑。

- [ ] **Step 1: 写失败的行模型/展开测试。** fixture 含 Default、position 降序的4个集合和未分类：仅前三个默认展开，空集合占名额、未分类有内容默认展开且不占名额；列表迟到只初始化一次、手动折叠后新增/重排不覆盖；workspace 切换再返回保持状态、刷新 provider 后重置。筛选仅展示有匹配组并临时展开，清除恢复；空库仍能显示可接收的 Default 标题；单集合无前三个限制。

```ts
test("single collection rows keep source order when columns change", () => {
  const bookmarks = [makeBookmark("a"), makeBookmark("b"), makeBookmark("c")];
  const model = buildContentRows({groups: null, bookmarks,
    selectedCollection: "default", columns: 2, isExpanded: () => true});
  expect(model.rows.flatMap(row => row.type === "bookmarks_row"
    ? row.bookmarks.map(bookmark => bookmark.id) : [])).toEqual(["a", "b", "c"]);
});
```

- [ ] **Step 2: 增加定位/选择断言并运行。** 第四组深链自动展开并定位；跨路由保留展开但选择清空；范围选择跳过折叠组；改变列数不改 viewOrder。现有 library-selection 里“第二组默认折叠”的 fixture 改为明确手动折叠或第四组，保留原测试目的，不能直接删断言。运行 `bun test test/dashboard-content-model.test.ts test/dashboard-content-expansion.test.tsx test/library-selection.test.tsx test/library-visible-filters.test.tsx test/highlight-deep-link.test.tsx` 至新行为失败。
- [ ] **Step 3: 拆分并实现纯行模型和展开 hook。** 按真实活跃集合排序初始化，不把未分类/all 当实体 ID；完整 viewOrder 包含折叠组，onScreenOrder 排除折叠组但不排除虚拟未挂载项。保留标签树 expandTagSelection；filterKey 包含排序后的标签 IDs、filterType、列表 searchQuery，排除 SearchBox.query。筛选会话的手动折叠不写回普通展开映射。
- [ ] **Step 4: 接入测量和锚点。** 每行定位外层与 droppable 内层分开，稳定 key 包含 mode/collection/rowIndex；固定 prefix 独立实测，估算使用 Task 1 密度，最终由 measureElement 决定。列数/viewMode/文字行高变化后 measure 并恢复锚点；源 ID 消失回退邻近集合。同步退休/删除沿用 useWorkspaceCollectionReset，不保留可写的旧目标。
- [ ] **Step 5: 重跑 Step 2、`bun test test/selection-scope.test.tsx test/workspace-collection-reset.test.tsx` 和 `bun run compile`。** 预期通过；显式 fake prefix 高度、滚动坐标与 ResizeObserver，不能用 happy-dom 判断真实行高。
- [ ] **Step 6: 提交明确文件与引用迁移。** `feat(dashboard): model collection sections and preserve scroll anchors`。

### Task 4: Minimal Neutral 与侧栏功能/数据完整性

**Files:** Modify `assets/globals.css`、`components/dashboard/sidebar/{index,user-profile,quota-card,sync-status,collection-row,section-header,tags-section}.tsx`、`components/dashboard/workspace-rail.tsx`（仅必要样式）；Test `test/dashboard-sidebar-preservation.test.tsx`；Reuse `test/sync-status-consent.test.tsx`、`quota-usage.test.ts`、`workspace-manager.test.tsx`、`sidebar-tags-section.test.tsx`。

**Interfaces:** 保持所有原组件 props、账号/plan store selector、原菜单事件与额度计算；只使用现有语义 CSS 变量，不增加第二套 Dashboard 主题或新的套餐数据适配器。Sidebar 宽度通过现有 CSS 变量设置；目标208px，若信息完整性实测不通过则保留256px并让网格按实测宽度计算。

- [ ] **Step 1: 写保留测试并先在旧代码运行。** 用例名 `sidebar retains account fields and all five quota resources`、`plan loading never fabricates zero usage`、`guest registration and sync consent remain actionable`。使用真实 UserProfile/QuotaCard/SyncStatusIndicator 与 typed store fixtures；验证游客登录/注册、已登录姓名/邮箱/验证状态/套餐、账户菜单中的套餐配额/导入/退出；五项资源 usage/limit、in-use/trash 明细、∞、升级/管理套餐均可访问。模拟 pending/failed plan 时不出现伪零值；同步授权/错误详情/立即同步仍走原回调。此项是特征保护测试，旧代码应 PASS，不人为制造失败；发现已有缺口先记录再限制到本次引入的回归。
- [ ] **Step 2: 运行 `bun test test/dashboard-sidebar-preservation.test.tsx test/sync-status-consent.test.tsx test/quota-usage.test.ts test/workspace-manager.test.tsx test/sidebar-tags-section.test.tsx` 记录基线。** 如需增强测试工具，只扩充已有 helper，不能以 mock 整个待保留组件取得通过。
- [ ] **Step 3: 应用配色与侧栏视觉。** 精确替换主设计 §8.2 中所有浅/深颜色值；保留 Inter、已有字体/全局 radius，卡片局部圆角见 Task1。减轻侧栏玻璃/大阴影/渐变，使用 sidebar/foreground/accent；保留内容自身标签、组和图标颜色。用户/配额/同步保持原对应区域及条件，额度不压住导航最后一项；允许文字换行和侧栏独立滚动，不能压成无信息图标。深色 sidebar-primary 原主题蓝色只用于对应语义。
- [ ] **Step 4: 重跑 Step 2 与 `bun run compile`。** 浏览器检查208px、256px、长邮箱、五项额度、配额卡展开、Guest/Free/Pro/Premium、加载/失败、浅/深；共享 CSS 影响的 Dialog、popover、搜索浮层与 popup 做配色检查，保持其布局与动作。只测颜色布局的部分不加类名快照测试。
- [ ] **Step 5: 提交明确文件。** `style(dashboard): apply minimal neutral and preserve sidebar information`。

### Task 5: 右栏折叠与真实浏览器来源

**Files:** Modify `components/dashboard/tabs-rail.tsx`、`entrypoints/newtab/App.tsx`、`components/dashboard/layout/{dashboard-topbar,dashboard-ui-state}.tsx`；Test `test/dashboard-tabs-rail.test.tsx`、`test/dashboard-panel-layout.test.tsx`；两份 messages.json。

**Interfaces:** `TabsRail({collapsed, onCollapsedChange}: {collapsed: boolean; onCollapsedChange: (collapsed: boolean) => void})`；数据加载在组件内持续存在，折叠不重置窗口选择。WindowTab 增加真实 `groupId: number`。`useRightPanelLayout(viewportWidth: number)` 使用 Task2 preference，返回 `{mode: "expanded" | "collapsed" | "hidden"; setPreference: (value: "expanded" | "collapsed") => void}`；可放 dashboard-ui-state.tsx，无需新全局 store。

- [ ] **Step 1: 写失败测试。** 用例名 `right panel restores desktop preference after narrow viewport`、`collapsed rail keeps window selection and real group identity`、`window query failure is not an empty result`。≥1200默认展开248px；768–1199强制收起44px；<768隐藏并由 topbar 的现有 /tabs 路由入口可达；回宽屏恢复用户选择；viewMode 不改右栏。折叠/展开保留选中窗口、数量来自该窗口真实可用 tabs；窗口关闭后修正选择；loadWindows 失败与空窗口不混淆。TABS_CHANGED 在折叠时仍刷新、卸载撤销监听；真实 groupId 进入 payload。
- [ ] **Step 2: 运行 `bun test test/dashboard-tabs-rail.test.tsx test/dashboard-panel-layout.test.tsx` 至新增断言失败。** fake viewport 只测试状态转换，实际宽度由 Task12 浏览器检查。
- [ ] **Step 3: 实现面板和行结构。** 平面列表约48px；行外层非 button，打开按钮与独立具名手柄是兄弟；正文/打开按钮仍可聚焦到原 tab/window。保留所有用户可用 tab 与窗口数据，不增加关闭标签功能。仅 handle touch-action:none，来源 URL 格式化安全回退。加载失败保留已有成功数据并显示错误/重试；不把错误呈现为0个标签。
- [ ] **Step 4: 接入响应式与布局事件并验证。** 用户切换与断点模式变化前调用 notifyDashboardLayoutChange；每像素 resize 不重复触发。禁用面板宽度补间，记录 preference 只在本页内存。补齐 Window/Opened Tabs/Ads/No open tabs 等本地化，运行 Step2、Task1 resize 测试和 `bun run compile`。
- [ ] **Step 5: 提交明确文件。** `feat(dashboard): add collapsible tabs rail without losing window state`。

### Task 6: 紧凑广告与滚动稳定性

**Files:** Modify `components/dashboard/ad-banner.tsx`、`content/index.tsx`、`tabs-rail.tsx`、`tabs-panel/tabs-ad-strip.tsx`；Test `test/dashboard-ads-layout.test.tsx`；两份 messages.json。

**Interfaces:** `AdBanner({freeze}: {freeze?: boolean})` 保留现有导出；freeze 为活动拖动时冻结当前可见广告和高度。数据仍来自 homepageAds/ensureFresh，右栏仍使用 sidebarAds，取数与 tier 不变。Task9 把真实会话接入 freeze。

- [ ] **Step 1: 写失败测试。** 用例名 `homepage ad keeps source order without automatic rotation`、`ad changes wait until drag ends`、`ad prefix resize preserves the visible bookmark offset`。无广告不占槽、单条无切换、多条按原顺序逐条可访问；不会复制广告数据或自动轮播；链接/广告标记不丢；freeze 期间新数据/空→有不插入，释放后才应用。仅全部书签无列表筛选显示首页位；右栏保持最多3条与原链接，不混入 homepageAds。
- [ ] **Step 2: 运行 `bun test test/dashboard-ads-layout.test.tsx test/ads-store.test.js` 至新增行为失败。** 使用 fake timers 检查不存在自动轮播，不以等待真实秒数验证。
- [ ] **Step 3: 改展示并接入滚动。** 首页高56–64px紧凑条置于 PageFrame prefix，提供上一/下一/序号，移除重复数组与自动滚动 timer。小屏可两行；广告更新由 prefix observer 重测并让 Task3 锚点恢复。右栏广告位于底部有界区域、不超过可用高度25%，Tabs 列表可伸缩；右栏收起不显示广告但展开后可访问全部原投放项。
- [ ] **Step 4: 重跑 Step2、Task3 定位测试及 `bun run compile`。** 浏览器验证广告晚加载、短高度与拖动期间几何稳定；广告不是书签或投放目标。
- [ ] **Step 5: 提交明确文件。** `style(dashboard): compact ad placements and stabilize scrolling`。

### Task 7: 拖放领域类型与统一策略

**Files:** Create `lib/drag-and-drop/types.ts`、`drop-policy.ts`；Modify `lib/drop-ids.ts`、`components/dashboard/tabs-dnd-provider.tsx`（仅类型重导出兼容）；Test `test/dashboard-drop-policy.test.ts`；Extend `test/drop-ids.test.ts`。

**Interfaces:** 以下类型在 types.ts 定义，纯领域文件不 import React/DOM/store：
- TabDragData、TabGroupDragData、BookmarkDragData 保留 provider 当前字段，三个对象改用 interface；DragData 为三者的可辨识联合。`DragSession {id: number; sourceWorkspaceId: string; data: DragData}`，session ID 单调递增。
- `DropTarget` 联合以 kind 区分：collection `{collectionId:string}`、chrome-group `{groupId:number}`、saved-group `{groupId:string}`、save-group、ungroup。`UNGROUP_DROP_ID = "tabs-ungroup"`；collection/saved-group 保留 lib/drop-ids.ts 编码，Chrome组目标为 `group-drop-<number>`（不是来源ID tab-group-），创建已保存组目标为 `sidebar-groups`。
- `DropSnapshot` 字段：`activeWorkspaceId: string; workspaces: readonly Workspace[]; collections: readonly Collection[]; bookmarks: ReadonlyMap<string, Bookmark>; savedGroups: readonly SavedGroup[]; groupTabs: readonly GroupTab[]; browserTabs: readonly BrowserTab[]; browserGroups: readonly BrowserTabGroup[]; selectedBookmarkIds: ReadonlySet<string>`。browserGroups 的 BrowserTabGroup 取自 lib/chrome/tab-groups.ts。
- `DropIntent` 以 kind 区分：move-bookmark `{bookmarkId,collectionId:string}`；save-tabs `{tabIds:readonly number[];collectionId:string}`；join-group `{tabId,groupId:number}`；append-saved-group `{tabIds:readonly number[];groupId:string}`；save-group `{groupId:number}`；ungroup-tab `{tabId:number}`。只含身份，实时 payload 由 executor 查询。
- `DropDecision`：allowed `{status:"allowed";targetKey:string;targetLabel:string;intent:DropIntent}`；noop `{status:"noop";targetKey:string;targetLabel:string;reason:"same-target"}`；blocked `{status:"blocked";reason:DropBlockedReason}`。DropBlockedReason 为 unsupported/source-unavailable/target-unavailable/workspace-changed/selection-active。
- `DropResult {status:"applied"|"partial"|"noop"|"blocked"|"failed";appliedCount:number;skippedCount:number;bookmarkIds:readonly string[];savedGroupId?:string;reason?:DropResultReason}`；DropResultReason 为 DropBlockedReason 加 same-target/duplicate/quota/browser-error。
- `parseDropTarget(dropId:string):DropTarget|null`、`resolveDrop(session:DragSession,target:DropTarget,snapshot:DropSnapshot):DropDecision`。targetKey 规范为 collection:<真实ID>、chrome-group:<数字ID>、saved-group:<ID>、save-group、ungroup；surface 不进入业务 ID。

- [ ] **Step 1: 写失败的策略矩阵测试。** 表驱动覆盖设计 §10 全部来源/目标组合；当前所属集合/组返回 noop；all 与内容未分类别名解析到真实 Default；缺 Default、隐藏/退休父级、归档/回收站书签、跨工作区、畸形数字组 ID 均 blocked/null。非空选择只禁书签拖动，Tab 不受影响；收藏和归档路由不凭共享卡片获得来源。断言 header/band/sidebar 别名的 targetKey 相同。

```ts
test("explicit ungroup is recognized and malformed chrome group ids are rejected", () => {
  expect(parseDropTarget("tabs-ungroup")).toEqual({kind: "ungroup"});
  expect(parseDropTarget("group-drop-12oops")).toBeNull();
});
```

- [ ] **Step 2: 运行 `bun test test/dashboard-drop-policy.test.ts test/drop-ids.test.ts` 至新增断言失败。** fixtures 使用现有 makeWorkspace/makeCollection/makeBookmark 与实际 Chrome 类型，不 mock resolveDrop。
- [ ] **Step 3: 实现类型与纯策略。** 严格解析 ID 和别名，使用可见性 helper；不能给未知来源/目标兜底允许。resolveDrop 不做配额/URL重复扫描/网络请求，不复制 bookmarks Map。provider 重导出 DragData 等保持现有导入兼容；待 Task9 再替换其执行逻辑。
- [ ] **Step 4: 重跑 Step2 和 `bun run compile`，预期通过。** 原 provider 在此阶段仍可运行，不提前引入未实现 executor。
- [ ] **Step 5: 提交明确文件。** `feat(dnd): define unified drop policy and domain contracts`。

### Task 8: 复验执行与真实结果

**Files:** Create `lib/drag-and-drop/execute-drop.ts`；Test `test/dashboard-drop-execution.test.ts`；Reuse `test/duplicate-lookup.test.ts`、`tabs-store-cross-window-search.test.js`、`tabs-store-save-covers.test.ts`。

**Interfaces:** `readDropSnapshot():DropSnapshot` 使用原 store 数据引用；浏览器 tabs 合并 allTabs/openTabs 去重只复制浏览器小列表，不复制书签 Map。`executeDrop(session:DragSession,target:DropTarget):Promise<DropResult>`；内部复用 updateBookmark/addBookmarks、groups createGroup/addTabToGroup、tabs moveTabsToGroup/ungroupSpecificTabs。保持这些 action 原签名与持久化契约，不改 store 返回值。

- [ ] **Step 1: 写失败的执行测试。** 用例名 `cross-window source is revalidated after browser await`、`quota-rejected writes never report applied items`、`empty saved group id never receives tabs`、`partial duplicates report exact applied and skipped counts`。跨窗口 rail tab 不在 openTabs 仍可保存；实时 chrome.tabs.get/query 更新了标题/URL/groupId 应采用当前值。用可控 Promise 让工作区/目标退休发生在 await 期间，断言无写入；组关闭/Tab消失 blocked。addBookmarks 被配额拦截 appliedCount=0；createGroup 返回空 ID 时不追加；同批严格重复只新增一次；已有重复和部分重复返回准确 skippedCount，保留原重复定位反馈；saved-group 按原始 URL 去重。浏览器分组 action rejection 返回 failed；操作成功后 loadTabs 刷新失败也不能虚报已回滚。
- [ ] **Step 2: 运行 `bun test test/dashboard-drop-execution.test.ts` 至新增断言失败。** 测试可以替换 action 为 typed spy，但必须真实运行 policy/executor；另用真实 bookmarks store 覆盖至少一个配额提前返回和一个成功写入后置条件。
- [ ] **Step 3: 实现执行器。** 第一次 snapshot/policy 后，查询真实 Chrome 来源/目标；每次查询 await 后、每个写入前复验 active workspace 与父级可见性。无浏览器来源的 bookmark 移动只接受 active map；保存时按当前严格规则去重，批次内同步更新 dedupe 集合。复用当前保存 payload 构造，包括 favicon 规范化、imageUrl/notes/updatedAt 的现有缺省语义；不通过简化 payload 清掉元数据。
- [ ] **Step 4: 计算后置条件并处理失败。** 新书签按本次生成 IDs 检查 Map；移动检查目标 collectionId；saved group 按前后原始 URL 集合/新组 ID 检查；浏览器操作以 API 完成为准。无法确认时 failed/browser-error 并安排静默刷新，保留真实结果可能已应用的解释；不自动重复执行，不承诺回滚。applied 只表示本地内存/API接受，不代表 IDB/远端确认。配额通知仍只有 QuotaAlert。
- [ ] **Step 5: 运行 Step2、策略测试和上述三份复用测试，再 `bun run compile`；预期通过。** 对全重复、全配额拒绝与部分成功分别断言计数/状态，不能按输入长度报成功。
- [ ] **Step 6: 提交明确文件。** `feat(dnd): execute drops with current-state validation and outcomes`。

### Task 9: 输入、碰撞、会话与明确解除分组

**Files:** Modify `lib/drag-sensors.ts`、`lib/drag-and-drop/types.ts`、`components/dashboard/tabs-dnd-provider.tsx`、`content/{index,collection-header,collection-band,draggable-bookmark-card}.tsx`、`tabs-rail.tsx`、`tabs-panel/{draggable-tab,group-card}.tsx`、`shared/group-card-base.tsx`、`sidebar/{index,collection-row}.tsx`、`group-detail/index.tsx`、`ad-banner.tsx`、`layout/{dashboard-topbar,page-header}.tsx`；Create `components/dashboard/drag-and-drop/ungroup-drop-zone.tsx`；Test `test/drag-sensors.test.ts`、`test/dashboard-dnd-provider.test.tsx`；两份 messages.json。

**Interfaces:**
- `getDragActivationConstraint(pointerType:string,isHandle:boolean):PointerActivationConstraint|null`；null 表示触摸正文禁用。SmartPointerSensor 构造参数使用 ConstructorParameters<typeof PointerSensor>[0]，实例复制 options，activator 不改共享对象。
- `DropSurfaceData {target:DropTarget;surfaceKey:string;priority:"sidebar"|"header"|"band"|"other"}` 存在每个 droppable 的 data；新增 `lib/drag-and-drop/types.ts` 中仅字符串/领域字段。surfaceKey 形如 content:<workspaceId>:<collectionId>、sidebar:<workspaceId>:<collectionId>，同内容集所有 band 共用 surfaceKey、drop ID 仍唯一。
- `useTabsDndContext()` 保留 activeData/overCollectionId，增加 `session:DragSession|null; decision:DropDecision|null; activeTargetKey:string|null; activeSurfaceKey:string|null; phase:"idle"|"dragging"|"executing"; isDragDisabled:boolean; cancelActiveDrag:()=>void`。后续完成反馈字段在 Task11 增加，不在本任务伪造成功。
- `UngroupDropZone()` 常驻注册 tabs-ungroup，仅实时有效的已分组 Tab 拖动时可见；不支持的浏览器不展示可执行目标。

- [ ] **Step 1: 写失败的 sensor/provider 测试。** 用例名 `handle activation never mutates body sensor options`、`blank drop never ungroups tabs`、`blocked foreground target prevents collection fallback`。鼠标/笔手柄4px、正文6px，触摸手柄250ms/5px、触摸正文null；手柄/正文轮换不污染共享配置。portal menu/dialog、input/textarea/select/contenteditable、链接/普通按钮/checkbox 不激活，具名手柄可激活。空白结束不 ungroup，只有指针进入 tabs-ungroup 才执行；不接受 rect fallback 的 ungroup。blocked/same-target 覆盖有效收藏集时不穿透。
- [ ] **Step 2: 增加会话及交互回归并运行。** 列数/断点/viewMode/layout 事件取消活动 sensor 并清掉 ownerDocument 监听；普通 width 变化不反复取消。路由/工作区变化、blur、visibilitychange、unmount 同样清理；Esc 不清多选；菜单打开取消未提交手势；drag 后 click 不打开书签。执行未结束禁止新拖动但其他按钮可用，Promise rejection 释放锁，切工作区后的迟到结果不通知/高亮。运行 `bun test test/drag-sensors.test.ts test/dashboard-dnd-provider.test.tsx` 至新断言失败。
- [ ] **Step 3: 实现 sensors 和语义手柄。** 所有来源使用 setActivatorNodeRef+button attributes/listeners，正文只保留 pointer 入口；只有 handle touch-none；Task1 的卡片 handleRef 接入。GroupCardBase 去掉触及的 any 索引签名，显式定义 button/ref/HTMLAttributes props。右栏打开按钮不作为 drag handle。保留原来源payload，禁止选择中的书签起拖。
- [ ] **Step 4: 接入 policy/executor 和碰撞。** 先看所有命中注册区域/显式 blocker，再从允许目标 pointerWithin，只有真正空隙才 rectIntersection；工具栏、广告、搜索结果、打开按钮、批量栏、弹层标记 `data-dashboard-drop-blocker`，结合最上层 elementFromPoint 避免穿透。键盘目标走选定 candidate，不依赖指针。targetKey 决定业务、surfaceKey 决定展示；去掉 no-over ungroup 分支和内联业务，统一 executeDrop。
- [ ] **Step 5: 完成清理、底部目标与文案。** cancelActiveDrag 经 ownerDocument Escape 进入 sensor 原生 cleanup，不仅清 state；取消按键 preventDefault、不中断 sensor 的传播。解除分组区邻近右栏、批量栏可见时上移并预留空间；不遮挡末行。广告 freeze 接真实 phase=dragging；通知复用 Alert，与 QuotaAlert 不叠位。文案使用补充设计 §8 固定中英/placeholder。拖动期间在 document 设置临时 data-dashboard-dragging，退出清除；CSS 隐藏无关 toolbar/portal Tooltip，不影响 Dialog。
- [ ] **Step 6: 运行 Step2、Task7/8、Task6测试及 `bun run compile`，预期通过。** 一个 pointer sensor 配合后续 keyboard sensor，不注册两个相同 onPointerDown activator。
- [ ] **Step 7: 提交明确文件。** `feat(dnd): unify drag sessions and explicit accessible drop targets`。

### Task 10: 虚拟收藏集整段高亮与 surface 区分

**Files:** Create `components/dashboard/drag-and-drop/collection-drop-highlight.tsx`；Modify `content/{index,collection-header,collection-band}.tsx`、`tabs-dnd-provider.tsx`、`sidebar/{index,collection-row}.tsx`、`tabs-panel/group-card.tsx`、`group-detail/index.tsx`；Test `test/dashboard-drop-surfaces.test.tsx`。

**Interfaces:**
- `getVisibleCollectionBounds(range:CollectionRowRange, measuredRows:readonly MeasuredContentRow[], viewport:CollectionViewport):CollectionBounds|null` 在高亮文件具名导出；MeasuredContentRow 为 `{index:number;start:number;size:number}`，CollectionViewport 为 `{scrollTop:number;height:number;prefixHeight:number}`，CollectionBounds 为 `{top:number;height:number;showTop:boolean;showBottom:boolean}`；统一换算为内容滚动坐标，已计入 prefix。
- `CollectionDropHighlight({bounds,state}: {bounds:CollectionBounds|null;state:"active"|"completed"|null})`，pointer-events:none，不提供 droppable、不修改测量节点。Task11 补 completed 的真实数据来源。

- [ ] **Step 1: 写失败的 surface/几何测试。** 用例名 `visible collection outline respects clipped true boundaries`、`sidebar and content surfaces never highlight together`。显式提供虚拟器可见行 start/size：跨同收藏集 band 不闪烁、不重复轮廓；部分滚出时仅展示真实进入视口的上下边界；折叠只覆盖标题；整段只挂载可见/overscan行而非整组。命中 sidebar 只亮 sidebar，命中 content 只亮该 content，单集合范围不包含页头/广告/批量栏。改变 prefixHeight/滚动位置后范围正确。
- [ ] **Step 2: 运行 `bun test test/dashboard-drop-surfaces.test.tsx test/dashboard-content-model.test.ts` 至新断言失败。** 不用伪造 className 证明几何正确，断言 bounds 和实际注册 surface 身份。
- [ ] **Step 3: 实现高亮与所有目标接入。** 由 Task3 range 加 virtualizer.getVirtualItems() 的测量结果计算可见区域；只遍历当前可见行，不用私有测量 API、不逐帧查整组 DOM。一个绝对背景层承载2px语义 primary 轮廓/浅底，无缩放，z-index位于卡片后。其他目标按同一 decision/surfaceKey 判断资格，不能保留旧的 activeData.type 直判允许。
- [ ] **Step 4: 重跑 Step2、Task3 深链/选择和 Task9 provider 测试，加 `bun run compile`。** 浏览器滚动穿过长集合并从 content 移到 sidebar，验证无相互高亮、无目标尺寸变化和滚动穿透。
- [ ] **Step 5: 提交明确文件。** `feat(dnd): highlight logical collection surfaces across virtual rows`。

### Task 11: 纯预览、结束动画、键盘与可访问性

**Files:** Create `components/dashboard/drag-and-drop/{drag-preview,drop-feedback}.tsx`、`hooks/use-reduced-motion.ts`、`lib/drag-and-drop/keyboard-coordinates.ts`；Modify `tabs-dnd-provider.tsx`、`lib/drag-sensors.ts`、`content/draggable-bookmark-card.tsx`、`tabs-rail.tsx`、`tabs-panel/{draggable-tab,group-card}.tsx`、`shared/group-card-base.tsx`、`drag-and-drop/collection-drop-highlight.tsx`、`assets/globals.css`；Test `test/dashboard-drop-feedback.test.tsx`、`use-reduced-motion.test.tsx`、`dashboard-keyboard-drag.test.tsx`；两份 messages.json。

**Interfaces:**
- `useReducedMotion():boolean` 初始读取并订阅 matchMedia change，卸载清理。
- `DragPreview({data,instruction,width}: {data:DragData;instruction:string;width:number})` 纯展示，不读 store；紧凑书签使用源实测宽/约88px密度，其余来源约200px，上限calc(100vw - 32px)。
- `DropFeedbackSnapshot {sessionId:number;workspaceId:string;sourceId:string;data:DragData;previewRect:DOMRectReadOnly;sourceElement:HTMLElement|null;sourceRect:DOMRectReadOnly|null;targetKey:string|null;surfaceKey:string|null;dropId:string|null;previewWidth:number}`，只存本页展示状态。
- `DropFeedbackLayer({snapshot,mode,reducedMotion,onComplete}: {snapshot:DropFeedbackSnapshot|null;mode:"settle"|"return";reducedMotion:boolean;onComplete:(sessionId:number)=>void})`。
- context 追加 `completedTargetKey:string|null;completedSurfaceKey:string|null;completedDropId:string|null;completedExpiresAt:number|null;returningSourceId:string|null`，Task10消费 completedSurfaceKey+到期时间，不因重挂载重播。
- `getKeyboardDropCandidates(session:DragSession,snapshot:DropSnapshot,containers:readonly KeyboardDropContainer[]):readonly KeyboardDropContainer[]`；KeyboardDropContainer 为 `{id:string;data:DropSurfaceData;node:HTMLElement}`。`createDashboardKeyboardCoordinates(readCandidates:()=>readonly KeyboardDropContainer[]):KeyboardCoordinateGetter`；类型取自 dnd-kit。

- [ ] **Step 1: 写失败的动画/偏好测试。** 用例名 `source unmount does not destroy the settling preview`、`stale session cannot clear current feedback`、`reduced motion change cancels an active return animation`。fake rect/WAAPI/matchMedia：写入使源卸载仍能160ms收起；取消读取源当前rect、源不连接原地淡出；180ms返回中scroll/resize/节点消失取消位移；600ms只高亮实际成功surface；部分成功显示准确摘要；quota/noop/failed不成功闪烁。旧session timer/Promise/Animation不得清新反馈；新手势清旧视觉、执行中不准启动。reduce运行中切换立即取消位移；WAAPI缺失直接清理，unmount撤销资源。
- [ ] **Step 2: 写失败的键盘/焦点测试并运行。** 用例名 `keyboard candidates deduplicate by logical target`、`Tab cancels once and restores focus without clearing selection`。Space/Enter只从手柄启动/提交；方向键按文档顺序前后、不循环；逻辑targetKey去重，优先sidebar/header/band；隐藏/断开/零尺寸/blocked/noop节点不入候选；选中目标scrollIntoView({behavior:"auto"})后重新测量。Esc/Tab取消并恢复源手柄，Tab被消费后下次才正常导航；源卸载回实际目标可聚焦控件，目标不可见回路由h1(tabIndex=-1)。Tab取消不打开网页、不清选择。运行 `bun test test/dashboard-drop-feedback.test.tsx test/use-reduced-motion.test.tsx test/dashboard-keyboard-drag.test.tsx` 至新增断言失败。
- [ ] **Step 3: 实现纯预览、动画与生命周期。** 保持 DragOverlay dropAnimation=null；写入前捕获快照、松手即收起；WAAPI只接管fixed反馈层transform/opacity。ease=cubic-bezier(0.2,0,0,1)，settle160ms/scale.98、return180ms、目标600ms；源拖动opacity.4占位，返回期暂隐藏避免重影，任何退出都恢复。只在result.appliedCount>0且session/workspace仍有效时完成高亮；目标卸载用文字，不reveal/滚动/导航。监听和timer集中于provider/反馈层，不能每卡片一个全局监听。
- [ ] **Step 4: 实现键盘候选与通知。** HandleKeyboardSensor使用公开KeyboardSensor，仅定制activator；keyboardCodes start/end=[Space,Enter]、cancel=[Escape,Tab]，scrollBehavior=auto，不覆写private方法或引入排序语义。候选中心相对collisionRect中心计算位移；使用真实可见节点与Task7 policy。provider内一个持久live region覆盖启动/语义目标变化/处理中/结果/取消，抑制默认重复announcements；同集合band切换不重复播报。
- [ ] **Step 5: 完成局部CSS与本地化。** hover120ms、action按压80ms/scale.97，整卡/导航不缩放；reduce关闭dashboard缩放/返回位移/pulse，保留即时边框/焦点/文字。仅本次控件标记dashboard-action，不全局覆盖Button/Dialog。全部手柄、复制/收藏/备注、面板/广告控制补可访问名称，短提示不改行尺寸，图层按主设计§12；新文案沿用固定dashboardDnd_文本与placeholder，不照抄图中标签。
- [ ] **Step 6: 重跑 Step2、Task9/10及现有 `test/bookmark-card-menu.test.tsx test/bookmark-selection.test.tsx test/selection-scope.test.tsx`，再 `bun run compile`。** 浏览器实测键盘完整链、触摸长按与reduce，DOM fake只能证明生命周期，不能证明动画手感。
- [ ] **Step 7: 提交明确文件。** `feat(dnd): add outcome-aware motion and keyboard drag accessibility`。

### Task 12: 完整功能回归、浏览器与性能验收

**Files:** Extend `test/dashboard-layout.test.tsx`、`dashboard-sidebar-preservation.test.tsx`、`dashboard-content-expansion.test.tsx`、`dashboard-dnd-provider.test.tsx`、`test/library-selection.test.tsx`、`favorites-bookmark-form.test.tsx`、`trash-content-group-purge.test.tsx`（仅与改版相关断言）；Update 本计划 checkbox/验收证据。结果录制与截图仍在被忽略的 output/design，不新增报告md或提交图像。

**Interfaces:** 不引入新接口；按主设计§2.1保留清单、§16验收和补充拖拽设计§9矩阵逐项验收。缺陷修复回到拥有该代码的任务接口，新增回归断言后修复，避免一个“最终清理”提交重做架构。

- [ ] **Step 1: 补端到端组件回归并运行定向测试。** 同一fixture依次进入书签/收藏/归档/回收站/tabs/saved-group，核对h1/搜索与专用动作、书签编辑/备注/封面/菜单/多选/批量栏、标签树筛选、深链、排序和view偏好；归档/回收站/已保存组恢复删除确认及离线/权限反馈仍有效。页头短高布局变化时不得重复挂载搜索或丢失活动输入/焦点。对比用户/套餐/额度真实值，不以截图省略为删减依据。
- [ ] **Step 2: 完成全自动检查。** 先 `bun test`（出现Bun mock污染使用已有隔离helper，不跳过相关测试），再 `bun run compile`、`bun run build`、`bun run build:firefox`。预期各命令exit0；若基线已有失败需列出原/新增差异，未修复相关失败不能声称通过。当前package没有test script，不使用bun run test。
- [ ] **Step 3: 执行浏览器功能矩阵。** Chrome/Edge/Firefox，CSS宽1440/1280/1024/768/390、可用高<600、浅/深、grid/gallery、右栏展开/收起、200%与coarse pointer。完整检查所有sidebar信息、窄列操作与标签溢出、搜索dropdown、广告、底部批量栏/ungroup不遮挡末行。Firefox只展示其实际支持的分组目标；无能力不得假成功。
- [ ] **Step 4: 执行拖放矩阵。** 主设计§10每一允许组合逐项验成功/same-target/重复/配额/部分成功/源目标失效/Chrome rejection/迟到结果；空白取消、明确ungroup、保存保留浏览器源。鼠标/笔、触摸、键盘均可开始/提交/取消，菜单/输入不误拖；滚动时命中与surface正确，layout切换、blur、切工作区及Dialog无残留。
- [ ] **Step 5: 对照性能基线。** 同设备、同生产构建方式、同1,000条数据、10秒滚动/拖动，记录首屏、mounted行数、React commits、布局绘制与长任务。不能因整段高亮挂载全组、每帧遍历全库或把跟手加弹簧；没有新增持续布局抖动/跟手延迟。性能异常先定位/修复，再复测受影响场景，不声称未经实测的FPS。
- [ ] **Step 6: 核验Git与交付。** `git diff --check`、`git diff --name-only`、`git ls-files output/design`（应无输出）、`git check-ignore output/design/content-redesign-2026-10-23/minimal-neutral/compact-v2/01-four-columns.png`（应命中）。核对无API/schema/套餐口径/偏好协议变化，无遗留大时钟模式、功能删除或图片依赖；仅提交修复文件/测试与计划证据，消息 `test(dashboard): verify redesigned layout and drag interactions`。按 requesting-code-review/finishing-a-development-branch完成所选执行方式要求的审查与交付，不自动合并/推送。

## 设计覆盖与执行交接

| 主设计章节 | 负责的任务 |
|---|---|
| §1–3、§2.1 范围/功能数据保留 | 全局约束、Task2/4/12 |
| §4–6 框架/响应式/搜索 | Task1/2/5 |
| §7 收藏集/选择/空状态 | Task3/12 |
| §8 卡片/颜色 | Task1/4 |
| §9 广告/右栏 | Task5/6 |
| §10 拖放业务/输入 | Task7/8/9/11 |
| §11 虚拟化/surface | Task3/9/10 |
| §12 动画/图层/底部区域 | Task9/10/11 |
| §13 无障碍/本地化 | 每项涉及文案的任务、Task11/12 |
| §14–15 组件/工程约束 | 文件结构、全部任务接口 |
| §16–18 验收/Git图片边界 | Task12、全局约束 |

自审：已检查任务依赖、共享签名、主/补充设计的尺寸与surface覆盖关系；未沿用旧计划的240px固定预览或仅按物理dropId闪烁。新行为有失败→实现→通过步骤，现有功能保护测试先记通过基线；视觉/浏览器/性能检查明确为执行时待完成，不把文档检查写成产品测试已通过。

建议采用 **Native（本会话顺序实施）**：12个任务共享页面滚动坐标、surface和session接口，顺序完成便于保持一致；末尾再由独立 reviewer 做整分支审查。也可选择 **Subagent-driven**：每任务新实现代理与独立审查，再做整分支审查，开销更高。用户评审计划并选择执行方式后，按对应技能开始；本次计划编写不派发实施代理。

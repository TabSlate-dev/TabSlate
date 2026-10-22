# Dashboard 拖拽与微交互设计

日期：2026-10-23

状态：待用户评审的设计草案。用户本次明确要求同时编写 design 和 plan，因此一并交付配套计划；这不代表已经批准产品代码实施。

配套计划：[Dashboard Drag and Motion Implementation Plan](../plans/2026-10-23-dashboard-drag-and-motion.md)

## 1. 目标与范围

面向频繁整理书签和浏览器标签页的用户，让每次拖放清楚表达三个信息：拖动了什么、松手会执行什么、执行后发生了什么。普通悬浮和点击保持稳定、快速，适合信息密集的工作界面。

依据上一轮调研，本轮采用以下设计假设：保留现有 dnd-kit；先完成当前已挂载页面的单项拖放闭环；不新增动画依赖，不调整服务端或持久化模型。需要用户评审的是这些具体设计决策，而非重新授权编写文档。

本轮包含：

- BookmarksContent 的 grid/gallery 书签，TabsRail、TabsPanel 中的 Tab 和浏览器标签组。
- 侧栏集合、内容区集合、当前已打开的 saved group 详情、浏览器标签组，以及明确的解除分组区域。
- 指针触发、有效目标判断、预览、原项状态、操作预告、结束反馈。
- 键盘拖放、读屏通知、焦点恢复、减少动态效果。
- 书签操作工具栏、集合标题和 dashboard 操作按钮的局部悬浮/按压反馈。

不包含：手动排序及插入线、批量选中项拖放、标签层级拖放、跨工作区拖放、外部文件/网页拖入、撤销系统、服务端同步状态提示、全站 Dialog 动画改版。FavoritesContent 当前没有拖动包装，本轮只共享 BookmarkCard 的微交互改进，不新增拖放入口。未挂载的 `groups-panel/` 保留，不重构、不接入。

## 2. 当前代码依据

| 位置 | 已确认的行为 | 对本设计的约束 |
|---|---|---|
| `entrypoints/newtab/App.tsx` | 所有 dashboard 路由由 TabsDndProvider 包裹；没有挂载 GroupsPanel | 只维护实际入口，不把遗留代码当作运行时问题 |
| `components/dashboard/tabs-dnd-provider.tsx` | 正文 250ms 长按，手柄 1px；pointerWithin 后回退 rectIntersection；dropAnimation 为 null | 统一触发与目标资格，结束反馈需要业务语义 |
| 同上 | 没命中目标的已分组 Tab 会解除分组 | 改为仅明确解除分组区域可以执行；空白松手取消 |
| `lib/drag-sensors.ts` | activator 会修改共享的 options.activationConstraint | 将约束选择放到本次 sensor 实例，防止手柄规则污染后续手势 |
| `components/dashboard/tabs-rail.tsx` | 整个打开标签按钮被标为手柄，dragData.fromGroupId 固定为 -1 | 拆出独立手柄，携带真实 groupId，保留打开标签按钮 |
| `components/dashboard/content.tsx` | 书签原项隐藏并显示虚线占位；集合带状目标包含多个虚拟行 | 保留行高度；按逻辑集合统一高亮、去重 |
| `components/dashboard/bookmark-card.tsx` | 预览复用有 store 订阅的完整卡片；工具栏通过 max-width 展开 | 纯展示预览；工具栏固定空间，不挤压标题 |
| `lib/bookmark-utils.ts`、`lib/types.ts` | 书签按规则排序，没有手动 position | 使用容器高亮，不能用插入线暗示可指定顺序 |
| `store/bookmarks-store.ts`、`store/groups-store.ts` | 部分写操作返回 void；配额会提前返回，saved group 创建失败可返回空 ID | 松手不等于成功，执行后检查实际本地结果 |

这些是静态代码观察，不是浏览器帧率、动画效果或性能测量结果。

## 3. 方案选择

| 方案 | 收益 | 成本/限制 |
|---|---|---|
| **A：现有 dnd-kit + 集中落点策略 + 轻量 CSS/WAAPI（采用）** | 适配现有虚拟列表；统一业务和视觉判断；不新增依赖 | 需要补充业务执行结果与结束反馈生命周期 |
| B：只调整透明度、阴影和 transition | 改动小，适合局部视觉修整 | 无法解决无效目标、空白解除分组和虚假成功反馈 |
| C：替换拖放引擎或整体引入 Motion | 可以采用其他布局/拖动能力 | 迁移范围大；无法自动解决业务语义；本轮没有对应需求 |

视觉采用 Notion/BlockNote 的手柄和克制悬浮；操作语义采用 Atlassian 的“容器高亮表示放入、线表示相对位置”的区分。只借鉴交互原则，不声称复制这些产品的内部动画参数。

## 4. 拖放语义

### 4.1 操作矩阵

| 来源 | 目标 | 结果 | 源项 |
|---|---|---|---|
| 活跃书签 | 另一活跃集合 | 移动书签 | 可能因筛选而离开当前视图 |
| 活跃书签 | 当前所属集合 | 无改动，提示“已在此收藏集” | 保留 |
| Tab / 浏览器标签组 | 活跃集合 | 保存书签，使用现有严格重复规则 | 浏览器 Tab/组保留 |
| Tab | 另一浏览器标签组 | 加入目标组 | 浏览器 Tab 被移动 |
| Tab | 当前浏览器标签组 | 无改动 | 保留 |
| Tab / 浏览器标签组 | 活跃 saved group 详情 | 保存到已有组，保留现有按原始 URL 去重语义 | 浏览器源保留 |
| 浏览器标签组 | 侧栏“已保存标签组”区域 | 创建 saved group 并保存组内 Tab | 浏览器源保留 |
| 已分组 Tab | 明确的解除分组区域 | 解除这个 Tab 的分组 | Tab 保留 |
| 任意来源 | 空白、已移除/不可用目标、不支持的组合 | 不执行写入 | 保留 |

All Bookmarks 及内容区已有的 `all` 别名继续解析为当前工作区 Default collection；缺少有效 Default 时拒绝，不将 `"all"` 写入 collectionId。当前“未分类”集合带使用 `all` 别名的兼容行为保留，操作预告必须显示实际 Default collection 的名称，避免标签与落点不一致。

书签来源必须仍在 active bookmarks，且来源和目标的集合/工作区都可见。Tab 来源在执行时重新查询浏览器；TabsRail 中来自其他窗口的 Tab 仍可保存，不能仅用当前窗口 openTabs 判断其存在。浏览器分组操作是否可执行以真实浏览器 API 为准，不新增未验证的跨窗口保证。

### 4.2 单一策略与执行边界

新增 `lib/drag-and-drop/types.ts`、`drop-policy.ts`、`execute-drop.ts`：

- `DragData` 保留现有三种 payload；对象形状改用 interface，原 provider 可重导出类型保持导入兼容。
- `DragSession`：`id: number`、`sourceWorkspaceId: string`、`data: DragData`。一次启动分配一个单调递增 ID。
- `DropTarget`：可辨识联合，kind 为 `collection`（collectionId）、`chrome-group`（groupId:number）、`saved-group`（groupId:string）、`save-group` 或 `ungroup`。
- `DropSnapshot`：现有 workspace、collection、bookmark Map、saved group/groupTabs、browser tab/group 的只读引用。拖动中不复制整个书签库，不在 selector 中派生数组。
- `DropDecision`：`allowed` 携带 `targetKey`、`targetLabel`、`intent`；`noop` 携带 same-target 原因；`blocked` 携带 unsupported、source-unavailable、target-unavailable 或 workspace-changed 原因。
- `DropIntent`：move-bookmark、save-tabs、join-group、append-saved-group、save-group、ungroup-tab；payload 仅包含执行所需实体身份和已解析目标，不携带 React/DOM 节点。
- `DropResult`：`status: "applied" | "partial" | "noop" | "blocked" | "failed"`、`appliedCount: number`、`skippedCount: number`、`bookmarkIds: readonly string[]`，可选 `savedGroupId: string`、`reason: "same-target" | "duplicate" | "quota" | "source-unavailable" | "target-unavailable" | "workspace-changed" | "browser-error"`。

固定入口：

```ts
parseDropTarget(dropId: string): DropTarget | null;
resolveDrop(session: DragSession, target: DropTarget, snapshot: DropSnapshot): DropDecision;
readDropSnapshot(): DropSnapshot;
executeDrop(session: DragSession, target: DropTarget): Promise<DropResult>;
```

parseDropTarget 复用 `lib/drop-ids.ts`，严格解析浏览器组 ID，新增唯一 ID `tabs-ungroup`。畸形 ID 返回 null。targetKey 对同集合所有虚拟行和侧栏别名一致。

碰撞检测先排除不支持、不可见、same-target 和已失效候选，再在有效候选中运行 pointerWithin；指针仍在某个已注册但不可接收的区域时返回无有效目标，不能穿透它选中后方集合。只有指针位于注册区域之间的空隙时才使用 rectIntersection 回退。ungroup 必须由指针真正进入区域，禁止矩形相交回退触发。键盘采用已选择的有效目标，不依赖 pointerWithin。

策略只判断结构资格，不在每帧搜索重复书签或请求配额。执行器重新读取状态、重新校验来源/目标，再调用现有 action。需要 await 浏览器查询时，在查询完成后、写入前再次检查工作区与来源/目标。普通工作区/路由切换结束本次拖动，不允许自动把旧来源送进新工作区。

执行结果遵守现有去重和配额：

- addBookmarks 后按本次生成 ID 检查 Map；未添加则无成功反馈，配额提示仍由 QuotaAlert 负责。
- updateBookmark 后确认活跃记录处于目标集合；不借该 action 的归档/回收站回退路径移动非活跃来源。
- createGroup 返回空 ID 时立即结束，不追加 tabs；追加 saved-group 前后比较 URL 集合，已存在项记入 skippedCount。
- 严格重复检测只在执行阶段进行；组内新候选也加入本次去重集合，避免同一批输入重复保存。部分保存返回 partial，展示“保存 N 项，跳过 M 项”，保留现有重复项定位能力。
- 浏览器 action 的 rejection 返回 failed 并安排静默刷新；失败不宣称已回滚。若 action 已改变浏览器但后续刷新失败，提示无法确认结果，让刷新后的真实状态呈现。
- applied 表示本地内存写入已接受或浏览器 API 已完成，不表示 IndexedDB/服务器同步已确认；本轮不改变 store 的持久化契约。

## 5. 输入与键盘

### 5.1 指针规则

| 输入 | 手柄 | 卡片正文 |
|---|---|---|
| 鼠标/笔 | 移动 4px 启动 | 移动 6px 启动 |
| 触摸 | 长按 250ms，容差 5px | 保留原生滚动，不启动拖动 |

只有手柄使用 touch-action:none，正文不整块禁用滚动。SmartPointerSensor 的实例构造阶段复制 options 并选择本次约束；activator 只检查输入与目标，不修改共享配置。菜单、Dialog、input/textarea/select、可编辑区域、链接、非手柄按钮及 checkbox 的按压不启动拖动。

书签和 Tab 手柄均为独立 `button type="button"`，连接 setActivatorNodeRef、attributes 和键盘 listeners；正文保留 pointer listener。TabsRail 外层改为非按钮容器，内容打开按钮与手柄为兄弟节点，不能嵌套 button。携带浏览器实际 groupId，取消硬编码 -1。

### 5.2 键盘与焦点

使用现有包的 KeyboardSensor，加一个只允许手柄触发的 activator 和目标坐标 getter，不引入 sortable 的相对排序语义。

- 手柄获得焦点后 Space/Enter 启动；方向键按文档顺序在有效逻辑目标之间切换，前进为 Down/Right，后退为 Up/Left；到边界停留，不循环。
- 同集合多个 band/侧栏候选按 targetKey 去重；优先侧栏集合，其次内容区 header，最后 band。忽略断开、无尺寸、隐藏、不可接收节点。
- 为选中候选滚动至可见并重新测量；坐标为候选中心相对当前 collisionRect 中心的位移。滚动使用 auto，减少目标坐标和视觉的竞态。
- Space/Enter 提交当前目标；没有目标时不执行写入；Escape 或 Tab 取消。取消消耗本次按键并恢复焦点，再次按 Tab 才继续正常焦点导航，操作说明明确这一点。
- KeyboardSensor 的公开 keyboardCodes 配置为 start/end=[Space,Enter]、cancel=[Escape,Tab]，scrollBehavior=auto。只定制静态 activator，不覆写其 private 方法；原生 cancel 路径会 preventDefault，防止同一次 Escape 清空多选。非拖动时现有 Escape 清空规则保留。
- PointerSensor 的 Escape 路径没有相同的 preventDefault 保证，因此 provider 在 active session 期间增加 ownerDocument 的 keydown 捕获监听：Escape 只 preventDefault，不 stopPropagation，让 sensor 继续取消、window 上的 selection listener 跳过。程序化取消同样走此路径，先取消 sensor 再清空 session。
- 取消/拒绝后优先恢复源手柄焦点；移动导致源卸载时，聚焦实际目标的现有按钮/链接（必要时给目标容器 tabIndex=-1）。不跳转页面或改变筛选来追踪落点。
- provider 内一处持久 live region 宣告启动、目标改变、完成/跳过/失败/取消，支持执行 Promise 完成后的异步播报；dnd-kit 的重复 announcements 返回空字符串，screenReaderInstructions 提供本地化操作说明。只在语义状态变化时播报，指针移动和同集合 band 切换不重复播报。

解除分组区域由 provider 常驻注册、仅在拖动已分组 Tab 时显示，固定在 TabsRail 左侧相邻的 dashboard 内容区域底部，避免占用虚拟列表布局；窄屏允许固定在内容区底部。它有独立 label、背景和边框，键盘同样可达。原 UngroupedSection 在 tabs.length=0 时会卸载，因此不能把唯一解除分组目标放在那里。

## 6. 视觉与生命周期

### 6.1 动效参数

CSS 令牌定义在 `assets/globals.css`；JS 动画读取对应 CSS 自定义属性，避免两套时长漂移。

| 令牌 | 值 | 用途 |
|---|---|---|
| `--dashboard-motion-hover` | 120ms | 背景、边框、操作区 opacity |
| `--dashboard-motion-press` | 80ms | 局部操作按钮按下 |
| `--dashboard-motion-settle` | 160ms | 接受拖放后预览收起 |
| `--dashboard-motion-return` | 180ms | 取消/拒绝后返回源项 |
| `--dashboard-motion-flash` | 600ms | 实际成功目标背景淡出 |
| `--dashboard-motion-ease` | cubic-bezier(0.2, 0, 0, 1) | 上述过渡 |

预览跟手不加 transition、spring 或惯性。拖动目标使用 primary 色低透明度背景和 1px 边框/outline，不放大目标，不新增布局间隙。原项统一 opacity:0.4 并保留占位高度；不再用书签虚线空框代替内容。

纯展示 DragPreview 只接受 payload 和 t，使用 FaviconImage，不订阅业务 store、不挂载菜单/checkbox、不发请求获取元数据。书签 grid/gallery 用统一紧凑预览：favicon、标题、host，宽 240px、最大宽 calc(100vw - 32px)，不复刻整张 gallery 封面。不旋转、不加黑色遮罩，opacity:0.96，使用轻阴影。标签组显示名称和数量。

预览下方显示操作预告：允许目标展示对应动词和实际目标名；无有效目标显示“松开取消”。对 same-target 的指针悬浮显示无改动说明，但不显示允许放置的高亮。预告为视觉文本，重复读屏信息由 live region 合并。

### 6.2 独立的结束反馈

继续关闭 dnd-kit 默认 dropAnimation；由 `DropFeedbackLayer` 处理业务结束效果，避免默认回原位与跨集合写入冲突，也避免依赖已经卸载的 draggable。

onDragEnd 在任何写入前捕获当前预览 rect、源节点身份和当前源 rect、逻辑目标与目标锚点 rect。将 payload 和几何快照保存在内存反馈状态，再清理 activeData。快照不是 cloneNode，不包含 DOM 内容拷贝和持久数据。

| 结果 | 预览 | 目标与说明 |
|---|---|---|
| 已接受本地操作 | 160ms 内 opacity→0、scale→0.98；不飞向可能不对应卡片的集合 header | 仅在 result.appliedCount>0 时高亮实际目标 600ms |
| 浏览器异步操作待完成 | 松手即按同样规则收起，不等待网络式长动画 | live region 宣告处理中；完成后再高亮，失败显示 Alert |
| 取消、无效、same-target、策略阶段被拒绝 | 源节点仍挂载时 180ms 返回其当前 rect，再恢复原项；否则原地淡出 | 无成功高亮；必要时解释无改动原因 |
| 已接受的操作在执行阶段被配额或最新状态拦截 | 已开始的收起继续结束，不倒放或重建已消失预览 | 无成功高亮，显示对应解释，配额交给 QuotaAlert |
| 部分成功 | 按成功收起 | 目标高亮；使用一个 Alert 显示成功和跳过数量 |

成功不自动调用 revealBookmark，不滚动到新书签，不要求新实体必须在排序后的当前虚拟窗口中挂载。完成反馈通过 context 的 `completedTargetKey: string | null` 和 `completedDropId: string | null` 同时记录逻辑目标和实际选中的 droppable ID：多处表示只高亮该 ID；执行后同 ID 重挂载可以在本次 600ms 窗口内消费反馈，过期后不重放。

组件使用 WAAPI，仅动画 fixed 反馈层内节点的 transform/opacity；源 DOM、目标 DOM 和虚拟行定位 transform 不由它接管。返回目的地在播放前读取一次；播放期间发生滚动/resize、节点卸载则终止位移动画并淡出。API 不可用时直接完成清理。

返回动画期间记录 returningSourceId，将对应原项临时隐藏但保留布局，反馈结束/中断即恢复；避免原卡片已经恢复不透明而返回预览再次覆盖的重影。它只用于展示，不修改业务 store 或选择状态。

每个反馈由 session ID 管理，动画、定时器、Promise 完成回调都校验 ID。新拖动清理旧视觉反馈；有业务执行未完成时只禁止新拖动，其他按钮仍可用。路由/工作区变更、窗口失焦、页面隐藏或 provider 卸载取消未提交手势并清理视觉资源。对已经启动的指针/键盘 sensor，取消通过 ownerDocument 的 Escape 事件进入其正常清理路径，不能只清空 React 状态；对应事件不得落入多选清空处理。已提交操作不能因清理而回滚；旧工作区的迟到结果不能向当前工作区显示高亮或通知。

## 7. 悬浮、点击和减少动态效果

- BookmarkCard 为收藏/复制预留固定 56px 操作区，hover 或 focus-within 时淡入；隐藏时不接收指针，键盘聚焦时立即显示。gallery 标题仍为两行，grid 仍为单行。
- 拖动期间隐藏无关操作工具栏与 Tooltip（包括 portal），菜单开启时锁定原操作区；按钮可访问名称不依赖 Tooltip。document 上的临时 data 属性由 provider 设置并在 cleanup 删除。
- 集合标题移除 hover/drop scale 和叠加大阴影，保留低对比背景、边框及 chevron 的 transform 过渡。
- `.dashboard-action` 只应用到本轮涉及的书签/Tab 工具按钮和侧栏新增按钮；按下 scale:0.97，抬起回到 1。导航项/整张卡片不缩放；不全局改写所有 Button 或 Dialog。
- 收藏保持立即切换填充，复制保持现有勾选/提示；本轮不加图标弹跳，也不改变业务成功判定。
- `hooks/use-reduced-motion.ts` 订阅 matchMedia，含初始值、变更和清理；只供自定义 WAAPI 使用。CSS 通过 prefers-reduced-motion 关闭 dashboard 的缩放、位移和脉冲，保留即时背景、边框、焦点环与状态说明。
- 偏好在动画播放中改为 reduce 时立即取消位移并完成清理；JS 和 CSS 都不能只在首次挂载读取偏好。现有 bookmark 定位/重复提示的缩放 pulse 在 reduce 下关闭，相关高亮颜色保留。

## 8. 实现边界与约束

| 单元 | 职责 |
|---|---|
| `lib/drag-and-drop/types.ts` | 共享的领域类型；无 React、store 和 DOM 导入 |
| `lib/drag-and-drop/drop-policy.ts` | drop ID 解析与纯资格判断；不做持久化或 API 调用 |
| `lib/drag-and-drop/execute-drop.ts` | 获取最新 snapshot、重校验、调用已有 store action、汇总真实结果 |
| `lib/drag-sensors.ts` | 本次指针约束与手柄限定的键盘 sensor |
| `lib/drag-and-drop/keyboard-coordinates.ts` | 有效逻辑目标去重、键盘顺序与坐标 |
| `components/dashboard/drag-and-drop/drag-preview.tsx` | 纯展示预览与操作预告 |
| `components/dashboard/drag-and-drop/drop-feedback.tsx` | 几何快照、WAAPI 结束反馈、资源清理；导出反馈所需类型 |
| `components/dashboard/drag-and-drop/ungroup-drop-zone.tsx` | 常驻注册的解除分组目标 |
| `components/dashboard/tabs-dnd-provider.tsx` | session 生命周期、碰撞筛选、公共 context、执行协调和通知 |
| `hooks/use-reduced-motion.ts`、`assets/globals.css` | 动效偏好与限定范围的视觉令牌/样式 |

全局约束（计划原文复用）：

- 只修改 TabSlate 前端；不修改 TabSlate-server、TabSlate-cloud、API、IndexedDB schema 或同步模型。
- 保留 @dnd-kit/core 6.x；不新增 Motion、拖拽引擎或其他运行时依赖；依赖管理只用 Bun。
- TypeScript 使用 strict、interface 对象形状、具名组件导出；不新增 any，避免 as 和非空断言，if 始终加花括号。
- Zustand 逐字段 selector，派生数据放 useMemo；高频列表的 callback props 使用 useCallback。
- favicon 使用 FaviconImage；浮动通知使用 Alert；复用 QuotaAlert，保持现有严格重复检测、集合排序与工作区可见性规则。
- 所有新用户可见文本通过 useTranslation 的 t()，同步维护 en、zh_CN 及 Chrome i18n placeholders。
- 虚拟列表定位、droppable 测量和动效分层；不对虚拟行定位节点添加布局动画，不在指针移动时写业务 store。
- 暂不增加手动排序、批量拖拽、标签层级拖拽或外部拖入；不删除未挂载的 groups-panel。
- 只暂存和提交本任务的明确文件；不包含其他会话的未提交改动，不推送或创建 PR。

新增文案使用 `dashboardDnd_` 前缀。固定文案：moveToCollection（“移动到「$1」” / “Move to ‘$1’”）、saveToCollection（“保存到「$1」” / “Save to ‘$1’”）、joinGroup（“加入「$1」” / “Join ‘$1’”）、saveToGroup（“保存到标签组「$1」” / “Save to group ‘$1’”）、saveGroup（“保存此标签组” / “Save this tab group”）、ungroup（“解除分组” / “Ungroup”）、releaseToCancel（“松开取消” / “Release to cancel”）、alreadyInTarget（“已在此位置” / “Already here”）、processing（“正在处理拖放…” / “Applying drop…”）、failed（“无法确认拖放结果，正在刷新标签页” / “Could not confirm the drop result. Refreshing tabs.”）、cancelled（“已取消拖动” / “Drag cancelled”）、savedSummary（“已保存 $1 项，跳过 $2 项” / “Saved $1 items; skipped $2”）。手柄名称、键盘说明和完成播报也使用该前缀，按语义而非 DOM 位置命名。

## 9. 验收与验证

自动验证覆盖业务与资源生命周期；不写只断言 Tailwind 类名的动画测试。happy-dom 不提供真实布局或渲染帧，动画几何使用显式 rect/WAAPI fake，实际手感必须浏览器验收。

1. 纯策略：矩阵、别名、same-target、畸形 ID、跨工作区和来源/目标失效；包含空集合及同集合多 band。
2. 执行：空白无写入、严格重复与批内重复、部分保存、配额提前返回、空 saved group ID、源归档/删除、await 期间目标退休、Chrome rejection。
3. 输入：连续多次正文/手柄交替不污染约束；普通点击/checkbox/菜单/表单不触发；触摸正文保留滚动。
4. 键盘：手柄启动、逻辑目标去重/切换、提交/取消、无目标、Tab 退出、Escape 不误清选择、源卸载后的焦点恢复与播报。
5. 反馈：源卸载后仍能收起；reduce 开关变更；WAAPI 缺失；新 session、路由/工作区切换、卸载与迟到 Promise 不留下悬浮层或错误高亮。
6. Chrome/Edge/Firefox 手工检查 grid/gallery、浅色/深色、长标题、折叠集合、空集合、跨窗口 Tab、长列表滚动、快速开始/取消、键盘全流程与 reduce。
7. 性能：同一设备、同一生产构建方式、同一份本地 1,000 书签数据，在改动前后分别录制 10 秒拖动并跨越多个集合/滚动。记录主线程长任务、布局/绘制和 React commits；拖动跟手不得新增持续 transform 过渡，不要求未测量的固定帧率承诺。发现长任务则定位本次新增调用，区分已有成本。

完成条件：定向 Bun 测试、`bun run compile`、`bun run build`、`bun run build:firefox` 通过；浏览器验收有记录；正常成功、部分成功、无效、取消和执行失败均有一致且诚实的反馈。

## 10. 后续工作边界

批量拖动需独立设计 selection-store、view order 和一次批量更新的契约；手动排序需先设计顺序字段及同步，再加入插入线/让位动画；标签树拖动需结合独立的层级方案判断 before/after/inside。本轮不预建这些能力的空接口。

## 11. 参考依据

- [Notion：手柄与蓝色布局引导](https://www.notion.com/help/columns-headings-and-dividers)：支持明确落点的设计原则，不用于推断内部动画时长。
- [BlockNote：侧边菜单与 hover/drop 容差](https://www.blocknotejs.org/docs/react/components/side-menu)：参考手柄可发现性和操作容错。
- [Plate：拖放组件](https://platejs.org/docs/dnd)：参考可视落点与边缘滚动。
- [Atlassian：拖拽设计指南](https://atlassian.design/components/pragmatic-drag-and-drop/design-guidelines/)：参考线/容器高亮区分、源项淡化、完成提示。
- [dnd-kit legacy DragOverlay](https://dndkit.com/legacy/api-documentation/draggable/drag-overlay/)：与仓库 core 6.x 对应；默认 drop animation 不能代替业务结果反馈。
- [React Aria：可访问拖放](https://react-aria.adobe.com/dnd)：参考键盘、读屏与不同操作类型的完整覆盖。
- [Motion：减少动态效果](https://motion.dev/docs/react-accessibility)：参考保留状态信息、减少位移/缩放的原则，不引入依赖。

## 12. 自审记录

已检查范围、类型入口、操作矩阵、反馈时机与测试边界：没有把未挂载 GroupsPanel 纳入实施，没有将保存误写为浏览器源移动，没有把本地 applied 写成同步成功；结束动画不依赖源节点存活；部分成功、无配额、跨窗口来源和切换工作区后的迟到结果都有明确处理。文档仍待用户评审，不记录为已批准或已实测。

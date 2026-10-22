# Dashboard Drag and Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一 dashboard 单项拖放的触发、有效落点、真实执行结果与结束反馈，并稳定悬浮/点击、键盘和减少动态效果体验。

**Architecture:** 保留现有 dnd-kit core 6.x，用纯 drop policy 同时驱动碰撞筛选、目标高亮、操作预告和执行前重校验。执行器复用现有 store action 并检查实际结果；纯展示预览与独立 WAAPI 反馈层负责动画，保持虚拟列表的定位和测量结构。

**Tech Stack:** TypeScript、React 19、Zustand、WXT、Tailwind CSS、shadcn/Radix、@dnd-kit/core 6.x、Web Animations API、Bun test、happy-dom。

**Spec:** [Dashboard 拖拽与微交互设计](../specs/2026-10-23-dashboard-drag-and-motion-design.md)

**Status:** 待评审的实施计划；用户本次仅要求编写 design 和 plan。以下 checkbox 均为未来实施步骤，不代表测试已运行或实现已完成。

## Global Constraints

- 只修改 TabSlate 前端；不修改 TabSlate-server、TabSlate-cloud、API、IndexedDB schema 或同步模型。
- 保留 @dnd-kit/core 6.x；不新增 Motion、拖拽引擎或其他运行时依赖；依赖管理只用 Bun。
- TypeScript 使用 strict、interface 对象形状、具名组件导出；不新增 any，避免 as 和非空断言，if 始终加花括号。
- Zustand 逐字段 selector，派生数据放 useMemo；高频列表的 callback props 使用 useCallback。
- favicon 使用 FaviconImage；浮动通知使用 Alert；复用 QuotaAlert，保持现有严格重复检测、集合排序与工作区可见性规则。
- 所有新用户可见文本通过 useTranslation 的 t()，同步维护 en、zh_CN 及 Chrome i18n placeholders。
- 虚拟列表定位、droppable 测量和动效分层；不对虚拟行定位节点添加布局动画，不在指针移动时写业务 store。
- 暂不增加手动排序、批量拖拽、标签层级拖拽或外部拖入；不删除未挂载的 groups-panel。
- 只暂存和提交本任务的明确文件；不包含其他会话的未提交改动，不推送或创建 PR。

## Review Focus

1. 当前窗口以外的 TabsRail 来源，以及浏览器组在拖动中被关闭：不能把 openTabs 当作全部来源，或把失效来源保存成成功；由 Task 2 执行测试覆盖。
2. 同一收藏集的 header/band/侧栏别名，以及无效目标覆盖有效目标：不能重复播报或错误穿透；由 Task 1、3、5 测试覆盖。
3. addBookmarks 的配额提前返回、createGroup 的空 ID、部分重复输入：不能播放完整成功或产生孤儿项；由 Task 2 测试覆盖。
4. 移动使源节点卸载、快速连续拖动、reduce 在播放中变更：不能遗留预览或让旧动画清掉新反馈；由 Task 4 测试覆盖。
5. Escape/Space 与多选、打开标签按钮或 portal 菜单同时存在：必须只执行当前交互，焦点有落点；由 Task 3、5 测试覆盖。

## 执行方式与文件边界

建议评审通过后使用 `superpowers:executing-plans` 在同一实施会话顺序完成，原因是六个任务共享 policy、session 和反馈接口，顺序实现便于集中验证。若用户选择 subagent-driven，再按对应技能派发；本次文档撰写不派发实施代理。

实施时先读取仓库实际 AGENTS.md/CLAUDE.md、当前 git 状态与本设计。按 using-git-worktrees 的规则检查是否需要隔离，不复制其他方案中的旧分支、提交署名或服务器工作流约束。只提交明确路径。

开始 Task 1 前，在未改产品代码的生产构建上完成设计第 9 节的 1,000 书签、10 秒拖动/滚动基线录制，并记录浏览器/设备/构建方式；Task 6 只录制改动后的相同场景并对照。样本使用本机临时测试数据，录制不提交仓库。

| 文件 | 新增/修改 | 职责 |
|---|---|---|
| `lib/drag-and-drop/types.ts` | 新增 | 领域类型、session、decision/result |
| `lib/drag-and-drop/drop-policy.ts` | 新增 | parseDropTarget、resolveDrop |
| `lib/drag-and-drop/execute-drop.ts` | 新增 | readDropSnapshot、executeDrop |
| `lib/drag-and-drop/keyboard-coordinates.ts` | 新增 | 键盘逻辑目标选择 |
| `lib/drag-sensors.ts` | 修改 | 每次独立约束、交互元素排除、手柄键盘启动 |
| `lib/drop-ids.ts` | 修改 | tabs-ungroup 常量；保留已有 collection/saved-group 编码 |
| `components/dashboard/drag-and-drop/drag-preview.tsx` | 新增 | 纯展示预览与操作预告 |
| `components/dashboard/drag-and-drop/drop-feedback.tsx` | 新增 | 独立反馈层和 WAAPI 生命周期 |
| `components/dashboard/drag-and-drop/ungroup-drop-zone.tsx` | 新增 | 常驻注册的明确解除分组区域 |
| `components/dashboard/tabs-dnd-provider.tsx` | 修改 | 生命周期、碰撞策略、执行/反馈协调、live region |
| `components/dashboard/content.tsx` | 修改 | 书签原项、手柄、集合一致高亮 |
| `components/dashboard/bookmark-card.tsx` | 修改 | 语义手柄、固定工具栏、局部微交互 |
| `components/dashboard/tabs-rail.tsx` | 修改 | 独立打开按钮/手柄、实际 groupId |
| `components/dashboard/tabs-panel/draggable-tab.tsx` | 修改 | 语义手柄和指针入口 |
| `components/dashboard/tabs-panel/group-card.tsx` | 修改 | 策略驱动目标状态、标签组手柄 |
| `components/dashboard/shared/group-card-base.tsx` | 修改 | 明确类型的 button 手柄/ref props、目标反馈标记 |
| `components/dashboard/sidebar/index.tsx` | 修改 | 接收真实 decision、固定目标锚点 |
| `components/dashboard/group-detail/index.tsx` | 修改 | saved group 资格、目标锚点 |
| `hooks/use-reduced-motion.ts` | 新增 | 实时 matchMedia 订阅 |
| `assets/globals.css` | 修改 | dashboard 范围动效令牌、reduce 和 portal Tooltip 隐藏 |
| `entrypoints/newtab/App.tsx` | 修改 | Layout 标记 dashboard 动效作用域 |
| `public/_locales/{en,zh_CN}/messages.json` | 修改 | dashboardDnd_ 文案与 placeholders |
| `test/dashboard-*.test.{ts,tsx}`、`test/drag-sensors.test.ts` | 新增 | 各任务下列实际行为测试 |

`store/`、package.json、锁文件和服务端不是预定修改目标。执行器用后置条件确认 void action 的结果，不为本轮改变现有 store 公共返回类型。测试复用 `test/helpers/dom-environment.ts`、`module-replacer.ts`、`virtualizer.ts`；仅当 mock 表导致跨文件污染时使用已有 `runsInIsolatedProcess`，不搭建新测试框架。

---

### Task 1: 定义可测试的落点策略

**Files:**
- Create: `lib/drag-and-drop/types.ts`
- Create: `lib/drag-and-drop/drop-policy.ts`
- Modify: `lib/drop-ids.ts`
- Test: `test/dashboard-drop-policy.test.ts`
- Extend: `test/drop-ids.test.ts`

**Interfaces:**
- Consumes: 设计第 4 节的类型字段；已有 Workspace、Collection、Bookmark、SavedGroup、GroupTab、BrowserTab、BrowserTabGroup；现有 drop ID 函数。
- Produces: `DragData`、`DragSession`、`DropTarget`、`DropSnapshot`、`DropDecision`、`DropIntent`、`DropResult`；`parseDropTarget(dropId: string): DropTarget | null`；`resolveDrop(session: DragSession, target: DropTarget, snapshot: DropSnapshot): DropDecision`；`UNGROUP_DROP_ID = "tabs-ungroup"`。
- DropIntent 联合固定为：move-bookmark {bookmarkId, collectionId}；save-tabs {tabs: readonly BrowserTab[], collectionId}；join-group {tabId, groupId:number}；append-saved-group {tabs: readonly BrowserTab[], groupId:string}；save-group {group: TabGroupDragData}；ungroup-tab {tabId}。
- DropSnapshot 字段：activeWorkspaceId、workspaces、collections、bookmarks、groups、groupTabs、browserTabs、browserGroups；数组为 readonly，bookmarks 为 ReadonlyMap<string, Bookmark>。browserTabs 为所有窗口来源，不只当前 openTabs。

- [ ] **Step 1: 写失败的纯策略测试。** 使用 fixture 明确建立工作区 w1/w2、Default c0、普通集合 c1/c2、活跃/归档/删除父级、两个浏览器组和一个 saved group。逐项断言设计矩阵的 intent/status；`all` 解析 c0；不存在 Default 时 blocked；书签同集合 noop；已分组 Tab 仅 ungroup 目标可解除；unsupported 组合 blocked；同集合 row/header 得到相同 targetKey；工作区变化/source 不活跃 blocked；`group-drop-42x`、空 saved-group ID 返回 null。
- [ ] **Step 2: 运行失败用例。** `bun test test/dashboard-drop-policy.test.ts test/drop-ids.test.ts`；预期新模块/导出尚不存在导致失败，确认不是 fixture 或语法错误。
- [ ] **Step 3: 实现共享类型、严格 ID 解析和纯 resolveDrop。** 复用 workspace-visibility；保留 collection 的 suffix/all 行为；不搜索全库重复项、不请求配额、不写 store。Chrome 来源和目标只依据 snapshot，最终浏览器存在性留给执行器。
- [ ] **Step 4: 再次运行上述命令。** 预期全部通过；`bun run compile` 无新增类型错误。
- [ ] **Step 5: 提交此任务明确文件。** 消息：`refactor(dnd): centralize drop eligibility and intent`。

### Task 2: 执行结果与实际业务状态对齐

**Files:**
- Create: `lib/drag-and-drop/execute-drop.ts`
- Test: `test/dashboard-drop-execution.test.ts`

**Interfaces:**
- Consumes: Task 1 的全部领域类型、resolveDrop；现有 store actions、严格 duplicate lookup 和浏览器 API。
- Produces: `readDropSnapshot(): DropSnapshot`；`executeDrop(session: DragSession, target: DropTarget): Promise<DropResult>`。
- appliedCount 是实际新增/移动数，skippedCount 是重复跳过数；零新增的同目标为 noop/same-target，全部重复为 noop/duplicate，配额为 blocked/quota；结果字段与设计一致。

- [ ] **Step 1: 写失败的执行测试。** 用 real store + 受控 action/API fake，断言：移动前源被归档时 updateBookmark 未调用；目标在 Chrome query 的 await 期间退休时没有写入；其他窗口的 Tab 可以保存；Tab/组查询不存在时 blocked；addBookmarks 被配额拦截时 appliedCount=0；createGroup 返回空字符串后 addTabToGroup 从未调用；同批相同严格 URL 只新增一次；部分重复返回 partial 和准确计数；saved-group 的既有原始 URL 计入跳过；Chrome rejection 返回 failed；成功不以远端同步完成为条件。
- [ ] **Step 2: 运行 `bun test test/dashboard-drop-execution.test.ts`。** 预期模块缺失导致失败，mock 不能提前替代待测执行器。
- [ ] **Step 3: 实现执行器。** readDropSnapshot 返回 store 现有引用，浏览器列表合并 allTabs/openTabs 时仅按 ID 覆盖，不复制书签 Map。对 Tab/组执行前使用 chrome.tabs.get/query 校验并获取实时 payload，再读取 snapshot 重校验；saved group/collection 写入前最后检查工作区。复用 addBookmarks、updateBookmark、createGroup、addTabToGroup、moveTabsToGroup、ungroupSpecificTabs；按生成 ID、collectionId、组内 URL 的后置条件计算结果。catch 浏览器错误并静默刷新，绝不未经检查宣告成功。
- [ ] **Step 4: 运行 Task 1/2 两组测试及 `bun run compile`。** 预期全部通过。现有严格重复定位需继续设置相关 Tab/collection/bookmark highlight，测试断言仍只指向可见活跃实体。
- [ ] **Step 5: 提交两个新增文件。** 消息：`feat(dnd): report applied and rejected drop outcomes`。

### Task 3: 接入统一指针规则、目标状态和明确解除分组

**Files:**
- Modify: `lib/drag-sensors.ts`
- Modify: `components/dashboard/tabs-dnd-provider.tsx`
- Modify: `components/dashboard/content.tsx`
- Modify: `components/dashboard/tabs-rail.tsx`
- Modify: `components/dashboard/tabs-panel/draggable-tab.tsx`
- Modify: `components/dashboard/tabs-panel/group-card.tsx`
- Modify: `components/dashboard/sidebar/index.tsx`
- Modify: `components/dashboard/group-detail/index.tsx`
- Create: `components/dashboard/drag-and-drop/ungroup-drop-zone.tsx`
- Modify: `public/_locales/en/messages.json`, `public/_locales/zh_CN/messages.json`
- Test: `test/drag-sensors.test.ts`, `test/dashboard-dnd-provider.test.tsx`

**Interfaces:**
- Consumes: Task 1 policy/targetKey，Task 2 executeDrop/readDropSnapshot。
- Produces: 保留 `useTabsDndContext()` 的 activeData 和 overCollectionId；增加 `session: DragSession | null`、`decision: DropDecision | null`、`activeTargetKey: string | null`、`isDragDisabled: boolean`、`completedTargetKey: string | null`、`completedDropId: string | null`、`returningSourceId: string | null`。反馈三字段在 Task 4 才产生非空值；targetKey 标识逻辑目标，drop ID 限制只有实际命中表示播放完成高亮，source ID 控制返回期间原项展示。
- `SmartPointerSensor` 构造参数使用 `ConstructorParameters<typeof PointerSensor>[0]`；导出 `getDragActivationConstraint(pointerType: string, isHandle: boolean): PointerActivationConstraint | null`；null 表示触摸正文不允许拖动。
- 新组件 `UngroupDropZone()` 常驻于 provider；只有 activeData.type=tab 且实时 fromGroupId!=-1 时可见/可接收。

- [ ] **Step 1: 写失败的输入与 provider 测试。** helper 断言鼠标/笔手柄 distance=4、正文 distance=6、触摸手柄 delay=250/tolerance=5、触摸正文 null；同一个 sensor 配置顺序经过手柄/正文仍保持各自规则。真实 activator 测试覆盖菜单/Dialog portal、input、链接、普通按钮、checkbox，以及允许的手柄 button。provider 事件 harness 断言空白松手不调用 ungroup；只有 tabs-ungroup 调用；无效已注册目标上不穿透到集合；同集合 band 切换不改变逻辑目标；另一工作区来源禁止提交。
- [ ] **Step 2: 运行 `bun test test/drag-sensors.test.ts test/dashboard-dnd-provider.test.tsx`。** 预期新接口及旧行为断言失败。provider 测试可用类型准确的 DndContext harness 发起 start/over/end/cancel，不能用 stub 代替 policy；真实 hit test/滚动另由 Task 6 浏览器验收。
- [ ] **Step 3: 修改 sensor 与 draggable 入口。** 不在 activator 修改共享 options；保留正文 pointer listener，交互控件排除；TabsRail 查询映射 WindowTab.groupId 并写入 dragData。先接入独立手柄的 DOM/ref，完整键盘语义在 Task 5 完成。将 touch-none 从整个 Tab 外层移到手柄。
- [ ] **Step 4: 接入 provider 和目标组件。** 生成 session；按设计先判断所有注册命中区域，再筛选可接收候选；只有真正空隙用 rectIntersection，ungroup 不回退；所有高亮读取 decision/activeTargetKey。删除 onDragEnd 的 no-over 解除分组分支，执行统一 executeDrop。添加明确 ungroup 区域；内容虚拟行定位/droppable 保持分层；有执行在途时禁止新拖动。active session 时的 document 捕获监听对 Escape preventDefault 但不 stopPropagation；测试同时断言指针 Escape 取消且不清 selection。
- [ ] **Step 5: 补齐此任务文案并运行测试与编译。** 加入 move/save/join/ungroup/releaseToCancel/alreadyInTarget/processing/failed/savedSummary，正文采用设计第 8 节固定值与 placeholders。`bun test test/drag-sensors.test.ts test/dashboard-dnd-provider.test.tsx test/dashboard-drop-policy.test.ts test/dashboard-drop-execution.test.ts test/drop-ids.test.ts`；`bun run compile`；预期全部通过。
- [ ] **Step 6: 提交此任务明确文件。** 消息：`feat(dnd): unify activation and explicit drop targets`。

### Task 4: 纯展示预览与独立结束反馈

**Files:**
- Create: `components/dashboard/drag-and-drop/drag-preview.tsx`
- Create: `components/dashboard/drag-and-drop/drop-feedback.tsx`
- Create: `hooks/use-reduced-motion.ts`
- Modify: `components/dashboard/tabs-dnd-provider.tsx`
- Modify: `components/dashboard/content.tsx`
- Modify: `assets/globals.css`
- Test: `test/dashboard-drop-feedback.test.tsx`, `test/use-reduced-motion.test.tsx`

**Interfaces:**
- Consumes: DragData、DragSession、DropDecision、DropResult；Task 3 的 session/decision/context。
- Produces: `DragPreview({data, instruction}: DragPreviewProps)`；props 为 data:DragData、instruction:string。
- `DropFeedbackSnapshot` 字段：sessionId:number、sourceId:string、data:DragData、previewRect:DOMRectReadOnly、sourceElement:HTMLElement|null、sourceRect:DOMRectReadOnly|null。sourceId 是实际 draggable ID；snapshot 在任何业务写入前捕获，sourceElement 仅供验证连接/当前 rect，不持久化。
- `DropFeedbackLayer({snapshot, mode, reducedMotion, onComplete}: DropFeedbackLayerProps)`；snapshot:DropFeedbackSnapshot|null、mode:"settle"|"return"、reducedMotion:boolean、onComplete:(sessionId:number)=>void。
- `useReducedMotion(): boolean`；provider 记录实际 targetKey、droppable ID 和反馈到期时间，完成后 600ms 过期。

- [ ] **Step 1: 写失败的生命周期测试。** 显式 fake getBoundingClientRect 和 HTMLElement.animate 返回的 Animation，断言 source 在 executeDrop 后卸载仍能收起；return 读取源当前 rect；源不连接时只淡出；scroll/resize 中断位移；matchMedia 初始 reduce、变更和 cleanup；无 WAAPI 直接清理；旧 session 动画/600ms timer 不清除新 session；pending Chrome 操作跨工作区完成时不显示成功高亮；本地配额拒绝没有完成高亮；部分成功高亮并显示准确摘要。
- [ ] **Step 2: 运行 `bun test test/dashboard-drop-feedback.test.tsx test/use-reduced-motion.test.tsx`。** 预期模块未实现失败。fake 必须显式完成/取消动画，不能依赖真实时间等候。
- [ ] **Step 3: 实现纯预览和偏好 hook。** 三种 payload 使用 FaviconImage，固定 240px/max viewport 宽，opacity=.96、无旋转；不 import BookmarkCard/store。hook 监听 matchMedia change 并清理。CSS 写入设计第 6 节全部固定令牌，WAAPI 从 computed style 读取毫秒值。
- [ ] **Step 4: 实现反馈层并接入 provider。** 结束时先捕获 preview/source rect，再清 activeData/写业务数据；保留 DragOverlay dropAnimation=null。accepted settle 160ms、return 180ms、flash 600ms，easing=cubic-bezier(0.2,0,0,1)。业务 Promise 不阻塞预览收起；依据真实结果设置 completedTargetKey/completedDropId/Alert，执行阶段拦截不重建已经收起的预览。source 拖动时统一 .4 opacity，返回阶段按 returningSourceId 临时隐藏并在完成/中断恢复，避免重影；去除虚线替代框。不向收藏集 header 播放空间飞行，不自动 reveal/导航。
- [ ] **Step 5: 完成清理守卫。** route/workspace 变化、blur、visibilitychange、卸载均终止未提交手势并清理动画/timer/data 属性；已经激活的 sensor 通过 ownerDocument 的 Escape 事件进入自身正常清理路径（含防止选择状态误清），不能只 setActiveData(null)。提交后的副作用继续完成，但回调先校验 session/workspace。临时禁止新拖动直到 executeDrop settle；Promise rejection 也必须释放锁。reduce 中途切换立即结束位移。scroll/resize 使用单个层级监听，不为每张卡片增加监听。
- [ ] **Step 6: 运行 Task 1–4 的定向测试与 `bun run compile`。** 预期全通过；测试只验证结果与清理，不用 className 快照证明动画手感。
- [ ] **Step 7: 提交本任务明确文件。** 消息：`feat(dnd): add outcome-aware drag completion feedback`。

### Task 5: 键盘、焦点和稳定微交互

**Files:**
- Create: `lib/drag-and-drop/keyboard-coordinates.ts`
- Modify: `lib/drag-sensors.ts`
- Modify: `components/dashboard/tabs-dnd-provider.tsx`
- Modify: `components/dashboard/bookmark-card.tsx`
- Modify: `components/dashboard/content.tsx`
- Modify: `components/dashboard/tabs-rail.tsx`
- Modify: `components/dashboard/tabs-panel/draggable-tab.tsx`
- Modify: `components/dashboard/tabs-panel/group-card.tsx`
- Modify: `components/dashboard/shared/group-card-base.tsx`
- Modify: `components/dashboard/sidebar/index.tsx`
- Modify: `components/dashboard/group-detail/index.tsx`
- Modify: `entrypoints/newtab/App.tsx`
- Modify: `assets/globals.css`
- Modify: `public/_locales/en/messages.json`, `public/_locales/zh_CN/messages.json`
- Test: `test/dashboard-dnd-keyboard.test.tsx`, `test/dashboard-keyboard-coordinates.test.ts`
- Regression: `test/selection-scope.test.tsx`, `test/bookmark-form.test.tsx`, `test/library-visible-filters.test.tsx`

**Interfaces:**
- Consumes: resolveDrop、parseDropTarget、readDropSnapshot、isDragDisabled 与反馈状态；现有 dnd-kit KeyboardCoordinateGetter 类型。
- Produces: `createDragKeyboardCoordinates(getSession: () => DragSession | null, getSnapshot: () => DropSnapshot): KeyboardCoordinateGetter`；`SmartKeyboardSensor extends KeyboardSensor`，限定 activator 只接受 data-drag-handle 的 button。
- group-card-base 的 dragHandleProps 改为 React.ButtonHTMLAttributes<HTMLButtonElement>，dragRef 为 React.Ref<HTMLButtonElement>，dropRef 为 React.Ref<HTMLDivElement>；只为本轮实际传入的其余 HTML props 定义类型，不扩展新的 any 索引签名。

- [ ] **Step 1: 写失败的键盘行为测试。** 按设计第 5.2 节断言 Space/Enter 手柄启动、其他按钮不启动；Down/Right 前进、Up/Left 后退且边界停留；同集合 sidebar/header/row 只选一次，优先 sidebar；hidden/disconnected/blocked 候选跳过；Tab 退出、Escape 取消保留已有 selection；移动源卸载后焦点落到目标；原按钮不会因此打开书签或切换浏览器 Tab。live region 仅在语义变化时更新，异步 applied/partial/failed 都能播报。
- [ ] **Step 2: 运行 `bun test test/dashboard-dnd-keyboard.test.tsx test/dashboard-keyboard-coordinates.test.ts`。** 预期缺失模块/未接入键盘导致失败。
- [ ] **Step 3: 实现坐标 getter 与手柄键盘 sensor。** 从当前注册且有效的 target 依文档顺序去重，按设计选择代表节点；必要时 scrollIntoView({block:"nearest",behavior:"auto"}) 并重新获取 rect。以目标中心/当前 collisionRect 中心计算 delta，不使用 sortable 让位逻辑。通过公开 keyboardCodes 设置 start/end=[Space,Enter]、cancel=[Escape,Tab]，scrollBehavior=auto；只覆盖静态 activator，不覆盖 KeyboardSensor 的 private 方法。取消消耗本次按键并恢复焦点，下次 Tab 正常导航；原 cancel 路径的 preventDefault 防止 Escape 误清 selection。
- [ ] **Step 4: 完成语义手柄、焦点与播报。** 将所有实际入口连接 setActivatorNodeRef 和 button attributes；隐藏手柄在 focus-within 显示；TabsRail 内容按钮与拖动按钮为兄弟节点。provider 增加持久 role=status/aria-live=polite 文本区，禁用重复默认 announcements，提供本地化 screenReaderInstructions。焦点恢复不改变路由/筛选；若目标消失，聚焦当前 dashboard 主内容的可聚焦容器。
- [ ] **Step 5: 应用局部视觉样式。** BookmarkCard 收藏/复制固定 56px，不再 max-width 动画，hover/focus-within 淡入、不可见时禁用 pointer；保留可访问名称、复制和收藏状态。集合标题去除 scale/大阴影；本轮工具按钮应用 dashboard-action，80ms scale .97；普通 hover 120ms。Layout 添加 data-dashboard-motion；拖动临时标记抑制 portal Tooltip/无关工具栏，cleanup 必须恢复。reduce 下关闭本轮位移、缩放和 bookmark pulse，保留静态高亮/焦点，不全局重写 Button 或 Dialog。
- [ ] **Step 6: 运行键盘两组测试及现有 selection/form/visible-filters 回归，随后 `bun run compile`。** 预期全部通过。工具栏宽度、字形截断和真实键盘滚动留到浏览器验证，不写 CSS 类名断言代替。
- [ ] **Step 7: 提交此任务明确文件。** 消息：`feat(dnd): support keyboard drag and stable dashboard motion`。

### Task 6: 综合验证、性能对照与交付记录

**Files:**
- Modify: 本计划的“实施验证记录”章节，仅记录实际执行结果。
- Fix only: 前述任务涉及且被真实失败定位到的文件。

**Interfaces:**
- Consumes: Task 1–5 实现；设计第 9 节验收矩阵。
- Produces: 可审阅的测试结果、浏览器验收和前后性能记录；无新产品接口。

- [ ] **Step 1: 运行完整定向测试。** `bun test test/dashboard-drop-policy.test.ts test/drop-ids.test.ts test/dashboard-drop-execution.test.ts test/drag-sensors.test.ts test/dashboard-dnd-provider.test.tsx test/dashboard-drop-feedback.test.tsx test/use-reduced-motion.test.tsx test/dashboard-dnd-keyboard.test.tsx test/dashboard-keyboard-coordinates.test.ts test/selection-scope.test.tsx test/bookmark-form.test.tsx test/library-visible-filters.test.tsx`。预期所有用例通过且确实有测试执行。出现共享 mock 污染先定位并使用已有隔离 helper，不把它当作业务修复。
- [ ] **Step 2: 运行静态与构建检查。** 依次 `bun run compile`、`bun run build`、`bun run build:firefox`；预期 exit 0。只读计划阶段不要求运行这些命令，实施完成时必须运行。
- [ ] **Step 3: 浏览器验证拖放。** Chrome/Edge/Firefox 的生产构建分别检查 grid/gallery、浅色/深色、普通/超长标题、空/折叠集合、全部/未分类别名、同集合 noop、全部/部分重复、配额、浏览器源关闭、实际其他窗口 Tab、明确解除分组和空白取消。列出每个浏览器已验证项及未能运行的环境，不把构建通过当作浏览器通过。
- [ ] **Step 4: 浏览器验证输入与动效。** 键盘启动→切换→提交/取消、Tab 取消后下一次 Tab 正常导航、焦点恢复、读屏说明、操作按钮不误拖；reduce 打开及播放中切换；scroll/resize、切换路由/工作区、隐藏页面、连续快速拖动。检查成功反馈不早于执行结果、不改变当前筛选，不产生重影/遗留预览。触摸滚动若缺少真实设备明确记录限制。
- [ ] **Step 5: 检查几何稳定和性能。** 与 Task 1 前保存的基线比较同机同构建方式的 1,000 书签、10 秒跨集合拖动/滚动；固定标题和工具区位置，记录长任务、布局/绘制与 React commits。缺少原基线时明确缺少对照，不编造改进比例；新长任务需定位到本次新增代码后再修复。录制可保存在临时目录，最终只把结论写入计划，不提交用户书签数据。
- [ ] **Step 6: 检查 diff 并记录交付。** `git diff --check`、`git status --short`；确认没有 package/lock/server/schema 改动或其他会话文件。把真实命令、结果、浏览器和限制填写到下方；按明确路径提交，消息：`docs(plan): record dashboard drag and motion verification`。

## 实施验证记录

当前阶段：仅完成设计和计划撰写，尚未实施。

- 自动测试：未运行；任务步骤中的命令属于未来实施要求。
- 类型/构建：未运行；本次只有 Markdown 文档。
- 浏览器/读屏/触摸：未运行。
- 性能基线与对照：未录制。
- 设计评审与执行方式：等待用户评审后决定；不因文档已提交而开始实施。

## 计划自审

范围与设计对应：Task 1/2 覆盖第 4 节业务语义，Task 3 覆盖指针与目标，Task 4 覆盖生命周期与减少动态效果，Task 5 覆盖键盘和微交互，Task 6 覆盖真实浏览器/性能验收。Review Focus 的五类输入都有具体测试归属；所有新接口在首次任务中定义并被后续任务复用。纯视觉低风险调整采用浏览器检查，没有新增仅镜像类名的测试。本计划不宣称设计已批准、实现已完成或效果已实测。

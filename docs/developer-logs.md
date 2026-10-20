# 开发者日志

0.1.102 的 `greeting.click_completed` 表示已收到单人沟通按钮的点击执行回执，携带 `sent`、`limit`、`completion=click_receipt`；不是消息送达证明。已知按钮点击后不再等待变色或逐人请求模型核对，记录使用 `clickedAt`，不填写 `confirmedAt`。未知输入结果仍停止，不自动重放。

本版新增预设暂停原因 `search_setup_required`、`source_position_unverified`、`received_tab_unverified`，分别表示搜索条件尚未确认、收到简历的来源职位尚未确认，以及收到简历 tab 尚未确认。搜索条件可由 AI 一次设置并提交，条件证据校验通过后接回连续预设；正常列表可全程 `turns=0`。任务仍保留至少 5 秒的沟通点击间隔；简历成功仍必须有最终保存回执。聊天侧栏和完整工作台读取同一任务记录，侧栏轮询不驱动浏览器。

0.1.98 起平台预设优先执行，`recruitment.preset_step` 记录平台、任务类型、实际工具及耗时，不写候选人或页面原文；`recruitment.ai_handoff` 表示预设无法继续，切换模型处理。`greeting.agent_finished` / `resume.agent_finished` 记录模型轮数和累计模型、工具耗时，`turns=0` 表示该任务由预设完成、没有请求模型。判断提速需同时核对成功人数及真实业务回执。

0.1.99 的 `recruitment.preset_paused` 记录具体未命中原因和观察规模：`position_unverified`、`candidate_identity_unreadable`、`candidate_ambiguous`、`greeting_result_unverified`、`foreground_present`、`paid_foreground`、`page_loading`、`platform_tabs_ambiguous`、`repeated_step` 或 `tool_failed`。包含元素数、候选人片段数、观察格式和弹窗数；工具失败另带工具名和错误码，不记录姓名或页面原文。候选人片段数不等于独立人数，同一卡片可以有多个片段。

插件默认以 `info` 级别记录本机结构化 JSONL 日志，与工作台上的用户进度文案分开。

## 寻聘诊断（0.1.134）

默认 `info` 级别即可通过任务记录中的“复制操作日志”取得以下事件：

- `sourcing.navigation_rejected`：被拒操作的工具、ref、快照、拒绝阶段、元素角色/标签/状态、有限祖先结构和与当前候选人的文本关系。`inputDispatched=false` 表示宿主尚未派发该输入。`controlTerms` 只保留固定界面诊断词；未知文案只记长度及 `targetLabelKey` 指纹，不记原文。候选人关系仅表示快照文字关联，不代表通过身份校验或获准点击。
- `sourcing.candidate_preflight`：初筛分数、证据覆盖率、本轮最低分门槛（默认 60 分），以及 `qualified`、`skip_low_score` 或 `duplicate` 的实际决定。
- `sourcing.assessment_rejected`：评分失败代码、原文长度，以及每项引用是否提供、是否出现在已采集原文中。不包含引用、分析理由或简历正文。
- `sourcing.resume_read`：已读取字数、来源为列表摘要还是在线履历，以及 `saved=false`，避免把“读到了”误认为“已保存”。
- `sourcing.candidate_recorded` / `sourcing.candidate_discarded`：分别表示已保存的人选和最终评分不足本轮最低分而丢弃的信息。
- `sourcing.channel_finished`：结束前的计数、是否取消、是否尚有未保存候选人及其已读字数；取消和异常收尾也记录该摘要。`status` 是进入渠道收尾时的状态，取消时须结合 `aborted=true` 和最终任务结果判断。

评分事件的逐项信息只含标准 ID、权重、评分状态、规则对应分值和引用核验布尔值。`assessment_rejected` 中的分值只是模型所填状态对应的计算值，引用未通过时并未接受该分数。`candidateKey` 为原有身份指纹，可用于关联同一人选的预评、读取和保存；日志不包含候选人姓名、联系方式、完整页面或完整简历。这些诊断不增加浏览器调用、不改变评分/点击规则，也不会补回旧任务缺失的信息。

## 获取日志

工作台“最近任务”列表每一项的“复制操作日志”会读取该任务最近 300 条日志，并连同任务停止时的排查详情一起复制，包含任务 ID、日志目录、日志级别、是否截断、是否丢弃记录和写入故障状态。复制不操作浏览器、不提交简历，也不修改原任务。旧任务没有新增日志时会明确提示；日志无法追溯补录。

日志目录为 `<stateDirectory>/<公司命名空间>/developer-logs/`，默认在 `~/.xinling-recruitment/` 下。`ai_recruit_help.developerLogs.directory` 返回实际绝对路径。当前文件叫 `developer.jsonl`，历史文件为 `developer.1.jsonl` 至 `developer.4.jsonl`；每份最多约 2 MiB，总共保留 5 份。

开发者也可以直接调用工作台 RPC `aiRecruitWorkbench/developerLogs`，参数格式遵循宿主 RPC：

```json
{ "args": { "request": { "id": "实际任务UUID", "limit": 300 } } }
```

省略 `id` 可读取插件最近日志，包括启动、原生桥接注册和授权服务挂载；`limit` 范围为 1–1000。此接口只读取本插件固定日志目录，不接受文件路径。

## 配置级别

插件配置 `developerLogLevel` 支持 `debug`、`info`、`warn`、`error`、`off`，默认 `info`。需要详细定位时设为 `debug`，按宿主配置生效方式重新加载插件，再复现问题。

- `info`：任务接收、阶段、完成状态；浏览器操作及快照摘要；候选人识别数量和排除原因；附件、文件读取、上传及入库阶段；脱敏后的 HTTP 请求、响应及传输失败。
- `debug`：额外记录调用开始、业务接受状态、候选人元素的 ref/角色/状态/文字长度，以及文件分片大小与偏移；常规状态轮询和分片成功日志只在此级别写入。
- `warn` / `error`：只保留对应级别及更严重的记录。
- `off`：停止产生新日志，已存在的日志仍可导出。

## 如何追踪

每行包含 `at`（UTC ISO 时间）、`level`、`event`、`pluginVersion`、`runId`（本次插件实例）、`sequence`。任务执行带有 `taskId`、`kind`、`platform`；单次调用有 `callId`、`parentCallId`、`durationMs`。候选人使用摘要标识；不会记录姓名。

例如识别失败时，先按 `taskId` 查看 `resume.candidates_read` 的 `elementCount`、`candidateCount`、`reasons`，再通过前后的 `browser.call.finished` 找到页面路径、快照 ID、元素数、弹窗数和是否截断。`debug` 下的 `resume.candidate_elements` 可进一步区分原生 `div` 卡片、遮挡状态和控件文字过短等结构问题。

入库问题按 `file.read_capture` → `file.upload` → `xrxs.call`（`operation=preuploadResume/submitUploadResume`）→ `ingest.stage_changed` 查看。HTTP 成功和业务接受分别记录；`uploaded` 仅表示文件服务上传完成，`preuploaded` 仅表示预上传解析回执成功，`saved` 才表示最终提交接口确认入库。`ingest.stage_changed=unknown` 也会在写请求发送前作为保护状态出现，须结合后续记录和最终结果判断；日志本身不触发任何重试。

0.1.76 起工作台以模型选择页面操作：`resume.model_decision` 记录动作、ref、调用耗时和 token 用量，`resume.action_selected` 记录实际执行步骤，`resume.action_observation` 记录交回模型重新理解的引用或非附件错误。`resume.download_entry` 的 `mode=download` 表示先监听响应、再真实点击；成功的 `resume.attachment_captured` 包含 `captureStrategy`。`resume.model_failed` / `resume.model_incomplete` 可区分模型服务失败与浏览器失败。模型提示词、页面正文、完整回复及推理不写入开发日志。

## 页面决策（0.1.80）

打招呼与简历流程共用宿主默认模型调用器，分别记录 `greeting.model_decision` 和 `resume.model_decision`；登录检测仅在渠道探测不可用时记录 `login.model_decision`。`*.model_failed` / `*.model_incomplete` 表示模型服务或生成异常，不表示业务接口失败。`greeting/resume.action_selected` 为已通过 schema 的具体步骤，`*.action_observation` 为引用/证据等可恢复错误交回模型的原因。发送、额度、去重及未知结果停止仍由执行器控制。

模型判断来源包括元素所属 `context.text`、选中标签和当前观察到的 iframe。提示词和页面正文仅提供给宿主模型，不写开发日志。登录状态使用模型的可核验页面摘录，不读取认证凭据；首选 `browser_channel_login` 仍保留。

## 悬停与重复动作（0.1.81）

`greeting/resume.navigation_started` 记录通用导航的 action、ref、目标角色、元素 ID、标签摘要及理由摘要；正文和姓名不落日志。理由原文显示在本机任务进度，模型动作历史也包含理由、目标和前后状态。

`greeting/resume.action_result` 在下一次新快照到达时记录 pageChanged、前后状态摘要、快照 ID、元素数、弹窗数及选中元素 ID；pageChanged 不等于职位已选中。`greeting/resume.action_repeat_blocked` 表示相同状态下的动作已达两次，当前动作在发给浏览器前被阻止；菜单开关后回到旧状态也会累计。状态摘要排除 snapshotId/ref，便于识别本次 33 次重复点击一类问题。原始模型输出及页面正文继续不写日志。

## 连续工具对话与检查（0.1.82）

打招呼与简历改用原生工具调用，`*.model_decision` 含 round、toolCount、toolNames、耗时和 token 用量；`*.inspection_finished` 含工具、ref、耗时和输出长度，`*.inspection_failed` 表示检查未成功。原文 DOM/AX/网络内容和完整对话不落开发日志。模型调用错误继续记录 `*.model_failed`。

`*.action_result` 增加派发/变化状态及验证摘要，模型上下文还保留控件前后状态、输入是否确认、滚动位置及边界。dispatched 表示事件发出，changed 表示可观察变化，两者均不能代替业务回执。工作台进度显示当前正在检查控件、阅读结构、查询请求或刷新页面，避免整段检查只显示一句“正在阅读”。

## HTTP 调用日志（0.1.77 起）

默认 `info` 即可获取，不需要切换到 `debug`。业务请求、薪招换票和文件服务上传均覆盖：

- `xrxs.http.request`：`http` 内含 `operation`、`httpCallId`、实际 URL、方法、鉴权类型、请求头、查询参数、请求体和重定向策略。文件上传仅记录文件大小和 MIME 类型。
- `xrxs.http.response`：`http` 内含对应 `httpCallId`、实际 HTTP 状态、响应头（包括服务器返回的 request-id / trace-id）、耗时及脱敏后的响应体。JSON 保留字段结构及服务端原始错误文案；非 JSON 保留脱敏文本。因此 HTTP 200 + 业务 code 401 可以直接区分，不再只看到插件的默认错误文案。
- `xrxs.http.failed`：记录失败发生在发出请求还是读取响应正文阶段，以及脱敏异常和网络错误码。读取失败时响应记录的 `bodyComplete=false`，不能当成空响应。

仍可按 `taskId`、`callId` 与 `parentCallId` 关联。`httpCallId` 是本地日志关联号，不会添加到业务请求中；后端追踪需使用响应头中服务器实际返回的标识。日志缺少服务端标识时不能据此声称请求已进入招聘 Controller。

普通响应不受常规日志 600 字限制。单个响应体在脱敏序列化后最多保留 128 KiB，超过时明确标记 `bodyTruncated=true`；`bodyBytes` 表示实际读到的原始正文 UTF-8 字节数。较大记录分为多行，包含 `httpCallId`、`httpPart`、`httpParts`、`httpText`，按序拼接 `httpText` 再解析 JSON 可还原。复制日志仍受总条数及轮转保留限制，先检查导出结果的 `truncated` 和 `dropped`。修改前的历史请求不能补回响应。

HTTP 日志中的 Cookie、Authorization、token、CSRF、会话、签名、fileKey、姓名、联系方式、简历正文及文件名字段替换为 `[REDACTED]`，已知凭据即使在错误文案中被回显也会脱敏。URL 查询值脱敏，安全查询参数另以结构化 `query` 保留。不会记录二进制附件。日志保留的是可排查的脱敏请求/响应，不是可重放凭据。

其他错误记录包含错误类型、错误码和调用栈位置；少量已知的本地错误另有固定说明。普通异常正文不直接落盘。页面地址去掉查询参数和 fragment。日志写入失败只告警，不改变业务结果；队列最多积压 500 条，超出时增加 `dropped` 计数。

遮挡恢复中的只读 `browser_inspect_element` 会记录目标角色、标签、有限状态、标签哈希、`pointerEvents=auto/none` 以及最多五层祖先的标签/角色。不会记录目标原文、候选人姓名、祖先正文、HTML、class 或 id。语义树本身没有几何和 DOM 样式信息，这些检查用于区分文字节点和实际控件；仍不能仅凭 `ELEMENT_OCCLUDED` 主错误码断定具体遮挡物。

日志属于本机开发记录，不包含扩展内部全部行为，也不证明最终业务写入成功。需要更长时间范围时直接读取轮转文件。


### 0.1.83 候选人资料证据诊断

`greeting.profile_evidence` 记录当前 ref、profileRef、mode（url/text）及 reason（valid_href/missing_href/non_navigation_href），不记录资料 URL 和候选人原文。无 href 的可选资料元素不再阻止已通过身份核验的候选人，继续使用既有文本去重。

`greeting.action_observation` 增加 ref/profileRef。错误码区分 `CANDIDATE_PROFILE_EVIDENCE_INVALID`、`CANDIDATE_PROFILE_URL_INVALID`、`CANDIDATE_PROFILE_ORIGIN_NOT_ALLOWED`、`CANDIDATE_IDENTITY_QUOTE_INVALID`，具体修正提示反馈模型；`*.inspection_failed` 现在同样包含脱敏 errorCode/stack，便于定位刷新和检查失败。


### 0.1.84 身份与职位证据反馈

`greeting.action_observation` 在身份原文拒绝时附带 quoteFound、nameIncluded、quoteLength、sourceCount。它们说明原文是否匹配、是否包含姓名，不记录模型引用原文或页面原文。候选人和选中职位的有限原文只作为工具反馈返回同一任务模型，不落开发日志。

refresh_page 使用统一输出预算，超大快照会显示 truncated 与 omittedElementCount/omittedDialogCount/omittedSelectedTabCount，优先省去重复树和完整尾部元素。宿主仍保留完整快照；模型只使用已返回的新引用，必要时按 ref 检查局部内容。


### 0.1.85 语义运行时与延迟

`*.model_decision` 新增 inputCharacters、firstChunkMs、provider/model、实际 reasoningEffort。模型快照使用唯一精简树，contexts 去重，不在日志中输出原文；工具调用仍记录 durationMs。只在宿主模型声明支持时选 low/minimal，仅影响当前页面任务。

打招呼 browser_snapshot 使用 format=semantic；ref 为真实后端节点引用。发送前 `browser_inspect_element` 只读取得已选节点的实际身份/职位详情，不增加模型轮次。旧扩展会继续返回 DOM 格式，但完整语义动作需要升级薪招 3.2.40。


### 0.1.86 页面就绪、错误码与自动收尾

`greeting.page_readiness` 记录新页面 DOM 稳定检查的 conditionMet、timeout、waitedMs。该结果不保证业务数据加载完成。`greeting.limit_reached` 记录宿主根据已触发次数自动结束；不产生额外模型轮次。

MCP 文本错误保留开头的网关代码，browser.call.finished 与 greeting.action_observation 不再统一丢成 TOOL_ERROR。日志仍不输出任意远端正文或候选人原文；工作台失败详情显示具体页面错误码和尝试时间。


### 0.1.87 就绪等待与返回截止时间分离

页面内部预算放在 browser_wait.condition.timeoutMs=2000，外层 timeoutMs=5000 留给网关派发、扩展执行与结果返回。页面不稳定时可正常收到 conditionMet=false、timeout=true、timeoutSource=plugin，然后交给模型判断。greeting.page_readiness 附带 waitBudgetMs/replyBudgetMs/timeoutSource。真正的网关 TOOL_CALL_OUTCOME_UNKNOWN 仍停止任务，不吞错也不重放。

### 0.1.142 猎聘职位路径与隐藏节点

猎聘将顶部招聘职位选择器与下方履历职位筛选分开处理。错误输入记录 `sourcing.navigation_rejected`，`errorCode=SOURCING_POSITION_ROUTE_REQUIRED`、`validationStage=position_route`、`inputDispatched=false`；模型收到正确入口的操作说明。

`ELEMENT_HIDDEN` 也会进行只读 `browser_inspect_element` 和快照恢复，记录原始错误码及 `browser_agent.observation_recovered`，不自动重放输入。它表示执行时目标不可见，不能据此归因为遮罩；`ELEMENT_OCCLUDED` 则表示真实命中检查失败。恢复检查仍只记录角色、标签、有限状态与祖先结构，不记录原始页面文案。

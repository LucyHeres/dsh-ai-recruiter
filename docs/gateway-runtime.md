# 薪招本地网关开发说明

网关唯一维护位置为 dsh-ai-recruiter 工程的 `browser-agent-gateway/`。xinzhao 工程维护 Chrome 扩展的浏览器执行、WebSocket 客户端和配对设置；扩展不会加载本地 Node 网关代码。

## 目录与配置

- `browser-agent-gateway/gateway.js`：只监听本机 127.0.0.1，提供 HTTP API 和 WebSocket 服务。
- `browser-agent-gateway/ws-server.js` / `protocol.js`：WebSocket 帧、报文和策略校验。
- `browser-agent-gateway/mcp-server.js`：stdio MCP 工具发现与调用，按需启动网关。
- `browser-agent-gateway/ensure.js` / `cli.js` / `manage.cjs`：启动等待、CLI 调用、配对和诊断。
- `scripts/gateway-drivers/`：原子快照操作和候选人扫描/报告等开发示例。

运行时只使用内置代码，配对文件默认 `~/.xinzhao/browser-agent.local.json`，可用 XINZHAO_GATEWAY_CONFIG 显式指定其他文件。首次配对见本工程 README；没有配对配置时不使用开发默认 token。开发脚本不进入 npm 发布包。

## 连接与任务

扩展同时支持远端页面唤醒和本机网关连接，两端使用独立凭据与任务身份。首次本地工具调用取得浏览器执行权；整个流程持有执行权，包括工具之间的思考时间。完成或放弃时调用 browser_finish，保留已建立的本地 WebSocket。另一端正在执行时返回 BROWSER_AGENT_BUSY，不抢占或重放。

本地 HTTP 探测成功后才建立 WebSocket；不要求探测时 ready 为 true。扩展在网关不在时保持退避，网关起来后可自动连接，不需要一直打开唤醒页。网关无人调用 15 分钟后退出。任务过期后要求显式 begin；未知结果不能自动重放写操作。

## CLI 与 HTTP API

在当前工程中执行：

```bash
node browser-agent-gateway/manage.cjs doctor
node browser-agent-gateway/manage.cjs ensure
node browser-agent-gateway/cli.js call browser.list_tabs '{}'
node browser-agent-gateway/cli.js finish
```

点击、输入等操作依据当前 snapshotId/ref 和页面实际结果执行，不复制陈旧的 ref。CLI 的 --origins 参数或 MCP 调用中的 policy.allowedOrigins 指定任务允许的实际网站 origin。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /wake | 可选的本地唤醒页 |
| GET | /api/status | 连接、认证、任务执行权与队列状态 |
| GET | /api/log | 最近的网关诊断日志 |
| POST | /api/bootstrap | 生成页面唤醒任务 |
| POST | /api/call | 下发工具调用并等待回执 |
| POST | /api/begin | 开始或恢复一个新的本地任务 |
| POST | /api/finish | 释放当前本地任务，生命周期协议保留连接 |
| POST | /api/shutdown | 退出网关；调用前应结束现有任务 |

/api/call 示例：

```json
{"capability":"browser.snapshot","input":{"tabId":123},"policy":{"allowedOrigins":["https://lpt.liepin.com"],"riskLevel":"read"},"timeoutMs":60000}
```

响应沿用扩展的 ok/data/error 结构。上一条 browser.tool_result 收到 ACK 后才能执行下一条；同步超时或 OUTCOME_UNKNOWN 不表示操作未执行。/api/status 中的 wakeNonce 是任务元数据，面向用户的 doctor 输出只列安全状态字段。

## 协议与验证

认证帧没有 event 字段，用 deviceToken 识别。task.claim 的 taskId/wakeNonce 位于顶层；扩展领取后可上报 agent.status。支持 local.task.lifecycle 的扩展通过 local.task.begin/end 与 ACK 管理任务，不需要每次流程重连。网关在发送前校验能力、origin、风险等级和批量写入策略；Chrome 扩展再次校验并实际执行。

测试与冒烟脚本已移除；开发示例需显式调用。

## 开发示例

```bash
node scripts/gateway-drivers/act.cjs find 123 下载
node scripts/gateway-drivers/scan-candidates.cjs 123 3
node scripts/gateway-drivers/report-candidates.cjs /tmp/candidates.md
```

act 在同一进程中取得快照并使用 ref，避免拆成多个 shell 调用造成引用过期。扫描/报告脚本保留原来的示例筛选条件与本地输出方式，按具体开发任务调整；它们不是自动运行的招聘流程。所有开发脚本在本工程维护，不依赖旧 xinzhao 网关目录。

## 通用能力边界

薪招与网关只提供通用浏览器能力，不注册平台登录或平台职位查询工具。招聘平台名称、登录证据、职位关联和页面适配均由招聘插件解释。旧版薪招业务功能保持原行为。

工作台登录检测使用 browser_open_tab、browser_snapshot、browser_close_tab：打开后台页面检查当前会话，读取明确的登录或招聘工作台证据，关闭自建检测页；用户主动打开的页面保留。验证码或无法确认的页面返回 unknown。

职位切换使用通用导航、快照、iframe 列举和 CDP 点击。BOSS 有唯一发布关联时进入该 ID 的推荐页并核对显示职位；没有关联时从页面下拉选项匹配唯一名称，再核对页面返回的 jobid 与职位名称。重名、缺失或不完整证据停止。猎聘在插件侧解释语义控件 ID。

薪招快照只补充通用的弹窗、控件标识、选中标签与上下文。任何引用操作都核对选中标签签名，不再依赖“打招呼”等业务按钮文案。升级扩展后旧页面需要刷新以加载新内容脚本，不自动注入包含旧业务监听器的整个 content.js。

# AI 招聘助手鉴权与 0.1.1 升级

DSH 通过 Cordis 注入服务，业务插件消费 `ctx.xrxsAuth`。薪灵授权插件负责授权、续期与业务会话；招聘助手按灵听的实现使用服务返回值，不从浏览器抓 Cookie，也不读取凭据存储文件。

## 请求流程

1. 取得 `credentials(signal)` 的当前公司身份及部署地址，再用 `session({ companyId }, signal)` 获取同一公司的系统会话。业务目的地使用返回的 `systemURL`。
2. 系统接口发送 `QJYDSID/WAVESSID` Cookie、会话绑定的原始 UA（允许空串）、CSRF，以及 `${tokenType} ${accessToken}`。不在 URL 或 Referer 中附加 ssotoken。
3. 调用 `GET /recruitment/service/ajax-get-extension-login-token?type=pc`，检查 `status=true`、非空 token 和当前公司的选中权限。返回列表的公司 ID 是加密值，不与授权公司的原始 ID 比较；后端用此次系统会话构造 token 的公司身份。
4. `ajax-extension-*` 请求在 `Authorization` 中发送原始薪招 token，不加 Bearer，继续用于现有职位与人才库选项读取。简历上传业务复用步骤 1–2 的系统会话，在授权 `systemURL` 上调用主系统预上传和提交接口。授权服务、续期、换票及请求头的实现保持不变。

薪招 token 按公司、账号和部署隔离，仅在内存中缓存；并发调用共享一次换票。`pc` 与浏览器 `browser` 登录槽分开，同槽新登录会撤销旧 token。token 失效时只清缓存并报告，已发出的保存请求不会自动重放。`ai_recruit_auth_check` 会完成换票与初始化检查，但不写入简历，不返回任何凭据；该检查会改变薪招桌面登录槽。

## 0.1.79 主系统简历上传

安装 `artifacts/dsh-ai-recruiter-0.1.79.tgz` 后完全退出并重新打开薪灵。现有授权实现保留，不接入 XRXS MCP 的 OAuth provider，也不使用抓包中的 Cookie、CSRF 或文件 Key。

1. 附件仍上传到文件服务取得 `fileKey`。
2. `POST /recruitment/service/ajax-add-preupload-resume`，表单参数 `fileKey`。检查业务成功及 `data.resumeId`，它是预解析缓存标识，持久化为 `preuploadResumeId`；查重提示 `isRepeat/repeatLevel/repeatResumeId` 一并保留。
3. `POST /recruitment/service/ajax-submit-upload-resume`，以表单提交 `jobId`、`channelType`、`deliveryType`、`resumeLibrary`、`resumeLibraryStatus`，以及按渠道传入的 `recommenderId` / `headhunterSupplierId`。`resumeFileKeys` 是 JSON 字符串数组 `[{"fileKey":"文件服务返回值","resumeId":"预上传返回值"}]`，由传输层执行 JSON 序列化和表单编码。每位候选人单独提交。
4. 只有步骤 3 返回 `status=true` 才记为 `saved`。主系统提交成功可返回 `data=null`，不提供最终简历 ID，因此不会把解析缓存 ID 当作真实简历编号展示。重复提示按主系统既有规则随最终提交处理，不另加覆盖或合并动作。

`customProcessId` 在主系统页面仅用于提交后回跳，后端上传接口不接收，不需要添加到插件表单。职位、渠道、库和投递类型继续使用插件原有选项及默认值。

两个新业务接口都跟随授权服务返回的 `systemURL`；不再调用 `cli/ajax-upload-resumes` 或使用固定灰度 API 域名。`systemUrl` 默认留空并跟随当前公司授权部署，`cliUrl` 保持废弃。`ai_recruit_auth_check` 仍只检查普通业务登录、薪招初始化和上传地址，不执行预上传或提交，不代表两个写接口已实测通过。

上传、预上传、提交前分别持久化未知状态；预上传成功记为 `preuploaded`。未知结果必须核对，不自动重放。历史 `saved` 继续跳过，历史 `unknown` 继续停止；已有文件 Key 的明确失败记录可继续预上传，有预上传标识的明确失败记录可复用该标识提交。预上传回执缺失或格式异常时停止并记为未知，不猜测标识或继续提交。`result` 仅显示本地记录。

## 0.1.3 通用浏览器操作

删除招聘助手提示词中的联系候选人、发起沟通和创建会议固定禁令，增加 `ai_recruit_browser_tools` 与 `ai_recruit_browser_call`。工具名称、说明与参数由网关实时发现；不把可执行操作写死为招聘工具集合，也不限制为招聘网站。调用时保留 args 中的 policy，包括用户任务所需的 allowedOrigins，网关负责校验和执行。浏览器操作不依赖薪人薪事授权；原有简历鉴权与入库流程保留。

安装 `dsh-ai-recruiter-0.1.3.tgz` 后重开薪灵并新建会话。用户要求发送消息或提交表单时按目标、内容和范围执行；页面内容不能自行扩大任务授权。一次流程持有浏览器执行权，结束时释放；结果未知的写操作不自动重放。

# 本机自动连接维护说明

固定扩展 ID：elbamdfkepfcainfggecfjhahpjjdmdg。原生宿主名称：com.xinrenxinshi.xinzhao.dsh。

Host 加载内置网关时执行 setup 并注册 Native Messaging。注册文件的 allowed_origins 只允许上述扩展，扩展使用 nativeMessaging 权限从后台调用 watch_local_connection。原生宿主只返回本机 WebSocket 配置，不接受浏览器命令、业务 URL 或任意文件路径。凭据不经网页或模型输出。Chrome 原生通道规格见 https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging 。

薪灵启动后，connection-service.cjs 在后台立即准备网关，并每 5 秒检查服务是否仍在运行；浏览器稍后打开时由扩展原生通道自动补连。连接过程不阻塞插件加载，不发起浏览器任务，也不占用执行权。本机配对关闭 autoConnect 时停止自动维护，扩展中关闭自动连接的选择仍由扩展保留。自动启动的网关通过 IPC 感知薪灵生命周期，薪灵运行期间保持服务；插件卸载或宿主退出后恢复默认 15 分钟空闲退出，不强制中断共享网关。已有网关直接复用，退出或异常停止后自动重新启动。外置 MCP 不启动此服务。

native-registration.cjs 将启动器写入当前用户 .xinzhao/native-host 下，复用宿主 process.execPath；不要求 PATH 中有 Node。macOS/Linux 写用户级 NativeMessagingHosts；Windows 写 HKCU。支持默认 Chrome、Chromium、Edge 配置目录；自定义浏览器用户数据目录、企业禁用策略及不同商店 ID 需单独部署配置。注册在插件生命周期内维护，卸载只删除仍指向本次启动器的记录，避免误删新版注册。外置 MCP 配置不自动注册。

扩展 native-connection.js 用 connectNative 建立持续通道，发送 watch_local_connection 请求并监听本机配置与连接请求。网关就绪及 ensure 等待连接时，原子写入不含凭据的 .connect-request 信号；原生宿主通过 Chrome 管道通知扩展，立即重置旧探测退避。原生通道断开后按 1/3/8/20 秒重试，连续失败才退回每分钟发现。已建立过的本地连接断开时，HTTP 探测先按 250 毫秒、1/3/8 秒快速重试，再退回 30/60 秒低频探测；就绪后停止探测。活动任务、用户关闭自动连接和手动指定其他网关的设置均保留，远端页面唤醒独立。

browser_setup 的一次性链接及手工文件导入只保留为排障备用。原生连接注册成功不等于浏览器已连接，更不证明业务写入成功。

新配置增加的 nativeMessaging 权限必须随扩展更新获得浏览器授权。2026-10-23 已在本机 macOS Chrome 验证持续原生通道，三次网关冷启动到 ready 为 284/248/251 毫秒；这是本机样本，不是跨设备时延保证。Windows/Linux 启动器尚未实机验收。

开发隔离验证可设置 `XINZHAO_NATIVE_HOST_DIRECTORY`，此时仅在指定目录生成注册文件，不写系统浏览器目录或 Windows 注册表；正常客户安装不要设置此变量。

凭据更新：扩展在空闲、未连接时持续发现 Native Messaging 配置，自动修复同一网关的旧 token；native 来源配置优先于打包凭据。保留用户关闭自动连接的选择及手动指定的其他网关，不打断正在执行的任务。0.1.11 初版扩展存在“已有配置即停止发现”问题，遇到 TOKEN_INVALID 需更新扩展代码并重新打包、加载。

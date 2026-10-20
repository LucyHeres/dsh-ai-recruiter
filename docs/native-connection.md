# 本机自动连接维护说明

固定扩展 ID：elbamdfkepfcainfggecfjhahpjjdmdg。原生宿主名称：com.xinrenxinshi.xinzhao.dsh。

Host 加载内置网关时执行 setup 并注册 Native Messaging。注册文件的 allowed_origins 只允许上述扩展，扩展使用 nativeMessaging 权限从后台调用 get_local_connection。原生宿主只返回本机 WebSocket 配置，不接受浏览器命令、业务 URL 或任意文件路径。凭据不经网页或模型输出。Chrome 原生通道规格见 https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging 。

native-registration.cjs 将启动器写入当前用户 .xinzhao/native-host 下，复用宿主 process.execPath；不要求 PATH 中有 Node。macOS/Linux 写用户级 NativeMessagingHosts；Windows 写 HKCU。支持默认 Chrome、Chromium、Edge 配置目录；自定义浏览器用户数据目录、企业禁用策略及不同商店 ID 需单独部署配置。注册在插件生命周期内维护，卸载只删除仍指向本次启动器的记录，避免误删新版注册。外置 MCP 配置不自动注册。

扩展 native-connection.js 每分钟探测缺失配置，服务工作线程唤醒时复用已有探测 alarm；已有配置不覆盖，活动任务不修改。取得配置后调用既有 HTTP 探测/WS 自动重连链路，保持远端页面唤醒独立。

browser_setup 的一次性链接及手工文件导入只保留为排障备用。原生连接注册成功不等于浏览器已连接，更不证明业务写入成功。

新配置增加的 nativeMessaging 权限必须随扩展更新获得浏览器授权。本版本没有进行真实浏览器原生通信或 Windows/Linux 启动器验收。

开发隔离验证可设置 `XINZHAO_NATIVE_HOST_DIRECTORY`，此时仅在指定目录生成注册文件，不写系统浏览器目录或 Windows 注册表；正常客户安装不要设置此变量。

凭据更新：扩展在空闲、未连接时持续发现 Native Messaging 配置，自动修复同一网关的旧 token；native 来源配置优先于打包凭据。保留用户关闭自动连接的选择及手动指定的其他网关，不打断正在执行的任务。0.1.11 初版扩展存在“已有配置即停止发现”问题，遇到 TOKEN_INVALID 需更新扩展代码并重新打包、加载。

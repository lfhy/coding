# coding-host-directory-picker

web GUI 宿主的工作区目录选择是一项能力 seam。抽象的 `DirectoryPicker` 服务（`ctx.directoryPicker`）是其 Service Definition。该服务只提供一个方法：`capability()`，它返回一个可辨识联合类型，说明操作者如何选择目录。后端之间的用户交互不同，不只是实现不同：`{ kind: 'native', pick(signal) }` 在宿主屏幕上打开一个原生 OS 选择器（[`-native`](../directory-picker-native/README.md)）；`{ kind: 'browse', list(path?), createDirectory(path, name), rename(path, nextName), remove(path) }` 提供应用内浏览器使用的列举、创建、同层改名与删除操作，也能服务于无法访问 OS 对话框的远程客户端（[`-browse`](../directory-picker-browse/README.md)）。消费方按 `capability().kind` 分支；联合类型由可合并扩展的 `DirectoryPickerCapabilities` 映射派生，新后端通过声明合并在其中加入自己的变体。遇到未知 kind 时，消费方会隐藏目录选择入口，而不是失败。能力对象在服务生命周期内必须保持稳定。每个后端包还提供 browser 入口，在 ui-workspace 的 directory-flow slot 中注册匹配的交互，因此一项组合配置会同时选择宿主能力与 client 流程。需要在运行时选择交互的组合挂载 [`-auto`](../directory-picker-auto/README.md)，它在启动时检查一次宿主情况，并挂载匹配的后端行。随包发布的 web 组合直接挂载 `-browse`（页面内对话框），所有载体因此拿到同一套交互；在覆盖层里组合 `-native` 是为“操作者就坐在宿主屏幕前”的场景固定系统面板。

浏览原语失败时会抛出带类型的 `DirectoryPickerError`（`directory-unreadable`／`directory-exists`／`directory-create-failed`／`directory-rename-failed`／`directory-delete-failed`，各自携带出错对象的 `path`），消费网关将其 1:1 映射为协议错误码；改名撞名沿用 `directory-exists`。`DirectoryEntry` 行携带宿主判定的 `hidden` 标志（POSIX 点前缀约定），展示策略留在客户端；`DirectoryListing.crumbs` 是从文件系统根开始的祖先链，每个 crumb 都是跳转目标。`DirectoryListing` 同时给出 `entries`（可挑选的子目录）与 `files`（同层直接子文件，只读展示，永远不是挑选目标），两者各按名称排序；`truncated` 的含义是「子目录与文件合计超出后端上限」，因此只要为真，浏览器就该提示当前层级不完整。`rename` 只在同一父目录下改名并返回新绝对路径，`remove` 删除文件或连同内容删除目录——破坏性操作，二次确认归调用方（浏览器对话框）负责。设计依据、与 `ctx.fs` 的切分、策略裁决见 目录选择能力 seam 设计记录。

## 模型体验

无。该 seam 服务于 GUI 宿主的目录选择；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **不支持多根目录**——浏览约定每次列举只公开一条祖先链；按部署限定可浏览根（以及在盘符根的上一级枚举 Windows 各盘符根目录）等到出现需要它的消费方再做，见 DirectoryPicker 设计记录。

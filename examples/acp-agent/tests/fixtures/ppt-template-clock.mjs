// 模板元数据读取时间，导入页 ID 会进入工具结果文本；两者都需在场景子进程内固定。
Date.now = () => 1700000000000
let nextId = 0
globalThis.crypto.randomUUID = () => {
  nextId += 1
  return `00000000-0000-4000-8000-${nextId.toString(16).padStart(12, '0')}`
}

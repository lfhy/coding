/** 生成与现代 XMind 相同的 ZIP 容器；数据描述符和大小字段可单独构造供校验测试。 */
import { crc32, deflateRawSync } from 'node:zlib'

interface XMindMember {
  name: string
  data: Uint8Array
  stored?: boolean
  descriptor?: boolean
  declaredSize?: number
  declaredCrc?: number
}

/**
 * 给定测试成员，写入标准大小的本地头和中央目录。
 * @param members - 测试用 ZIP 成员。
 * @returns 内存中的 ZIP 字节。
 */
export function xmindArchive(members: readonly XMindMember[]): Buffer {
  const locals: Buffer[] = []
  const entries: Buffer[] = []
  let offset = 0
  for (const member of members) {
    const name = Buffer.from(member.name)
    const bytes = member.stored ? Buffer.from(member.data) : deflateRawSync(member.data)
    const flags = member.descriptor ? 0x0808 : 0x0800
    const method = member.stored ? 0 : 8
    const checksum = member.declaredCrc ?? crc32(member.data)
    const size = member.declaredSize ?? member.data.byteLength
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, bytes)
    let descriptorLength = 0
    if (member.descriptor) {
      const descriptor = Buffer.alloc(16)
      descriptor.writeUInt32LE(0x08074b50)
      descriptor.writeUInt32LE(checksum, 4)
      descriptor.writeUInt32LE(bytes.length, 8)
      descriptor.writeUInt32LE(size, 12)
      locals.push(descriptor)
      descriptorLength = descriptor.length
    } else {
      local.writeUInt32LE(checksum, 14)
      local.writeUInt32LE(bytes.length, 18)
      local.writeUInt32LE(size, 22)
    }
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(bytes.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    entries.push(central, name)
    offset += local.length + name.length + bytes.length + descriptorLength
  }
  const directory = Buffer.concat(entries)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(members.length, 8)
  end.writeUInt16LE(members.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

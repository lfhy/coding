/** 根调用与递归子调用共用同一条 keyed 原子分发路径。 */
import { memo, useMemo, type ReactNode } from 'react'
import type { ToolCallBlock } from 'coding-client-runtime/client'
import type { ChatNode } from 'coding-client-ui-conversation/client'
import { backgroundSessionId, backgroundStart } from 'coding-tools/tool-action-title'
import type { ToolCallOwnerProps, ToolTreeProps } from '../contract/slots.ts'
import { resultText } from './models/tool-call-model.ts'
import { GenericToolCard } from './toolviews/GenericToolCard.tsx'
import css from './ToolCallTree.module.css'

/** 从运行中或已完成的调用块读取 wire 工具名。 */
function callName(node: ToolCallBlock): string {
  return 'kind' in node ? node.call?.name ?? '' : node.name
}

/** 从已加载的同会话工具节点匹配后台任务，窗口缺失启动回执时不猜测任务。 */
function backgroundDescriptions(nodes: readonly ChatNode[], sessionIds: ReadonlySet<string>): ReadonlyMap<string, string> {
  const descriptions = new Map<string, string>()
  const visit = (block: ToolCallBlock): void => {
    if ('kind' in block && block.call !== null && !block.isError
      && (block.call.name === 'bash' || block.call.name === 'exec_command')) {
      const start = backgroundStart(block.call.name, block.call.argsRaw, resultText(block))
      if (start !== undefined && sessionIds.has(start.id)) descriptions.set(start.id, start.description)
    }
    for (const child of block.subCalls) visit(child)
  }
  for (const node of nodes) {
    if (node.kind === 'tool-call') visit(node.data.root)
  }
  return descriptions
}

/** 子调用可能拥有自己的后台会话，不能沿用父调用的任务说明。 */
function sessionIdsIn(block: ToolCallBlock): ReadonlySet<string> {
  const ids = new Set<string>()
  const visit = (current: ToolCallBlock): void => {
    const id = backgroundSessionId(callName(current), 'kind' in current ? current.call?.argsRaw ?? '' : current.argsRaw)
    if (id !== undefined) ids.add(id)
    for (const child of current.subCalls) visit(child)
  }
  visit(block)
  return ids
}

function sameDescriptions(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  return left.size === right.size && [...left].every(([id, value]) => right.get(id) === value)
}

/** 通过工具展示 keyed slot 分发单个原子调用。 */
const ToolCall = memo(function ToolCall({
  renderSlot, callId, toolName, block, openFile, loadImage, selected, cwd, home, taskDescriptions, inspectCall, t, children,
}: Pick<ToolTreeProps, 'renderSlot' | 'openFile' | 'loadImage' | 'cwd' | 'inspectCall' | 't'> & {
  callId: string
  toolName: string
  block: ToolCallBlock
  selected: boolean
  home?: string | undefined
  taskDescriptions: ReadonlyMap<string, string>
  children?: ReactNode
}) {
  const owner: ToolCallOwnerProps = useMemo(() => ({
    callId,
    toolName,
    block,
    openFile,
    loadImage,
    cwd,
    home,
    taskDescription: taskDescriptions.get(backgroundSessionId(toolName, 'kind' in block ? block.call?.argsRaw ?? '' : block.argsRaw) ?? ''),
    inspect: () => { inspectCall(callId) },
  }), [callId, toolName, block, openFile, loadImage, cwd, home, taskDescriptions, inspectCall])
  return (
    <div
      className={css.callRow}
      data-chat-anchor-key={`call:${callId}`}
      data-chat-call-id={callId}
      data-selected={selected || undefined}
    >
      {renderSlot('tool.call.toolview', owner, {
        entryKey: toolName,
        fallback: <GenericToolCard {...owner} t={t} />,
      })}
      {children}
    </div>
  )
})

const ToolCallBranch = memo(function ToolCallBranch({
  renderSlot, block, selectedCallId, cwd, home, taskDescriptions, openFile, loadImage, inspectCall, t,
}: Pick<ToolTreeProps, 'renderSlot' | 'selectedCallId' | 'cwd' | 'openFile' | 'loadImage' | 'inspectCall' | 't'> & {
  block: ToolCallBlock
  home?: string | undefined
  taskDescriptions: ReadonlyMap<string, string>
}) {
  return (
    <ToolCall
      renderSlot={renderSlot}
      callId={block.callId}
      toolName={callName(block)}
      block={block}
      openFile={openFile}
      loadImage={loadImage}
      selected={block.callId === selectedCallId}
      cwd={cwd}
      home={home}
      taskDescriptions={taskDescriptions}
      inspectCall={inspectCall}
      t={t}
    >
      {block.subCalls.length > 0 ? (
        <div className={css.subCalls} data-subcalls>
          {block.subCalls.map(child => (
            <ToolCallBranch
              key={child.callId}
              renderSlot={renderSlot}
              block={child}
              selectedCallId={selectedCallId}
              cwd={cwd}
              home={home}
              taskDescriptions={taskDescriptions}
              openFile={openFile}
              loadImage={loadImage}
              inspectCall={inspectCall}
              t={t}
            />
          ))}
        </div>
      ) : null}
    </ToolCall>
  )
})

/**
 * 将根调用及递归子调用交给同一条原子 keyed 分发路径。
 * @param props - 完整调用树的 owner 数据与工具拥有的子 slot share。
 * @returns 工具调用树。
 */
export function ToolCallTree({
  renderSlot, node, selectedCallId, cwd, openFile, loadImage, inspectCall, useHostDescription, useSession, t,
}: ToolTreeProps) {
  const home = useHostDescription(description => description?.home)
  const block = node.data.root
  const sessionIds = useMemo(() => sessionIdsIn(block), [block])
  const taskDescriptions = useSession(snapshot => sessionIds.size === 0 ? new Map<string, string>()
    : backgroundDescriptions(snapshot.chat.nodes.values() as readonly ChatNode[], sessionIds), sameDescriptions)
  return (
    <ToolCallBranch
      renderSlot={renderSlot}
      block={block}
      selectedCallId={selectedCallId}
      cwd={cwd}
      home={home}
      taskDescriptions={taskDescriptions}
      openFile={openFile}
      loadImage={loadImage}
      inspectCall={inspectCall}
      t={t}
    />
  )
}

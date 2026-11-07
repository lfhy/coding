/** 根调用与递归子调用共用同一条 keyed 原子分发路径。 */
import { memo, useMemo, type ReactNode } from 'react'
import type { ToolCallBlock } from 'coding-client-runtime/client'
import type { ToolCallOwnerProps, ToolTreeProps } from '../contract/slots.ts'
import { GenericToolCard } from './toolviews/GenericToolCard.tsx'
import css from './ToolCallTree.module.css'

/** 从运行中或已完成的调用块读取 wire 工具名。 */
function callName(node: ToolCallBlock): string {
  return 'kind' in node ? node.call?.name ?? '' : node.name
}

/** 通过工具展示 keyed slot 分发单个原子调用。 */
const ToolCall = memo(function ToolCall({
  renderSlot, callId, toolName, block, openFile, loadImage, selected, cwd, home, inspectCall, t, children,
}: Pick<ToolTreeProps, 'renderSlot' | 'openFile' | 'loadImage' | 'cwd' | 'inspectCall' | 't'> & {
  callId: string
  toolName: string
  block: ToolCallBlock
  selected: boolean
  home?: string | undefined
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
    inspect: () => { inspectCall(callId) },
  }), [callId, toolName, block, openFile, loadImage, cwd, home, inspectCall])
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
  renderSlot, block, selectedCallId, cwd, home, openFile, loadImage, inspectCall, t,
}: Pick<ToolTreeProps, 'renderSlot' | 'selectedCallId' | 'cwd' | 'openFile' | 'loadImage' | 'inspectCall' | 't'> & {
  block: ToolCallBlock
  home?: string | undefined
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
  renderSlot, node, selectedCallId, cwd, openFile, loadImage, inspectCall, useHostDescription, t,
}: ToolTreeProps) {
  const home = useHostDescription(description => description?.home)
  const block = node.data.root
  return (
    <ToolCallBranch
      renderSlot={renderSlot}
      block={block}
      selectedCallId={selectedCallId}
      cwd={cwd}
      home={home}
      openFile={openFile}
      loadImage={loadImage}
      inspectCall={inspectCall}
      t={t}
    />
  )
}

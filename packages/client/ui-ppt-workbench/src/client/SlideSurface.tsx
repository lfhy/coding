/**
 * 幻灯片渲染：把页面元素画成 DOM（矢量、秒出），坐标系与导出的 .pptx 一致。
 * 面板画布与缩略图共用这里，因此「所见」与「导出」不会各自演化出两套版式。
 * @module coding-client-ui-ppt-workbench/client/SlideSurface
 */

import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { PPT_THEMES, SLIDE_SIZES, type PptDeck, type PptElement, type PptPage } from 'coding-ppt-model'
import css from './SlideSurface.module.css'

/** 元素边框：位置与尺寸，单位是基准像素。 */
export interface ElementBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** 画布交互回调；缩略图不传时不可交互。 */
export interface SlideInteraction {
  readonly onSelect: (id: string | null) => void
  readonly onBeginEdit: (id: string) => void
  readonly onMove: (id: string, x: number, y: number) => void
  readonly onResize: (id: string, box: ElementBox) => void
}

/** 就地编辑草稿。 */
export interface SlideEditing {
  readonly id: string
  readonly content: string
  readonly onChange: (content: string) => void
  readonly onCommit: () => void
  readonly onCancel: () => void
}

export interface SlideSurfaceProps {
  readonly deck: PptDeck
  readonly page: PptPage
  /** 渲染宽度（CSS 像素）；内部按基准像素等比缩放。 */
  readonly width: number
  readonly selectedId?: string | null
  readonly editing?: SlideEditing | null
  readonly interaction?: SlideInteraction
  readonly emptyHint?: string
  /** 图片地址；缺省时不渲染图片内容。 */
  readonly mediaUrl?: (source: string) => string
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
type Handle = (typeof HANDLES)[number]

const HANDLE_POSITION: Record<Handle, CSSProperties> = {
  nw: { left: 0, top: 0, cursor: 'nwse-resize' },
  n: { left: '50%', top: 0, cursor: 'ns-resize' },
  ne: { left: '100%', top: 0, cursor: 'nesw-resize' },
  e: { left: '100%', top: '50%', cursor: 'ew-resize' },
  se: { left: '100%', top: '100%', cursor: 'nwse-resize' },
  s: { left: '50%', top: '100%', cursor: 'ns-resize' },
  sw: { left: 0, top: '100%', cursor: 'nesw-resize' },
  w: { left: 0, top: '50%', cursor: 'ew-resize' },
}

function alignOf(align: string): CSSProperties['justifyContent'] {
  return align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start'
}

function valignOf(valign: string): CSSProperties['alignItems'] {
  return valign === 'middle' ? 'center' : valign === 'bottom' ? 'flex-end' : 'flex-start'
}

function elementStyle(element: PptElement, box: ElementBox): CSSProperties {
  if (element.kind === 'line') {
    const length = Math.hypot(box.w, box.h)
    const angle = Math.atan2(box.h, box.w) * (180 / Math.PI)
    return {
      left: box.x, top: box.y, width: length, height: element.width,
      background: element.color, transform: `rotate(${angle}deg)`, transformOrigin: '0 50%',
    }
  }
  const style: CSSProperties = { left: box.x, top: box.y, width: box.w, height: box.h }
  if (element.kind === 'text') {
    Object.assign(style, {
      color: element.text.color,
      fontSize: element.text.size,
      lineHeight: 1.25,
      fontWeight: element.text.bold ? 700 : 400,
      textAlign: element.text.align,
      justifyContent: alignOf(element.text.align),
      alignItems: valignOf(element.text.valign),
    })
  } else if (element.kind === 'table') {
    const total = element.columnWeights.reduce((sum, weight) => sum + weight, 0)
    Object.assign(style, {
      display: 'grid',
      gridTemplateColumns: element.columnWeights.map(weight => `${weight / total}fr`).join(' '),
      gridTemplateRows: `repeat(${element.rows}, 1fr)`,
      border: `1px solid ${element.borderColor}`,
      fontSize: element.text.size,
      color: element.text.color,
      fontWeight: element.text.bold ? 700 : 400,
    })
  } else if (element.kind === 'image') {
    style.overflow = 'hidden'
  } else {
    style.background = element.fill
    if (element.kind === 'ellipse') style.borderRadius = '50%'
  }
  return style
}

/**
 * 渲染一页幻灯片。
 * @param props - 工程、页面、渲染宽度与可选交互。
 * @returns 等比缩放后的页面 DOM。
 */
export function SlideSurface({
  deck, page, width, selectedId, editing, interaction, emptyHint, mediaUrl,
}: SlideSurfaceProps) {
  const base = SLIDE_SIZES[deck.size]
  const theme = PPT_THEMES[deck.theme]
  const scale = width / base.width
  const background = page.background ?? theme.background
  const [draft, setDraft] = useState<{ id: string; box: ElementBox } | null>(null)
  const origin = useRef<{
    mode: 'move' | 'resize'
    handle?: Handle
    id: string
    pointerX: number
    pointerY: number
    box: ElementBox
  } | null>(null)

  const selected = page.elements.find(element => element.id === selectedId) ?? null
  const boxOf = (element: PptElement): ElementBox => (draft?.id === element.id ? draft.box : element)

  const beginMove = (element: PptElement) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (interaction === undefined || event.button !== 0) return
    event.stopPropagation()
    origin.current = {
      mode: 'move', id: element.id, pointerX: event.clientX, pointerY: event.clientY,
      box: { x: element.x, y: element.y, w: element.w, h: element.h },
    }
    interaction.onSelect(element.id)
  }

  const beginResize = (element: PptElement, handle: Handle) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (interaction === undefined || event.button !== 0) return
    event.stopPropagation()
    origin.current = {
      mode: 'resize', handle, id: element.id, pointerX: event.clientX, pointerY: event.clientY,
      box: { x: element.x, y: element.y, w: element.w, h: element.h },
    }
  }

  const drag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = origin.current
    if (start === null) return
    const dx = (event.clientX - start.pointerX) / scale
    const dy = (event.clientY - start.pointerY) / scale
    if (start.mode === 'move') {
      setDraft({
        id: start.id,
        box: { ...start.box, x: Math.round(start.box.x + dx), y: Math.round(start.box.y + dy) },
      })
      return
    }
    const handle = start.handle ?? 'se'
    let { x, y, w, h } = start.box
    if (handle.includes('e')) w = Math.max(8, Math.round(start.box.w + dx))
    if (handle.includes('s')) h = Math.max(8, Math.round(start.box.h + dy))
    if (handle.includes('w')) {
      w = Math.max(8, Math.round(start.box.w - dx))
      x = Math.round(start.box.x + (start.box.w - w))
    }
    if (handle.includes('n')) {
      h = Math.max(8, Math.round(start.box.h - dy))
      y = Math.round(start.box.y + (start.box.h - h))
    }
    setDraft({ id: start.id, box: { x, y, w, h } })
  }

  const end = (): void => {
    const start = origin.current
    const current = draft
    origin.current = null
    setDraft(null)
    if (start === null || current === null || interaction === undefined) return
    if (start.mode === 'move') interaction.onMove(start.id, current.box.x, current.box.y)
    else interaction.onResize(start.id, current.box)
  }

  const rendering = editing ?? null
  return (
    <div className={css.frame} style={{ width, height: Math.round(base.height * scale) }}>
      <div
        className={css.surface}
        style={{ width: base.width, height: base.height, transform: `scale(${scale})`, background }}
        onPointerDown={() => { interaction?.onSelect(null) }}
      >
        {page.elements.length === 0 && emptyHint !== undefined
          ? <p className={css.empty} style={{ fontSize: 28, color: theme.muted }}>{emptyHint}</p>
          : null}
        {page.elements.map((element) => {
          const box = boxOf(element)
          const style = elementStyle(element, box)
          const isEditing = rendering?.id === element.id
          if (isEditing && element.kind === 'text') {
            return (
              <textarea
                key={element.id}
                className={css.editor}
                style={{ ...style, color: element.text.color, fontSize: element.text.size }}
                value={rendering.content}
                autoFocus
                onChange={(event) => { rendering.onChange(event.target.value) }}
                onBlur={() => { rendering.onCommit() }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') { event.preventDefault(); rendering.onCancel() }
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    rendering.onCommit()
                  }
                }}
              />
            )
          }
          return (
            <div
              key={element.id}
              data-element-id={element.id}
              data-element-kind={element.kind}
              className={`${css.element} ${element.kind === 'text' ? css.text : ''}`}
              style={style}
              onPointerDown={beginMove(element)}
              onPointerMove={drag}
              onPointerUp={end}
              onPointerCancel={end}
              onDoubleClick={() => interaction?.onBeginEdit(element.id)}
            >
              {element.kind === 'text' ? element.text.content : null}
              {element.kind === 'image' && mediaUrl !== undefined
                ? (
                  <img
                    className={css.image}
                    style={{ objectFit: element.fit }}
                    src={mediaUrl(element.source)}
                    alt=""
                    draggable={false}
                  />
                )
                : null}
              {element.kind === 'table'
                ? element.cells.map((row, rowIndex) => row.map((cell, columnIndex) => (
                  <span
                    key={`${rowIndex}-${columnIndex}`}
                    className={css.cell}
                    data-header={element.header && rowIndex === 0 ? 'true' : undefined}
                    style={{
                      borderColor: element.borderColor,
                      background: element.header && rowIndex === 0 ? element.headerFill : 'transparent',
                      justifyContent: alignOf(element.text.align),
                    }}
                  >
                    {cell.content}
                  </span>
                )))
                : null}
            </div>
          )
        })}
        {selected === null || interaction === undefined ? null : (
          <div
            className={css.selection}
            data-selected-id={selected.id}
            style={{
              left: boxOf(selected).x - 2,
              top: boxOf(selected).y - 2,
              width: boxOf(selected).w + 4,
              height: boxOf(selected).h + 4,
            }}
          >
            {HANDLES.map(handle => (
              <div
                key={handle}
                className={css.handle}
                data-handle={handle}
                style={HANDLE_POSITION[handle]}
                onPointerDown={beginResize(selected, handle)}
                onPointerMove={drag}
                onPointerUp={end}
                onPointerCancel={end}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

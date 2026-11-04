/**
 * 幻灯片渲染：把页面元素画成 DOM（矢量、秒出），坐标系与导出的 .pptx 一致。
 * 面板画布与缩略图共用这里，因此「所见」与「导出」不会各自演化出两套版式。
 * @module coding-ppt-workbench/client/SlideSurface
 */

import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { PPT_THEMES, SLIDE_SIZES, type PptDeck, type PptElement, type PptPage } from 'coding-ppt-model'
import css from './SlideSurface.module.css'

/** 拖拽提交：把元素左上角移动到基准像素坐标。 */
export type MoveHandler = (id: string, x: number, y: number) => void

/** 画布交互回调；缩略图不传时不可交互。 */
export interface SlideInteraction {
  readonly onSelect: (id: string | null) => void
  readonly onBeginEdit: (id: string) => void
  readonly onMove: MoveHandler
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
}

function alignOf(align: string): CSSProperties['justifyContent'] {
  return align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start'
}

function valignOf(valign: string): CSSProperties['alignItems'] {
  return valign === 'middle' ? 'center' : valign === 'bottom' ? 'flex-end' : 'flex-start'
}

function elementStyle(element: PptElement, offset: { x: number; y: number } | null): CSSProperties {
  const x = offset?.x ?? element.x
  const y = offset?.y ?? element.y
  if (element.kind === 'line') {
    const length = Math.hypot(element.w, element.h)
    const angle = Math.atan2(element.h, element.w) * (180 / Math.PI)
    return {
      left: x, top: y, width: length, height: element.width,
      background: element.color, transform: `rotate(${angle}deg)`,
      transformOrigin: '0 50%',
    }
  }
  const style: CSSProperties = { left: x, top: y, width: element.w, height: element.h }
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
  deck, page, width, selectedId, editing, interaction, emptyHint,
}: SlideSurfaceProps) {
  const base = SLIDE_SIZES[deck.size]
  const scale = width / base.width
  const background = page.background ?? PPT_THEMES[deck.theme].background
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null)
  const origin = useRef<{ id: string; pointerX: number; pointerY: number; x: number; y: number } | null>(null)

  const beginDrag = (element: PptElement) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (interaction === undefined || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    origin.current = {
      id: element.id, pointerX: event.clientX, pointerY: event.clientY, x: element.x, y: element.y,
    }
    interaction.onSelect(element.id)
  }

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = origin.current
    if (start === null || interaction === undefined) return
    const x = Math.round(start.x + (event.clientX - start.pointerX) / scale)
    const y = Math.round(start.y + (event.clientY - start.pointerY) / scale)
    setDrag({ id: start.id, x, y })
  }

  const endDrag = () => {
    const start = origin.current
    origin.current = null
    const current = drag
    setDrag(null)
    if (start !== null && current !== null && interaction !== undefined) {
      interaction.onMove(start.id, current.x, current.y)
    }
  }

  const rendering = editing === undefined || editing === null ? null : editing
  return (
    <div className={css.frame} style={{ width, height: Math.round(base.height * scale) }}>
      <div
        className={css.surface}
        style={{ width: base.width, height: base.height, transform: `scale(${scale})`, background }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) interaction?.onSelect(null)
        }}
      >
        {page.elements.length === 0 && emptyHint !== undefined
          ? <p className={css.empty} style={{ fontSize: 28, color: PPT_THEMES[deck.theme].muted }}>{emptyHint}</p>
          : null}
        {page.elements.map((element) => {
          const offset = drag?.id === element.id ? drag : null
          const style = elementStyle(element, offset)
          const content = element.kind === 'text' ? element.text.content : ''
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
              className={`${css.element} ${element.kind === 'text' ? css.text : ''}`}
              style={style}
              onPointerDown={beginDrag(element)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onDoubleClick={() => interaction?.onBeginEdit(element.id)}
            >
              {content}
            </div>
          )
        })}
        {selectedId === undefined || selectedId === null ? null : (
          <div
            className={css.selection}
            data-selected-id={selectedId}
            style={selectionStyle(page.elements.find(element => element.id === selectedId) ?? null, drag)}
          />
        )}
      </div>
    </div>
  )
}

function selectionStyle(
  element: PptElement | null,
  drag: { id: string; x: number; y: number } | null,
): CSSProperties {
  if (element === null) return { display: 'none' }
  const offset = drag?.id === element.id ? drag : null
  const x = offset?.x ?? element.x
  const y = offset?.y ?? element.y
  return { left: x - 2, top: y - 2, width: element.w + 4, height: element.h + 4 }
}

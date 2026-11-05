/** 画布只消费会话文档节点；指针局部轨迹在完成时作为一条保存操作提交。 */
import { useEffect, useRef, useState } from 'react'
import { Button, Icon, IconTrashOutline16 } from 'coding-client-ui-primitives'
import type { InjectFace, PropsLocale } from 'coding-client-ui-slots'
import type { CanvasFace } from './canvas.ts'
import type { CanvasNode, ImageNode, StrokeNode } from './wire.ts'
import { NS } from './locales.ts'
import css from './CanvasPanel.module.css'

const WIDTH = 960
const HEIGHT = 640
type Tool = 'select' | 'pencil' | 'eraser'

/** 主画廊工作台的会话画布操作面。 */
export type CanvasSurfaceProps = PropsLocale<typeof NS> & InjectFace<CanvasFace> & { shown: boolean }
/** 画布组件测试沿用的形状。 */
export type CanvasPanelProps = CanvasSurfaceProps

/**
 * 原生 Canvas 2D 按节点顺序重放；图片解码失败仅影响该图片，不丢弃其他画迹。
 * @param surface - Canvas 元素。
 * @param nodes - 已保存或待保存的画布节点。
 * @param image - 仅生成同会话受限图片地址。
 * @returns 图片加载后的清理函数，避免卸载后的绘制。
 */
function draw(surface: HTMLCanvasElement, nodes: CanvasNode[], image: (id: string) => string,
  preview: () => StrokeNode | null): () => void {
  const context = surface.getContext('2d')
  if (context === null) return () => {}
  let active = true
  const loaded = new Map<string, HTMLImageElement>()
  const redraw = () => {
    if (!active) return
    context.clearRect(0, 0, WIDTH, HEIGHT)
    const pending = preview()
    for (const node of pending === null ? nodes : [...nodes, pending]) {
      if (node.type === 'image') {
        const loadedImage = loaded.get(node.imageId)
        if (loadedImage?.complete && loadedImage.naturalWidth > 0) {
          context.drawImage(loadedImage, node.x, node.y, node.width, node.height)
        }
        continue
      }
      const first = node.points[0]
      if (first === undefined) continue
      context.save()
      context.globalCompositeOperation = node.erase ? 'destination-out' : 'source-over'
      context.strokeStyle = getComputedStyle(surface).getPropertyValue('--dsw-alias-label-primary')
      context.fillStyle = context.strokeStyle
      context.lineWidth = node.width
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.beginPath()
      context.moveTo(first.x, first.y)
      for (const point of node.points.slice(1)) context.lineTo(point.x, point.y)
      if (node.points.length === 1) { context.arc(first.x, first.y, node.width / 2, 0, Math.PI * 2); context.fill() }
      else context.stroke()
      context.restore()
    }
  }
  for (const node of nodes) {
    if (node.type !== 'image' || loaded.has(node.imageId)) continue
    const element = new Image()
    element.onload = redraw
    element.src = image(node.imageId)
    loaded.set(node.imageId, element)
  }
  redraw()
  return () => { active = false; for (const element of loaded.values()) element.onload = null }
}

/** 画布坐标始终由元素实际尺寸投影至固定逻辑尺寸。 */
function pointOf(event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
  const box = event.currentTarget.getBoundingClientRect()
  return {
    x: Math.max(0, Math.min(WIDTH, (event.clientX - box.left) * WIDTH / box.width)),
    y: Math.max(0, Math.min(HEIGHT, (event.clientY - box.top) * HEIGHT / box.height)),
  }
}

/** 图片的选区只包含矩形范围；笔迹不参与移动。 */
function imageAt(nodes: CanvasNode[], point: { x: number; y: number }): ImageNode | undefined {
  return nodes.findLast((node): node is ImageNode => node.type === 'image'
    && point.x >= node.x && point.x <= node.x + node.width && point.y >= node.y && point.y <= node.y + node.height)
}

/**
 * 画笔、橡皮、清空和图片选区与会话保存同处一面板。
 * @param props - 画布状态、显隐和操作回调。
 * @returns 主工作台的画布内容。
 */
export function CanvasSurface({ shown, useImageCanvas, show, refresh, add, select, move, remove, clear, url, t }: CanvasSurfaceProps) {
  const state = useImageCanvas(s => s)
  const [tool, setTool] = useState<Tool>('pencil')
  const canvas = useRef<HTMLCanvasElement>(null)
  const stroke = useRef<StrokeNode | null>(null)
  const redraw = useRef<() => void>(() => {})
  const frame = useRef<number | null>(null)
  const moving = useRef<{ id: string; x: number; y: number; originalX: number; originalY: number } | null>(null)
  useEffect(() => { if (!shown) return; show(true); return () => { show(false) } }, [shown, show])
  useEffect(() => {
    if (state.phase !== 'ready' || canvas.current === null) return
    const release = draw(canvas.current, state.nodes, url, () => stroke.current)
    redraw.current = () => {
      if (canvas.current !== null) {
        const context = canvas.current.getContext('2d')
        if (context === null || stroke.current === null) return
        const points = stroke.current.points
        const last = points.at(-1)
        const before = points.at(-2)
        if (last === undefined) return
        context.save()
        context.globalCompositeOperation = stroke.current.erase ? 'destination-out' : 'source-over'
        context.strokeStyle = getComputedStyle(canvas.current).getPropertyValue('--dsw-alias-label-primary')
        context.fillStyle = context.strokeStyle
        context.lineWidth = stroke.current.width
        context.lineCap = 'round'
        context.beginPath()
        context.moveTo(before?.x ?? last.x, before?.y ?? last.y)
        if (before === undefined) { context.arc(last.x, last.y, stroke.current.width / 2, 0, Math.PI * 2); context.fill() }
        else { context.lineTo(last.x, last.y); context.stroke() }
        context.restore()
      }
    }
    return () => { if (frame.current !== null) cancelAnimationFrame(frame.current); release() }
  }, [state.nodes, state.phase, url])
  const selected = state.nodes.find(node => node.id === state.selectedId && node.type === 'image') as ImageNode | undefined
  const begin = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (state.phase !== 'ready' || state.issue === 'conflict') return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointOf(event)
    if (tool === 'select') {
      const hit = imageAt(state.nodes, point)
      select(hit?.id ?? null)
      if (hit !== undefined) moving.current = { id: hit.id, x: point.x, y: point.y, originalX: hit.x, originalY: hit.y }
    } else {
      stroke.current = { id: crypto.randomUUID(), type: 'stroke', points: [point], width: tool === 'eraser' ? 24 : 4,
        color: 'ink', ...(tool === 'eraser' ? { erase: true } : {}) }
      redraw.current()
    }
  }
  const progress = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (stroke.current === null || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    if (stroke.current.points.length >= 2000) return
    stroke.current.points.push(pointOf(event))
    if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; redraw.current() })
  }
  const end = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const finished = stroke.current
    stroke.current = null
    if (finished !== null) void add(finished)
    const dragging = moving.current
    moving.current = null
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    if (dragging !== null) {
      const point = pointOf(event)
      if (point.x !== dragging.x || point.y !== dragging.y) {
        void move(dragging.id, dragging.originalX + point.x - dragging.x, dragging.originalY + point.y - dragging.y)
      }
    }
  }
  return <section className={css.root} aria-label={t('canvas')}>
    <div className={css.toolbar} role="toolbar" aria-label={t('canvas')}>
      <strong className={css.title}><Icon name="model-vision" size={16} />{t('canvas')}</strong>
      {(['select', 'pencil', 'eraser'] as const).map(name => <Button key={name} size="sm"
        aria-pressed={tool === name} disabled={state.phase !== 'ready'} onClick={() => { setTool(name) }}>{t(name)}</Button>)}
      <Button size="sm" aria-label={t('clear')} title={t('clear')} disabled={state.phase !== 'ready' || !state.nodes.length}
        onClick={() => { void clear() }}><IconTrashOutline16 size={16} /></Button>
    </div>
    {state.phase === 'loading' && <p role="status" className={css.notice}>{t('canvasLoading')}</p>}
    {state.phase === 'error' && <div className={css.notice} role="alert">{t('canvasUnavailable')}
      <Button size="sm" onClick={refresh}>{t('retry')}</Button></div>}
    {state.issue !== null && <div className={css.notice} role="alert">
      {t(state.issue === 'conflict' ? 'canvasConflict' : 'canvasSaveFailed')}
      <Button size="sm" onClick={refresh}>{t('retry')}</Button>
    </div>}
    <div className={css.surface}>
      {state.phase === 'ready' && state.nodes.length === 0 && <p className={css.empty}>{t('canvasEmpty')}</p>}
      <canvas ref={canvas} className={css.canvas} width={WIDTH} height={HEIGHT}
        aria-label={t('canvas')} style={{ touchAction: 'none' }}
        onPointerDown={begin} onPointerMove={progress} onPointerUp={end}
        onPointerCancel={() => {
          stroke.current = null; moving.current = null
          if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
          refresh()
        }} />
      {selected !== undefined && <p className={css.selected} role="status">{t('selectedImage')}</p>}
    </div>
    {selected !== undefined && <Button size="sm" disabled={state.saving} onClick={() => { void remove() }}>{t('remove')}</Button>}
  </section>
}

/** 兼容包内直接挂载画布的测试与调用方。 */
export function CanvasPanel(props: CanvasPanelProps) { return <CanvasSurface {...props} /> }

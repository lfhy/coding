/** 主进程独占的指针显示层；租约切换不改变其原生命中与绘制状态。 */
import { randomUUID } from 'node:crypto'
import { BaseWindow, WebContentsView, type BrowserWindow } from 'electron'
import { POINTER_PATH, POINTER_TIP } from './browser-pointer-shape.ts'

const SIZE = 32
const HOTSPOT = { x: POINTER_TIP.x * SIZE / 1024, y: POINTER_TIP.y * SIZE / 1024 }

const document = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
html,body { margin:0; width:100%; height:100%; overflow:hidden; background:transparent; }
#cursor { position:absolute; left:0; top:0; display:none; pointer-events:none; }
#pointer { width:${SIZE}px; height:${SIZE}px; overflow:visible; filter:drop-shadow(0 0 3px rgba(68,175,255,.95)) drop-shadow(0 0 7px rgba(68,175,255,.55)) drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
#pointer path { fill:rgba(44,44,44,.9); stroke:rgba(255,255,255,.95); stroke-width:36; stroke-linejoin:round; paint-order:stroke fill; }
#trail { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; overflow:visible; }
#trail path { fill:none; stroke-linecap:round; stroke-linejoin:round; }
#trail .outline { stroke:rgba(255,255,255,.75); stroke-width:5; opacity:.7; }
#trail .ink { stroke:rgba(44,44,44,.7); stroke-width:2.5; opacity:.65; }
#pulse { position:absolute; left:-11px; top:-11px; width:26px; height:26px; border:2px solid rgba(44,44,44,.55); border-radius:50%; opacity:0; }
#cursor[data-action] #pulse { animation:pulse 220ms ease-out; }
#cursor[data-action=click] #pointer { transform:scale(.85); }
#cursor[data-action=fill] #pointer { transform:rotate(-10deg); }
#cursor[data-action=scroll] #pointer { transform:translateY(4px); }
@media (prefers-reduced-motion:reduce) { #cursor[data-action] #pulse { animation:none; opacity:.65; } }
@keyframes pulse { from { opacity:.85; transform:scale(.5); } to { opacity:0; transform:scale(1.8); } }
</style><svg id="trail"><path class="outline"/><path class="ink"/></svg><div id="cursor"><svg id="pointer" viewBox="0 0 1024 1024"><path d="${POINTER_PATH}"/></svg><div id="pulse"></div></div>
<script>
const cursor=document.getElementById('cursor'), trail=document.getElementById('trail');
const paths=trail.querySelectorAll('path');
let position=null, epoch=0;
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const place=(point)=>{
  cursor.style.transform='translate('+(point.x-${HOTSPOT.x})+'px,'+(point.y-${HOTSPOT.y})+'px)';
  position=point;
  cursor.style.display='block';
};
const frame=()=>new Promise(resolve=>{
  const timer=setTimeout(()=>resolve(performance.now()),100);
  requestAnimationFrame(time=>{clearTimeout(timer);resolve(time)});
});
globalThis.moveCursor=async(x,y,action)=>{
  const token=++epoch;
  // 首个动作有明确目的地但没有已知起点时，直接出现于目标，不虚构中心轨迹。
  if(!position) place({x,y});
  if(action) {
    place({x,y});
    cursor.removeAttribute('data-action'); void cursor.offsetWidth; cursor.dataset.action=action;
    await new Promise(resolve=>setTimeout(resolve,reduced()?100:160));
    return;
  }
  cursor.removeAttribute('data-action');
  if(reduced()||position.x===x&&position.y===y) { place({x,y}); return; }
  const start={...position}, points=[];
  const dx=x-start.x, dy=y-start.y, distance=Math.hypot(dx,dy);
  const bend=Math.min(32,distance*.12);
  const began=await frame();
  const deadline=setTimeout(()=>{ if(token===epoch) { epoch++; place({x,y}); trail.style.opacity='0'; paths.forEach(path=>path.setAttribute('d','')); } },1000);
  let now=began;
  while(token===epoch) {
    const progress=Math.min(1,(now-began)/300), eased=1-Math.pow(1-progress,3);
    const arc=Math.sin(eased*Math.PI)*bend;
    const point=progress===1?{x,y}:{x:start.x+dx*eased-(distance?dy/distance:0)*arc,
      y:start.y+dy*eased+(distance?dx/distance:0)*arc};
    place(point); points.push(point);
    const d=points.map((p,i)=>(i?'L':'M')+p.x.toFixed(2)+' '+p.y.toFixed(2)).join(' ');
    paths.forEach(path=>path.setAttribute('d',d)); trail.style.opacity='1';
    if(progress===1) break;
    now=await frame();
  }
  clearTimeout(deadline);
  if(token!==epoch) return;
  const ended=await frame(); now=ended;
  while(token===epoch && now-ended<100) {
    trail.style.opacity=String(1-(now-ended)/100); now=await frame();
  }
  if(token===epoch) { trail.style.opacity='0'; paths.forEach(path=>path.setAttribute('d','')); }
};
</script>`

/** guest 在宿主内容区内的矩形，以及指针在 guest 视口内的 CSS 坐标。 */
export interface CursorPlacement {
  bounds: { x: number; y: number; width: number; height: number }
  point: { x: number; y: number }
}

/**
 * 创建原生点击穿透的常驻指针窗口，唯一持有箭头和轨迹；租约输入屏障不绘制指针。
 * 显示层失败只移除自己，调用方继续管理 guest 和输入屏障。
 * @param parent - 拥有 guest 的宿主窗口。
 * @returns 移动、操作反馈、更新位置、查询存活及销毁指针窗口的操作。
 */
export function createBrowserCursorOverlay(parent: BrowserWindow) {
  const window = new BaseWindow({ parent, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', focusable: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false })
  const view = (() => {
    try {
      return new WebContentsView({ webPreferences: {
        partition: `dsh-browser-cursor-${randomUUID()}`, sandbox: true, contextIsolation: true,
        nodeIntegration: false, webSecurity: true, webviewTag: false, devTools: false,
        backgroundThrottling: false,
      } })
    } catch (error) {
      try { window.destroy() } catch { /* 构造失败的窗口可能已经不可用。 */ }
      throw error
    }
  })()
  const wc = view.webContents
  let closed = false
  let loaded = false
  let shown = false
  let hidden = false
  let current: CursorPlacement | undefined
  let lastBounds: { x: number; y: number; width: number; height: number } | undefined
  const position = (): boolean => {
    if (closed || !current || parent.isDestroyed() || window.isDestroyed()) return false
    const { bounds, point } = current
    if (bounds.width <= 0 || bounds.height <= 0 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
    const content = parent.getContentBounds()
    const next = { x: content.x + bounds.x, y: content.y + bounds.y,
      width: bounds.width, height: bounds.height }
    if (lastBounds && Object.keys(next).every(key => next[key as keyof typeof next] ===
      lastBounds?.[key as keyof typeof next])) return true
    window.setBounds(next)
    view.setBounds({ x: 0, y: 0, width: next.width, height: next.height })
    lastBounds = next
    return true
  }
  const clean = (run: () => void): void => { try { run() } catch { /* 展示层失败不应影响 guest。 */ } }
  const onPosition = (): void => { try { position() } catch { dispose() } }
  const hideWithParent = (): void => {
    hidden = true
    shown = false
    if (!closed && !window.isDestroyed()) {
      try { window.hide() } catch { dispose() }
    }
  }
  const showIfReady = (): void => {
    if (closed || !loaded || !current || parent.isDestroyed() || window.isDestroyed() || hidden || !parent.isVisible()) return
    let valid = false
    try { valid = position() } catch { dispose(); return }
    if (!valid || shown) return
    try {
      window.showInactive()
      shown = true
    } catch { dispose() }
  }
  const showWithParent = (): void => { hidden = false; showIfReady() }
  const dispose = (): void => {
    if (closed) return
    closed = true
    current = undefined
    clean(() => parent.removeListener('move', onPosition))
    clean(() => parent.removeListener('resize', onPosition))
    clean(() => parent.removeListener('show', showWithParent))
    clean(() => parent.removeListener('restore', showWithParent))
    clean(() => parent.removeListener('hide', hideWithParent))
    clean(() => parent.removeListener('minimize', hideWithParent))
    clean(() => parent.removeListener('closed', dispose))
    clean(() => window.removeListener('closed', dispose))
    // BaseWindow 不自动关闭所附视图的 webContents；两项原生资源分别释放。
    clean(() => { if (!wc.isDestroyed()) wc.close() })
    clean(() => { if (!window.isDestroyed()) window.destroy() })
  }
  try {
    window.setIgnoreMouseEvents(true)
    view.setBackgroundColor('#00000000')
    window.contentView.addChildView(view)
    parent.on('move', onPosition)
    parent.on('resize', onPosition)
    parent.on('show', showWithParent)
    parent.on('restore', showWithParent)
    parent.on('hide', hideWithParent)
    parent.on('minimize', hideWithParent)
    parent.on('closed', dispose)
    window.on('closed', dispose)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    wc.session.setPermissionCheckHandler(() => false)
    wc.session.on('will-download', (event) => { event.preventDefault() })
    wc.on('will-navigate', (event) => { event.preventDefault() })
    wc.on('render-process-gone', dispose)
    wc.on('destroyed', dispose)
    const ready = wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`)
    void ready.then(() => {
      if (closed) return
      loaded = true
      showIfReady()
    }).catch(dispose)
    return {
      get alive() { return !closed },
      show(placement: CursorPlacement): void {
        if (closed) return
        current = placement
        if (shown) onPosition()
        else showIfReady()
      },
      async move(point: { x: number; y: number }, action?: 'click' | 'fill' | 'scroll'): Promise<void> {
        if (closed) return
        try {
          await ready
          if (!window.isDestroyed()) await wc.executeJavaScript(`globalThis.moveCursor(${JSON.stringify(point.x)},${JSON.stringify(point.y)},${JSON.stringify(action ?? null)})`)
        } catch { dispose() }
      },
      dispose,
    }
  } catch (error) {
    dispose()
    throw error
  }
}

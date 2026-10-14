/** 主进程独占的原生输入覆盖视图；它不属于 guest 文档或模型观测。 */
import { randomUUID } from 'node:crypto'
import { BrowserWindow, WebContentsView } from 'electron'

/** 指针图形来自用户给定的 1024 视图框箭头；把笔尖平移到原点后落在光标坐标上。 */
const POINTER_PATH = 'M847.127273 633.018182L195.490909 32.581818C181.527273 18.618182 158.254545 13.963636 144.290909 23.272727c-18.618182 9.309091-32.581818 23.272727-32.581818 46.545455v884.363636c0 18.618182 13.963636 41.890909 32.581818 46.545455 4.654545 0 13.963636 4.654545 18.618182 4.654545 13.963636 0 27.927273-4.654545 37.236364-18.618182l246.690909-269.963636 367.709091 4.654545c18.618182 0 37.236364-13.963636 46.545454-32.581818 4.654545-18.618182 0-41.890909-13.963636-55.854545z'
const POINTER_TIP = { x: 144.290909, y: 23.272727 }

function buildDocument(initialPosition?: { x: number; y: number }): string {
  const initialPoint = initialPosition ? JSON.stringify(initialPosition) : 'null'
  return `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<style>
:root { color-scheme: light dark; }
html,body { margin:0; width:100%; height:100%; overflow:hidden; background:transparent; cursor:not-allowed; }
#cursor { position:absolute; left:0; top:0; pointer-events:none; display:none; }
#pointer { width:32px; height:32px; overflow:visible; transform-origin:0 0; filter:drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
#pointer path { fill:rgba(44,44,44,.9); stroke:rgba(255,255,255,.85); stroke-width:28; stroke-linejoin:round; paint-order:stroke fill; }
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
</style><svg id="trail"><path class="outline"/><path class="ink"/></svg><div id="cursor"><svg id="pointer" viewBox="0 0 1024 1024"><path transform="translate(${-POINTER_TIP.x} ${-POINTER_TIP.y})" d="${POINTER_PATH}"/></svg><div id="pulse"></div></div>
<script>
const cursor=document.getElementById('cursor'), trail=document.getElementById('trail');
const paths=trail.querySelectorAll('path');
let position=${initialPoint}, epoch=0;
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const place=(point)=>{ cursor.style.transform='translate('+point.x+'px,'+point.y+'px)'; position=point; };
const clamp=(point)=>({x:Math.min(Math.max(point.x,0),Math.max(innerWidth-1,0)),
  y:Math.min(Math.max(point.y,0),Math.max(innerHeight-1,0))});
const frame=()=>new Promise(resolve=>{
  const timer=setTimeout(()=>resolve(performance.now()),100);
  requestAnimationFrame(time=>{clearTimeout(timer);resolve(time)});
});
globalThis.moveCursor=async(x,y,action)=>{
  const token=++epoch;
  cursor.style.display='block';
  // 上一次动作留下的位置优先；只有完全没有记录时才退回视口中心。
  if(position) place(clamp(position));
  else place({x:innerWidth/2,y:innerHeight/2});
  if(action) {
    place({x,y});
    cursor.removeAttribute('data-action'); void cursor.offsetWidth; cursor.dataset.action=action;
    await new Promise(resolve=>setTimeout(resolve,reduced()?100:160));
    return;
  }
  cursor.removeAttribute('data-action');
  if(reduced()) { paths.forEach(path=>path.setAttribute('d','')); place({x,y}); return; }
  const start={...position}, points=[];
  const dx=x-start.x, dy=y-start.y, distance=Math.hypot(dx,dy);
  const bend=Math.min(32,distance*.12);
  const began=await frame();
  const deadline=setTimeout(()=>{ if(token===epoch) { epoch++; place({x,y}); trail.style.opacity='0'; } },1000);
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
}

/**
 * 创建不可由 guest 操纵的透明原生视图，原生 hit-test 与焦点接收人工输入。
 * @param window - 拥有该视图的窗口。
 * @param onFailure - 加载失败或原生页面丢失时立即卸载 guest 的 fail-closed 回调。
 * @returns 覆盖层的附着、动画和销毁操作；调用方负责租约与页面复核。
 */
export function createBrowserInputOverlay(window: BrowserWindow, onFailure: () => void, initialPosition?: { x: number; y: number }) {
  const view = new WebContentsView({ webPreferences: {
    partition: `dsh-browser-overlay-${randomUUID()}`, sandbox: true, contextIsolation: true,
    nodeIntegration: false, webSecurity: true, webviewTag: false, devTools: false,
    backgroundThrottling: false,
  } })
  const wc = view.webContents
  try {
    view.setBackgroundColor('#00000000')
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    wc.session.setPermissionCheckHandler(() => false)
    wc.session.on('will-download', (event) => { event.preventDefault() })
    wc.on('will-navigate', (event) => { event.preventDefault() })
    wc.on('before-input-event', (event) => { event.preventDefault() })
    wc.on('before-mouse-event', (event) => { event.preventDefault() })
    let attached = false
    let closed = false
    const usable = (): boolean => attached && !closed
    const failed = () => { if (!closed) onFailure() }
    wc.on('render-process-gone', failed)
    wc.on('destroyed', failed)
    const ready = wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildDocument(initialPosition))}`)
    // 加载失败或进程丢失时立即卸载 guest，不保留无法验证的输入屏障。
    void ready.catch(failed)
    return {
      view,
      ready,
      attach(bounds: { x: number; y: number; width: number; height: number }) {
        if (closed) throw new Error('browser input overlay closed')
        view.setBounds(bounds)
        if (!attached) { window.contentView.addChildView(view); attached = true }
        wc.focus()
      },
      async move(x: number, y: number, action?: 'click' | 'fill' | 'scroll') {
        if (!usable()) return
        await ready
        if (!usable()) return
        await wc.executeJavaScript(`globalThis.moveCursor(${JSON.stringify(x)},${JSON.stringify(y)},${JSON.stringify(action ?? null)})`)
      },
      close() {
        if (closed) return
        closed = true
        if (attached && !window.isDestroyed() && window.contentView.children.includes(view)) {
          window.contentView.removeChildView(view)
        }
        attached = false
        if (!wc.isDestroyed()) wc.close()
      },
    }
  } catch (error) {
    if (!wc.isDestroyed()) wc.close()
    throw error
  }
}

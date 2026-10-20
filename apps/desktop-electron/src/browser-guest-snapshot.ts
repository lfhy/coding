/** 隔离世界中的浏览器页面观测脚本与其返回类型；脚本只保存页面内引用，不暴露主进程对象。 */

/**
 * 在 guest 页面中收集文本、可操作元素和 DOM 修订号；调用方负责在主进程隔离世界执行。
 * 仅隔离世界保存元素引用，页面脚本无法获取 Map 或伪造跨观测版本的 ref。
 */
export const snapshotScript = `(function () {
  const root = globalThis;
  root.__dshGuestMutationRevision ??= 0;
  root.__dshGuestObservers?.forEach(observer => observer.disconnect());
  const observers = new Map();
  const scanRoots = () => {
    const pending = [document]; let scanned = 0; let truncated = false;
    while (pending.length && scanned < 50000) {
      const tree = pending.pop();
      if (!observers.has(tree)) {
        const observer = new MutationObserver(() => { root.__dshGuestMutationRevision++; });
        observer.observe(tree, { subtree: true, childList: true, attributes: true, characterData: true });
        observers.set(tree, observer);
        if (tree !== document) root.__dshGuestMutationRevision++;
      }
      const walker = document.createTreeWalker(tree, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        if (++scanned > 50000) { truncated = true; break; }
        if (walker.currentNode.shadowRoot) pending.push(walker.currentNode.shadowRoot);
      }
    }
    if (pending.length) truncated = true;
    for (const observer of observers.values()) {
      if (observer.takeRecords().length) root.__dshGuestMutationRevision++;
    }
    root.__dshGuestObserverIncomplete = truncated;
    return root.__dshGuestMutationRevision;
  };
  root.__dshGuestObservers = observers;
  root.__dshGuestReadMutationRevision = scanRoots;
  scanRoots();
  root.__dshGuestRefs?.forEach(ref => ref.observer?.disconnect());
  const refs = new Map(); const entries = [];
  const ACTIONABLE = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="textbox"]';
  const BLOCKING = '[inert], [aria-disabled="true"]';
  // 语义属性：改变它们可能改变点击的后果（提交目标、下载、导航、禁用状态）。
  const SEMANTIC = ['role', 'id', 'type', 'name', 'value', 'href', 'ping', 'target', 'rel', 'download', 'hreflang',
    'disabled', 'readonly', 'required', 'tabindex', 'contenteditable', 'inert', 'placeholder', 'title', 'for',
    'accept', 'multiple', 'checked', 'selected', 'form', 'formaction', 'formmethod', 'formtarget', 'formenctype',
    'formnovalidate', 'autocomplete', 'inputmode', 'spellcheck', 'dir', 'lang'];
  const sortAttributes = attributes => attributes.sort((left, right) => left[0].localeCompare(right[0]));
  const semantic = el => sortAttributes(Array.from(el.attributes, attr => [attr.name, attr.value])
    .filter(([name]) => name.startsWith('on') || name.startsWith('aria-') || SEMANTIC.includes(name)));
  // 祖先只比事件处理器与 inert：包装层的 class/style 会随动画和主题抖动。
  const handlers = node => sortAttributes(Array.from(node.attributes, attr => [attr.name, attr.value])
    .filter(([name]) => name.startsWith('on') || name === 'inert'));
  const path = el => {
    const chain = [];
    for (let node = el; node && node !== document; node = node.parentNode || node.host) {
      if (node.nodeType === Node.ELEMENT_NODE) chain.push({ node, parent: node.parentNode, attributes: handlers(node) });
    }
    return chain;
  };
  // 子树里新增的事件处理器会改变冒泡行为，其余子树更新与点击含义无关。
  const subtreeHandlers = el => {
    const found = []; let nodes = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      if (++nodes > 200) return null;
      const node = walker.currentNode;
      for (const attr of Array.from(node.attributes)) {
        if (attr.name.startsWith('on')) found.push(node.tagName + ':' + attr.name + '=' + attr.value);
      }
    }
    return found.sort();
  };
  const identity = el => ({ tag: el.tagName,
    attributes: semantic(el),
    role: el.getAttribute('role'), id: el.getAttribute('id'),
    // 名称只取属性来源：按钮里的计数、徽标或加载文案会随轮询变化，不代表目标换了含义。
    name: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '',
    value: 'value' in el && typeof el.value === 'string' ? el.value : undefined,
    href: el.href || el.getAttribute('href'), form: el.form?.id,
    action: el.hasAttribute('formaction') ? el.formAction : el.form?.action,
    method: el.hasAttribute('formmethod') ? el.formMethod : el.form?.method,
    target: el.hasAttribute('formtarget') ? el.formTarget : el.form?.target || el.getAttribute('target'),
    enctype: el.hasAttribute('formenctype') ? el.formEnctype : el.form?.enctype,
    noValidate: !!(el.form?.noValidate || el.formNoValidate),
    type: el.getAttribute('type'),
    disabled: !!el.disabled || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
    readOnly: !!el.readOnly,
    handlers: subtreeHandlers(el),
    // 关联表单可能不在祖先链上（form 属性指向别处），它自己的处理器同样会截获提交。
    formHandlers: el.form ? handlers(el.form) : undefined });
  const clean = value => String(value).replace(/[\u0000-\u001f]/g, ' ').slice(0, 60);
  const describe = node => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return '';
    return clean(node.getAttribute('role') || node.tagName.toLowerCase()) + ' ' +
      JSON.stringify(clean(node.getAttribute('aria-label') || node.getAttribute('title') || node.tagName.toLowerCase()));
  };
  root.__dshGuestIdentity = identity;
  root.__dshGuestPath = path;
  root.__dshGuestDescribe = describe;
  const centre = (start, end, limit) => Math.max(0, Math.min(limit - 1, Math.floor((start + end) / 2)));
  // 命中测试是引用仍然有效的最终依据；被遮挡时回报遮挡者，便于模型换目标或先关掉浮层。
  const hit = el => {
    const box = el.getBoundingClientRect();
    const left = Math.max(0, box.left), top = Math.max(0, box.top);
    const right = Math.min(innerWidth, box.right), bottom = Math.min(innerHeight, box.bottom);
    if (left >= right || top >= bottom) return { reason: 'element_offscreen' };
    const x = centre(left, right, innerWidth), y = centre(top, bottom, innerHeight);
    let scope = el.getRootNode();
    const covered = () => ({ reason: 'element_covered',
      blocker: describe(scope.elementFromPoint ? scope.elementFromPoint(x, y) : null) });
    const found = scope.elementFromPoint ? scope.elementFromPoint(x, y) : null;
    if (!found || (found !== el && !el.contains(found))) return covered();
    while (scope !== document) {
      const host = scope.host; if (!host) return { reason: 'element_covered' };
      scope = host.getRootNode();
      if (!scope.elementFromPoint || scope.elementFromPoint(x, y) !== host) return covered();
    }
    return { ok: true, x: x, y: y };
  };
  root.__dshGuestHit = hit;
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
  let scanned = 0;
  while (walker.nextNode() && scanned++ < 50000 && entries.length < 150) {
    const el = walker.currentNode;
    if (!el.matches(ACTIONABLE)) continue;
    const box = el.getBoundingClientRect(); const style = getComputedStyle(el);
    if (!box.width || !box.height || style.display === 'none' || style.visibility === 'hidden' ||
      style.pointerEvents === 'none' || box.right <= 0 || box.bottom <= 0 ||
      box.left >= innerWidth || box.top >= innerHeight) continue;
    if (el.closest(BLOCKING)) continue;
    if (!hit(el).ok) continue;
    const ref = 'e' + (entries.length + 1) + '-' + Date.now() + '-' + Math.random();
    const entry = { el, form: el.form ?? null, identity: identity(el), path: path(el) };
    const password = el instanceof HTMLInputElement && el.type === 'password';
    const name = password ? (el.getAttribute('aria-label') || el.getAttribute('placeholder') || 'Password') :
      (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || el.getAttribute('title') || '');
    refs.set(ref, entry);
    entries.push(ref + ' ' + (el.getAttribute('role') || el.tagName.toLowerCase()) + ' ' +
      JSON.stringify(String(name).trim().slice(0, 160)) + ' (' + [box.x, box.y, box.width, box.height].map(Math.round).join(',') + ')');
  }
  root.__dshGuestRefs = refs;
  return { text: (document.body?.innerText || '').slice(0, 6000), entries,
    title: document.title.slice(0, 4096), href: location.href.length <= 4096 ? location.href : null,
    domRevision: scanRoots() };
})()`

/** 主进程执行观测脚本后得到的页面摘要。 */
export type Snapshot = { text: string; entries: string[]; title: string; href: string | null; domRevision: number }

/**
 * 引用复核结果：命中点，或无法点击的具体原因与遮挡者。
 */
export type TargetOutcome = { ok: true; x: number; y: number } | { ok?: false; reason?: string; blocker?: string }

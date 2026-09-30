export const id = '57cf9ee2-f1e7-4aa6-87b9-c3fb7e353882'
export const otherId = 'de337974-ff43-4143-96b7-cdadc2075c80'
export function state(revision = 1, activeTabId = id, generation = 'g1') {
  return {
    browserGeneration: generation, stateRevision: revision, operationActive: false,
    viewport: { width: 1280, height: 720 },
    tabs: [
      { id, generation: 'tab-g1', url: 'https://example.com/', title: 'Example', canGoBack: true, canGoForward: false },
      { id: otherId, generation: 'tab-g2', url: 'about:blank', title: '', canGoBack: false, canGoForward: false },
    ],
    activeTabId,
    observation: activeTabId === id ? {
      tabId: id, generation: 'tab-g1', revision, url: 'https://example.com/', title: 'Example',
      snapshot: 'Page text', viewport: { width: 1280, height: 720 },
      cursor: { x: 320, y: 540, kind: 'click', at: 123 },
    } : null,
    hasFrame: activeTabId === id,
  }
}

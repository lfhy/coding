package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"

	"github.com/deepseek-ai/coding/apps/desktop/internal/desktopremote"
)

const bridgeTokenBytes = 32

// Remote-SSH DTO 与纯 Go 服务共用同一 JSON 契约。
type RemoteSSHConnectInput = desktopremote.RemoteSSHConnectInput
type RemoteSSHAuthInput = desktopremote.RemoteSSHAuthInput
type RemoteSSHConnectResult = desktopremote.RemoteSSHConnectResult
type RemoteSSHDirectoryEntry = desktopremote.RemoteSSHDirectoryEntry
type RemoteSSHDirectoryListing = desktopremote.RemoteSSHDirectoryListing
type RemoteSSHDirectorySelection = desktopremote.RemoteSSHDirectorySelection

var errDesktopBridgeUnauthorized = errors.New("coding: desktop bridge is not authorized")
var errDesktopRemoteUnavailable = errors.New("coding: Remote-SSH service is unavailable")

// newBridgeToken 为一个桌面窗口生成仅存于内存的 binding 授权 token。
func newBridgeToken() (string, error) {
	bytes := make([]byte, bridgeTokenBytes)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("coding: create desktop bridge token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

// validBridgeToken 在常数时间内校验从 Host WebView 传入的窗口 token。
func validBridgeToken(expected, received string) bool {
	return len(expected) > 0 && len(expected) == len(received) && subtle.ConstantTimeCompare([]byte(expected), []byte(received)) == 1
}

// RemoteSSHConnect 在校验窗口授权后将握手交给共享服务。
func (a *App) RemoteSSHConnect(token string, input RemoteSSHConnectInput) (RemoteSSHConnectResult, error) {
	if !validBridgeToken(a.bridgeToken, token) {
		return RemoteSSHConnectResult{}, errDesktopBridgeUnauthorized
	}
	if a.remoteService == nil {
		return RemoteSSHConnectResult{}, errDesktopRemoteUnavailable
	}
	return a.remoteService.RemoteSSHConnect(input)
}

// RemoteSSHListDirectories 在校验窗口授权后列出远端目录。
func (a *App) RemoteSSHListDirectories(token, connectionID, remotePath string) (RemoteSSHDirectoryListing, error) {
	if !validBridgeToken(a.bridgeToken, token) {
		return RemoteSSHDirectoryListing{}, errDesktopBridgeUnauthorized
	}
	if a.remoteService == nil {
		return RemoteSSHDirectoryListing{}, errDesktopRemoteUnavailable
	}
	return a.remoteService.RemoteSSHListDirectories(connectionID, remotePath)
}

// RemoteSSHSelectDirectory 在校验窗口授权后执行 marker 选择事务。
func (a *App) RemoteSSHSelectDirectory(token, connectionID, remotePath string) (RemoteSSHDirectorySelection, error) {
	if !validBridgeToken(a.bridgeToken, token) {
		return RemoteSSHDirectorySelection{}, errDesktopBridgeUnauthorized
	}
	if a.remoteService == nil {
		return RemoteSSHDirectorySelection{}, errDesktopRemoteUnavailable
	}
	return a.remoteService.RemoteSSHSelectDirectory(connectionID, remotePath)
}

// RemoteSSHClose 在校验窗口授权后关闭不再被 marker 引用的连接。
func (a *App) RemoteSSHClose(token, connectionID string) error {
	if !validBridgeToken(a.bridgeToken, token) {
		return errDesktopBridgeUnauthorized
	}
	if a.remoteService == nil {
		return errDesktopRemoteUnavailable
	}
	return a.remoteService.RemoteSSHClose(connectionID)
}

// RemoteSSHCancelConnect 在校验窗口授权后取消该次连接尝试。
func (a *App) RemoteSSHCancelConnect(token, attemptID string) error {
	if !validBridgeToken(a.bridgeToken, token) {
		return errDesktopBridgeUnauthorized
	}
	if a.remoteService == nil {
		return errDesktopRemoteUnavailable
	}
	return a.remoteService.RemoteSSHCancelConnect(attemptID)
}

// RemoteSSHRejectHostKey 在校验窗口授权后丢弃未确认的 host key。
func (a *App) RemoteSSHRejectHostKey(token, confirmationID string) error {
	if !validBridgeToken(a.bridgeToken, token) {
		return errDesktopBridgeUnauthorized
	}
	if a.remoteService == nil {
		return errDesktopRemoteUnavailable
	}
	return a.remoteService.RemoteSSHRejectHostKey(confirmationID)
}

func desktopBindingsScript(token, hostOrigin, topInset, rightInset string) string {
	quotedToken := strconv.Quote(token)
	quotedOrigin := strconv.Quote(hostOrigin)
	quotedTopInset := strconv.Quote(topInset)
	quotedRightInset := strconv.Quote(rightInset)
	return `(() => {
  if (window.location.origin !== ` + quotedOrigin + `) return
  document.documentElement.style.setProperty('--app-safe-area-inset-top', ` + quotedTopInset + `)
  document.documentElement.style.setProperty('--app-safe-area-inset-right', ` + quotedRightInset + `)
  const token = ` + quotedToken + `
  if (!Object.prototype.hasOwnProperty.call(window, '__CODING_DESKTOP_BRIDGE_TOKEN')) {
    Object.defineProperty(window, '__CODING_DESKTOP_BRIDGE_TOKEN', {
      value: token, writable: false, configurable: false,
    })
  }
  // Wails 自己的启动页已经有完整 runtime；保留它的 callback 表以避免影响 Host 启动。
  if (window.go?.main?.App && window.wails?.Callback && window.runtime?.EventsOn) return
  const callbacks = Object.create(null)
  const listeners = Object.create(null)
  const send = (message) => {
    if (typeof window.WailsInvoke === 'function') return window.WailsInvoke(message)
    if (window.chrome?.webview?.postMessage) return window.chrome.webview.postMessage(message)
    if (window.webkit?.messageHandlers?.external?.postMessage) return window.webkit.messageHandlers.external.postMessage(message)
    throw new Error('Coding desktop bridge is unavailable')
  }
  const call = (name, args) => new Promise((resolve, reject) => {
    let callbackID
    do {
      callbackID = name + '-' + String(window.crypto?.getRandomValues
        ? window.crypto.getRandomValues(new Uint32Array(1))[0]
        : Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))
    } while (callbacks[callbackID])
    callbacks[callbackID] = { resolve, reject }
    try {
      send('C' + JSON.stringify({ name, args, callbackID }))
    } catch (error) {
      delete callbacks[callbackID]
      reject(error)
    }
  })
  const callback = (raw) => {
    let message
    try { message = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return }
    const pending = callbacks[message?.callbackid]
    if (!pending) return
    delete callbacks[message.callbackid]
    if (message.error) pending.reject(new Error(String(message.error)))
    else pending.resolve(message.result)
  }
  const notify = (raw) => {
    let event
    try { event = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return }
    if (typeof event?.name !== 'string' || !Array.isArray(event.data)) return
    for (const listener of [...(listeners[event.name] ?? [])]) {
      try { listener(...event.data) } catch {}
    }
  }
  const on = (name, listener) => {
    const entries = listeners[name] ?? (listeners[name] = [])
    entries.push(listener)
    return () => {
      const current = listeners[name]
      if (!current) return
      const index = current.indexOf(listener)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) delete listeners[name]
    }
  }
  window.wails = window.wails || {}
  window.wails.Callback = callback
  window.wails.EventsNotify = notify
  window.runtime = window.runtime || {}
  window.runtime.EventsOn = on
  window.go = window.go || {}
  window.go.main = window.go.main || {}
  window.go.main.App = window.go.main.App || {}
  for (const method of [
    'RemoteSSHConnect', 'RemoteSSHListDirectories', 'RemoteSSHSelectDirectory',
    'RemoteSSHClose', 'RemoteSSHCancelConnect', 'RemoteSSHRejectHostKey',
  ]) {
    window.go.main.App[method] = (...args) => call('main.App.' + method, args)
  }
})()`
}

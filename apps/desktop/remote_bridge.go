package main

import (
	"context"
	"crypto/subtle"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

const remoteBridgeMaxPayloadBytes int64 = 40 << 20

var remoteConnectionIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// remoteBridgeProxy 是本地 bridge 交给 SSH manager 的单个无状态请求。返回体
// 必须已是远端 agent 的 JSON；bridge 不解释业务字段，以免丢失文件工具的错误码。
type remoteBridgeProxy func(ctx context.Context, connectionID, method, path string, body []byte) (status int, response []byte, err error)

// remoteBridge 仅监听本机回环地址，供本地 Node Host 转发 marker 工作区的 I/O。
// SSH bearer token 由 manager 保留；Node 仅持有此桥接器的窗口私有 token。
type remoteBridge struct {
	token    string
	proxy    remoteBridgeProxy
	listener net.Listener
	server   *http.Server
	close    sync.Once
}

// newRemoteBridge 启动一个随机回环端口的 HTTP bridge。
func newRemoteBridge(token string, proxy remoteBridgeProxy) (*remoteBridge, error) {
	if len(token) < 32 {
		return nil, errors.New("coding: remote bridge token is too short")
	}
	if proxy == nil {
		return nil, errors.New("coding: remote bridge proxy is required")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	bridge := &remoteBridge{token: token, proxy: proxy, listener: listener}
	bridge.server = &http.Server{
		Handler:           http.HandlerFunc(bridge.serveHTTP),
		ReadHeaderTimeout: 10 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	go func() {
		_ = bridge.server.Serve(listener)
	}()
	return bridge, nil
}

// URL 返回 Node Host 专用的回环 URL；调用方不可把它展示或持久化给浏览器。
func (b *remoteBridge) URL() string {
	return "http://" + b.listener.Addr().String()
}

// Close 停止本地 bridge，不等待远端会话本身；manager 负责随后关闭 SSH。
func (b *remoteBridge) Close() error {
	var result error
	b.close.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		result = b.server.Shutdown(ctx)
		if result != nil {
			_ = b.server.Close()
		}
	})
	return result
}

func (b *remoteBridge) serveHTTP(writer http.ResponseWriter, request *http.Request) {
	if !bridgeAuthorized(request, b.token) {
		writeBridgeError(writer, http.StatusUnauthorized, "unauthorized")
		return
	}
	if !allowedBridgeRoute(request.Method, request.URL.Path) {
		writeBridgeError(writer, http.StatusNotFound, "not-found")
		return
	}
	connectionID := request.Header.Get("X-Coding-Remote-Connection")
	if !remoteConnectionIDPattern.MatchString(connectionID) {
		writeBridgeError(writer, http.StatusBadRequest, "invalid-connection")
		return
	}
	if request.Method == http.MethodPost {
		mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
		if err != nil || mediaType != "application/json" {
			writeBridgeError(writer, http.StatusUnsupportedMediaType, "invalid-content-type")
			return
		}
	}
	body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, remoteBridgeMaxPayloadBytes))
	if err != nil {
		writeBridgeError(writer, http.StatusRequestEntityTooLarge, "too-large")
		return
	}
	status, response, err := b.proxy(request.Context(), connectionID, request.Method, request.URL.Path, body)
	if err != nil {
		writeBridgeError(writer, http.StatusServiceUnavailable, "bridge-unavailable")
		return
	}
	if status < http.StatusOK || status > 599 || len(response) > int(remoteBridgeMaxPayloadBytes) {
		writeBridgeError(writer, http.StatusBadGateway, "invalid-agent-response")
		return
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_, _ = writer.Write(response)
}

func allowedBridgeRoute(method, path string) bool {
	switch path {
	case "/v1/resolve", "/v1/stat", "/v1/directories", "/v1/read_file", "/v1/read_bytes", "/v1/update_file", "/v1/edit_file", "/v1/exec":
		return method == http.MethodPost
	default:
		return false
	}
}

func bridgeAuthorized(request *http.Request, expected string) bool {
	parts := strings.Fields(request.Header.Get("Authorization"))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return false
	}
	value := parts[1]
	return len(value) == len(expected) && subtle.ConstantTimeCompare([]byte(value), []byte(expected)) == 1
}

func writeBridgeError(writer http.ResponseWriter, status int, code string) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_, _ = writer.Write([]byte(`{"error":{"code":"` + code + `"}}` + "\n"))
}

// Package helperwire 实现 Electron 主进程与 Go helper 之间的有界 NDJSON 传输。
package helperwire

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
)

const (
	Protocol              = 1
	MaxLineBytes          = 2 << 20
	MaxConcurrentRequests = 16
	maxIDBytes            = 128
	maxRequests           = 65536
)

// Handler 只接收经过传输层验证的请求；业务方法及 payload 仍须由实现方校验。
type Handler interface {
	Handle(ctx context.Context, method string, payload json.RawMessage) (any, error)
}

type request struct {
	Type     string          `json:"type"`
	Protocol int             `json:"protocol"`
	ID       string          `json:"id"`
	Method   string          `json:"method"`
	Payload  json.RawMessage `json:"payload"`
}

type wireError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Emitter 负责所有 stdout 协议帧；ready、响应和事件必须共享同一个实例。
type Emitter struct {
	mu  sync.Mutex
	out io.Writer
}

// NewEmitter 创建独占 stdout 的串行编码器；调用者不能绕过它直接写 stdout。
func NewEmitter(out io.Writer) *Emitter { return &Emitter{out: out} }

func (e *Emitter) write(frame any) error {
	if e == nil || e.out == nil {
		return errors.New("helperwire: output unavailable")
	}
	data, err := json.Marshal(frame)
	if err != nil || len(data)+1 > MaxLineBytes {
		return errors.New("helperwire: output exceeds protocol limit")
	}
	data = append(data, '\n')
	e.mu.Lock()
	defer e.mu.Unlock()
	for len(data) > 0 {
		n, err := e.out.Write(data)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}

// WriteReady 仅公布有效的 IPv4 loopback Host origin，不携带任何授权 token。
func (e *Emitter) WriteReady(origin string) error {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.String() != origin {
		return errors.New("helperwire: invalid ready origin")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 || u.Host != net.JoinHostPort("127.0.0.1", strconv.Itoa(port)) {
		return errors.New("helperwire: invalid ready origin")
	}
	return e.write(struct {
		Type     string `json:"type"`
		Protocol int    `json:"protocol"`
		Origin   string `json:"origin"`
	}{"ready", Protocol, origin})
}

// WriteReady 为只写一次 ready 的调用者提供简便入口；有并发事件时使用共享 Emitter。
func WriteReady(out io.Writer, origin string) error { return NewEmitter(out).WriteReady(origin) }

// EmitProgress 写入无诊断文字的 Remote-SSH 进度；message 参数永不进入协议，避免泄露凭据。
func (e *Emitter) EmitProgress(attemptID, phase, message string) error {
	if !validID(attemptID) || !validID(phase) {
		return errors.New("helperwire: invalid progress event")
	}
	_ = message
	return e.write(struct {
		Type     string `json:"type"`
		Protocol int    `json:"protocol"`
		Name     string `json:"name"`
		Payload  struct {
			AttemptID string `json:"attemptId"`
			Phase     string `json:"phase"`
			Message   string `json:"message"`
		} `json:"payload"`
	}{Type: "event", Protocol: Protocol, Name: "coding:remote-ssh-progress", Payload: struct {
		AttemptID string `json:"attemptId"`
		Phase     string `json:"phase"`
		Message   string `json:"message"`
	}{attemptID, phase, ""}})
}

// EmitActivate 通知 Electron 显示已有窗口，不携带第二实例的参数或诊断内容。
func (e *Emitter) EmitActivate() error {
	return e.write(struct {
		Type     string   `json:"type"`
		Protocol int      `json:"protocol"`
		Name     string   `json:"name"`
		Payload  struct{} `json:"payload"`
	}{Type: "event", Protocol: Protocol, Name: "coding:activate"})
}

// Serve 创建自己的 Emitter；已写入 ready 或需发事件时改用 ServeWithEmitter。
func Serve(ctx context.Context, in io.Reader, out io.Writer, handler Handler) error {
	return ServeWithEmitter(ctx, in, NewEmitter(out), handler)
}

// ServeWithEmitter 持续读取请求直到 EOF；EOF 或取消会取消并等待所有请求。
// 取消时若 reader 实现 io.Closer，Serve 会关闭它以打断阻塞读取。
// Handler 必须响应 ctx 取消，且调用者必须提供可中断的 reader。
func ServeWithEmitter(ctx context.Context, in io.Reader, emitter *Emitter, handler Handler) error {
	if ctx == nil || in == nil || emitter == nil || emitter.out == nil || handler == nil {
		return errors.New("helperwire: invalid serve arguments")
	}
	serveCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	if closer, ok := in.(io.Closer); ok {
		stop := context.AfterFunc(serveCtx, func() { _ = closer.Close() })
		defer stop()
	}
	reader := bufio.NewReaderSize(in, 64<<10)
	seen := make(map[string]struct{})
	active := make(map[string]struct{})
	var group sync.WaitGroup
	done := make(chan string, MaxConcurrentRequests)
	var resultMu sync.Mutex
	var writeErr error
	var readErr error
loop:
	for {
		if err := serveCtx.Err(); err != nil {
			readErr = err
			break
		}
		line, err := readLine(reader)
		if err != nil {
			if err != io.EOF {
				readErr = err
			}
			break
		}
		req, err := parseRequest(line)
		if err != nil {
			readErr = err
			break
		}
		if _, exists := seen[req.ID]; exists || len(seen) >= maxRequests {
			readErr = errors.New("helperwire: duplicate or exhausted request id")
			break
		}
		seen[req.ID] = struct{}{}
		// 仅由读循环更新 active；完成通道释放槽位。
		for {
			select {
			case id := <-done:
				delete(active, id)
			default:
				if len(active) >= MaxConcurrentRequests {
					readErr = errors.New("helperwire: too many concurrent requests")
					break loop
				}
				active[req.ID] = struct{}{}
				group.Go(func() {
					defer func() { done <- req.ID }()
					if err := handle(serveCtx, emitter, handler, req); err != nil {
						resultMu.Lock()
						if writeErr == nil {
							writeErr = err
						}
						resultMu.Unlock()
					}
				})
				continue loop
			}
		}
	}
	cancel()
	group.Wait()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return errors.Join(readErr, writeErr)
}

func readLine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		part, err := reader.ReadSlice('\n')
		if len(line)+len(part) > MaxLineBytes {
			return nil, errors.New("helperwire: input line too long")
		}
		line = append(line, part...)
		switch err {
		case nil:
			return bytes.TrimSuffix(line, []byte{'\n'}), nil
		case bufio.ErrBufferFull:
			continue
		case io.EOF:
			if len(line) == 0 {
				return nil, io.EOF
			}
			return nil, errors.New("helperwire: unterminated input line")
		default:
			return nil, errors.New("helperwire: input read failed")
		}
	}
}

func parseRequest(line []byte) (request, error) {
	var req request
	if !uniqueFields(line) {
		return req, errors.New("helperwire: invalid request")
	}
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return req, errors.New("helperwire: invalid request")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF || req.Type != "request" || req.Protocol != Protocol || !validID(req.ID) || !validID(req.Method) || len(req.Payload) == 0 || !json.Valid(req.Payload) || string(req.Payload) == "null" {
		return req, errors.New("helperwire: invalid request")
	}
	return req, nil
}

func uniqueFields(line []byte) bool {
	decoder := json.NewDecoder(bytes.NewReader(line))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return false
	}
	seen := make(map[string]struct{}, 5)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return false
		}
		key, ok := token.(string)
		if !ok {
			return false
		}
		if _, exists := seen[key]; exists {
			return false
		}
		seen[key] = struct{}{}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return false
		}
	}
	last, err := decoder.Token()
	return err == nil && last == json.Delim('}')
}

func validID(value string) bool {
	if len(value) == 0 || len(value) > maxIDBytes {
		return false
	}
	for _, char := range value {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || strings.ContainsRune("_.:-", char)) {
			return false
		}
	}
	return true
}

func handle(ctx context.Context, emitter *Emitter, handler Handler, req request) (err error) {
	defer func() {
		if recover() != nil {
			err = emitter.failure(req.ID, "internal_error", "Helper request failed")
		}
	}()
	value, handlerErr := handler.Handle(ctx, req.Method, req.Payload)
	if ctx.Err() != nil {
		return nil
	}
	if handlerErr != nil {
		return emitter.failure(req.ID, "request_failed", "Helper request failed")
	}
	data, marshalErr := json.Marshal(value)
	if marshalErr != nil || len(data)+256 > MaxLineBytes {
		return emitter.failure(req.ID, "invalid_result", "Helper result unavailable")
	}
	return emitter.write(struct {
		Type     string          `json:"type"`
		Protocol int             `json:"protocol"`
		ID       string          `json:"id"`
		OK       bool            `json:"ok"`
		Value    json.RawMessage `json:"value"`
	}{"response", Protocol, req.ID, true, data})
}

func (e *Emitter) failure(id, code, message string) error {
	return e.write(struct {
		Type     string    `json:"type"`
		Protocol int       `json:"protocol"`
		ID       string    `json:"id"`
		OK       bool      `json:"ok"`
		Error    wireError `json:"error"`
	}{"response", Protocol, id, false, wireError{code, message}})
}

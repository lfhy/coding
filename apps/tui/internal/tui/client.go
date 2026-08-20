// Package tui implements Coding's native HTTP and WebSocket client transport.
package tui

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// RPCError is the Host's business-error form.
type RPCError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// RPCResult is the typed business result slot of a server response.
type RPCResult[T any] struct {
	OK    bool      `json:"ok"`
	Value T         `json:"value"`
	Error *RPCError `json:"error"`
}

// response is the four-quadrant unary response envelope.
type response[T any] struct {
	Type   string       `json:"type"`
	RPCID  string       `json:"rpcId"`
	Result RPCResult[T] `json:"result"`
}

// Client validates the existing /api envelope rather than inventing a Go RPC.
type Client struct {
	baseURL string
	http    *http.Client
}

// NewClient creates a client for one loopback Host URL.
func NewClient(baseURL string) *Client {
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), http: &http.Client{Timeout: 20 * time.Second}}
}

// Call sends a client-request and decodes the matching server-response.
func Call[T any](ctx context.Context, client *Client, method string, payload any) (RPCResult[T], error) {
	var zero RPCResult[T]
	rpcID := randomID()
	message := map[string]any{"type": "client-request", "rpcId": rpcID, "method": method, "payload": payload}
	body, err := json.Marshal(message)
	if err != nil {
		return zero, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.baseURL+"/api/"+method, bytes.NewReader(body))
	if err != nil {
		return zero, err
	}
	request.Header.Set("Content-Type", "application/json")
	responseValue, err := client.http.Do(request)
	if err != nil {
		return zero, err
	}
	defer responseValue.Body.Close()
	if responseValue.StatusCode != http.StatusOK {
		return zero, fmt.Errorf("%s: HTTP %d", method, responseValue.StatusCode)
	}
	var decoded response[T]
	if err := json.NewDecoder(io.LimitReader(responseValue.Body, 32<<20)).Decode(&decoded); err != nil {
		return zero, fmt.Errorf("%s: invalid server response: %w", method, err)
	}
	if decoded.Type != "server-response" || decoded.RPCID != rpcID {
		return zero, fmt.Errorf("%s: mismatched response envelope", method)
	}
	return decoded.Result, nil
}

// Frame is a server-request from either WebSocket downlink.
type Frame struct {
	Type    string          `json:"type"`
	RPCID   string          `json:"rpcId"`
	Method  string          `json:"method"`
	Payload json.RawMessage `json:"payload"`
}

// Stream reads one downlink until it closes, context ends, or frame validation fails.
func (client *Client) Stream(ctx context.Context, path string, frames chan<- Frame) error {
	address, err := url.Parse(client.baseURL + path)
	if err != nil {
		return err
	}
	if address.Scheme == "https" {
		address.Scheme = "wss"
	} else {
		address.Scheme = "ws"
	}
	connection, _, err := websocket.DefaultDialer.DialContext(ctx, address.String(), nil)
	if err != nil {
		return err
	}
	defer connection.Close()
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-ctx.Done():
			_ = connection.Close()
		case <-stop:
		}
	}()
	for {
		_, message, err := connection.ReadMessage()
		if err != nil {
			return err
		}
		var frame Frame
		if err := json.Unmarshal(message, &frame); err != nil {
			return fmt.Errorf("%s: invalid JSON frame: %w", path, err)
		}
		if frame.Type != "server-request" || frame.RPCID == "" || frame.Method == "" || len(frame.Payload) == 0 {
			return fmt.Errorf("%s: invalid server-request envelope", path)
		}
		select {
		case frames <- frame:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// Subscribe keeps both downlinks alive and restarts the generation when either
// ends. The callback receives generation-zero and every reconnect generation.
func (client *Client) Subscribe(ctx context.Context, onGeneration func(uint64), frames chan<- Frame) {
	var generation uint64
	for ctx.Err() == nil {
		generation++
		onGeneration(generation)
		generationCtx, cancel := context.WithCancel(ctx)
		var group sync.WaitGroup
		group.Add(2)
		for _, path := range []string{"/api/events.mux", "/api/events.host"} {
			path := path
			go func() {
				defer group.Done()
				_ = client.Stream(generationCtx, path, frames)
				cancel()
			}()
		}
		group.Wait()
		cancel()
		if ctx.Err() != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

// Events starts both reconnecting downlinks once and forwards their frames to
// one channel. The caller owns its context; it must not invoke this again for
// each received event, or it would create parallel WebSocket generations.
func (client *Client) Events(ctx context.Context) (<-chan Frame, <-chan uint64) {
	frames := make(chan Frame, 64)
	generations := make(chan uint64, 4)
	go func() {
		defer close(frames)
		defer close(generations)
		client.Subscribe(ctx, func(number uint64) {
			select {
			case generations <- number:
			case <-ctx.Done():
			}
		}, frames)
	}()
	return frames, generations
}

func randomID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return hex.EncodeToString(bytes[:])
	}
	return fmt.Sprintf("%d", time.Now().UnixNano())
}

// clientResponse 是 POST /api/respond 携带的第四种信封：rpcId 必须回显
// 待应答 server-request 的稳定 id，不做任何改名。
type clientResponse struct {
	Type   string         `json:"type"`
	RPCID  string         `json:"rpcId"`
	Result RPCResult[any] `json:"result"`
}

// Respond 应答一条 approval/question server-request。成功与取消都以
// result.value 形式提交；取消改用 ok=false、error.code="cancelled"。
func Respond(ctx context.Context, client *Client, rpcID string, result RPCResult[any]) error {
	message := clientResponse{Type: "client-response", RPCID: rpcID, Result: result}
	body, err := json.Marshal(message)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.baseURL+"/api/respond", bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	responseValue, err := client.http.Do(request)
	if err != nil {
		return err
	}
	defer responseValue.Body.Close()
	if responseValue.StatusCode != http.StatusOK {
		return fmt.Errorf("respond: HTTP %d", responseValue.StatusCode)
	}
	var receipt struct {
		Accepted bool   `json:"accepted"`
		Reason   string `json:"reason"`
	}
	if err := json.NewDecoder(io.LimitReader(responseValue.Body, 1<<20)).Decode(&receipt); err != nil {
		return fmt.Errorf("respond: invalid receipt: %w", err)
	}
	if !receipt.Accepted {
		return fmt.Errorf("respond rejected: %s", receipt.Reason)
	}
	return nil
}

// Cancel 是取消应答的通用形式：Host 侧仅接受 code="cancelled"。
func Cancel(ctx context.Context, client *Client, rpcID string) error {
	return Respond(ctx, client, rpcID, RPCResult[any]{
		Error: &RPCError{Code: "cancelled", Message: "cancelled by Coding TUI"},
	})
}

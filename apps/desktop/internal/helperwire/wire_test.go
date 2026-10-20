package helperwire

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"testing"
	"time"
)

type handlerFunc func(context.Context, string, json.RawMessage) (any, error)

func (fn handlerFunc) Handle(ctx context.Context, method string, payload json.RawMessage) (any, error) {
	return fn(ctx, method, payload)
}

func TestWriteReady(t *testing.T) {
	t.Parallel()
	var out bytes.Buffer
	emitter := NewEmitter(&out)
	if err := emitter.WriteReady("http://127.0.0.1:41001"); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "{\"type\":\"ready\",\"protocol\":1,\"origin\":\"http://127.0.0.1:41001\"}\n"; got != want {
		t.Fatalf("ready = %q, want %q", got, want)
	}
	for _, origin := range []string{"http://localhost:41001", "https://127.0.0.1:41001", "http://127.0.0.1:0", "http://127.0.0.1:41001/", "http://user@127.0.0.1:41001"} {
		if err := emitter.WriteReady(origin); err == nil {
			t.Errorf("accepted invalid origin %q", origin)
		}
	}
}

func TestEmitterEmitProgress(t *testing.T) {
	t.Parallel()
	var out bytes.Buffer
	emitter := NewEmitter(&out)
	if err := emitter.EmitProgress("attempt-1", "connecting", "secret-password"); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "{\"type\":\"event\",\"protocol\":1,\"name\":\"coding:remote-ssh-progress\",\"payload\":{\"attemptId\":\"attempt-1\",\"phase\":\"connecting\",\"message\":\"\"}}\n"; got != want {
		t.Fatalf("event = %q, want %q", got, want)
	}
	if err := emitter.EmitProgress("", "connecting", ""); err == nil {
		t.Fatal("empty attempt id accepted")
	}
}

func TestEmitterEmitActivate(t *testing.T) {
	t.Parallel()
	var out bytes.Buffer
	emitter := NewEmitter(&out)
	if err := emitter.EmitActivate(); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "{\"type\":\"event\",\"protocol\":1,\"name\":\"coding:activate\",\"payload\":{}}\n"; got != want {
		t.Fatalf("activation = %q, want %q", got, want)
	}
}

func TestParseRequest(t *testing.T) {
	t.Parallel()
	valid := `{"type":"request","protocol":1,"id":"req-1","method":"remoteSSH.connect","payload":{"x":1}}`
	if req, err := parseRequest([]byte(valid)); err != nil || req.ID != "req-1" {
		t.Fatalf("valid request = %+v, %v", req, err)
	}
	cases := []struct {
		name  string
		input string
	}{
		{"unknown type", strings.Replace(valid, `"request"`, `"event"`, 1)},
		{"wrong protocol", strings.Replace(valid, `"protocol":1`, `"protocol":2`, 1)},
		{"unknown field", strings.Replace(valid, `"payload"`, `"secret":"value","payload"`, 1)},
		{"duplicate field", strings.Replace(valid, `"id":"req-1"`, `"id":"req-1","id":"req-2"`, 1)},
		{"empty id", strings.Replace(valid, `"req-1"`, `""`, 1)},
		{"long id", strings.Replace(valid, `"req-1"`, `"`+strings.Repeat("a", maxIDBytes+1)+`"`, 1)},
		{"bad id", strings.Replace(valid, `"req-1"`, `"bad id"`, 1)},
		{"missing payload", strings.Replace(valid, `,"payload":{"x":1}`, ``, 1)},
		{"null payload", strings.Replace(valid, `{"x":1}`, `null`, 1)},
		{"trailing data", valid + ` true`},
		{"malformed", `{"type":`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if _, err := parseRequest([]byte(tc.input)); err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatalf("parse error = %v", err)
			}
		})
	}
}

func TestReadLine(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name    string
		input   string
		wantErr bool
	}{
		{"boundary", strings.Repeat("a", MaxLineBytes-1) + "\n", false},
		{"oversize", strings.Repeat("a", MaxLineBytes) + "\n", true},
		{"unterminated", "{}", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, err := readLine(bufio.NewReader(strings.NewReader(tc.input)))
			if (err != nil) != tc.wantErr {
				t.Fatalf("read error = %v, want error %v", err, tc.wantErr)
			}
		})
	}
}

func TestServeWithEmitterSequenceAndSecretRedaction(t *testing.T) {
	t.Parallel()
	in, input := io.Pipe()
	output, out := io.Pipe()
	defer output.Close()
	emitter := NewEmitter(out)
	called := make(chan struct{}, 1)
	handler := handlerFunc(func(ctx context.Context, method string, payload json.RawMessage) (any, error) {
		if err := emitter.EmitProgress("attempt-1", "connecting", "secret-password"); err != nil {
			return nil, err
		}
		if err := emitter.EmitActivate(); err != nil {
			return nil, err
		}
		called <- struct{}{}
		return map[string]string{"status": "ready"}, nil
	})
	finished := make(chan error, 1)
	go func() { finished <- ServeWithEmitter(context.Background(), in, emitter, handler) }()
	go func() { _ = emitter.WriteReady("http://127.0.0.1:41001") }()
	reader := bufio.NewReader(output)
	if line := nextLine(t, reader); !strings.Contains(line, `"type":"ready"`) {
		t.Fatalf("first frame = %q", line)
	}
	writeRequest(t, input, "req-1")
	event := nextLine(t, reader)
	if !strings.Contains(event, `"type":"event"`) || strings.Contains(event, "secret-password") {
		t.Fatalf("progress frame = %q", event)
	}
	activation := nextLine(t, reader)
	if got, want := activation, "{\"type\":\"event\",\"protocol\":1,\"name\":\"coding:activate\",\"payload\":{}}\n"; got != want {
		t.Fatalf("activation = %q, want %q", got, want)
	}
	response := nextLine(t, reader)
	if !strings.Contains(response, `"ok":true`) || !strings.Contains(response, `"status":"ready"`) {
		t.Fatalf("response = %q", response)
	}
	<-called
	input.Close()
	if err := waitResult(t, finished); err != nil {
		t.Fatal(err)
	}
	out.Close()
}

func TestServeWithEmitterDuplicateID(t *testing.T) {
	t.Parallel()
	in, input := io.Pipe()
	started := make(chan struct{})
	stopped := make(chan struct{})
	handler := handlerFunc(func(ctx context.Context, method string, payload json.RawMessage) (any, error) {
		close(started)
		<-ctx.Done()
		close(stopped)
		return nil, ctx.Err()
	})
	finished := make(chan error, 1)
	go func() { finished <- Serve(context.Background(), in, io.Discard, handler) }()
	writeRequest(t, input, "same")
	<-started
	writeRequest(t, input, "same")
	if err := waitResult(t, finished); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("duplicate error = %v", err)
	}
	select {
	case <-stopped:
	default:
		t.Fatal("in-flight handler was not canceled")
	}
	input.Close()
}

func TestServeWithEmitterRejectsReusedCompletedID(t *testing.T) {
	t.Parallel()
	in, input := io.Pipe()
	output, out := io.Pipe()
	defer output.Close()
	finished := make(chan error, 1)
	go func() {
		finished <- Serve(context.Background(), in, out, handlerFunc(func(context.Context, string, json.RawMessage) (any, error) {
			return "done", nil
		}))
	}()
	writeRequest(t, input, "same")
	if line := nextLine(t, bufio.NewReader(output)); !strings.Contains(line, `"ok":true`) {
		t.Fatalf("first response = %q", line)
	}
	writeRequest(t, input, "same")
	if err := waitResult(t, finished); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("reused id error = %v", err)
	}
	input.Close()
	out.Close()
}

func TestServeWithEmitterRejectsMalformedInput(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		input string
	}{
		{"unknown type", `{"type":"event","protocol":1,"id":"r","method":"connect","payload":{}}` + "\n"},
		{"oversized line", strings.Repeat("x", MaxLineBytes) + "\n"},
		{"trailing json", `{"type":"request","protocol":1,"id":"r","method":"connect","payload":{}} true` + "\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			var out bytes.Buffer
			err := Serve(context.Background(), strings.NewReader(tc.input), &out,
				handlerFunc(func(context.Context, string, json.RawMessage) (any, error) {
					t.Fatal("invalid request reached handler")
					return nil, nil
				}))
			if err == nil || out.Len() != 0 {
				t.Fatalf("serve error = %v, output = %q", err, out.String())
			}
		})
	}
}

func TestRequestBudgetReservesShutdownCapacity(t *testing.T) {
	t.Parallel()
	budget := requestBudget{seen: make(map[string]struct{}), active: make(map[string]bool)}
	for i := 0; i < maxBusinessConcurrent; i++ {
		if busy, err := budget.admit(request{ID: strconv.Itoa(i), Method: "connect"}); busy || err != nil {
			t.Fatalf("business admission %d = %v, %v", i, busy, err)
		}
	}
	if busy, err := budget.admit(request{ID: "overflow", Method: "connect"}); !busy || err != nil {
		t.Fatalf("business overflow = %v, %v", busy, err)
	}
	if len(budget.active) != maxBusinessConcurrent || len(budget.seen) != MaxConcurrentRequests {
		t.Fatalf("overload changed active capacity or lost id: %+v", budget)
	}
	if busy, err := budget.admit(request{ID: "stop", Method: "shutdown"}); busy || err != nil {
		t.Fatalf("reserved shutdown = %v, %v", busy, err)
	}
	if busy, err := budget.admit(request{ID: "overflow-with-stop", Method: "connect"}); !busy || err != nil {
		t.Fatalf("business overload during shutdown = %v, %v", busy, err)
	}
	if _, err := budget.admit(request{ID: "extra-stop", Method: "shutdown"}); err == nil {
		t.Fatal("shutdown bypassed total concurrency limit")
	}
	budget.release("0")
	if busy, err := budget.admit(request{ID: "replacement", Method: "connect"}); busy || err != nil {
		t.Fatalf("released business capacity = %v, %v", busy, err)
	}
	budget.release("stop")
	if busy, err := budget.admit(request{ID: "next-stop", Method: "shutdown"}); busy || err != nil {
		t.Fatalf("released shutdown capacity = %v, %v", busy, err)
	}
	if _, err := budget.admit(request{ID: "overflow", Method: "connect"}); err == nil {
		t.Fatal("overloaded request id was reusable")
	}
}

func TestRequestBudgetBoundsRepeatedShutdowns(t *testing.T) {
	t.Parallel()
	budget := requestBudget{seen: make(map[string]struct{}), active: make(map[string]bool)}
	for i := 0; i < MaxConcurrentRequests; i++ {
		if busy, err := budget.admit(request{ID: strconv.Itoa(i), Method: "shutdown"}); busy || err != nil {
			t.Fatalf("shutdown admission %d = %v, %v", i, busy, err)
		}
	}
	if _, err := budget.admit(request{ID: "overflow", Method: "shutdown"}); err == nil {
		t.Fatal("repeated shutdowns bypassed total concurrency limit")
	}
}

func TestRequestBudgetReservesFinalID(t *testing.T) {
	t.Parallel()
	for _, method := range []string{"connect", "shutdown"} {
		t.Run(method, func(t *testing.T) {
			t.Parallel()
			budget := requestBudget{seen: make(map[string]struct{}), active: make(map[string]bool)}
			for i := 0; i < maxBusinessRequests; i++ {
				id := strconv.Itoa(i)
				if busy, err := budget.admit(request{ID: id, Method: method}); busy || err != nil {
					t.Fatalf("admission %d = %v, %v", i, busy, err)
				}
				budget.release(id)
			}
			if _, err := budget.admit(request{ID: "business-overflow", Method: "connect"}); err == nil {
				t.Fatal("business consumed the reserved final id")
			}
			if busy, err := budget.admit(request{ID: "final-stop", Method: "shutdown"}); busy || err != nil {
				t.Fatalf("final shutdown = %v, %v", busy, err)
			}
			budget.release("final-stop")
			if _, err := budget.admit(request{ID: "shutdown-overflow", Method: "shutdown"}); err == nil {
				t.Fatal("shutdown bypassed total request id limit")
			}
			if len(budget.seen) != maxRequests {
				t.Fatalf("tracked ids = %d, want %d", len(budget.seen), maxRequests)
			}
		})
	}
}

type frameWriter struct {
	frames chan string
}

func (w frameWriter) Write(data []byte) (int, error) {
	w.frames <- string(data)
	return len(data), nil
}

func TestServeWithEmitterConcurrencyLimit(t *testing.T) {
	t.Parallel()
	in, input := io.Pipe()
	defer input.Close()
	started := make(chan string, MaxConcurrentRequests)
	frames := make(chan string, 1)
	handler := handlerFunc(func(ctx context.Context, method string, payload json.RawMessage) (any, error) {
		started <- method
		<-ctx.Done()
		return nil, ctx.Err()
	})
	finished := make(chan error, 1)
	go func() { finished <- Serve(context.Background(), in, frameWriter{frames}, handler) }()
	for i := 0; i < maxBusinessConcurrent; i++ {
		writeRequest(t, input, "req-"+strconv.Itoa(i))
		<-started
	}
	writeRequest(t, input, "overflow")
	if frame := <-frames; !strings.Contains(frame, `"id":"overflow","ok":false`) || !strings.Contains(frame, `"code":"request_limit"`) {
		t.Fatalf("business overload response = %q", frame)
	}
	writeMethodRequest(t, input, "stop", "shutdown")
	if method := <-started; method != "shutdown" {
		t.Fatalf("overloaded business reached handler: %q", method)
	}
	writeMethodRequest(t, input, "extra-stop", "shutdown")
	if err := waitResult(t, finished); err == nil || !strings.Contains(err.Error(), "concurrent") {
		t.Fatalf("concurrency error = %v", err)
	}
}

type pausedResponseWriter struct {
	frames chan string
	resume chan struct{}
}

func (w pausedResponseWriter) Write(data []byte) (int, error) {
	w.frames <- string(data)
	if strings.Contains(string(data), `"id":"complete"`) {
		<-w.resume
	}
	return len(data), nil
}

func TestServeWithEmitterShutdownAfterVisibleResponseBeforeSlotRelease(t *testing.T) {
	t.Parallel()
	t.Run("response writer has not released the completed business slot", func(t *testing.T) {
		in, input := io.Pipe()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		defer input.Close()
		frames := make(chan string, 2)
		resume := make(chan struct{})
		defer func() {
			select {
			case <-resume:
			default:
				close(resume)
			}
		}()
		started := make(chan string, MaxConcurrentRequests)
		finished := make(chan error, 1)
		go func() {
			finished <- Serve(ctx, in, pausedResponseWriter{frames, resume}, handlerFunc(func(ctx context.Context, method string, _ json.RawMessage) (any, error) {
				if method == "complete" {
					return "done", nil
				}
				started <- method
				<-ctx.Done()
				return nil, ctx.Err()
			}))
		}()
		writeMethodRequest(t, input, "complete", "complete")
		if frame := <-frames; !strings.Contains(frame, `"ok":true`) {
			t.Fatalf("visible response = %q", frame)
		}
		for i := 1; i < maxBusinessConcurrent; i++ {
			writeRequest(t, input, "req-"+strconv.Itoa(i))
			<-started
		}
		// stdout 已交付响应，但 Write 尚未返回；控制请求不能依赖业务完成通知回收槽位。
		writeMethodRequest(t, input, "stop", "shutdown")
		if method := <-started; method != "shutdown" {
			t.Fatalf("next handler = %q, want shutdown", method)
		}
		close(resume)
		input.Close()
		if err := waitResult(t, finished); err != nil {
			t.Fatal(err)
		}
	})
}

type failingWriter struct {
	writes chan struct{}
}

func (w *failingWriter) Write(_ []byte) (int, error) {
	w.writes <- struct{}{}
	return 0, io.ErrClosedPipe
}

func TestServeWithEmitterWriterFailureAfterManyRequests(t *testing.T) {
	t.Parallel()
	in, input := io.Pipe()
	defer input.Close()
	writer := &failingWriter{writes: make(chan struct{}, MaxConcurrentRequests+1)}
	finished := make(chan error, 1)
	go func() {
		finished <- Serve(context.Background(), in, writer,
			handlerFunc(func(context.Context, string, json.RawMessage) (any, error) { return "done", nil }))
	}()
	for i := 0; i < MaxConcurrentRequests; i++ {
		writeRequest(t, input, "req-"+strconv.Itoa(i))
	}
	for i := 0; i < MaxConcurrentRequests; i++ {
		select {
		case <-writer.writes:
		case <-time.After(5 * time.Second):
			t.Fatal("initial request did not reach the failing writer")
		}
	}
	// 等待已失败请求退出，为第 17 个请求腾出并发槽位。
	time.Sleep(10 * time.Millisecond)
	writeRequest(t, input, "req-17")
	select {
	case <-writer.writes:
	case <-time.After(5 * time.Second):
		t.Fatal("seventeenth request did not reach the failing writer")
	}
	input.Close()
	if err := waitResult(t, finished); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("serve error = %v, want writer failure", err)
	}
}

func TestServeWithEmitterEOFAndCancel(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		stop func(context.CancelFunc, *io.PipeWriter)
	}{
		{"eof", func(_ context.CancelFunc, writer *io.PipeWriter) { _ = writer.Close() }},
		{"context cancel", func(cancel context.CancelFunc, _ *io.PipeWriter) { cancel() }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in, input := io.Pipe()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			stopped := make(chan struct{})
			started := make(chan struct{})
			finished := make(chan error, 1)
			go func() {
				finished <- Serve(ctx, in, io.Discard, handlerFunc(func(ctx context.Context, _ string, _ json.RawMessage) (any, error) {
					close(started)
					<-ctx.Done()
					close(stopped)
					return nil, ctx.Err()
				}))
			}()
			writeRequest(t, input, "req-1")
			<-started
			tc.stop(cancel, input)
			if err := waitResult(t, finished); tc.name == "eof" && err != nil || tc.name == "context cancel" && !errors.Is(err, context.Canceled) {
				t.Fatalf("serve error = %v", err)
			}
			select {
			case <-stopped:
			default:
				t.Fatal("handler outlived serve")
			}
			input.Close()
		})
	}
}

func TestServeDoesNotEchoHandlerErrorOrPanic(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name    string
		handler handlerFunc
	}{
		{"error", func(context.Context, string, json.RawMessage) (any, error) { return nil, errors.New("secret-password") }},
		{"panic", func(context.Context, string, json.RawMessage) (any, error) { panic("secret-password") }},
		{"marshal error", func(context.Context, string, json.RawMessage) (any, error) { return make(chan int), nil }},
		{"oversized result", func(context.Context, string, json.RawMessage) (any, error) {
			return strings.Repeat("x", MaxLineBytes), nil
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in, input := io.Pipe()
			output, out := io.Pipe()
			defer output.Close()
			finished := make(chan error, 1)
			go func() { finished <- Serve(context.Background(), in, out, tc.handler) }()
			writeRequest(t, input, "req-1")
			line := nextLine(t, bufio.NewReader(output))
			if strings.Contains(line, "secret-password") || !strings.Contains(line, `"ok":false`) {
				t.Fatalf("unsafe response = %q", line)
			}
			input.Close()
			if err := waitResult(t, finished); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func writeRequest(t *testing.T, writer io.Writer, id string) {
	t.Helper()
	writeMethodRequest(t, writer, id, "connect")
}

func writeMethodRequest(t *testing.T, writer io.Writer, id, method string) {
	t.Helper()
	_, err := io.WriteString(writer, `{"type":"request","protocol":1,"id":"`+id+`","method":"`+method+`","payload":{}}`+"\n")
	if err != nil {
		t.Fatal(err)
	}
}

func nextLine(t *testing.T, reader *bufio.Reader) string {
	t.Helper()
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	return line
}

func waitResult(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not terminate")
		return nil
	}
}

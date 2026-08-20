package tui

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// respond 服务端夹具校验 client-response 信封的关键字段后返回收据。
func TestRespondPostsClientResponseEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/respond" {
			t.Fatalf("path = %s", request.URL.Path)
		}
		var body struct {
			Type   string         `json:"type"`
			RPCID  string         `json:"rpcId"`
			Result RPCResult[any] `json:"result"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if body.Type != "client-response" || body.RPCID != "rpc-1" || !body.Result.OK {
			t.Fatalf("envelope = %+v", body)
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{"accepted": true})
	}))
	defer server.Close()
	if err := Respond(context.Background(), NewClient(server.URL), "rpc-1", RPCResult[any]{OK: true, Value: map[string]any{
		"sessionId": "s", "approvalId": "a", "outcome": "allowed-once",
	}}); err != nil {
		t.Fatalf("Respond: %v", err)
	}
}

// 交互帧存在时按键被交互层消费，不进入 composer。
func TestInteractionKeysTakePrecedence(t *testing.T) {
	model := Model{active: "s", approval: &PendingApproval{RPCID: "rpc-1", ToolName: "shell"}}
	before := model.composer
	updated, command := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'y'}})
	model = updated.(Model)
	if model.approval != nil {
		t.Fatalf("approval not cleared")
	}
	if model.composer != before {
		t.Fatalf("composer mutated during approval")
	}
	if command == nil {
		t.Fatalf("approval answer cmd missing")
	}
}

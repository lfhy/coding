package tui

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type session struct {
	ID      string `json:"sessionId"`
	Updated int64  `json:"updatedAt"`
	Running bool   `json:"running"`
	Blank   bool   `json:"blank"`
}

type hostDescription struct {
	Version string `json:"version"`
	CWD     string `json:"cwd"`
}

type sessionsResult struct {
	Items []session `json:"items"`
}

type historyEntry struct {
	Event struct {
		Type string `json:"type"`
		Data struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"data"`
	} `json:"event"`
}

type historyResult struct {
	Events []historyEntry `json:"events"`
}

type loadedMsg struct {
	Description hostDescription
	Sessions    []session
	Err         error
}

type historyMsg struct {
	SessionID string
	Lines     []string
	Err       error
}

type sentMsg struct{ Err error }
type frameMsg struct{ Frame Frame }
type generationMsg struct{ Number uint64 }

// PendingApproval 镜像 mux 的 approval/requested 帧：应答时用帧内 rpcId
// 走 POST /api/respond，不携带额外本地状态。
type PendingApproval struct {
	RPCID      string `json:"rpcId"`
	SessionID  string `json:"sessionId"`
	ApprovalID string `json:"approvalId"`
	ToolName   string `json:"toolName"`
	Reason     string `json:"reason"`
}

// PendingQuestion 镜像 mux 的 question/requested 帧。
type PendingQuestion struct {
	RPCID     string         `json:"rpcId"`
	SessionID string         `json:"sessionId"`
	Questions []QuestionItem `json:"questions"`
}

// QuestionItem 是 ask_user_question 的单项问题。
type QuestionItem struct {
	ID          string           `json:"id"`
	Question    string           `json:"question"`
	Options     []QuestionOption `json:"options"`
	MultiSelect bool             `json:"multiSelect"`
}

// QuestionOption 是单项问题的一个选项。
type QuestionOption struct {
	Label string `json:"label"`
}

// Model is the first usable Linux Coding client: it lists/resumes sessions,
// creates sessions, sends prompts, displays streamed text, and reconnects both
// downlinks. Further first-party panels consume the same client transport.
type Model struct {
	client      *Client
	ctx         context.Context
	cancel      context.CancelFunc
	frames      <-chan Frame
	generations <-chan uint64
	sessions    []session
	selected    int
	active      string
	composer    string
	transcript  []string
	status      string
	width       int
	height      int
	generation  uint64
	// approval 与 question 是待交互的 server-request：同一时刻只展示
	// 最新的一个；应答/取消后清空，等待下一帧。
	approval *PendingApproval
	question *PendingQuestion
	// questionView 的当前选择下标，与 questions 一一对应。
	questionIndex int
	// questionSelected 记录 multiSelect 模式下当前问题已勾选的选项。
	questionSelected map[int]bool
}

var (
	titleStyle  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("86"))
	dimStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("241"))
	activeStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("229")).Background(lipgloss.Color("62"))
)

// NewModel returns a TUI model connected to one discovered Host.
func NewModel(client *Client) Model {
	ctx, cancel := context.WithCancel(context.Background())
	frames, generations := client.Events(ctx)
	return Model{client: client, ctx: ctx, cancel: cancel, frames: frames, generations: generations, status: "Connecting"}
}

func (model Model) Init() tea.Cmd {
	return tea.Batch(model.load(), model.subscribe())
}

func (model Model) load() tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(model.ctx, 15*time.Second)
		defer cancel()
		description, err := Call[hostDescription](ctx, model.client, "host.describe", map[string]any{})
		if err != nil {
			return loadedMsg{Err: err}
		}
		if !description.OK {
			return loadedMsg{Err: fmt.Errorf("host.describe: %s", description.Error.Message)}
		}
		listing, err := Call[sessionsResult](ctx, model.client, "session.list", map[string]any{})
		if err != nil {
			return loadedMsg{Err: err}
		}
		if !listing.OK {
			return loadedMsg{Err: fmt.Errorf("session.list: %s", listing.Error.Message)}
		}
		return loadedMsg{Description: description.Value, Sessions: listing.Value.Items}
	}
}

func (model Model) subscribe() tea.Cmd {
	return func() tea.Msg {
		select {
		case frame, ok := <-model.frames:
			if !ok {
				return nil
			}
			return frameMsg{Frame: frame}
		case number, ok := <-model.generations:
			if !ok {
				return nil
			}
			return generationMsg{Number: number}
		case <-model.ctx.Done():
			return nil
		}
	}
}

func (model Model) loadHistory(sessionID string) tea.Cmd {
	return func() tea.Msg {
		result, err := Call[historyResult](model.ctx, model.client, "session.history", map[string]any{"sessionId": sessionID})
		if err != nil {
			return historyMsg{SessionID: sessionID, Err: err}
		}
		if !result.OK {
			return historyMsg{SessionID: sessionID, Err: fmt.Errorf("session.history: %s", result.Error.Message)}
		}
		lines := make([]string, 0, len(result.Value.Events))
		for _, entry := range result.Value.Events {
			for _, block := range entry.Event.Data.Content {
				if block.Type == "text" && block.Text != "" {
					lines = append(lines, block.Text)
				}
			}
		}
		return historyMsg{SessionID: sessionID, Lines: lines}
	}
}

func (model Model) createSession() tea.Cmd {
	return func() tea.Msg {
		result, err := Call[struct {
			SessionID string `json:"sessionId"`
		}](model.ctx, model.client, "session.create", map[string]any{})
		if err != nil {
			return sentMsg{Err: err}
		}
		if !result.OK {
			return sentMsg{Err: fmt.Errorf("session.create: %s", result.Error.Message)}
		}
		return historyMsg{SessionID: result.Value.SessionID}
	}
}

func (model Model) sendPrompt() tea.Cmd {
	text := strings.TrimSpace(model.composer)
	if text == "" || model.active == "" {
		return nil
	}
	sessionID := model.active
	return func() tea.Msg {
		result, err := Call[struct {
			Accepted bool `json:"accepted"`
		}](model.ctx, model.client, "session.prompt", map[string]any{
			"sessionId": sessionID,
			"mode":      "queue",
			"content":   []map[string]string{{"type": "text", "text": text}},
		})
		if err != nil {
			return sentMsg{Err: err}
		}
		if !result.OK || !result.Value.Accepted {
			return sentMsg{Err: fmt.Errorf("session.prompt was rejected")}
		}
		return sentMsg{}
	}
}

// handleInteraction 处理待应答 server-request 的按键。返回非 nil 的 Cmd
// 表示消费了该按键；nil 表示当前没有待交互帧，交回常规键位。
func (model *Model) handleInteraction(key string) tea.Cmd {
	if model.approval != nil {
		pending := *model.approval
		switch key {
		case "y":
			model.approval = nil
			return model.answerApproval(pending, "allowed-once")
		case "n", "esc":
			model.approval = nil
			return model.answerApproval(pending, "rejected")
		}
		return model.noop
	}
	if model.question != nil {
		pending := *model.question
		switch key {
		case "up", "k":
			if model.questionIndex > 0 {
				model.questionIndex--
			}
			return model.noop
		case "down", "j":
			if model.questionIndex+1 < len(pending.Questions) {
				model.questionIndex++
			}
			return model.noop
		case "enter":
			model.question = nil
			return model.answerQuestion(pending, model.questionIndex)
		case "esc":
			model.question = nil
			rpcID := pending.RPCID
			return func() tea.Msg {
				return sentMsg{Err: Cancel(model.ctx, model.client, rpcID)}
			}
		}
		return model.noop
	}
	return nil
}

// noop 占位 Cmd：交互帧消费了按键但不需要网络往返。
func (model *Model) noop() tea.Msg { return nil }

// answerApproval 用帧内 rpcId 提交审批结论。
func (model *Model) answerApproval(pending PendingApproval, outcome string) tea.Cmd {
	return func() tea.Msg {
		return sentMsg{Err: Respond(model.ctx, model.client, pending.RPCID, RPCResult[any]{OK: true, Value: map[string]any{
			"sessionId":  pending.SessionID,
			"approvalId": pending.ApprovalID,
			"outcome":    outcome,
		}})}
	}
}

// answerQuestion 首版以每题第一个选项提交；单选恰好满足“selected 长度 1”
// 的校验，多选取第一个选项为最小合法应答，逐项勾选交互后续迭代细化。
func (model *Model) answerQuestion(pending PendingQuestion, index int) tea.Cmd {
	return func() tea.Msg {
		answers := make([]map[string]any, 0, len(pending.Questions))
		for _, question := range pending.Questions {
			selected := []string{}
			if len(question.Options) > 0 {
				selected = append(selected, question.Options[0].Label)
			}
			answers = append(answers, map[string]any{"id": question.ID, "selected": selected})
		}
		return sentMsg{Err: Respond(model.ctx, model.client, pending.RPCID, RPCResult[any]{OK: true, Value: map[string]any{
			"sessionId": pending.SessionID,
			"answer":    map[string]any{"answers": answers},
		}})}
	}
}

func (model Model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch value := message.(type) {
	case tea.WindowSizeMsg:
		model.width, model.height = value.Width, value.Height
	case tea.KeyMsg:
		// 交互帧存在时优先接管按键，避免把 y/n/回车误输入 composer。
		if command := model.handleInteraction(value.String()); command != nil {
			return model, command
		}
		switch value.String() {
		case "ctrl+c":
			if model.active != "" {
				return model, func() tea.Msg {
					_, err := Call[struct {
						Accepted bool `json:"accepted"`
					}](model.ctx, model.client, "session.cancel", map[string]any{"sessionId": model.active})
					return sentMsg{Err: err}
				}
			}
			model.cancel()
			return model, tea.Quit
		case "ctrl+n":
			model.status = "Creating session"
			return model, model.createSession()
		case "up", "k":
			if model.selected > 0 {
				model.selected--
			}
		case "down", "j":
			if model.selected+1 < len(model.sessions) {
				model.selected++
			}
		case "enter":
			if model.active == "" && len(model.sessions) > 0 {
				model.active = model.sessions[model.selected].ID
				model.status = "Loading session"
				return model, model.loadHistory(model.active)
			}
			if model.active != "" {
				command := model.sendPrompt()
				if command != nil {
					model.transcript = append(model.transcript, "> "+model.composer)
					model.composer = ""
					model.status = "Sending"
					return model, command
				}
			}
		case "esc":
			model.active = ""
			model.transcript = nil
			model.status = "Session list"
		case "backspace":
			if len(model.composer) > 0 {
				model.composer = model.composer[:len(model.composer)-1]
			}
		default:
			if model.active != "" && len(value.Runes) > 0 && value.Alt == false {
				model.composer += string(value.Runes)
			}
		}
	case loadedMsg:
		if value.Err != nil {
			model.status = value.Err.Error()
			return model, nil
		}
		sort.Slice(value.Sessions, func(i, j int) bool { return value.Sessions[i].Updated > value.Sessions[j].Updated })
		model.sessions = value.Sessions
		model.status = "Connected to " + value.Description.Version
	case historyMsg:
		if value.Err != nil {
			model.status = value.Err.Error()
			return model, nil
		}
		if value.SessionID != "" {
			model.active = value.SessionID
		}
		model.transcript = value.Lines
		model.status = "Session ready"
	case sentMsg:
		if value.Err != nil {
			model.status = value.Err.Error()
		} else {
			model.status = "Sent"
		}
	case generationMsg:
		model.generation = value.Number
		model.status = fmt.Sprintf("Connected (generation %d)", value.Number)
	case frameMsg:
		var envelope struct {
			Type      string          `json:"type"`
			SessionID string          `json:"sessionId"`
			Event     json.RawMessage `json:"event"`
		}
		if err := json.Unmarshal(value.Frame.Payload, &envelope); err == nil {
			switch envelope.Type {
			case "session/event":
				if envelope.SessionID != model.active {
					return model, model.subscribe()
				}
				var event struct {
					Data struct {
						Content []struct {
							Type string `json:"type"`
							Text string `json:"text"`
						} `json:"content"`
					} `json:"data"`
				}
				if json.Unmarshal(envelope.Event, &event) == nil {
					for _, block := range event.Data.Content {
						if block.Type == "text" && block.Text != "" {
							model.transcript = append(model.transcript, block.Text)
						}
					}
				}
			case "approval/requested":
				var pending PendingApproval
				if json.Unmarshal(value.Frame.Payload, &pending) == nil {
					pending.RPCID = value.Frame.RPCID
					model.approval = &pending
					model.question = nil
				}
			case "question/requested":
				var pending PendingQuestion
				if json.Unmarshal(value.Frame.Payload, &pending) == nil {
					pending.RPCID = value.Frame.RPCID
					model.question = &pending
					model.approval = nil
					model.questionIndex = 0
				}
			}
		}
		return model, model.subscribe()
	}
	return model, nil
}

// interactionView 渲染待应答帧；无待交互帧时返回空串。
func (model Model) interactionView() string {
	if model.approval != nil {
		rows := []string{titleStyle.Render("Approval requested"), model.approval.ToolName}
		if model.approval.Reason != "" {
			rows = append(rows, dimStyle.Render(model.approval.Reason))
		}
		rows = append(rows, dimStyle.Render("y allow once  n reject"))
		return strings.Join(rows, "\n") + "\n"
	}
	if model.question != nil {
		rows := []string{titleStyle.Render("Questions")}
		for index, question := range model.question.Questions {
			prefix := "  "
			if index == model.questionIndex {
				prefix = activeStyle.Render("> ")
			}
			rows = append(rows, prefix+question.Question)
		}
		rows = append(rows, dimStyle.Render("Enter answer with first option  Esc cancel"))
		return strings.Join(rows, "\n") + "\n"
	}
	return ""
}

func (model Model) View() string {
	if model.width == 0 {
		return "Loading Coding..."
	}
	if model.active == "" {
		rows := make([]string, 0, len(model.sessions))
		for index, session := range model.sessions {
			row := session.ID
			if session.Running {
				row += "  running"
			}
			if session.Blank {
				row += "  new"
			}
			if index == model.selected {
				row = activeStyle.Render(row)
			}
			rows = append(rows, row)
		}
		if len(rows) == 0 {
			rows = append(rows, dimStyle.Render("No sessions. Press Ctrl+N to create one."))
		}
		return titleStyle.Render("Coding") + "\n" + strings.Join(rows, "\n") + "\n\n" + dimStyle.Render(model.status+"  Ctrl+N new  Enter open  Ctrl+C exit")
	}
	lines := append([]string(nil), model.transcript...)
	if len(lines) == 0 {
		lines = append(lines, dimStyle.Render("No messages yet."))
	}
	return titleStyle.Render("Coding") + "  " + dimStyle.Render(model.active) + "\n\n" + model.interactionView() + strings.Join(lines, "\n\n") + "\n\n" + activeStyle.Render("> "+model.composer) + "\n" + dimStyle.Render(model.status+"  Enter send  Esc sessions  Ctrl+C interrupt")
}

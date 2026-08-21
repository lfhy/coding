package tui

import (
	"context"
	"fmt"
	"sort"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// 面板种类：会话列表之外的第一方功能面板，按键 Ctrl+P 呼出面板选择。
const (
	panelWorkspaces = "workspaces"
	panelJobs       = "jobs"
	panelSubagents  = "subagents"
	panelGoals      = "goals"
	panelSkills     = "skills"
	panelModels     = "models"
	panelPresets    = "presets"
	panelSettings   = "settings"
	panelPlugins    = "plugins"
)

// panelCatalog 是面板选择列表的固定顺序。
var panelCatalog = []string{panelWorkspaces, panelJobs, panelSubagents, panelGoals, panelSkills, panelModels, panelPresets, panelSettings, panelPlugins}

// panelNames 渲染面板选择列表的行。
func panelNames() []string {
	lines := make([]string, 0, len(panelCatalog))
	for _, name := range panelCatalog {
		lines = append(lines, "  "+name)
	}
	return lines
}

// panelMsg 面板数据加载结果。
type panelMsg struct {
	Name  string
	Lines []string
	Err   error
}

// handlePanel 处理面板覆盖层的按键：上/下选择，Enter 打开或确认，Esc 关闭。
func (model *Model) handlePanel(key string) tea.Cmd {
	switch key {
	case "up", "k":
		if model.panelSelected > 0 {
			model.panelSelected--
		}
		return model.noop
	case "down", "j":
		if model.panelSelected+1 < len(panelCatalog) && model.panel == "" {
			model.panelSelected++
		}
		return model.noop
	case "esc":
		model.panel = ""
		model.panelLines = nil
		return model.noop
	case "enter":
		if model.panel == "" {
			name := panelCatalog[model.panelSelected]
			model.panel = name
			model.panelSelected = 0
			model.panelLines = []string{"Loading " + name + "..."}
			return model.loadPanel(name)
		}
		return model.panelAction()
	}
	return model.noop
}

// loadPanel 拉取面板数据并渲染为纯文本行；每个面板只做只读展示，操作类
// 动作（goal 完成、凭据写入等）通过 panelAction 后续迭代接入。
func (model *Model) loadPanel(name string) tea.Cmd {
	client, ctx, sessionID := model.client, model.ctx, model.active
	return func() tea.Msg {
		var lines []string
		var err error
		switch name {
		case panelWorkspaces:
			lines, err = loadWorkspaces(ctx, client)
		case panelSkills:
			lines, err = loadSkills(ctx, client, sessionID)
		case panelPresets:
			lines, err = loadPresets(ctx, client)
		case panelSettings:
			lines, err = loadSettings(ctx, client)
		case panelModels:
			lines, err = loadModels(ctx, client, sessionID)
		case panelJobs:
			lines = model.jobsLines()
		case panelSubagents:
			lines, err = loadSubagents(ctx, client, sessionID)
		case panelGoals:
			lines = model.goalLines()
		default:
			lines = []string{name + ": 第三方 Web 插件卡片在 TUI 中不可渲染（占位）"}
		}
		return panelMsg{Name: name, Lines: lines, Err: err}
	}
}

// panelAction 是面板内的 Enter 动作；首版仅重新加载数据。
func (model *Model) panelAction() tea.Cmd {
	return model.loadPanel(model.panel)
}

// jobsLines 由最近一次 session/jobs 帧渲染后台任务列表。
func (model *Model) jobsLines() []string {
	if len(model.jobs) == 0 {
		return []string{"No background jobs."}
	}
	lines := make([]string, 0, len(model.jobs))
	for _, job := range model.jobs {
		lines = append(lines, fmt.Sprintf("  [%s] %s (%s)", job.Status, job.Label, job.ID))
	}
	return lines
}

// goalLines 由最近一次 goal/change 事件的目标状态渲染。
func (model *Model) goalLines() []string {
	if model.goal == "" {
		return []string{"No active goal."}
	}
	return []string{"  " + model.goal}
}

func loadWorkspaces(ctx context.Context, client *Client) ([]string, error) {
	result, err := Call[workspaceListResult](ctx, client, "workspace.list", map[string]any{})
	if err != nil {
		return nil, err
	}
	if !result.OK {
		return nil, fmt.Errorf("workspace.list: %s", result.Error.Message)
	}
	lines := make([]string, 0, len(result.Value.Items))
	for _, workspace := range result.Value.Items {
		lines = append(lines, fmt.Sprintf("  %s — %s", workspace.Title, workspace.Path))
	}
	return lines, nil
}

func loadSkills(ctx context.Context, client *Client, sessionID string) ([]string, error) {
	if sessionID == "" {
		return []string{"Open a session first."}, nil
	}
	result, err := Call[skillListResult](ctx, client, "skill.list", map[string]any{"sessionId": sessionID})
	if err != nil {
		return nil, err
	}
	if !result.OK {
		return nil, fmt.Errorf("skill.list: %s", result.Error.Message)
	}
	sort.Slice(result.Value.Skills, func(i, j int) bool { return result.Value.Skills[i].Name < result.Value.Skills[j].Name })
	lines := make([]string, 0, len(result.Value.Skills))
	for _, skill := range result.Value.Skills {
		lines = append(lines, "  /"+skill.Name+" — "+skill.Description)
	}
	return lines, nil
}

func loadPresets(ctx context.Context, client *Client) ([]string, error) {
	result, err := Call[agentPresetListResult](ctx, client, "agentPreset.list", map[string]any{})
	if err != nil {
		return nil, err
	}
	if !result.OK {
		return nil, fmt.Errorf("agentPreset.list: %s", result.Error.Message)
	}
	lines := make([]string, 0, len(result.Value.Presets))
	for _, preset := range result.Value.Presets {
		marker := "  "
		if preset.IsDefault {
			marker = "* "
		}
		lines = append(lines, marker+preset.ID+" ("+preset.Trust+")")
	}
	return lines, nil
}

func loadSettings(ctx context.Context, client *Client) ([]string, error) {
	result, err := Call[settingsDescribeResult](ctx, client, "settings.describe", map[string]any{})
	if err != nil {
		return nil, err
	}
	if !result.OK {
		return nil, fmt.Errorf("settings.describe: %s", result.Error.Message)
	}
	lines := make([]string, 0, len(result.Value.Namespaces))
	for _, namespace := range result.Value.Namespaces {
		lines = append(lines, fmt.Sprintf("  %s (revision %d)", namespace.NS, namespace.Revision))
	}
	return lines, nil
}

func loadModels(ctx context.Context, client *Client, sessionID string) ([]string, error) {
	if sessionID == "" {
		return []string{"Open a session first."}, nil
	}
	result, err := Call[sessionModelsResult](ctx, client, "session.models", map[string]any{"sessionId": sessionID})
	if err != nil {
		return nil, err
	}
	if !result.OK {
		return nil, fmt.Errorf("session.models: %s", result.Error.Message)
	}
	lines := []string{fmt.Sprintf("  current: %s / %s", result.Value.Current.Provider, result.Value.Current.Model)}
	for _, group := range result.Value.Groups {
		for _, model := range group.Models {
			lines = append(lines, fmt.Sprintf("  %s / %s — %s", group.ID, model.ID, model.Name))
		}
	}
	return lines, nil
}

func loadSubagents(ctx context.Context, client *Client, sessionID string) ([]string, error) {
	if sessionID == "" {
		return []string{"Open a session first."}, nil
	}
	result, err := Call[subagentListResult](ctx, client, "subagent.list", map[string]any{"parentSessionId": sessionID})
	if err != nil {
		return nil, err
	}
	if !result.OK {
		return nil, fmt.Errorf("subagent.list: %s", result.Error.Message)
	}
	if len(result.Value.Entries) == 0 {
		return []string{"No subagents."}, nil
	}
	lines := make([]string, 0, len(result.Value.Entries))
	for _, entry := range result.Value.Entries {
		lines = append(lines, fmt.Sprintf("  [%s/%s] %s %s", entry.Kind, entry.Mode, entry.ID, entry.Activity))
	}
	return lines, nil
}

// panelView 渲染面板覆盖层；选择行加高亮。
func (model Model) panelView() string {
	if model.panel == "" && model.panelLines == nil {
		return ""
	}
	title := "Panels"
	if model.panel != "" {
		title = model.panel
	}
	lines := make([]string, len(model.panelLines))
	copy(lines, model.panelLines)
	if model.panel == "" && model.panelSelected < len(lines) {
		lines[model.panelSelected] = activeStyle.Render(strings.TrimPrefix(lines[model.panelSelected], "  "))
	}
	footer := "Enter open  Esc close"
	if model.panel != "" {
		footer = "Enter refresh  Esc back"
	}
	return titleStyle.Render(title) + "\n" + strings.Join(lines, "\n") + "\n" + dimStyle.Render(footer) + "\n"
}

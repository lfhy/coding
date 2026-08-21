// api.go 镜像 Host /api 的响应值类型：字段与 packages/host/apiproxy 的
// zod schema 一一对应，未消费的字段保持省略而不是复制整张表。
package tui

import "encoding/json"

// WorkspaceView 是 workspace.* 的行类型。
type WorkspaceView struct {
	WorkspaceID string   `json:"workspaceId"`
	Path        string   `json:"path"`
	Title       string   `json:"title"`
	SessionIDs  []string `json:"sessionIds"`
}

type workspaceListResult struct {
	Items              []WorkspaceView `json:"items"`
	ArchivedSessionIDs []string        `json:"archivedSessionIds"`
}

// SkillEntry 是 skill.list 的行类型。
type SkillEntry struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type skillListResult struct {
	Skills []SkillEntry `json:"skills"`
}

// AgentPresetEntry 是 agentPreset.list 的行类型。
type AgentPresetEntry struct {
	ID          string `json:"id"`
	Trust       string `json:"trust"`
	IsDefault   bool   `json:"isDefault"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
}

type agentPresetListResult struct {
	Presets []AgentPresetEntry `json:"presets"`
}

// JobView 是 session/jobs 帧和后台任务列表的行类型。
type JobView struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Label  string `json:"label"`
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

// SubagentEntry 是 subagent.list 的行类型（one-shot/continuable/diagnostic）。
type SubagentEntry struct {
	Kind     string `json:"kind"`
	ID       string `json:"id"`
	Mode     string `json:"mode"`
	Activity string `json:"activity"`
	Label    string `json:"label,omitempty"`
}

type subagentListResult struct {
	Entries []SubagentEntry `json:"entries"`
}

// SettingsNamespace 是 settings.describe 的命名空间视图。
type SettingsNamespace struct {
	NS       string          `json:"ns"`
	Value    json.RawMessage `json:"value"`
	Revision int64           `json:"revision"`
}

type settingsDescribeResult struct {
	Writable   bool                `json:"writable"`
	Namespaces []SettingsNamespace `json:"namespaces"`
}

// CredentialView 是 credentials.describe 的条目。
type CredentialView struct {
	Configured bool   `json:"configured"`
	Source     string `json:"source,omitempty"`
}

type credentialsDescribeResult struct {
	Credentials map[string]CredentialView `json:"credentials"`
}

// ModelCatalogModel 是 session.models 的模型条目。
type ModelCatalogModel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ModelProviderGroup 是 session.models 的提供方分组。
type ModelProviderGroup struct {
	ID     string              `json:"id"`
	Name   string              `json:"name"`
	Models []ModelCatalogModel `json:"models"`
}

type sessionModelsResult struct {
	Current ModelSelection       `json:"current"`
	Groups  []ModelProviderGroup `json:"groups"`
}

// ModelSelection 是当前会话的模型选择。
type ModelSelection struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

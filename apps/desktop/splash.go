package main

import "html"

// splashHTML 生成启动页：先显示窗口与加载动画，Host 就绪后再跳转真实页面。
func splashHTML(message string) string {
	return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#0b0d10;color:#e6e8ea;font-family:-apple-system,"Segoe UI",sans-serif}
.box{display:flex;flex-direction:column;align-items:center;gap:18px}
.logo{width:72px;height:72px;border-radius:18px;background:linear-gradient(135deg,#4f6ef7,#7a5cf0);display:flex;align-items:center;justify-content:center;font-size:34px;font-weight:700;color:#fff}
.spinner{width:26px;height:26px;border:3px solid rgba(255,255,255,.15);border-top-color:#7a5cf0;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.msg{font-size:13px;color:#9aa0a6}
	</style></head><body><div class="box"><div class="logo">C</div><div class="spinner"></div><div class="msg">` + html.EscapeString(message) + `</div></div></body></html>`
}

// errorHTML 生成 Host 启动失败页，避免白窗口无反馈。
func errorHTML(err error) string {
	return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#0b0d10;color:#e6e8ea;font-family:-apple-system,"Segoe UI",sans-serif}
.box{max-width:520px;display:flex;flex-direction:column;gap:12px}
h1{font-size:16px;margin:0}
pre{white-space:pre-wrap;word-break:break-all;background:#15181d;padding:12px;border-radius:8px;font-size:12px;color:#f08c7a}
	</style></head><body><div class="box"><h1>Coding 启动失败</h1><pre>` + html.EscapeString(err.Error()) + `</pre></div></body></html>`
}

var _ = html.EscapeString

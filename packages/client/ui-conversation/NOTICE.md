# 来源与许可

`src/client/chat/turn-status-phrases/` 下的短语数据移植自 [MIT 许可](https://github.com/01Virex/dsh-status-rotator/blob/main/LICENSE)的 [`01Virex/dsh-status-rotator`](https://github.com/01Virex/dsh-status-rotator) 0.37.0（Copyright (c) 2026 01Virex），只取其中四个短语包的中英文短语：

| 包 | 中文名 |
| --- | --- |
| `coding` | 写代码日常 |
| `daily` | 日常 |
| `internet-memes` | 网络梗 |
| `slacking` | 摸鱼 |

只移植短语数据本身，并按上游的 `thinking`／`running`／`long` 三个阶段与 `zh`／`en` 两种语言分组，组内顺序保持上游原样：

- 带模板占位符（`{tps}`／`{model}` 等）的条目没有对应的渲染能力，未移植。
- 带稀有度权重的条目按普通短语处理，权重与洗牌袋未移植。
- 轮换节奏、阶段边界、可见动画与无障碍文案由本仓库自己实现；上游的插件外壳、设置页、主题、打字机与弹幕能力均未移植。

上游短语数据继续适用其 MIT 条款。

# 架构图版本与交付规则

本目录只保留 canonical 别名和已验收的版本化交付，不保留 `latest`、`next` 或 `same-json-*` 等实验名称。

## 当前版本

- `totemora-architecture.archify.json` / `totemora-architecture.html`：文档与 GitHub Pages 使用的 canonical 别名。
- `totemora-architecture-v2.15-r2.archify.json` / `totemora-architecture-v2.15-r2.html`：当前冻结版本，使用已安装的 Archify 2.15 生成。
- `totemora-architecture-v2.15.*`：上一份已验收快照，仅用于历史比较。

当前 canonical 与 `v2.15-r2` 字节一致：

| 产物 | SHA-256 |
| --- | --- |
| Archify JSON | `15cd4aeda910a01244fb47f21b62ebe25c058aff22b0b5a72e58ded83441edbf` |
| Standalone HTML | `f771740c337179ecb7e96196cab2b3c317865980c4df250403eab8d08666a9de` |

交付验证为 showcase `9/9`、`0 errors`、`0 warnings`。视觉检查覆盖 1440×900、1600×1000、1920×1080、2048×1320，并人工检查最小/最大尺寸的明暗主题；本轮视觉修正次数为 `1`。截图、contact sheet 和 JSON receipt 是本地 QA 产物，由 `.gitignore` 排除，不是运行时或 Pages 依赖。

## 更新约束

1. 只依据当前代码、部署配置和已接受 ADR 更新图中事实，不写入 Secret、Token、内部样本或私有绝对路径。
2. 冻结候选后先通过 Archify `validate --quality showcase`，再用 `deliver` 原子生成版本化 HTML。
3. canonical JSON 与 HTML 必须来自同一冻结版本，并保持对应 SHA 回执。
4. `visual-check` 后人工检查明暗主题、边界框、连线、标签和第一屏可读性；有视觉修订时重新验证和交付。
5. 新版本使用新的稳定后缀，旧的已验收版本不覆盖；实验中间文件不提交。

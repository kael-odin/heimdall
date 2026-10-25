---
description: "克隆一页或整站，取得镜像（真值）与简报。"
argument-hint: "<url> [page|site] [mirror|verified]"
allowed-tools: "mcp__plugin_heimdall_heimdall__heimdall_clone mcp__plugin_heimdall_heimdall__heimdall_jobs mcp__plugin_heimdall_heimdall__heimdall_site mcp__plugin_heimdall_heimdall__heimdall_brief mcp__plugin_heimdall_heimdall__heimdall_doctor Bash(heimdall *)"
---

克隆 `$ARGUMENTS`（范围与级别见参数；缺省 page / mirror）：先 `heimdall_doctor`，再 `heimdall_clone`，用 `heimdall_jobs(wait)` 反复等待，最后 `heimdall_site(view="coverage")` 用三句话汇报覆盖、卡点与缺口。

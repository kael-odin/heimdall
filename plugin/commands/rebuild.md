---
description: "把一页重建成可维护的项目（分段迭代，Heimdall 修复包驱动）。"
argument-hint: "<url> [stack] [fidelity] [gate]"
allowed-tools: "mcp__plugin_heimdall_heimdall__heimdall_overview mcp__plugin_heimdall_heimdall__heimdall_brief mcp__plugin_heimdall_heimdall__heimdall_compare mcp__plugin_heimdall_heimdall__heimdall_clone mcp__plugin_heimdall_heimdall__heimdall_jobs mcp__plugin_heimdall_heimdall__heimdall_doctor Read Edit Write Glob Grep Bash(heimdall *) Bash(git *)"
---

按 `heimdall-rebuild` 技能把 `$ARGUMENTS` 重建成可维护项目。先读技能正文，按它的步骤与停止条件执行；缺参数时最多问一次，其余用默认。

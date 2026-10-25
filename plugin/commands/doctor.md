---
description: "环境自检：Node、Chromium、引擎、数据根、端口、磁盘，每项给出修复命令。"
allowed-tools: "mcp__plugin_heimdall_heimdall__heimdall_doctor Bash(heimdall doctor *) Bash(heimdall overview *)"
---

运行 `heimdall doctor --json`（或 `heimdall_doctor`），逐项汇报：✓ 通过、! 提醒、✗ 需要处理；每项 ✗ 附上修复命令。不要自动执行需要管理员权限或会改动用户环境的修复。

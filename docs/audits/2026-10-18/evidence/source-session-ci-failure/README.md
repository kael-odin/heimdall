# 命名会话用例的 CI 失败原件

精确 head `209cf405656628156952bb43f1188092b4089344`，run `39078795034`，attempt 1，终态为 **completed / failure**。原 CI 唯一失败是 `source-operations.test.mjs:196` 的 `report.flows[0].passed` 断言，expected true、actual false。此归档保留失败结论，原 CI 未保存完整 flow report，根因尚未由这批原件确认。

- [原诊断报告](diagnosis/REPORT.md)保留身份、唯一失败、TAP 原生统计、跳过门禁与证据边界；报告原字节没有改写。
- [原始逐项清单](diagnosis/original-manifest.json)声明 75 项 CI/核验/工具原件，共 4,839,648 字节。
- [相对路径清单](manifest.json)列出这 75 项原件和额外 8 项诊断文件的归档路径、来源、字节长度与 SHA256；归档路径均以本目录为基准。
- [归档完整性检查](archive-integrity.json)逐项比对复制前来源、复制后来源与归档字节，并校验原日志 ZIP 的 CRC。完整性通过仅表示复制一致。
- [离线核验脚本](verify-archive.py)只读取本目录；运行 `python verify-archive.py` 可重算全部 83 项复制文件，不依赖本机旧工作树。
- [归档脚本](build-archive.py)记录复制规则与原始来源，遇到已有目标文件会拒绝覆盖。

Core 原生统计为 2661 total / 2656 pass / 1 fail / 4 skipped，`pnpm test` 用时 27 分 49 秒，未达到 45 分钟门限。主 Core 后续 20 项 acceptance smoke 与 Docker offline delivery 被跳过；D5 没有终态摘要，Docker 没有 2/2 零 skip 的通过证据。另两个 job 成功不替代本轮失败及未执行门禁。

`final-20261017T235300.096697Z/` 保留采集 API、完整日志、ZIP 与 workflow 原件；`verification-20261017T235316.280542Z/` 保留原独立核验输出；`tools/` 保留采集和核验工具原字节；`diagnosis/` 保留原诊断报告、摘录、精确 CI 源码与自身清单。

本目录使用 `* -text` 保留所有原字节。log / txt 原件和原 REPORT.md 禁用文本 diff，沿用此前 CI 失败证据的 CRLF 保护规则；不调整原始空白、换行或摘要。后续复现和修复另行留证，本目录不包含项目测试或 Browser 重跑，也不标记 CI 已通过或问题已修复。

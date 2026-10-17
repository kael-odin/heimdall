# Browser source binding console：精确提交 CI 失败证据

GitHub run [39005540253](https://github.com/kael-odin/heimdall/actions/runs/39005540253)，attempt 1，head `b42826e4956d491b461bbd00af3d18b2ad702ad5`，`main / push`，结果 **completed / failure**。本包完整保存该失败事实；归档完成仅表示证据包完整。

- 完整 Linux Core：**2273 total / 2269 pass / 0 fail / 4 skip**，1045616.546411 ms，步骤成功。
- 第一个 Acceptance console smoke 失败；其后 **14 个 acceptance smoke 均 skipped**，包括片 C 控制台 smoke。
- Docker 独立步骤 **skipped**。片 C 不能据该 CI 标记通过。
- e2e smoke job 与 console build job 成功。

失败断言为 `smoke-acceptance-console.mjs:161:10` 的 `pageErrors == []`；真实浏览器 GET 详情端点曾返回 **409 / MANAGED_RUN_INTEGRITY_FAILED**。同 URL 前后有 200 响应，之后 report、triage、证据读取及 reload 均记录为 200。原始上传数据仅含请求顺序，没有逐请求时间戳或完整响应 body；这里不推断根因，也不把该 409 作为预期冲突忽略。完整 stack、响应顺序与限制见 `diagnostic-summary.json`。

`run.json / jobs.json / artifacts.json / run-view.json / workflow-content.json`、`commands/`、`ci.stdout.log` 与 `run-logs.zip` 均保存 gh/API 原字节。工作流直接读取该精确远端提交，验证 Git blob SHA-1 与全部 15 个 smoke 命令，未使用并行 D1 工作树代替合同。原始日志 ZIP 共 **46 entries / 46 文件**，每项已验证 CRC、解包集合、长度和字节。Core 总数在 gh 渲染日志与独立 ZIP step 日志中一致。

GitHub 上传 **1 个 failure artifact**，全部 ZIP 原件、逐项解压文件和清单保存在 `artifacts/`；下载 ZIP SHA 与 GitHub metadata digest 一致，所有条目均通过 CRC 与字节回环。截图来自该远端 artifact，不以本机素材补造。

`monitoring/` 保留完整 SHA 的 run list、API/jobs、原始工作流读取和每 45 秒监控记录；`input-files.json` 逐项关联 ignored 原件与发布副本，所有 SHA 与字节发布前后不变。采集及发布操作均使用 new-only / wx；没有重新运行 CI、测试或浏览器，没有修改产品文件。

强凭据扫描覆盖 **339 份文本输入**及派生诊断，所列模式匹配 **0**；ZIP 内容按独立解压文本扫描，PNG/ZIP 原二进制单独列明，关键词仅记数量。此结论限于 `sensitive-scan.json` 明示的正则范围。

原始字节、行尾和原生日志尾空格均保留；`.gitattributes` 仅对原始输出路径关闭 whitespace 检查。`file-manifest.json` 排除自身、`SHA256SUMS.txt` 与 `COMPLETED.json`；SHA 文本包含 manifest，最终完成凭据锚定二者。缺失完成凭据的目录属于不完整尝试，禁止覆盖或续写。

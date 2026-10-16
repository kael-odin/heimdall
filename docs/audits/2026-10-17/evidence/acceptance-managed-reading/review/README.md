# 独立审查证据归档

本目录选择性保留 managed reader 审查所需的复现脚本、修复前后原始 JSON/TAP 和最终 WSL focused 结果。源文件原件仍保留在 `core/workspace/_runs/managed-consumers-review-20261017/`，未移动或删除。

`archive-provenance.json` 记录本目录及 sibling `reader-linux/` 共 19 份复制文件的原 repo 相对路径、归档相对路径、bytes、源 SHA-256 和归档 SHA-256。`archiveRelativePath` 相对于 `docs/audits/2026-10-17/evidence/acceptance-managed-reading/`。每项源/归档 SHA 一致；JSON、TAP、脚本和原始说明均未重新序列化或规范化。原 README 以 `independent-review-notes.original.md` 保存。本 README 与 provenance 是归档时新建的说明文件，不计入复制文件数。

最终 WSL 回归为 Node v22.23.3、189/189 pass、0 fail/skip/cancelled、exit 0。20 份源码与测试前后 SHA 相同。该运行源码位于 Windows C: 的 9p/v9fs，临时 fixture 位于 WSL ext4 `/dev/sdd`；环境见原始 `linux-final-environment.txt`。

## 环境限制与复现

- `.probe.mjs` 保留原位置的相对 imports，直接在当前 docs 归档位置执行会找不到模块。复现时将其复制回 provenance 所列原 repo 位置，再从对应 checkout 使用 Node 执行。
- `run-linux-final-focused.sh` 保留本机绝对路径 `/mnt/c/Users/44548/.codex/worktrees/managed-spec-provenance/heimdall`，引用未归档的 sibling ignored Node archive，并把输出写回原 `_runs` 目录。它是当次执行凭据；换机器执行应复制一份脚本，调整路径并提供 SHA 符合记录的 Node archive。
- Windows 上下文与失败 TAP 中的用户名/worktree 路径是真实测试环境位置；它们仅用于环境定位，不是被测业务数据。没有为消除路径而修改原始证据。
- 修复前 JSON/TAP 是历史故障现场。当前已修源码上的同一探针应返回修复后结果；不能把旧失败日志当作当前失败。

## 合成值与敏感信息检查

已检查本次复制内容中的 token、secret、password、Authorization/Bearer、cookie、API key、私钥及 URL 相关命中。未发现真实密钥、账号凭证、会话 cookie 或业务数据。

`SECRET_TOKEN` 和 `ENOENT: C:\private\credentials.json SECRET_TOKEN` 是探针代码明确写入的合成错误字符串，用于证明修复前泄漏及修复后受控投影；不是读取真实 credentials 文件所得。`127.0.0.1:9` 和动态 loopback 端口是受控本机 fixture，`REQ-PROBE`、`REQ-SNAPSHOT`、随机 run/project/release ID、SHA 和错误响应体也是合成测试材料。日志中的 “without cookies or credentials” 是复现说明。原始值保留以维持故障证据。

DTO 独立探针调用的是实际 route 所用投影函数，本身不是 HTTP 请求；最终 `linux-final-focused-tests.tap` 的 consumers/quarantine 套件另有真实本机 engine HTTP 覆盖。

两个归档子目录的 `.gitattributes` 将 text/eol 转换关闭，防止仓库默认 `text=auto eol=lf` 或 core.autocrlf 在暂存/检出时改写原始证据 bytes。归档说明、provenance 和属性文件是新建元数据，不计入 19 份复制证据。

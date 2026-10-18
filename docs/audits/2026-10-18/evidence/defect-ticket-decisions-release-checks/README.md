# D6 发布核验原件

2026-10-18。此目录保存 [D6 最终门禁归档](../defect-ticket-decisions-final/README.md) 封印完成后的命令输出、文档检查和发布检查原件。它独立于已封印 final，不回写 final、v1/v2 准备目录或维护输入，也不替代精确提交 SHA 的后续 CI。

## 已保存的原始命令

| 来源 | 原命令结果 | 完整原件 |
| --- | --- | --- |
| archive-v2-create-20261018T040006.493094Z | create exit0，维护输入未变 | [run](archive-commands/create/run.json)、[stdout](archive-commands/create/stdout.log)、[stderr](archive-commands/create/stderr.log) |
| archive-v2-verify-20261018T040131.773571Z | verify exit0，维护输入未变 | [run](archive-commands/verify/run.json)、[stdout](archive-commands/verify/stdout.log)、[stderr](archive-commands/verify/stderr.log) |
| archive-v2-verify-sources-20261018T040146.989630Z | verify --sources exit0，维护输入未变 | [run](archive-commands/verify-sources/run.json)、[stdout](archive-commands/verify-sources/stdout.log)、[stderr](archive-commands/verify-sources/stderr.log) |

三次命令分别保留整个已结束的窄目录，包含 run.json、前后输入清单及完整 stdout/stderr。原 stdout 确认 final 为 1915 文件、34915071 bytes；两次 verify 均为 passed/integrityPassed/strictPassed true，只有 --sources 的 checkedSources 为 true。manifest SHA256 为 `18d3c0e28b35a0a9bb33127f05ad12484d3e0d5b796b9d3e2f496f3df6ba7455`，tree SHA256 为 `48956df9bf0e6ece2cf96db56cb687d4895e70f68915b67310e9a123f4d34f89`。

[sources.json](sources.json) 逐来源记录原相对路径、归档目标、复制时间、完整文件清单、bytes/SHA256、源 stat 和原 run。源目录全部保留；普通 payload 使用 COPYFILE_EXCL 拒绝覆盖，复制前后源文件 stat/字节/摘要及源文件集合必须一致，目标按完整字节读回。符号链接和硬链接被拒绝，没有删除、移动、改写原日志或筛掉诊断行。[tools/run-command.py](tools/run-command.py) 只保存原命令采集脚本字节，不在此位置执行它。

本目录 `.gitattributes` 使用 `* -text` 保留原字节，局部 `.gitignore` 显式放行全部 payload，包括 `.log`。README、sources.json 及这两个局部规则是发布封装控制文件，不冒充原命令输出；sources.json 随新增的已结束来源追加，既有 payload 不覆盖。

## 后续追加与检查范围

root 提供真实终态路径后，继续追加 postarchive-docs 的完整 batch/stage/run/log/input 原件，以及 protected-eight、frozen-index、evidence-index、cached diff-check 四份 checkpoint 窄输出。尚未取得原件的检查没有在本 README 中声明通过。追加只涉及非 Markdown 原件与 sources.json；本说明预先固定，供后续文档链接检查读取。

检查范围分别是：postarchive-docs 验证其执行时的真实 Markdown 链接；protected-eight 核对八个指定文件的 baseline/HEAD/index/worktree 原 blob 摘要；frozen-index 把四个通过批次的 627 个冻结维护输入绑定到当时 index/worktree；evidence-index 验证运行开始时已 stage 的 `docs/audits/2026-10-18/evidence` 下 ACM 路径，并在末尾复核该路径集合未变；cached diff-check 只按其真实退出码及完整诊断记录判断。它们不外推为任意仓库文件都经过相同检查。

checkpoint 原输出在检查结束后才被复制和 stage，因此该次输出自身不属于其已核对集合。归档的 checkpoint 不自证自身，不为形成自引用而改写既有验证器。最终完整交付 stage 后，root 再做只读发布终查；该次原输出保留在独立 ignored 现场，路径由交付记录说明，不再回抄本目录以触发循环。

这里没有执行 engine、Browser、Core、目标网络请求或新的复杂校验系统；实际命令与结果以各份保留的原 run/log 为准。

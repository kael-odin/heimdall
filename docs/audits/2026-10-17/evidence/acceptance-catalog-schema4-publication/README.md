# Schema4 公开证据包的独立发布核验

本目录保留工作树与 Git 暂存区两阶段独立核验原件。核验器原样复用主树已审阅版本，SHA256 `f84a1cc154191d00b07bbc31a9bd436d7f67b6ac1523f0189e816fdc1de34ce3`。正式 authority 在执行前冻结；两阶段使用相同字节。

| 阶段 | 结论 | 核验范围 | 耗时 | 原件 |
|---|---|---|---:|---|
| Working tree | passed / exit 0 | 原始包全部 95 个文件、41 个完整组 | 33278 ms | [结果](working-tree/result/verification.json)、[命令](working-tree/command.json)、[完成凭据](working-tree/COMPLETED.json) |
| Staged | passed / exit 0 | 同一完整核验，加原始 95 个暂存 blob 的逐字节/SHA256比较 | 31775 ms | [结果](staged/result/verification.json)、[命令](staged/command.json)、[完成凭据](staged/COMPLETED.json) |

原始公开包共 **95 files / 19,499,035 bytes**。41 组归档包含 **21,836 个原件文件、139 个目录（各组根目录分别计入）、27,705,426 bytes**，完整 gzip 膨胀 tar 流合计 **61,982,720 bytes**。独立解析通过 gzip CRC、全部 tar 路径集合、类型、逐文件长度/SHA256、ignored 来源当前字节及完整来源稳定核对。完整 549 条源码 guard 和 17 条关键记录均与当前源码一致；七个 followup 最终门禁 snapshot 同步匹配。原 351 文件 CI 锚点也完成原字节核对。

原始包身份：

- COMPLETED SHA256: `8eb770fa28e80cd6725c330fd26014190dac2bb6a8c2c78b44ef110ec7cee020`
- INDEX SHA256: `5703beb0e6783843c21ac1ee4d8d6768767c95900350449fdbb56141b2cefcf2`

两阶段分别扫描原始 95 个公开文件与全部完整膨胀 tar 流（含 tar headers），每阶段 **81,481,755 bytes**，七类强凭据签名均 **0 candidates / 0 allowlisted findings**。扫描类别为 private key、GitHub token、OpenAI-style key、AWS access key、Slack token、Google API key 与 npm token。嵌套 ZIP payload 未递归展开；其完整原字节有 SHA256 核对，0988 CI 组另含原始解压日志与失败 artifact。强签名扫描结果不构成所有可能凭据均不存在的证明。详见两阶段 `result/credential-scan.json` 的界限与上限。

两阶段核验材料各保留 verifier、authority、command、stdout/stderr、exit code、verification、scan、文件清单与完成凭据，共各 **11 文件**。working-tree 复制 **43,599 bytes**，staged 复制 **43,538 bytes**；均验证完整路径/类型/长度/SHA256与 ignored 原件一致，源目录重读未变。复制凭据分别为 [working-tree-copy-receipt.json](working-tree-copy-receipt.json) 与 [staged-copy-receipt.json](staged-copy-receipt.json)。`.gitattributes` 保留原始字节。

## Root 交付门禁入口

`pnpm docs:links` 已通过，exit 0，原始结果为 794 个本地目标 / 226 个 Markdown 文件。完整[命令](docs-links/command.json)、[stdout](docs-links/stdout.log)、[stderr](docs-links/stderr.log)、[退出码](docs-links/exitcode.json)与[复制凭据](docs-links-copy-receipt.json)保留原字节。补充本段及审计导航后，root 在最终暂存前再次确认链接；该次原件保存在同目录的 `docs-links-confirmation/`，不覆盖首轮。

上述 staged 核验范围是原始证据包 95 个文件。本 publication 目录由 root 统一暂存，再执行全 index 字节检查，覆盖所有暂存源码、文档与证据文件，以及全部 549 条最终测试源码；检查输出保存在本机 `core/workspace/_runs/staged-d1-bytes-*/verification.json`。这项检查不把自己的输出放入所核验的 index，避免自引用。

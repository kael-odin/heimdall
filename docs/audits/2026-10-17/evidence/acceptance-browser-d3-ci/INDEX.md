# D3 CI 与 owner-loss hotfix 公开原件索引

本目录保存 e3cc0ee 自身 CI 的三份原始输出及捕获 metadata，以及独立 hotfix 的根目录验证原件。逐字节复制并对源文件复核 SHA-256；没有复制 Node 运行时包、package 目录、旧 D3 审计包或 ZIP。

下表覆盖全部公开原件；本索引自身不列入原件清单。CI 捕获 metadata 中的 exitCode=0 表示日志/API 读取命令成功，工作流结论以 completed-jobs.stdout 为准。

| 路径 | bytes | SHA-256 |
| --- | ---: | --- |
| [ci/complete-run.json](ci/complete-run.json) | 479 | `ef62758db34f7514a88d512053261fe7f16d6465609b9ea8b45d2aab93a13c45` |
| [ci/complete-run.stdout](ci/complete-run.stdout) | 1664021 | `0e5b53496ea60b628cf928080c66985d78cca2e1072005c56539648d42113fb1` |
| [ci/completed-jobs.json](ci/completed-jobs.json) | 470 | `167ade982b7dfa480ed605d3c84d3fa2a66b22d7008de2ed817663d5b01efaaa` |
| [ci/completed-jobs.stdout](ci/completed-jobs.stdout) | 13549 | `71aa7486079d31335ddbcc2732a953e187eec9f4d0b472de21cb56f50ed86aad` |
| [ci/failed-steps.json](ci/failed-steps.json) | 486 | `0c9644b7f4fe8edc8aeff50d5ccd2b44d9b29c47d0dd78d7b5cd315c9c1ec243` |
| [ci/failed-steps.stdout](ci/failed-steps.stdout) | 1453467 | `f613e839dbaa46e2a877c8478aaa6566766fcfe08c5e350c4337f2378d16614d` |
| [hotfix/after-node22-linux-full.exit](hotfix/after-node22-linux-full.exit) | 3 | `13bf7b3039c63bf5a50491fa3cfd8eb4e699d1ba1436315aef9cbe5711530354` |
| [hotfix/after-node22-linux-full.stdout](hotfix/after-node22-linux-full.stdout) | 3511 | `2a416e75f774f17991b5d266761dd12fe53fa450525061b2b3815806474eedcc` |
| [hotfix/after-node22-windows-full.exit](hotfix/after-node22-windows-full.exit) | 3 | `13bf7b3039c63bf5a50491fa3cfd8eb4e699d1ba1436315aef9cbe5711530354` |
| [hotfix/after-node22-windows-full.stdout](hotfix/after-node22-windows-full.stdout) | 3478 | `3c7398fae70be26db0d7c4b7aa624bef3e6f5383543a9335fddf06259505eb8d` |
| [hotfix/after-node22-windows-isolated.exit](hotfix/after-node22-windows-isolated.exit) | 3 | `13bf7b3039c63bf5a50491fa3cfd8eb4e699d1ba1436315aef9cbe5711530354` |
| [hotfix/after-node22-windows-isolated.stdout](hotfix/after-node22-windows-isolated.stdout) | 376 | `60fa498b618d9c41bcf665649d22d770e0b030a379168ce003c8e441518c9e2f` |
| [hotfix/before-isolated.exit](hotfix/before-isolated.exit) | 3 | `13bf7b3039c63bf5a50491fa3cfd8eb4e699d1ba1436315aef9cbe5711530354` |
| [hotfix/before-isolated.stdout](hotfix/before-isolated.stdout) | 376 | `aa63a5cd81ac086fd40cd63682fd4ed0ebb85cd2f252da016464f0005650efca` |
| [hotfix/before-node22-linux-relocated-isolated.exit](hotfix/before-node22-linux-relocated-isolated.exit) | 3 | `f1b2f662800122bed0ff255693df89c4487fbdcf453d3524a42d4ec20c3d9c04` |
| [hotfix/before-node22-linux-relocated-isolated.stdout](hotfix/before-node22-linux-relocated-isolated.stdout) | 761 | `32d7f8700215b20e4c953e3ecdc8f506558c46540e9cb790e8711a8b23dd6da8` |
| [hotfix/before-node22-windows.exit](hotfix/before-node22-windows.exit) | 3 | `f1b2f662800122bed0ff255693df89c4487fbdcf453d3524a42d4ec20c3d9c04` |
| [hotfix/before-node22-windows.stdout](hotfix/before-node22-windows.stdout) | 730 | `979b9581e5d72e83b9461233b496f8f9d9d0f559ae30c16f4283f448d011c5e7` |
| [hotfix/review.md](hotfix/review.md) | 3712 | `2a722795dee76e26c51a5faf7ac68e99fd09b3f1a8b8749a91f074d1415234cb` |
| [hotfix/source-sha256.json](hotfix/source-sha256.json) | 450 | `09c66726db97ed01fdda6dd37e596ec3d87f4ba1b88a96f23a16263402b988b0` |

共 20 个公开原件，3145884 bytes（不含本索引）。

hotfix 的 review.md 是本地交接原件，其中提及的 Node 安装包及重定位复现输入没有纳入本公开目录；此目录公开其 stdout / exit 结果。hotfix 自身 hosted CI 仍待推送后按新提交另行核验。

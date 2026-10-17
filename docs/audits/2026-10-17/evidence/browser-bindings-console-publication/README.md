# Browser 来源归属控制台发布检查

2026-10-17。仅记录本片 C 的发布核验，不代替产品门禁或本片远端 CI。

- `independent-verification.json`：独立解包 13 组 tar、240 份原件，核对集合、SHA、原件字节和无损 gzip；同时核对片 B CI ZIP 的 CRC、60 份解压原件及清单。
- `staged-verification.json`：同一严格检查，再用 `git cat-file --batch` 比对 230 份证据的 Git index blob 与工作区原字节。
- 四类强凭据模式扫描 382 项，命中 0。该有界扫描不保证发现任意凭据。
- `verify.mjs` 为实际独立核验器；`run-docs-links.mjs` 为实际文档链接命令记录器。wx 原始命令、stdout、stderr、exitcode 已随本目录保存。`pnpm docs:links` exit 0：746 个本地目标 / 215 份文件。

本片本机包 116 文件 / 4,704,502 bytes；父提交 CI 包 114 文件 / 6,634,876 bytes。核验器的 extracted 目录保留在 ignored 运行空间，未复制第三份完整解包树到公开文档。本机包和父提交 CI 包均已冻结。远端 CI 应按 C 的精确提交另行记录。

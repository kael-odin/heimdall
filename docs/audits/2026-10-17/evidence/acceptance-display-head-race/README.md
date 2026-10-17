# Acceptance display head race：原始证据与本机热修复验证

日期：2026-10-17。产品基线：`b42826e4956d491b461bbd00af3d18b2ad702ad5`。本目录将原 CI、全部已知失败或放弃尝试、最终四阶段验证、最终独立审查，以及补充本机门禁按完整来源目录分别保存。精确目录和逐文件 SHA256 以 `INDEX.json`、`manifests/` 和 `COMPLETED.json` 为准。

## 问题与实现边界

原始 Linux CI run `39005540253` attempt 1 的 Core 为 2273 total / 2269 pass / 0 fail / 4 skip，原控制台 smoke 因 GET detail 409 失败。原 CI 没有完整 409 body 和逐请求时间戳，因此不能断言已精确证明原 CI 的 fence 瞬间。后续本机诊断在保持 tracked 字节不变时，复现了正常连续 atomic manifest publication 触发 GET list 409。

最终实现给列表和单 run GET 详情引入显式 display-only 请求内旧字节视图：本次请求可继续展示首次稳定读取的普通 legacy manifest/report；下一次请求才读取新版本。通用严格读取器、managed facts、finalize、triage/artifact 前置、source snapshot、recovery 和 evidence 路径继续执行严格校验。展示旧视图不提供 managed/source/triage 授权。

## 最终通过的本机验证

| 证据组 | 结果 |
| --- | --- |
| `11-final-four-stages` targeted tests | 79 total / 77 pass / 0 fail / 2 skip；93,164 ms |
| 同组专项 race 文件 | 29 total / 28 pass / 0 fail / 1 skip |
| 同组 syntax lint | exit 0；19,147 ms |
| 同组 console build | exit 0；1,021 ms |
| 同组未修改的原始 fresh acceptance-console smoke | exit 0；27,627 ms；17 个 smoke checks 全为 true；`pageErrors: []` |
| `10-final-independent-review` | 12/12 probes；exit 0；stderr 为空；最终五文件 SHA 前后一致 |
| `12-full-core` | 2302 total / 2292 pass / 0 fail / 10 skip；545,705.8707 ms |
| `13-docs-links` | 中间文档链接检查 exit 0；最终公开文档导航另行检查 |
| `14-forge-smoke` | exit 0 |
| `15-console-clone-cdp-gate`、`16-console-clone-cdp-runtime` | exit 0；task `done`；clone HTTP 200；`pageErrors: []` |
| `18-browser-bindings-ui-gate`、`19-browser-bindings-ui-runtime` | exit 0；14/14 checks；8 张截图；`pageErrors: []` |

补充门禁的 wrapper 都记录 `sourcesUnchanged: true`、`sourceFileCount: 542`。原 smoke 脚本保持原字节；未放宽 console/HTTP 409 断言，也未增加 timeout。

Fresh acceptance fixture 刻意包含行为缺陷，其验收报告为 39 checks / 36 pass / 3 bugs / gate failed；这与系统 smoke passed 同时成立，表示系统正确保留了被测夹具的失败结论。默认 C UI smoke 也保留 mirror/regression 的 failed comparison；其中一条受控 502 为显式预期注入，日志完整保留。

## 尚未覆盖的范围

本轮是 Windows 上的本地受控夹具、真实控制台/engine/workers/Chromium/CDP 验证。AI 链路使用本地模型模拟器，不代表外部模型或真实业务站点验收。默认 C 的 Browser bindings 为受控组织 UI，记录 `executionReady: false`，并未增加 Browser candidate、approval、selection 或 executor。

专项 race 中原生 Linux fd-open atomic rename 在 Windows 跳过；独立审查中的 Linux-fd 部分是 Windows syscall metadata 模型，不能标记为原生 Linux 已执行。其他 skip 的具体原因保留在原测试输出中。本目录的本机通过结果不能替代热修复提交后的 Linux CI。

## 失败历史与归档格式

`02` 至 `09` 保留初始 race 失败、已放弃的 retry 方案、当时通过但随后被推翻的验证、再次失败的原 smoke、运行期诊断，以及独立审查夹具错误和修正。它们不用于冒充最终版本通过证据。诊断 loader 仅属于 ignored 证据工具，不是最终产品源码。

每组 `archives/<id>.tar.gz` 完整保存对应目录，包括空目录，成员以前缀 `<id>/` 命名；没有文件排除规则。`manifests/<id>.json` 列出完整成员集合、文件字节长度、SHA256、mode 和来源 mtimeNs metadata；不宣称 tar 精确保全纳秒时间戳或所有目录属性。`controls/pack.py`、`controls/inputs.json`、`controls/source-guard.json` 为精确字节副本，`17-packer-source` 另外保存打包准备目录整树。包根 `source-before.json` 和 `source-after.json` 固定完整 Core 门禁的 542 条源码条目；`11-final-four-stages` 另行保留原始五文件 authority 和 frozen 副本（最终三源文件、一个测试文件、未修改的原 smoke 脚本）。

打包器只在每组输入集合、字节及来源 metadata 前后相同，tar 解压成员集合完整且逐文件长度/SHA256/mode 回环一致，gzip CRC 完整读取通过，542 条源码 SHA 不变时写入 `COMPLETED.json`。任何失败留下 `FAILED.json` 及部分输出，不能作为完成包。`13-docs-links` 早于最终根文档导航变更，最终 publication 文档链接由主任务另验。发布后仍需独立 verifier 重算，不应仅信任 JSON 中的成功布尔值。

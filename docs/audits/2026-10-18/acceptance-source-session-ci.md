# 来源会话断言的 CI 失败与诊断补全

日期：2026-10-18。双核调度提交 `209cf405656628156952bb43f1188092b4089344` 的 Linux CI run `39078795034`、attempt 1 为 **completed / failure**。本片保留失败原件，并为原断言补充已经脱敏的 flow report；没有将间歇失败标记为已修复。D6 人工动作永久拒绝仍未实施。

## 精确 CI 事实

| 范围 | 原始结果 |
| --- | --- |
| core (lint + test) | failure，UTC 2026-10-17 23:22:52–23:51:55 |
| Run pnpm test | failure，23:24:03–23:51:52，原生 duration 1666825.100912 ms |
| 唯一失败 | `source capture separates named sessions per flow and fails closed on missing sessions`，`source-operations.test.mjs:196:10` |
| 失败断言 | 管理员侧 `report.flows[0].passed`，expected true / actual false |
| 原生统计 | 2661 total / 2656 pass / 1 fail / 0 cancelled / 4 skipped / 0 todo |
| 20 项 acceptance smoke | 全部 skipped；D5 没有终态摘要 |
| Docker offline delivery | skipped，没有 2/2 实际通过证据 |
| 另两个 job | console build、独立 e2e smoke 均 success |

这是明确的测试断言失败，未达到 45 分钟门限。不能将其解释为第二次超时，也不能用另两个 job 成功代替完整 CI 通过。[失败原件归档](evidence/source-session-ci-failure/README.md)保存 75 项 CI / 原核验 / 工具原件，另有 8 项诊断原件；[相对清单](evidence/source-session-ci-failure/manifest.json)提供来源、长度与 SHA256。

原采集 exit 0 只表示执行采集；原独立 verifier exit 1，251 checks，`identityMatches:true`、`captureComplete:false`、`executionAccepted:false`、`passed:false`。旧工具及失败结果不改写。

## 已证实的范围与未知项

原 CI 在前三条断言中确认了报告使用命名的 admin session，但没有输出完整的 `issues` 和 `assertions`。因此，仅凭该次 `passed:false` 不能区分登录失败、可见性超时、请求未收尾或其他采集问题，也不能确认本机复现与原 CI 同根因。

Windows / Node v25.2.1 的受控诊断保留原 50 ms settle、100 ms assertion timeout、30 秒测试时限及全部断言。探针副本只调整相对 import 和失败消息；第二个观测副本额外在已经发生的 `waitFor` 失败后读取页面的布尔状态与元素尺寸，不重试或覆盖失败结果。原始副本、运行脚本、日志和摘要见[本机诊断证据](evidence/source-session-local/README.md)。

| 受控条件 | 实际结果 |
| --- | --- |
| 普通串行，诊断副本 | 20 次全部通过 |
| 两核 affinity，1 个有时限的纯 CPU 负载进程，失败后观测副本 | 10 次全部通过；guest / missing 仍拒绝 |
| 两核 affinity，2 个纯 CPU 负载进程，诊断副本 | 首次即失败，admin 唯一 issue 为 `assertion`，导航与 document 请求完整 |
| 同上，失败后观测副本 | 首次失败；admin `TimeoutError`，实测 110 ms；随后读取到 cookie / sessionStorage 均符合夹具要求，元素存在、非 hidden、高 18 px；guest / missing 仍隐藏、认证均 false |

这证明受控高负载可以让本用例的短预算可见性检查失败，不能证明旧 CI 当时的 CPU 数量、负载、DOM 状态或具体内部错误。两次失败日志均保留失败终态；人工负载不是新的业务验收条件，也不替代真实 Linux CI。

## 本片实际改动与验证

维护测试仅将原 `assert.equal(report.flows[0].passed, true)` 增加第三参数 `JSON.stringify(report.flows[0])`。来源采集报告原本只包含允许公开的脱敏元数据；cookie、sessionStorage 值、selector、输入和查询值仍不进入该报告。原脱敏断言继续执行。

所有期望值、生产代码、100 ms / 50 ms / 30 秒时限、调度器、workflow、20 项 smoke、兼容清单与受保护的历史验证器保持原字节。未增加自动重试、失败过滤或接受条件。该变更改善下一次失败的定位能力，不构成对间歇失败的行为修复。

维护的 `source-operations.test.mjs` 整文件真实运行 **17/17 通过，0 fail / cancelled / skipped / todo**，原生 duration 14153.0037 ms。语法检查为 513 文件通过，文档链接通过；这轮三个检查前后 **614 个维护输入**摘要一致。完整 Core、console build、全部 20 项 smoke 与 Docker 由推送后该精确提交自身的 Linux CI 独立执行与核验，本片没有重复引用前一提交通过结果来填补它们。

若下一轮 CI 失败，首先读取本次补出的完整 flow report，再依据实际 issue 定位；原失败继续保留。即使下一轮完整通过，也只证明该次提交的该次执行通过，不能据此关闭本片记录的间歇失败风险。D6 和比赛演示闭环继续按长期目标推进，只有真实通过的验证才写入通过结论。

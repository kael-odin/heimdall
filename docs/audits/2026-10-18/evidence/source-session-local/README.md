# 来源会话的本机受控诊断原件

本目录保存 Windows / Node v25.2.1 的真实诊断与针对性验证；它不代表 Linux CI 已通过，也不将两次受控失败标记为通过。[实施记录](../../acceptance-source-session-ci.md)区分旧 CI 已知事实、本机复现与仍未知的根因。

[manifest.json](manifest.json)列出 51 项复制原件，共 268,385 字节，包括运行脚本、两个探针副本、完整输出、结果摘要、维护测试验证时的原字节和 614 个输入的前后摘要。[runtime.json](runtime.json)说明运行版本和范围；[verify-local.py](verify-local.py)只读重算归档字节、核对真实结果，不执行 Browser。

- `baseline-*.log`：普通串行诊断 20/20 通过。
- `two-core-load-01.log`：两核 affinity、两个纯 CPU 负载进程，原断言真实失败；只有 admin 可见性断言 issue，导航和请求均完整。
- `two-core-observation-*.log`：两核与一个负载进程，10/10 通过；预期拒绝的 guest / missing 仍失败。
- `two-core-observation2-01.log`：两核与两个负载进程，原断言再次失败；只在 `waitFor` 已经抛错后读取布尔认证状态和元素尺寸，保留原错误。admin 的 TimeoutError 耗时 110 ms，随后 DOM 非 hidden、高 18 px；guest / missing 隐藏且未认证。
- `source-operations.log`：仅增加脱敏失败消息后的维护测试整文件，17/17 通过，零 skip；`targeted-gates.json` 保存命令和时间，lint / docs 也成功。
- `inputs-before.json`、`inputs-after.json`：该轮三个检查前后的 614 个维护输入 SHA256 一致。

两种副本仍使用原 50 ms settle、100 ms assertion timeout、30 秒测试时限和原期望。CPU 负载进程具有 180 秒自身上限，并在实验结束时明确收束；普通验证在负载全部结束后执行。诊断脚本归档用于说明原实验，里面保存的输出路径指向原 ignored 工作区；重现时应选用全新目录，不能覆盖这些历史原件。

本机人工负载不证明旧 CI 的 CPU 数量或负载；失败后 DOM 观测也不证明超时发生前的状态。旧 CI 没有完整 flow report，因果结论继续保留。新增失败消息不改变生产代码、成功条件、timeout 或自动重试策略。

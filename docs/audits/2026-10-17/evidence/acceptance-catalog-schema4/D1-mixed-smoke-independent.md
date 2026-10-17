# D1 混合历史 smoke 只读审查（2026-10-17）

范围：`core/scripts/fixtures/catalog-v4-compatibility.mjs` 与 `core/scripts/smoke-acceptance-browser-bindings-console.mjs` 的 `--migrate-catalog` 分支。没有运行浏览器或执行夹具，没有修改产品/脚本，没有 stage/commit/push。两个脚本 `node --check` 均 exit0。

审查快照 SHA256：helper `c7f5958157726c2291b65c0808f16d05438698f28ceb266bbbb065a678553312`；smoke `b75a02746774bd8fe7ab50940f6522668e43cb1e8d944e09d6f20ebea2511911`。

## 应在最终发布证据前补强的围栏

1. 重启后的完整不可变性没有被当前分支验证。helper `65-103` 保存并比较的是迁移前后完整文件树（文件 bytes/SHA/nlink/mtime/ctime，排除 owner、head/previous 的预期变化）；smoke `279-299` 重启后只比较解析后的 catalog 对象，以及最后 Browser 原 run 文件字节。因此即使启动恢复重新序列化 catalog，改写 Spec source/dispatch/生命周期文件，或为 prepared-only 派发新增一个 run，在没有发目标请求时也可能不影响现有断言。此处是潜在 false-green 证据缺口，不是已复现的产品写入缺陷。建议重启加 UI/HTTP 检查结束后，再与 helper.afterTree 比较完整 bytes/stat 文件树；owner 锁照原规则排除。

2. Schema4 UI 阶段沿用过宽的资源错误豁免。smoke `85` 把任意含 409/404/502/503/ERR_FAILED 的 console warning/error 归入 expectedResourceErrors；`298` 只检查 errors 空。新阶段没有故障注入，若该阶段某个 UI GET/poll 出现真实资源错误而其余显式 HTTP/UI断言仍能完成，可能继续输出 passed。建议在新阶段固定 expectedResourceErrors 起点，并要求新增段为空，或仅以具体URL/动作精确列入真实预期；不能用这一全局豁免声称新阶段 console 无错。

## 已核对的真实性与边界

- smoke `147-159,181-234` 先通过真实引擎 Mirror/Regression worker 生成两组来源并进行三次原生归属，`captureRequestCount` 在 Browser capture 完成后固定；新模式复用这些实际捕获。
- helper `36-51` 是明确的 Spec 草稿、候选、批准、取消/重选 setup；草稿 `approved:false`，Spec runner `239-242` 走 blocked/no-request 分支。store 的批准与选用仍是明确的 harness API调用，没有混称 Browser 能力。
- helper `53-64` 仅准备三条派发；其中两条调用 owner-bound create/settle 生命周期 writer，标记 `owner-bound-lifecycle-writer-without-runner`，一条 `prepared-only`。没有调用 Spec executor 或 runner；返回 boundary 与最终 browser-checks JSON 都保留了这种证据级别。
- helper `67-90` 只围住实际 preview/apply，禁止 string path 下的 ac-* 与 dispatch 子树 readFile/open/lstat/stat/readdir/opendir 同步读取；使用 `syncBuiltinESMExports` 更新 ESM 导入，finally 恢复。当前 Catalog 维护代码读取元数据，不调用来源/派发重核验；来源重核验明确在 guard 解除后 `104-105` 执行。此 guard 不是全进程 I/O 沙箱，不应扩大成任意 async/Buffer/URL/FD 读取均受监视的声明。
- helper `93-103` 核对 schema/revision/generation、全部既有实体与事件前缀、当前 Spec selection、空 browserCandidates，比较迁移前后所有其他文件 bytes/stat，并验证准确的 v3 preimage 与 rolling previous 原字节。
- smoke `275,296` 将 Spec setup、迁移及重启UI期间的受控目标请求总数与 capture 后计数比较；目标服务记录全部方法与路径，因此本地 target 意外请求会失败。该证据只证明此受控 target，不是全进程网络隔离证明。
- smoke `282-299` 真实重开原生 Browser 归属预览并抓桌面/手机版，HTTP 核对原 Spec candidate/approval/三条selection与当前selection、所有 Browser ax 仍可重核验。没有升级 Browser candidate 写入或批准接口。
- 显示 DTO 的生产构造器 `browser-binding-view.mjs:117-139` 始终输出 `presentation.completeSourceProjection:false` 与 `executionReady:false`。新模式建议也对每条 HTTP DTO 明确断言这两个字段，避免把当前只读显示的 contentMatches 当作完整批准合同。

结论：setup 与 migration 的事实标注清楚，未发现直接冒充 Browser 执行或批准的实现；上述两项新阶段证据围栏建议在实际新模式运行前补齐。当前没有运行结果，不能标为该模式通过。

## 后续补强与独立复核

保留上文原始审查快照与风险历史；以下是主流程补强后的只读增量复核。

当前 SHA256：helper `3b538ae71e3c07e7fe616dccc05a292142147117cdf224eb57056e81cce262fc`；smoke `9fa6f4e443dfa94835c7b450dcd881394e903190d17e3be690c2f40b04ee65ef`。本次对这两份文件重新执行 `node --check`，均 exit0。

1. 完整不可变性围栏已补齐，原第 1 项证据缺口关闭。helper 导出 `catalogCompatibilityTree`；smoke `281` 在引擎重启后立即将完整文件树与 `catalogMigration.afterTree` 比较，`305-307` 在 HTTP/UI 读取结束后再次核对完整文件路径、bytes、SHA256、nlink、mtimeNs、ctimeNs，并落盘 `catalog-v4-after-review-tree.json`。owner 文件按原规则排除。重启或复核若新增 prepared run、改写任意来源/派发/生命周期文件，或只重新序列化 catalog，均会触发差异。

2. 新阶段资源错误围栏已补齐，原第 2 项证据缺口关闭。smoke `271` 固定 Schema4 阶段前 `expectedResourceErrors.length`，`304` 要求结束时数量不变，同时保留 `errors` 为空的断言。因此新阶段资源错误不能再由先前过宽的全局预期错误列表吞掉。

3. 每条 Browser binding 的 fresh HTTP 读取现在明确核对 `diagnostics.contentMatches:true`、`preview.presentation.completeSourceProjection:false` 与顶层 `executionReady:false`。增量审查曾发现初版断言误写为 `read.preview.completeSourceProjection`，该值为 undefined 会使新模式必然失败；主流程现已修正为生产 DTO 的 `read.preview.presentation.completeSourceProjection`，只读复核确认与 `browser-binding-view.mjs:127` 一致，该新增问题关闭。

本轮没有运行 Browser、夹具或 `--migrate-catalog` 模式，没有修改产品/脚本，没有 stage/commit/push。结论仅为两项证据缺口与一项新增断言错误均已在源码层面修正，且语法检查通过；真实混合模式结果由主流程串行运行并保留现场，不能据本记录声称该模式已通过。

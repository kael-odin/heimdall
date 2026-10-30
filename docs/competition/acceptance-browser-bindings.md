# Browser 来源侧归属与重核验

Browser 历史对照运行可以包含两个独立来源：`baseline` 和 `target`。内部 catalog store 现在允许操作方明确选择其中一侧，归属到一个项目的不可变版本；绑定时验证该侧的完整 planned entry URL、来源原件、实际引用证据与投影摘要。它为后续完整预览、批准和固定来源执行建立可复核的组织关系。

本文说明严格 Schema3 实体与服务器内部方法。后续已接入[HTTP 与来源归属工作台](acceptance-browser-bindings-console.md)，使用有意不完整的显示 DTO；Browser 完整批准预览、候选 / 批准 / 选用 / 托管执行继续建设，Spec 的候选、批准和选用链保持原合同。[目录迁移](acceptance-catalog-schema3.md)继续负责旧格式和完整 Spec 历史的兼容，[来源读取器](acceptance-browser-reading.md)与[纯来源投影器](acceptance-browser-source.md)负责实际材料核验。

## 明确来源与项目版本

新实体存入 `browserSourceBindings`，使用独立 `ax-UUID`，保存 projectId、releaseId、来源 runId、原运行模式、明确 side、规范完整 entryUrl，以及完整纯来源投影的摘要。`sourceContentDigest` 保留原无项目上下文的来源摘要；目录事件的 `entityDigest` 覆盖整条绑定，包括项目、版本和来源侧。未来批准必须另定义含组织上下文的内容摘要，不能把来源摘要直接当作批准。

`(runId, side)` 在全库唯一，已有归属不能重新认领。同一运行的 baseline 与 target 可以分别属于不同项目或版本。旧 `runBindings` 继续表示整次运行的 target 组织归属，不自动生成新侧归属，也不为 baseline 提供归属依据。

同一 run 的新 target 归属与旧 runBinding 若共存，projectId 和 releaseId 必须相同。新绑定写入、旧 `bindRun` 写入和纯 schema 验证三处都执行这项检查；两个项目即使 URL 相同，也不能互相替代。只有 baseline 已归另一个项目时，不阻止 target 建立独立归属。

所选 projection 的完整规范 entryUrl 必须严格等于 release.targetUrl，保留 path、query 值和查询顺序。脱敏的 observed final URL、相同 origin 或相同 pathname 不能证明版本相同。该关系仍是声明的入口归属，不是远端部署内容冻结证明。

## 内部操作合同

```js
await store.bindBrowserSource(projectId, {
  expectedGenerationId,
  expectedRevision,
  runId,
  sourceSide: 'baseline', // 必须明确 baseline 或 target
  releaseId,
});

store.readBrowserSourceBinding(projectId, bindingId);
```

绑定输入只接受上面的五个字段，不接收调用方提供的 projection、preview、digest、plan 或 actor。目录队列先核对 CAS、项目、版本、重复来源侧和 target 相容，再以真实 owner 调用私有 reader 与纯 projector。reader 可读与所选侧合格分别验证；比较 gate 为 failed 的运行仍可有合格的健康侧，原比较门禁保持不变。任何实际引用证据缺失或损坏都不能借另一侧健康绕过。

结果返回目录 generation / revision、binding、完整 preview、event 和 `executionReady:false`，不包含原始 Buffer、files Map、私有 normalized plan 或 owner。绑定实体严格验证字段、规范 URL、十个摘要 / 指纹和 Browser domain 内容摘要；V1/V2 不接受新表或事件。新事件必须晚于项目与版本；带 `2→3` 历史时还必须晚于该迁移，原生 Schema3 则无需虚造迁移。

Browser 的固定 digest 配置与计算提取到轻量 identity 模块，由原 projector 保持同名常量导出。摘要公式与已保存投影保持一致，纯 catalog schema 无需加载 PNG 依赖。

## 提交与只读复核

绑定复用目录现有提交顺序：先核对双文件字节 CAS，保存 rolling previous，再在新 head 提交前重新有界捕获同一 run 与同一侧、完整重投影，并与第一次的完整 projection 比较。所选入口与 release 同时复核，不能只比较一个 content digest 或沿用旧 preview。

初次读取保留 reader / projector 的安全错误码。提交前来源变化、缺失或失去资格返回 `BASELINE_CHANGED /409`；owner 或 root 失效保留 503。失败不推进新 head / revision，但 previous 可能已前移为旧 head；原件和这个现场均保留。

单条 `readBrowserSourceBinding` 重新读取并核验所选来源。成功返回完整 preview 与 eligible / contentMatches；变化时返回 preview:null 和固定诊断，保留历史实体，不修改目录、修复源文件或启动运行。只查一条，不为所有绑定解码 PNG。未来列表只能展示已存事实，不能因此声称来源当前已验证。

每次 capture 内部固定 run / 文件身份；现 reader 没有跨两次调用的 inode 能力。如果两次捕获之间目录或文件被逐字节相同地重建，完整投影也相同，本合同可以接受。它证明提交前重读内容一致，不承诺跨调用永久固定目录或跨文件原子快照。真实 owner 仍独立固定 acquire 时的数据根身份。

## 验证

```powershell
node --test core/test/acceptance-browser-source-binding-schema.test.mjs
node --test core/test/acceptance-browser-source-binding.test.mjs
pnpm acceptance:browser:bindings:smoke
```

纯 schema 与固定材料专项、真实 owner 的事务 / 来源变化回归、新采集 mirror / regression 受控流程及完整质量门见[实施验收记录](../audits/README.md)。固定材料和受控站点用于验证声明的合同，不代表授权外部项目、认证业务或全部真实部署已经验收。

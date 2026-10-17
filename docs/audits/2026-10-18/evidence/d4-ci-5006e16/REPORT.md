# D4 精确提交 CI 独立核验

- Run: `39051880267` / attempt `1` / head `5006e16bf73e47f36877da24df4ac4a5c8207965`
- API结论: `completed` / `success`
- 原件完整: `True`；身份匹配: `True`；执行验收: `True`
- 核验项: 308；失败: 0

原件与派生解析分开保存，所有数字均来自本次精确提交日志。

|Job|状态|结论|
|---|---|---|
|console (build)|completed|success|
|core (e2e smoke, local fixture)|completed|success|
|core (lint + test)|completed|success|

主Core测试统计：

```json
{
  "path": "core (lint + test)/11_Run pnpm test.txt",
  "stats": {
    "tests": 2530,
    "suites": 0,
    "pass": 2526,
    "fail": 0,
    "cancelled": 0,
    "skipped": 4,
    "todo": 0,
    "duration_ms": 1732507.590567
  },
  "skippedTests": [
    "real Windows reader holding a non-delete-sharing file handle releases after 180ms and replacement succeeds",
    "real Windows non-share-delete reader releases and replacement retries successfully",
    "Docker network-none delivery serves SSR, SPA and data-driven SPA bundles without a source workspace",
    "Docker network-none delivery persists adapter writes in a volume after container recreation"
  ]
}
```

D3/D4事件：

```json
[
  {
    "command": "pnpm acceptance:browser:execute:smoke",
    "name": "Browser single-operation execution (fixed source, real target BUG, explicit retest and restart)",
    "path": "core (lint + test)/29_Browser single-operation execution (fixed source, real target BUG, explicit retest and restart).txt",
    "apiConclusion": "success",
    "events": [
      {
        "status": "passed",
        "checks": 16,
        "outputDirectory": "/home/runner/work/heimdall/heimdall/core/workspace/_runs/browser-execution-console-smoke-d66541b0-aca3-44f2-9fc3-1f411b6acf49"
      }
    ]
  },
  {
    "command": "pnpm acceptance:browser:resolution:smoke",
    "name": "Browser start resolution (same unfinished ingress, durable deny, same-origin restart and native locks)",
    "path": "core (lint + test)/30_Browser start resolution (same unfinished ingress, durable deny, same-origin restart and native locks).txt",
    "apiConclusion": "success",
    "events": [
      {
        "status": "passed",
        "checks": 9,
        "outputDirectory": "/home/runner/work/heimdall/heimdall/core/workspace/_runs/browser-resolution-console-smoke-bd5339d0-b173-4046-8794-e49b6d3cfdb5"
      }
    ]
  }
]
```

Docker统计：

```json
{
  "path": "core (lint + test)/32_Docker offline delivery (SSR + SPA + data SPA + adapter).txt",
  "stats": {
    "tests": 2,
    "suites": 0,
    "pass": 2,
    "fail": 0,
    "cancelled": 0,
    "skipped": 0,
    "todo": 0,
    "duration_ms": 39163.818053
  },
  "passedTests": [
    "Docker network-none delivery serves SSR, SPA and data-driven SPA bundles without a source workspace",
    "Docker network-none delivery persists adapter writes in a volume after container recreation"
  ]
}
```

19项后续smoke：

- `pnpm acceptance:smoke`：`success`；`core (lint + test)/12_Acceptance console (real browser, local model stub).txt`
- `pnpm acceptance:spec:smoke`：`success`；`core (lint + test)/13_Spec contract console (real browser, local API fixture).txt`
- `pnpm acceptance:comparison:smoke`：`success`；`core (lint + test)/14_Acceptance comparison console (explicit runs, integrity and CLI).txt`
- `pnpm acceptance:catalog:smoke`：`success`；`core (lint + test)/15_Acceptance project catalog (versions, explicit bindings and two-engine isolation).txt`
- `pnpm acceptance:catalog:migration:smoke`：`success`；`core (lint + test)/16_Acceptance catalog explicit migration (legacy artifacts, CLI confirmation and browser continuity).txt`
- `pnpm acceptance:baseline:smoke`：`success`；`core (lint + test)/17_Spec baseline review (candidates, approvals, selections and source integrity).txt`
- `pnpm acceptance:managed:prepare:smoke`：`success`；`core (lint + test)/18_Managed Spec preparation (immutable contract, replay and zero execution).txt`
- `pnpm acceptance:managed:read:smoke`：`success`；`core (lint + test)/19_Managed Spec result reading (captured evidence and zero execution).txt`
- `pnpm acceptance:owned:recovery:smoke`：`success`；`core (lint + test)/20_Owned acceptance recovery (startup barrier, restart and zero execution).txt`
- `pnpm acceptance:managed:execute:smoke`：`success`；`core (lint + test)/21_Managed Spec execution (fresh admission, real runner, BUG and cancel).txt`
- `pnpm acceptance:execution:ui:smoke`：`success`；`core (lint + test)/22_Managed execution UI (explicit click, durable recovery and stop).txt`
- `pnpm acceptance:browser:source:smoke`：`success`；`core (lint + test)/23_Browser candidate source (fresh captures and explicit healthy side).txt`
- `pnpm acceptance:browser:read:smoke`：`success`；`core (lint + test)/24_Browser private source reader (owner fences and unchanged originals).txt`
- `pnpm acceptance:browser:bindings:smoke`：`success`；`core (lint + test)/25_Browser source bindings (fresh captures, explicit sides and source revalidation).txt`
- `pnpm acceptance:browser:bindings:ui:smoke`：`success`；`core (lint + test)/26_Browser source binding console (native HTTP, source review and verified evidence).txt`
- `pnpm acceptance:browser:bindings:v4:smoke`：`success`；`core (lint + test)/27_Schema4 combined history (fresh Browser bindings and explicit Spec lifecycle fixtures).txt`
- `pnpm acceptance:browser:candidates:ui:smoke`：`success`；`core (lint + test)/28_Browser full candidates (explicit review, durable save and read-only reconciliation).txt`
- `pnpm acceptance:browser:execute:smoke`：`success`；`core (lint + test)/29_Browser single-operation execution (fixed source, real target BUG, explicit retest and restart).txt`
- `pnpm acceptance:browser:resolution:smoke`：`success`；`core (lint + test)/30_Browser start resolution (same unfinished ingress, durable deny, same-origin restart and native locks).txt`

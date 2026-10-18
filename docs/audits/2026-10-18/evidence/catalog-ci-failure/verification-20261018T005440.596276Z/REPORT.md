# D5 精确提交 CI 独立核验

- Run: `39082419484` / attempt `1` / head `41c359a62ecbb67ac15f38c51c95fa983a7492d3`
- API结论: `completed` / `failure`
- 原件完整: `False`；身份匹配: `True`；执行验收: `False`
- 核验项: 263；失败: 45

原件与派生解析分开保存，所有数字均来自本次精确提交日志。

|Job|状态|结论|
|---|---|---|
|console (build)|completed|success|
|core (lint + test)|completed|failure|
|core (e2e smoke, local fixture)|completed|success|

主Core测试统计：

```json
{
  "path": "core (lint + test)/11_Run pnpm test.txt",
  "stats": {
    "tests": 2661,
    "suites": 0,
    "pass": 2657,
    "fail": 0,
    "cancelled": 0,
    "skipped": 4,
    "todo": 0,
    "duration_ms": 1665894.745146
  },
  "skippedTests": [
    "real Windows reader holding a non-delete-sharing file handle releases after 180ms and replacement succeeds",
    "real Windows non-share-delete reader releases and replacement retries successfully",
    "Docker network-none delivery serves SSR, SPA and data-driven SPA bundles without a source workspace",
    "Docker network-none delivery persists adapter writes in a volume after container recreation"
  ]
}
```

D3/D4及D5事件：

```json
[
  {
    "command": "pnpm acceptance:defect:tickets:smoke",
    "name": "Manual defect tickets (fixed source members, explicit closure, regression and read-only reconciliation)",
    "path": null,
    "apiConclusion": null,
    "events": []
  }
]
```

D5核验：10个true key、4张截图、0个page error、3条受控HTTP控制台错误；不声称控制台零错误。

```json
{
  "path": null,
  "summary": {},
  "consoleExpectation": "Three explicitly controlled HTTP errors; zero page errors does not mean zero console errors."
}
```

Docker统计：

```json
{}
```

20项后续smoke：

- `pnpm acceptance:smoke`：`success`；`core (lint + test)/12_Acceptance console (real browser, local model stub).txt`
- `pnpm acceptance:spec:smoke`：`success`；`core (lint + test)/13_Spec contract console (real browser, local API fixture).txt`
- `pnpm acceptance:comparison:smoke`：`success`；`core (lint + test)/14_Acceptance comparison console (explicit runs, integrity and CLI).txt`
- `pnpm acceptance:catalog:smoke`：`failure`；`core (lint + test)/15_Acceptance project catalog (versions, explicit bindings and two-engine isolation).txt`
- `pnpm acceptance:catalog:migration:smoke`：`None`；`None`
- `pnpm acceptance:baseline:smoke`：`None`；`None`
- `pnpm acceptance:managed:prepare:smoke`：`None`；`None`
- `pnpm acceptance:managed:read:smoke`：`None`；`None`
- `pnpm acceptance:owned:recovery:smoke`：`None`；`None`
- `pnpm acceptance:managed:execute:smoke`：`None`；`None`
- `pnpm acceptance:execution:ui:smoke`：`None`；`None`
- `pnpm acceptance:browser:source:smoke`：`None`；`None`
- `pnpm acceptance:browser:read:smoke`：`None`；`None`
- `pnpm acceptance:browser:bindings:smoke`：`None`；`None`
- `pnpm acceptance:browser:bindings:ui:smoke`：`None`；`None`
- `pnpm acceptance:browser:bindings:v4:smoke`：`None`；`None`
- `pnpm acceptance:browser:candidates:ui:smoke`：`None`；`None`
- `pnpm acceptance:browser:execute:smoke`：`None`；`None`
- `pnpm acceptance:browser:resolution:smoke`：`None`；`None`
- `pnpm acceptance:defect:tickets:smoke`：`None`；`None`

未通过核验项：

```json
[
  {
    "category": "execution",
    "name": "run completed successfully",
    "passed": false,
    "detail": {
      "status": "completed",
      "conclusion": "failure"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) completed successfully",
    "passed": false,
    "detail": null
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Acceptance project catalog (versions, explicit bindings and two-engine isolation)",
    "passed": false,
    "detail": {
      "number": 15,
      "status": "completed",
      "conclusion": "failure"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Acceptance catalog explicit migration (legacy artifacts, CLI confirmation and browser continuity)",
    "passed": false,
    "detail": {
      "number": 16,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Spec baseline review (candidates, approvals, selections and source integrity)",
    "passed": false,
    "detail": {
      "number": 17,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Managed Spec preparation (immutable contract, replay and zero execution)",
    "passed": false,
    "detail": {
      "number": 18,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Managed Spec result reading (captured evidence and zero execution)",
    "passed": false,
    "detail": {
      "number": 19,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Owned acceptance recovery (startup barrier, restart and zero execution)",
    "passed": false,
    "detail": {
      "number": 20,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Managed Spec execution (fresh admission, real runner, BUG and cancel)",
    "passed": false,
    "detail": {
      "number": 21,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Managed execution UI (explicit click, durable recovery and stop)",
    "passed": false,
    "detail": {
      "number": 22,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Browser candidate source (fresh captures and explicit healthy side)",
    "passed": false,
    "detail": {
      "number": 23,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Browser private source reader (owner fences and unchanged originals)",
    "passed": false,
    "detail": {
      "number": 24,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Browser source bindings (fresh captures, explicit sides and source revalidation)",
    "passed": false,
    "detail": {
      "number": 25,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Browser source binding console (native HTTP, source review and verified evidence)",
    "passed": false,
    "detail": {
      "number": 26,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Schema4 combined history (fresh Browser bindings and explicit Spec lifecycle fixtures)",
    "passed": false,
    "detail": {
      "number": 27,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Browser full candidates (explicit review, durable save and read-only reconciliation)",
    "passed": false,
    "detail": {
      "number": 28,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Browser single-operation execution (fixed source, real target BUG, explicit retest and restart)",
    "passed": false,
    "detail": {
      "number": 29,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Browser start resolution (same unfinished ingress, durable deny, same-origin restart and native locks)",
    "passed": false,
    "detail": {
      "number": 30,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Manual defect tickets (fixed source members, explicit closure, regression and read-only reconciliation)",
    "passed": false,
    "detail": {
      "number": 31,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Preserve acceptance smoke failure diagnostics",
    "passed": false,
    "detail": {
      "number": 32,
      "status": "completed",
      "conclusion": "success"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Docker offline delivery (SSR + SPA + data SPA + adapter)",
    "passed": false,
    "detail": {
      "number": 33,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "execution",
    "name": "core (lint + test) / Post Run actions/setup-node@v7",
    "passed": false,
    "detail": {
      "number": 64,
      "status": "completed",
      "conclusion": "skipped"
    }
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Acceptance catalog explicit migration (legacy artifacts, CLI confirmation and browser continuity)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Spec baseline review (candidates, approvals, selections and source integrity)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Managed Spec preparation (immutable contract, replay and zero execution)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Managed Spec result reading (captured evidence and zero execution)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Owned acceptance recovery (startup barrier, restart and zero execution)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Managed Spec execution (fresh admission, real runner, BUG and cancel)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Managed execution UI (explicit click, durable recovery and stop)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Browser candidate source (fresh captures and explicit healthy side)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Browser private source reader (owner fences and unchanged originals)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Browser source bindings (fresh captures, explicit sides and source revalidation)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Browser source binding console (native HTTP, source review and verified evidence)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Schema4 combined history (fresh Browser bindings and explicit Spec lifecycle fixtures)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Browser full candidates (explicit review, durable save and read-only reconciliation)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Browser single-operation execution (fixed source, real target BUG, explicit retest and restart)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Browser start resolution (same unfinished ingress, durable deny, same-origin restart and native locks)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Manual defect tickets (fixed source members, explicit closure, regression and read-only reconciliation)",
    "passed": false,
    "detail": []
  },
  {
    "category": "capture",
    "name": "unique step log core (lint + test) / Docker offline delivery (SSR + SPA + data SPA + adapter)",
    "passed": false,
    "detail": []
  },
  {
    "category": "execution",
    "name": "D5 unique terminal summary event",
    "passed": false,
    "detail": []
  },
  {
    "category": "execution",
    "name": "D5 passed with exact ten true keys",
    "passed": false,
    "detail": {}
  },
  {
    "category": "execution",
    "name": "D5 exact four desktop/mobile captures",
    "passed": false,
    "detail": null
  },
  {
    "category": "execution",
    "name": "D5 zero page errors",
    "passed": false,
    "detail": null
  },
  {
    "category": "execution",
    "name": "D5 three explicitly controlled HTTP console errors",
    "passed": false,
    "detail": {
      "consoleMessageCount": null,
      "controlledReplyCount": null
    }
  },
  {
    "category": "execution",
    "name": "Docker stats available",
    "passed": false,
    "detail": null
  }
]
```

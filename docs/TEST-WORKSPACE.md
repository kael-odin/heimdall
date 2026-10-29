# Test Workspace Configuration (heimdall-test-workspace)

For acceptance testing against a real project (with or without a reference baseline). The configuration lives in your testing workspace, not in the Heimdall repository.

## File: `.heimdall/workspace.json`

```json
{
  "version": 1,
  "project": {
    "name": "Xspark Proxy IP Platform",
    "description": "代理 IP 服务平台,覆盖官网、用户仪表板和管理后台"
  },
  "sites": {
    "official": {
      "entry": "https://www.xspark.cn",
      "loginRequired": false
    },
    "dashboard": {
      "entry": "https://dashboard.xspark.cn",
      "loginRequired": true,
      "loginProfile": "dashboard-qa-account"
    },
    "admin": {
      "entry": "https://admin.example.com",
      "loginRequired": true,
      "loginProfile": "admin-token-injection"
    }
  },
  "loginProfiles": {
    "dashboard-qa-account": {
      "kind": "storageState",
      "file": ".heimdall/sessions/dashboard-qa.json"
    },
    "admin-token-injection": {
      "kind": "initScript",
      "file": ".heimdall/sessions/admin-init.mjs"
    }
  },
  "conventions": {
    "notReported": [
      "【】括号为强调写法",
      "折扣阶梯配置可随时开启",
      "企业认证流程存在",
      "支付宝实名模式",
      "政策文档四页(用户服务协议/隐私政策/退款政策/合规声明)整页不查"
    ]
  },
  "ledger": {
    "file": "09-全局问题总报告/data/issues.json",
    "schema": "xspark-patrol-v1"
  },
  "knowledge": {
    "root": ".",
    "prd": "08-PRD原始件",
    "apiSpecs": "03-接口底表",
    "reports": "05-测试报告"
  }
}
```

## Login Profiles

### `storageState` (Playwright storageState file)
- Heimdall loads cookies, localStorage, sessionStorage from a Playwright-generated JSON file.
- Generate it once: log in manually via browser, then save with `page.context().storageState({ path: 'sessions/name.json' })`.
- File stays in your testing workspace and is never committed to the Heimdall repository.

### `initScript` (Custom initialization JavaScript)
- For backends that store JWT in localStorage or use non-cookie auth.
- Heimdall runs the script in the new browser context before navigating to the page.
- Example for Xspark admin:
  ```javascript
  // .heimdall/sessions/admin-init.mjs
  export default async function initAdminSession(page) {
    const token = process.env.XSPARK_ADMIN_TOKEN || '从凭据文件读取';
    await page.addInitScript(() => {
      localStorage.setItem('_token', token);
      localStorage.setItem('_user_info', JSON.stringify({...}));
      localStorage.setItem('_permission', JSON.stringify({...}));
    });
  }
  ```
- Heimdall redacts token values from logs and reports; only the profile name appears.

## Ledger & Verdicts

When Heimdall finds a difference, it checks the ledger first:
- **Match existing issue**: apply the previous verdict (true-bug / false-positive / team-convention / deferred / design-as-intended).
- **New finding**: present to user for triage; save their verdict to the ledger with reasoning and date.

Ledger format for Xspark: see `F:\学习手册\Xspark\代理IP调研\Xspark接手测试\09-全局问题总报告\data\issues.json`. Heimdall imports existing entries and appends new ones.

## Knowledge Assets

Heimdall reads PRDs, API specs, and historical reports to:
1. Generate acceptance point candidates from PRD sections.
2. Validate API response structure against OpenAPI schemas.
3. Link findings to source documents.

Paths are workspace-relative. Heimdall does not commit workspace content to its repository.

## Conventions & Filters

- `conventions.notReported`: patterns that are team-agreed exceptions (e.g., bracket emphasis style, policy doc exemptions).
- Findings matching these patterns are filtered out before reporting.
- Each convention includes reasoning so it can be reviewed later.

## Single-Site Mode (No Baseline)

When `mode: "single"` in a plan, Heimdall checks:
- Navigation and HTTP status
- Console errors and network failures
- Horizontal overflow
- Broken links
- Declared assertions from acceptance points

No visual or structural comparison. Findings marked as `observation` unless supported by PRD contract. Used for original projects like Xspark that have no clone baseline.

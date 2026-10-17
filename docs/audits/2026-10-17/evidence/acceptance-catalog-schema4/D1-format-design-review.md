# D1 schema4 纯格式与 Browser 组织候选摘要只读复核

2026-10-17。基于当前开发工作树的源码分析；没有运行测试、构建、迁移、runner 或浏览器，没有修改产品文件或公开文档，没有 stage/commit。本文件位于 ignored 工作区。已先读 D 主设计及其补充 README，以下以补充的“普通启动不迁移，D1 → D2 独立门禁”为准。

结论：推荐按下述合同实施 D1。`browserCandidates` 在格式层完整冻结，D1 新建/迁移所得 map 为空；本片没有创建候选的 store 方法、候选写 API、完整预览 API 或 UI。现存 schema3 与 schema4 都继续支持已有 Spec 和 ax 行为。

## 1. 已核对的代码触点

| 文件/当前行 | 事实 | D1 必须动作 |
|---|---|---|
| `core/src/acceptance/catalog-schema.mjs:8-20` | limits、ID 集、V1/V2/V3 root fields 分开 | 新增 bc ID、V4_MAPS/V4_FIELDS、browserCandidates=1024、migrations=3；保留旧 root 精确集合 |
| 同上 `:105,131,136,158` | capacity、root dispatcher、map entries、ax 校验只覆盖到3，ax分支为 `===3` | entries/ax条件使用 `>=3`，V4单独 strict root，capacity计入新map |
| 同上 `:213-224` | migration数量≤schemaVersion-1；合法 transition 只到2→3 | v4允许3→4且原1→2/2→3仍合法；不要求恰好3条，因为原生v3→4只有1条 |
| 同上 `:232-282` | hasV3Migration及browser-source-bound同样写死3 | v4仍执行2→3前不得出现ax的屏障；独立增加v4候选屏障与seenBrowserBindings |
| 同上 `:304-307` | 通用dispatcher接受1/2/3 | 扩为1/2/3/4，旧显式V1/V2/V3 validator不扩大形状 |
| 同上 `:334` | buildCatalogMigrationV3是纯2→3构造器 | 保持其输入/输出；新增纯3→4构造器，不能把v3误传入旧V3构造器 |
| `core/src/acceptance/catalog.mjs:33-59` | history-prefix maps与previous只到3 | 新map纳入prefix，previous允许相邻3→4；不允许跨版本previous或下降 |
| 同上 `:141-145` | requireCurrent只接受3 | 既有操作接受3/4，v4候选能力未来另设requireV4；1/2仍固定MIGRATION_REQUIRED |
| 同上 `:163-184` | preimage仅v1/v2，正则[12]，每版本≤2 | 增v3并保持每版本≤2，先校验所有版本名/原字节摘要，不能只扩文件名 |
| 同上 `:202-242` | initialize自动1→2→3；空目录隐式创建3 | 分离open-only initialize、显式创建、显式维护迁移；普通启动不调用migrateOne |
| `core/src/acceptance/browser-candidate-identity.mjs` | 冻结旧Browser来源域与projectionVersion1 | 整文件旧常量及旧hash原义不改；新组织域放独立纯模块 |
| `core/src/acceptance/identity.mjs:14` | canonical JSON拒绝getter/proxy/hook/sparse/nonfinite | 复用同一canonicalJsonVersion，不引入第二个生产canonical实现 |
| `core/src/acceptance/owner.mjs:24` | assertAcceptanceOwner做genuine acquired-owner品牌校验 | 新维护入口必须用该函数，不能只接受assertOwned方法形状 |

`catalog.mjs` 现有 assertOwned 只检查方法形状。新维护入口的 genuine-owner 要求应显式落实；可以在新维护路径先做品牌校验，不必顺手改变所有旧测试的fake owner合同。

## 2. 精确的 schema4 候选形状

root = V3_FIELDS + `browserCandidates`，必需且仅允许这些字段。`browserCandidates` 必须为plain、无accessor/symbol/hidden/proxy的map；null-prototype map仍可接受，与旧map一致。key只能为小写 `bc-UUID`。

每条bc strict字段恰为：

```text
id, candidateContractVersion, mode, projectId, releaseId, sourceBindingId,
sourceContentDigest, organizationContextDigest, contentDigest, createdAt, actor
```

逐项验证顺序应在hash/clone前完成：

1. map key/id相同且均bc；版本精确数值1、mode精确browser；ap/ar/ax前缀不扩大。
2. project/release/ax均存在；release.projectId、ax.projectId与candidate.projectId一致；ax.releaseId与candidate.releaseId一致。
3. actor严格`{kind:'local-operator'}`，createdAt严格当前iso helper；三个digest均64位小写hex。
4. `candidate.sourceContentDigest === ax.sourceContentDigest`。ax已按旧来源公式通过完整纯格式校验；D1不读source重新取摘要。
5. 从当前完整project/release/ax重算organizationContextDigest，再从显式candidateContent字段重算contentDigest。
6. 全catalog维护一个seenSourceBindings集合，第二个bc引用同一ax即拒绝。不同ax即使S相同仍可有不同bc。
7. 单实体JSON字节预算和catalog整体/计数预算均生效。建议精确固定`Buffer.byteLength(JSON.stringify(candidate)) <= browserCandidateBytes`，默认8192；预算计算发生在strict验证后。有效实体本来很小，边界测试可调低limit，不需要引入padding字段。

strict失败建议固定reason：`INVALID_BROWSER_CANDIDATE`；三层不符分开`BROWSER_CANDIDATE_SOURCE_MISMATCH`、`BROWSER_CANDIDATE_ORGANIZATION_MISMATCH`、`BROWSER_CANDIDATE_DIGEST_MISMATCH`；重复ax可为`BROWSER_CANDIDATE_ALREADY_EXISTS`。这些是schema不可用reason，不代表D1已发布对应HTTP写错误。

不要把bc加入旧`candidates` union。旧ab候选source.releaseId、mode:spec、projectionVersion1及旧contentDigest算法全部原样。旧aa候选引用仍只能ab，旧as仍spec，currentSelectionsOf仍只返回spec。

## 3. 三层摘要与推荐纯模块边界

新增例如 `browser-organized-candidate-identity.mjs`，只import `hashAcceptanceValue`，无catalog/projector/source/fs import：

```js
export const BROWSER_ORGANIZED_CANDIDATE_V1 = Object.freeze({
  candidateContractVersion: 1,
  canonicalJsonVersion: 'acceptance-json-v1',
  digestAlgorithm: 'sha256',
  domain: 'heimdall-acceptance-browser-organized-candidate',
});
export function hashOrganizedBrowserCandidateValue(kind, value) {
  return hashAcceptanceValue({ ...BROWSER_ORGANIZED_CANDIDATE_V1, kind, value });
}
```

`kind='organization-context'`与`kind='content'`的原字节拼写是冻结合同，不可缩写。底层hash helper可与旧helper一样接受strict JSON；领域对象的strict字段与关联校验放schema/builder，避免新模块反向import schema形成环。

schema内从已验证实体构建：

```js
const organizationContext = { project, release, sourceBinding };
const organizationContextDigest = D('organization-context', organizationContext);
const candidateContent = {
  candidateContractVersion: 1, mode: 'browser',
  projectId, releaseId, sourceBindingId,
  sourceContentDigest: sourceBinding.sourceContentDigest,
  organizationContextDigest,
};
const contentDigest = D('content', candidateContent);
```

需要导出给未来D2使用的helper时，推荐明确的`browserCandidateContentOf(candidate)`，只投影上列7项；不能套用旧`candidateProjectionOf`，后者只去掉id/createdAt，会意外将bc actor纳入候选内容。`organizationContextOf`只在strict已过后返回JSON copy，不能先JSON.stringify外部对象再验证。

组织摘要包含完整不可变project/release/ax：project/release的createdAt、release可选buildRef、ax.boundAt/actor及全部来源字段均参与。buildRef缺失保持缺失，不能填null/空串。bc自身id/createdAt/actor不参与contentDigest，但仍参与entityDigest。generationId/revision/events/migrations不参与两层新内容摘要。

sourceContentDigest始终是旧Browser域S.contentDigest，包含旧projectionVersion，不含组织ID。相同S在两个独立有效组织中sourceDigest相同，org/content不同。修改合法URL查询值/查询顺序/重复参数会改变源和组织身份；不要经Display URL重建，不调用URLSearchParams.sort。已有sourcePlanDigest仍是原JSON.stringify(normalizedPlan)字节hash。

## 4. 事件历史：不能复用Spec或legacy run-bound门槛

新增 `browser-candidate-created`，仅schema4接受，entityId精确bc。entityDigest仍hashAcceptanceValue完整候选，event.at必须等于候选createdAt；projectId需一致。保持一实体一事件、revision=events.length=全部map实体数、global migration event不能带projectId。

独立增加`seenBrowserBindings`，在合法browser-source-bound事件通过后add(ax)。bc事件要求：已见其project、release和sourceBinding事件；有3→4迁移时必须已见该迁移。合法ax可以没有legacy run-bound，因此不能要求旧seenBindings含ac。

v4有两个独立版本屏障：

```text
hasV3Migration = schemaVersion >= 3 && exists(toSchemaVersion=3)
hasV4Migration = schemaVersion >= 4 && exists(toSchemaVersion=4)
ax事件 => !hasV3Migration || seenV3Migration
bc事件 => !hasV4Migration || seenV4Migration
```

原生v4没有迁移记录时，合法的project→release→ax→bc应可校验。原生v3迁至v4只含3→4，旧ax本来在迁移前；该历史必须合法。由v1来的链须1→2→3→4顺序连续，不允许省中间步、逆序、重复transition、重复generation或最终toVersion不是root版本。已有`seenBaselineEvent`仅保护1→2前不得存在Spec实体的原逻辑，保留原义。

迁移event与bc之间有序要求属于格式合同，即使D1尚无bc writer，也必须通过纯fixture验证；否则D2会被迫同版本补改格式。

## 5. 纯3→4构造器的最小行为

推荐export `validateAcceptanceCatalogV4` 与 `buildCatalogMigrationV4`。后者先严格validateV3、检查headSha256/previousSha256/at，deep clone后：

- schemaVersion=4；新增browserCandidates={}。
- generation产生新ag，排除当前generation及历史所有fromGenerationId。
- 追加一个am，from3/to4、原generation/revision、调用者已核验原字节head/previous SHA、时间/actor。
- revision+1，仅追加一个global catalog-migrated event；老实体、老migration、老events prefix逐语义值不变。
- capacity/jsonBytes预检后validateV4返回新值；输入值不变。不要在纯builder读文件、算source文件SHA或持久保存任何PNG。

V1/V2/V3显式validator的strict字段列表保持原样。通用validator只添加V4分派；不能让schemaVersion=3但带browserCandidates={}通过。

## 6. 显式维护入口与普通启动的分离

建议分为三条明确能力；命名可由主实现统一：

1. open-only `initialize()`：catalog存在时读/验证head+previous，接受3/4，返回且零catalog/preimage写入。v1/2给MIGRATION_REQUIRED；未知版本UNSUPPORTED_SCHEMA。catalog缺失时不悄悄造库。
2. explicit create：空目录只有在调用者显式给targetSchemaVersion（3或4）时创建对应空形状，仍拒绝已有catalog.*恢复材料。普通engine若需要兼容首次安装，可以在明确空库分支调用create({targetSchemaVersion:3})；必须在代码/输出中清楚区分“创建”与“打开”，不借创建覆盖旧目录。
3. maintenance plan/apply：genuine owner、明确target=4、expectedGenerationId/revision/head原字节SHA；plan只读给每步容量/preimage/hash/版本/generation变化说明，apply再队列内核对相同输入后逐步执行。新维护程序应独立获取owner，活动engine持owner时拒绝，不强抢。

若一次显式apply从v1开始，可逐步1→2→3→4，但每一步独立durable事实。失败后返回当前head身份/版本和已完成步骤；恢复由新head重新plan并确认，不以旧CAS重复apply。可以一步只迁相邻版本以简化，仍需明确target/计划与恢复体验。

preimage支持v1/v2/v3每版最多2个SHA命名原件。`previous`可能与head同版本，也可能是相邻迁移前版本；计算新step计划时应保留两者。migration前像容量、损坏前像、hash命名不符、symlink、未知previous均在任何preimage/previous/head写入前拒绝。既有commit late失败可已旋转previous，不应承诺“所有失败零写入”。

普通startup验收的byte/stat范围应明确catalog/preimage/运行原件；owner lock与engine正常recovery记录属于不同生命周期。不能为了“全目录零变化”错误禁止正常owner获取，也不能把owner变化算作catalog迁移。

## 7. 建议独立测试矩阵（均未执行）

| 测试组 | 必须包含的向量/反例 |
|---|---|
| 新域golden | 固定UUID/时间、固定完整project/release/ax，独立canonical+createHash生成org/content两个常量；expected不得调用生产D/helper；原Browser source golden与原Spec golden原值全部保留 |
| 域区分 | 同value下新org、新content、旧Browser content、裸hash四者不同；改candidateContractVersion/domain/canonicalJsonVersion/digestAlgorithm/kind均改变hash |
| 同源多组织 | 两组独立有效catalog复用同source projection；改project/release/ax ID之一；sourceDigest不变而org/content改变；不能在单catalog造重复run/side ax绕过B唯一性 |
| 参与字段 | project.name/createdAt，release.label/targetUrl/buildRef/createdAt，ax.boundAt及其完整source/digests分别变更且重算相关event/sourcehash后，旧org/content拒绝；缺buildRef与存在buildRef有独立golden |
| 排除字段 | bc.id/createdAt、catalog generation/revision/无关合法event变化后content相同；entityDigest仍按bc完整字段变化；actor只有一种合法kind，不用非法actor变体证明排除 |
| canonical | 对象键序稳定、null-prototype稳定、Unicode按现有规则；数组顺序敏感（通用hash测试），query重复/顺序/空query按既有URL规范化合同；URL显示脱敏不可替代内部身份 |
| 类型strict | map/root/record/actor各层proxy、getter、symbol、hidden、错误prototype、toJSON/unknown字段、undefined/NaN/BigInt/cycle/sparse拒绝且用户代码调用计数0；先结构拒绝再hash |
| 字段strict | 每字段删除/额外字段、bc/ap/ar/ax错前缀/大写UUID、id-key不等、版本字符串1/数值2、mode spec、actor多字段、坏时间/hash逐个拒绝 |
| 关联/摘要 | 不存在项目/版本/ax、跨项目release、跨release binding、sourceDigest和ax不等、伪造org/content各拒绝；攻击者重算entityDigest也不能通过；重复ax以不同bc拒绝 |
| 事件 | bc事件错误kind/id/project/at/entityDigest；bc早于project/release/ax、早于3→4；ax早于2→3；交换/reindex/rehash后仍拒绝；孤立record、孤立event、revision/count不符拒绝 |
| 原生/迁移 | 空native4、native4带Spec+ax+bc纯fixture，native3→4、native2→3→4、v1全链；只有后缀迁移链合法，不要求从1开始；重复/跳级/倒序/未完成链拒绝 |
| 构造器容量 | 原V3输入不变；原实体/旧event prefix和source hashes值不变；新map空、仅一am/event、revision+1、新generation不复用；events/migrations/jsonBytes边界及+1 |
| 实体/map容量 | browserCandidates=1024及+1、可调低browserCandidateBytes的精确边界； limitsOf对负数/小数/未知key拒绝；v3没有新map但不会被undefined计数误判 |
| store前驱 | 同版本rolling previous需含bc prefix不变；相邻3→4需要原SHA/generation/revision精确且history prefix；4→3、2→4、非祖先、改bc后rehash历史均拒绝 |
| 维护失败恢复 | preimage每版2/+1；所有early容量失败无catalog写；preimage后/previous后/head后中断；owner丢失/root替换；重启只是open，不继续迁移；显式重新plan仅继续未完成步 |
| 启动无迁移 | schema3/4反复open，catalog/preimage字节、stat、revision/generation相同；v1/2只给维护状态且原件保留；空目录不隐式换4；未知版本不降级 |
| 历史回归 | 完整旧Spec candidate→approve→select→cancel/reselect与prepare/dispatch/read/recovery合同不变；schema3/4均可继续原操作；bc送到旧Spec方法/aa/as/managed envelope均拒绝 |
| 无source I/O | 单纯validateV4、新digest、migration plan/apply不调用Browser/Spec source reader，不打开ac目录/plan/report/PNG；catalog读写与preimage是唯一预期持久变化 |

现有测试复用点：`acceptance-catalog-schema-v3.test.mjs`、`acceptance-browser-source-binding-schema.test.mjs`已有独立test-side投影和攻击性rehash方法，可平行增加V4 suite；不要直接修改其V3期望来掩盖兼容退化。`acceptance-catalog-schema.test.mjs`精确断言export集合，新增exports后需按意图更新。

## 8. 容易遗漏的历史与smoke兼容

1. 新browserCandidates map不能只进schema：必须进hasHistoryPrefix，否则rolling previous可能删除/改bc而未被前驱校验发现。
2. v4中旧ax分支的三个`===3`（校验/hasV3Migration/event）都要解除；只改root会留下旧ax“格式不认识”的断路。
3. 同一run baseline可归不同project/release，target与legacy runBinding仍必须一致；schema4保留B两种顺序约束。新bc通过ax引用，不新增一套run/side归属入口。
4. native3迁到4含一条migration，v1全链含三条；不可把migrations.length固定3或要求必有1→2。
5. preimage v3可能含旧Spec+ax历史、raw空白/CRLF等，必须保存原字节；pretty打印后的等价JSON不是前像。
6. 现有catalog migration smoke通过launch引擎触发隐式升级，D1后该场景必须改为“启动只提示维护→停engine→维护plan/apply→重启读取”，不能删除该smoke或继续声称普通启动自动迁移。
7. 大量fixture默认`store.initialize()`会造空schema3；应让fixture显式创建目标格式。C Browser binding DTO/HTTP/UI合同本身不用改；适配创建入口不等于扩大C产品范围。
8. 旧程序读取v4应失败；历史preimage用于隔离调查，不承诺旧程序可直接打开活动v4目录。D1不能静默回写3或丢弃browserCandidates。
9. D1只纯格式接受未来bc；新建/迁移结果必须browserCandidates={}，公开文档不能写成“已能记录Browser候选”。
10. 当前generic hash本身不设深度/节点预算；新实体先strict固定字段/关联校验再hash，不能先hash未经验证的任意嵌套外部对象来扩大栈/内存风险。

推荐验收顺序为：纯identity/V4 schema → 显式维护与中断恢复 → schema3/4完整Spec与B/C兼容 → 精确commit对应fresh迁移smoke → 本片Core与CI。全部运行应由父任务安排串行资源窗口；本次只读报告没有任何已通过运行结果。

# Bili Daily C3-1 审计补强报告：特征空间校验与 IDF 模型结构校验

- 日期：2026-11-11
- 阶段：C3-1 审计补强（不进入 C3-2）
- 修改文件：`recommend-core.js`、`test-recommend-core.js`
- 新增测试：11 项（45 → 56）
- 结论：**两个问题均已复现并修复；56/56 + 241/241 = 297/297 全部通过**
- 未修改：C1 / C2 全部模块、popup、manifest、storage、content

---

## 0. 执行状态总表

| 项目 | 状态 | 证据 |
|---|---|---|
| 问题 1（跨特征空间比较）复现 | **已执行** | §2.1，修复前返回 `approximation` |
| 问题 2（IDF 模型结构未校验）复现 | **已执行** | §2.2，修复前抛 TypeError |
| 回滚快照 | 已执行 | `rollback/before-c3-1-audit/` |
| 修改 `recommend-core.js` | 已执行 | §3 |
| 追加测试 46–56 | 已执行 | §4 |
| 新增 56 项测试 | **已执行** | `56/56 通过`，退出码 0 |
| 既有 241 项回归 | **已执行** | 全绿，退出码全 0 |
| `node --check`（7 个文件） | **已执行** | 退出码全 0 |
| 缺陷修复后复验 | **已执行** | §2.3 |
| C3-1 正式验收报告存在性确认 | **已执行** | §7 |
| 修改业务模块 / 权限 / UI | **未执行（禁止）** | 零改动 |

---

## 1. 审计范围

### 1.1 问题 1：compareVectors 缺少 feature space 校验

审查意见：`compareVectors()` 已检查 `basis`，但 partition 与 title 属于不同特征空间，
应禁止互相比较；`allowCrossBasis` 只允许不同统计口径，不允许不同特征空间。

### 1.2 问题 2：buildTfIdfVector 未校验外部 IDF 模型

审查意见：外部模型缺少结构校验；损坏模型可能抛未捕获异常或被静默修正。

---

## 2. 复现与修复验证

### 2.1 问题 1 修复前（实际输出）

构造用户分区向量（`space: "partition"`, `basis: "watch-ms"`）与
TF-IDF 标题向量（`space: "title"`, `basis: "token-count"`）：

```
compareVectors(uv, tv, { allowCrossBasis: true })
-> approximation  similarity = 0.8610369959439764
cosineSimilarity(uv, tv, { allowCrossBasis: true })
-> 0.8610369959439764
```

**缺陷确认**：`allowCrossBasis` 把"跨口径"误当成了"跨特征空间"的通行证，
算出了一个数学上存在、语义上无意义的相似度。

### 2.2 问题 2 修复前（实际输出）

| 输入模型 | 修复前行为 |
|---|---|
| `{ enabled:true, documentCount:1, oovIdf:1, idf:null }` | **抛 `TypeError: Cannot convert undefined or null to object`** |
| `"abc"` | 静默按统一权重计算，`status: "ok"`，`vector: {"a":1}` |
| `{}` | 同上（静默） |
| `idf: { a: NaN }` | 同上（NaN 被静默替换为 oov） |
| `oovIdf: -1` | 同上 |
| `documentCount: NaN` | 同上 |

**缺陷确认**：一类模型直接崩溃，其余损坏模型被静默降级为"无 IDF"，
产出的结果与合法输入无法区分——正是"静默修正损坏数据"。

### 2.3 修复后复验（实际输出）

```
compareVectors(uv, tv, { allowCrossBasis: true })
-> space-mismatch   similarity = null

buildTfIdfVector({a:1}, { enabled:true, documentCount:1, oovIdf:1, idf:null })
-> status = invalid-idf-model   code = invalid-model-idf   vector = null
（未抛异常）
```

---

## 3. 修改内容

只修改 `recommend-core.js`，约 250 行新增（1732 → 1952 行）。

### 3.1 特征空间校验

| 位置 | 改动 |
|---|---|
| 新增 `spaceMismatch(leftSpace, rightSpace)` | 两侧都声明 space 且不同 → `true` |
| `cosineSimilarity()` | 在任何数学计算前检查空间；跨空间直接返回 `null`（`allowCrossBasis` 无效） |
| `compareVectors()` | 新增 `status: "space-mismatch"`，`similarity: null`，附 `reasons` 与 `limitations`；返回新增 `spaces: {left, right}` |
| `summarizeSide()` | 证据块新增 `space` 字段 |
| 未声明 space 的原始稀疏向量 | 保持纯数学兼容；`compareVectors` 追加 `space-unspecified` 原因与限制说明 |

`allowCrossBasis` 的语义被限定为：**只放宽统计口径（watch-ms vs video-count），
绝不放宽特征空间（partition vs title）**。

### 3.2 IDF 模型结构校验

新增 `validateIdfModel(model)`，逐项检查：

| 字段 | 规则 |
|---|---|
| 整体 | 必须是普通对象（`"abc"` → 拒绝） |
| `enabled` | 必须是布尔值 |
| `documentCount` | 必须是非负整数 |
| `oovIdf` | 必须是有限正数 |
| `idf` | 必须是普通对象，且每个值都是有限正数 |
| `minDocuments`（可选） | 若存在，必须是非负有限数 |
| `df`（可选） | 若是存在，必须是普通对象，值均为非负整数 |

损坏模型返回 `status: "invalid-idf-model"`、`vector: null`，附
`reasons[0].code`（如 `invalid-model-idf`）与 `config.modelRejected: true`。

**不做任何修补**：不补默认值、不跳过坏字段、不退回统一权重。
`model` 为 `null` / `undefined` 仍然合法（调用方明确要求"无 IDF"），
与"模型损坏"在输出中可区分（前者 `status: "ok"`）。

---

## 4. 新增测试（46–56）

| 编号 | 覆盖点 |
|---|---|
| 46 | 不同特征空间默认拒绝，`spaces` 可审计 |
| 47 | `allowCrossBasis` 不能绕过空间校验 |
| 48 | `cosineSimilarity` 跨空间返回 `null`（含显式近似） |
| 49 | 同空间不同口径仍可显式近似（原有能力未被误伤） |
| 50 | 未声明 space 的原始向量保持数学兼容并标注限制 |
| 51 | 损坏模型：非对象、缺字段、非法 enabled/documentCount/oovIdf/idf |
| 52 | 损坏模型：NaN / Infinity / 0 / 负数 / 字符串 idf、非法 df、非法 minDocuments，全部不抛异常 |
| 53 | 损坏模型不会被静默修正成统一权重（与 `null` 模型结果可区分） |
| 54 | 拒绝输出可 JSON 往返、无 NaN / Infinity |
| 55 | 合法边界模型（enabled / disabled / JSON 冻结）仍通过 |
| 56 | 比较结果的 `space` 字段可审计且 JSON 稳定 |

原有 45 项**未删除、未跳过、未放宽任何断言**，全部保持通过。

---

## 5. 测试结果（实际执行）

| 测试文件 | 结果 | 退出码 |
|---|---|---|
| `test-recommend-core.js` | **56/56 通过** | 0 |
| `test-candidate-content-import.js` | 60/60 通过 | 0 |
| `test-candidate-features.js` | 38/38 通过 | 0 |
| `test-candidate-quality.js` | 28/28 通过 | 0 |
| `test-candidate-pool.js` | 33/33 通过 | 0 |
| `test-interest-profile.js` | 24/24 通过 | 0 |
| `test-uid.js` | 21/21 通过 | 0 |
| `test-up-stats.js` | 17/17 通过 | 0 |
| `test-stats.js` | 20/20 通过 | 0 |

合计 **297/297**，`FAILED_FILES=0`。

---

## 6. 语法检查

```
node --check recommend-core.js            -> 0
node --check test-recommend-core.js       -> 0
node --check stats.js                     -> 0
node --check interest-profile.js          -> 0
node --check candidate-pool.js            -> 0
node --check candidate-features.js        -> 0
node --check candidate-content-import.js  -> 0
```

---

## 7. C3-1 正式验收报告确认

| 文件 | 状态 |
|---|---|
| `docs/acceptance/C3-1/C3-1-core-report.md` | **已存在**（13,991 字节，2026-11-11 18:26） |
| `docs/acceptance/C3-1/C3-1-core-report.html` | **已存在**（25,822 字节，18:27，由 Markdown 生成） |

两份文件均在本次审计前生成，本次**未覆盖**。
上表中 C3-1 的测试数字为补强前的 `45/45`；补强后的最新数字以本报告 §5 为准（56/56）。

---

## 8. 兼容性影响

| 场景 | 影响 |
|---|---|
| 同空间、同口径比较 | 不变 |
| 同空间、不同口径 + `allowCrossBasis: true` | 不变（仍为 approximation） |
| 不同空间 + `allowCrossBasis: true` | **行为变化**：由返回近似值改为 `space-mismatch` + `null`（本次修复目标） |
| `cosineSimilarity` 传入声明了不同 space 的包装对象 | **行为变化**：返回 `null`（此前会计算） |
| `buildTfIdfVector` 传入损坏模型 | **行为变化**：由静默降级/抛异常改为显式拒绝（本次修复目标） |
| `buildTfIdfVector` 传入 `null` 模型 | 不变（统一权重 1） |
| 合法模型（含 JSON 往返冻结模型） | 不变 |

以上变化只影响**非法或语义无效的输入**，不影响任何既有合法调用路径；
原有 45 项测试全部通过即为其证据。

---

## 9. 回滚方法

快照：`rollback/before-c3-1-audit/`（两个文件 + README）。

```powershell
cd D:\Bili-Daily
Copy-Item rollback\before-c3-1-audit\recommend-core.js . -Force
Copy-Item rollback\before-c3-1-audit\test-recommend-core.js . -Force
node test-recommend-core.js   # 应回到 45/45，且两个缺陷重新出现
```

本轮新增的验收报告文件可单独删除，不影响代码回滚。

---

## 10. 未执行项与局限

| 项目 | 说明 |
|---|---|
| Edge popup 真机验证 | 尚无 UI 接入 |
| 真实数据评测 | 数据量不足 |
| 时间衰减 / MMR / 综合评分 | 本阶段禁止 |
| 对 `counts` 入参的原型污染防护测试 | 词元来自内部构建器，暂未覆盖 `__proto__` 等异常键的独立用例 |
| 对 `idf` 对象 getter 抛异常的防护 | 期望输入为 JSON 往返后的普通数据；带 getter 的对象不在支持范围 |

---

## 11. 声明

- §2 的"修复前"输出、§5 的通过数与退出码均为实际执行所得；
- 未编造任何测试结果或性能数据；
- 本次未修改任何 C1 / C2 / popup / manifest / storage / content 文件；
- 本阶段结束，等待审核，**不进入 C3-2**。

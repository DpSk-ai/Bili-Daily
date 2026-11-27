# 验收与测试报告保存约定

本目录保存 Bili Daily 各阶段的测试结果、开发结果与验收报告。

## 1. 固定规则

**每次测试或开发完成后，结果必须落盘保存为文件，不能只停留在对话里。**

- 源文件使用 Markdown，放在 `docs/acceptance/<阶段>/`。
- 同时生成一份**单文件 HTML**，CSS 内联、不依赖外部资源、不需要联网，便于直接打开、打印或归档。
- Markdown 是事实来源；HTML 由 Markdown 生成，不手工改 HTML。
- 报告中必须区分**已执行 / 未执行 / 推导**，不得把未运行的测试写成通过。
- 每次新增测试轮次应保留历史，不静默覆盖旧报告；建议文件名带日期，例如
  `C2-4-test-results-2026-11-12.md`。

## 2. 命名建议

| 类型 | 文件名 |
|---|---|
| 阶段开发 / 验收报告 | `<阶段>-<主题>-report.md` |
| 单次测试结果 | `<阶段>-test-results-YYYY-MM-DD.md` |
| 对应 HTML | 与 Markdown 同名，扩展名改为 `.html` |

现有文件如 `C2-2-quality-report.md`、`C2-3-feature-report.md` 保持原命名。

## 3. 生成单文件 HTML

在 `D:\Bili-Daily` 下执行：

```powershell
node tools/build-report-html.js `
  docs/acceptance/C2-3/C2-3-feature-report.md `
  docs/acceptance/C2-3/C2-3-feature-report.html
```

脚本只读取 Markdown 并写出 HTML，不修改源文件，不访问网络，不引入依赖。

生成后应至少检查：

- HTML 能被浏览器正常打开；
- 目录、表格、代码块完整；
- 页面标题与报告标题一致；
- 打印 / A4 样式无明显溢出。

## 4. 报告至少包含

1. 本阶段实际新建 / 修改的文件；
2. 关键数据结构或行为变化；
3. 实际执行的命令与输出结果；
4. 新增测试数量、通过数、退出码；
5. 既有测试回归结果；
6. 语法检查结果；
7. 未执行项及原因；
8. 已知限制与风险；
9. 回滚方式；
10. 下一步的输入需求（如适用）。

## 5. 现有报告索引

| 阶段 | 报告 |
|---|---|
| C1 | [C1 验收报告](C1/C1-acceptance-report-2026-11-11.md) |
| C1 | [兴趣画像审计](C1/C1-interest-profile-audit-2026-11-10.md) |
| C1 | [Edge 真实数据验收](C1/edge-real-data-acceptance-2026-11-11.md) |
| C1 | [测试结果](C1/test-results-2026-11-11.md) |
| C2-1 | [测试结果](C2-1/test-results-2026-11-11.md) |
| C2-2 | [候选质量报告](C2-2/C2-2-quality-report.md) · [HTML](C2-2/C2-2-quality-report.html) |
| C2-3 | [候选内容特征报告](C2-3/C2-3-feature-report.md) · [HTML](C2-3/C2-3-feature-report.html) |
| C2-4A | [新 UP 主候选来源评审](C2-4A/C2-4A-research-report.md) · [HTML](C2-4A/C2-4A-research-report.html) |
| C2-4B | [导入内容证据引擎](C2-4B/C2-4B-import-report.md) · [HTML](C2-4B/C2-4B-import-report.html) |
| C2-4B | [第 46 项测试失败修复报告](C2-4B/C2-4B-test46-fix-report.md) · [HTML](C2-4B/C2-4B-test46-fix-report.html) |
| C3-0 | [推荐算法架构与离线评测设计](C3-0/C3-0-research-report.md) · [HTML](C3-0/C3-0-research-report.html)（架构正文见 [docs/design/C3-0-recommendation-architecture.md](../design/C3-0-recommendation-architecture.md)；三项修正见 [补充说明](../design/C3-0-architecture-amendments.md)） |
| C3-1 | [内容向量化 / TF-IDF / 余弦纯函数](C3-1/C3-1-core-report.md) · [HTML](C3-1/C3-1-core-report.html) |
| C3-1 | [审计补强：特征空间校验与 IDF 模型结构校验](C3-1/C3-1-audit-report.md) · [HTML](C3-1/C3-1-audit-report.html)（测试 45 → 56） |
| MVP Sprint | [算法与测试层状态报告](MVP-Sprint/MVP-sprint-report.md) · HTML 未生成（执行通道阻断，见报告第 0 节） |
| MVP Sprint | [排序层 `userPartitionVector` 缺陷修复报告](MVP-Sprint/MVP-rank-fix-report.md) · [HTML](MVP-Sprint/MVP-rank-fix-report.html)（代码已修复，28/47/297 项测试待本机回填） |
| MVP Sprint | [第 4 项排序测试修复报告](MVP-Sprint/MVP-rank-test4-fix-report.md) · [HTML](MVP-Sprint/MVP-rank-test4-fix-report.html)（结果 note 文案与“准确率”子串检查冲突；测试待本机回填） |
| MVP Sprint | [工作包 B+C 一体化开发报告](MVP-Sprint/MVP-BC-integration-report.md) · [HTML](MVP-Sprint/MVP-BC-integration-report.html)（候选持久化、导入管理、推荐接线、popup UI；新增 50 项测试，命令通道阻断，结果待本机回填） |
| MVP Sprint | [候选持久化测试启动失败修复记录](MVP-Sprint/MVP-BC-candidate-store-test-fix.md) · [HTML](MVP-Sprint/MVP-BC-candidate-store-test-fix.html)（`test-candidate-store.js` 缺少 `candidate-features.js` require；已最小修复，28/28 与 422/422 待本机回填） |
| MVP Sprint | [候选 sidecar 测试第 25 / 26 项修复报告](MVP-Sprint/MVP-candidate-sidecar-test-fix-report.md) · [HTML](MVP-Sprint/MVP-candidate-sidecar-test-fix-report.html)（测试误用评估结构读取 sidecar；改为正式字段，追加同 BV 去重断言；28/28 与 422/422 待本机回填） |
| MVP Sprint | [自动发现新 UP 主开发报告](MVP-Sprint/MVP-auto-discovery-report.md) · [HTML](MVP-Sprint/MVP-auto-discovery-report.html)（HTML 为命令通道阻断时按 Markdown 手工整理，非生成脚本输出；新增 73 项测试、真实 DOM、性能均待本机回填） |
| MVP Sprint | [自动发现三个失败测试套件修复报告](MVP-Sprint/MVP-auto-discovery-test-fix-report.md) · [HTML](MVP-Sprint/MVP-auto-discovery-test-fix-report.html)（补 `stats.js` require；修复服务层把 observations 数组误判为非对象；495/495 待本机回填） |
| MVP Sprint | [**MVP v1.0 最终验收归档**](MVP-Sprint/MVP-v1.0-final-acceptance.md) · HTML 待生成（本轮命令通道阻断，生成命令见报告 11.1；未用手工 HTML 替代；495/495 为项目所有者本机结果；真实 Edge 验收标记为“用户报告通过”；快照位于 `snapshots/personal-mvp-v1.0-2026-11-12/`） |
| v1.1 | [**v1.1 Neon Edition 开发报告**](v1.1/v1.1-development-report.md) · HTML 待生成（30 项数据备份 + 20 项 UI 契约测试；495 项回归、语法检查、Git 提交均待本机回填；[文件哈希基线](v1.1/v1.1-file-hashes.txt)；视觉规范见 [docs/design/v1.1-neon-design-spec.md](../design/v1.1-neon-design-spec.md)） |
| C3-2 | [排序层测试失败分析与修复](C3-2/rank-test-failure-2026-11-12.md)（首轮定位，HTML 未生成） |

## 6. 稳定版封存

个人自用 MVP v1.0 已封存，代码/测试/文档的完整副本与 SHA-256 清单位于：

```text
D:\Bili-Daily\snapshots\personal-mvp-v1.0-2026-11-12\
```

- 本目录的报告仍以 Markdown 为事实来源；HTML 由 `tools/build-report-html.js` 生成。
- 扩展目录快照**不包含** `chrome.storage.local` 用户数据；数据导出/恢复方案见最终验收报告第 7 节。
- `rollback/` 历史快照未被覆盖或删除。
- v1.1 开发改动位于工作目录，未写入 v1.0 快照；开发前副本见 `rollback/before-v1.1-neon/`，验收脚本见 `tools/run-v1.1-acceptance.ps1`。

# OmniPM CDL 能力自发现层——五维质量评分卡与一票否决条件

> **引用关系**：OmniPM CDL（Capability Discovery Layer）子系统引用本模块，用于在发现候选依赖/工具/库时执行自动化质量评估。
> **用途**：对 CDL 发现的候选目标（npm 包、PyPI 包、GitHub 仓库等）执行五维质量评分与安全审查，输出 auto/manual/rejected 三级裁决。

---

## 模块元数据

```yaml
module_name: "cdl_quality_gate"
version: "1.0.0"
depends_on:
  - modules/security_gate.md      # §4.1 依赖审查清单复用
  - OMNIPM_SYSTEM_PROMPT.md       # §2.3 代码生成安全门禁复用
purpose: |
  CDL 质量门禁模块。
  为 OmniPM 能力自发现层提供标准化的候选目标质量评估框架，
  覆盖五维评分卡（Q-Score）、8 项一票否决条件、GitHub 生态额外门禁（D3.8），
  以及 .pi/skills.yaml 的 YAML schema 定义。
applies_to:
  - CDL 候选发现阶段
  - 依赖引入决策
  - Step C 开发实现——依赖审查子步骤
  - Step D 测试——安全自查子步骤
last_updated: "2026-07-21"
```

---

## 1. 五维质量评分卡（Q-Score）

Q-Score 是 CDL 对候选目标的综合质量评分，满分 100 分，由五个维度加权计算得出。

### 1.1 维度一：安全性（权重 30%）

| 评分项 | 满分 | 评分规则 |
|--------|------|----------|
| 已知漏洞（CVE） | 40 | 无已知 CVE 得满分；每发现 1 个未修复中危 CVE 扣 10 分，高危扣 20 分，扣完为止 |
| `--ignore-scripts` 兼容性 | 30 | 不依赖 install/postinstall 脚本得满分；存在但已审查得 15 分；存在且未审查得 0 分 |
| LICENSE 类型 | 30 | MIT / Apache-2.0 / BSD-2-Clause / BSD-3-Clause / ISC 得满分；其他宽松协议（MPL-2.0、Unlicense）得 15 分；GPL 系列得 5 分；无 LICENSE 得 0 分（同时触发 VETO-02 一票否决） |

### 1.2 维度二：活跃度（权重 20%）

| 评分项 | 满分 | 评分规则 |
|--------|------|----------|
| 最近 commit 时间 | 40 | ≤1 个月得满分；≤6 个月得 30 分；≤12 个月得 15 分；>12 个月得 0 分（同时触发 VETO-03 一票否决） |
| Release 频率 | 30 | 最近 6 个月有 release 得满分；最近 12 个月有 release 得 15 分；>12 个月得 0 分 |
| Issue 响应速度 | 30 | 平均 issue 首次响应 ≤3 天得满分；≤14 天得 15 分；>14 天或无法统计得 0 分 |

### 1.3 维度三：社区验证（权重 25%）

| 评分项 | 满分 | 评分规则 |
|--------|------|----------|
| GitHub Stars | 35 | ≥1000 Stars 得满分；≥100 Stars 得 25 分；≥10 Stars 得 10 分；<10 得 0 分 |
| npm/PyPI 下载量（近 7 天） | 35 | ≥100 万/周得满分；≥1 万/周得 25 分；≥100/周得 10 分；<100/周得 0 分 |
| 被其他项目依赖数 | 30 | 被 ≥1000 个包依赖得满分；被 ≥100 个包依赖得 20 分；被 ≥10 个包依赖得 10 分；<10 得 0 分 |

### 1.4 维度四：功能匹配（权重 15%）

| 评分项 | 满分 | 评分规则 |
|--------|------|----------|
| 需求关键词交集比例 | 60 | 交集比 ≥80% 得满分；50-79% 得 35 分；20-49% 得 15 分；<20% 得 0 分 |
| API 设计契合度 | 40 | 人工/LLM 评估：与项目架构风格一致得满分；部分一致得 20 分；不一致得 0 分 |

### 1.5 维度五：可维护性（权重 10%）

| 评分项 | 满分 | 评分规则 |
|--------|------|----------|
| 代码规范 | 35 | Lint/Format 配置齐全且无严重警告得满分；有配置但存在警告得 20 分；无配置得 0 分 |
| 文档完整度 | 35 | README ≥2000 字 + API 文档齐全得满分；README ≥500 字得 20 分；README <100 字得 0 分（同时触发 VETO-04 一票否决） |
| TypeScript 类型覆盖 | 30 | 自带类型定义得满分；DefinitelyTyped 有社区类型得 15 分；无类型定义得 0 分（仅 JS/TS 生态适用；非 JS/TS 生态此项默认满分） |

---

## 2. 评分公式与裁决阈值

### 2.1 核心公式

```
Q-Score = S_security × 0.30 + S_activity × 0.20 + S_community × 0.25 + S_fit × 0.15 + S_maintainability × 0.10

其中：
  S_security        ∈ [0, 100]  安全性维度小计
  S_activity        ∈ [0, 100]  活跃度维度小计
  S_community       ∈ [0, 100]  社区验证维度小计
  S_fit             ∈ [0, 100]  功能匹配维度小计
  S_maintainability ∈ [0, 100]  可维护性维度小计
```

### 2.2 三级裁决阈值

| Q-Score 区间 | 裁决结果 | 标识 | CDL 动作 |
|-------------|----------|------|----------|
| **≥ 75** | **自动通过（auto）** | 🟢 AUTO | 直接纳入候选集，无需人工审查 |
| **50 ~ 74** | **人工审查（manual）** | 🟡 MANUAL | 输出详细评分报告，等待用户确认后纳入 |
| **< 50** | **拒绝（rejected）** | 🔴 REJECTED | 直接拒绝，记录拒绝原因至审计日志 |

### 2.3 裁决优先级

一票否决条件（§3）**优先于** Q-Score 计算。候选目标先经过 8 项一票否决检查，**全部通过**后才进入 Q-Score 计算。命中任一否决条件则直接标记为 `rejected`，不再计算 Q-Score。

### 2.4 评分计算示例

```
候选目标: lodash@4.17.21（npm）

安全性:
  已知漏洞: 0 个 → 40 分
  install 脚本: 不依赖 → 30 分
  LICENSE: MIT → 30 分
  S_security = 100 分

活跃度:
  最近 commit: 2 周前 → 40 分
  Release 频率: 3 个月前 → 30 分
  Issue 响应: 平均 2 天 → 30 分
  S_activity = 100 分

社区验证:
  Stars: 59,000 → 35 分
  周下载量: 5,000 万 → 35 分
  被依赖: 30,000+ 包 → 30 分
  S_community = 100 分

功能匹配:
  关键词交集: 90% → 60 分
  API 契合度: 一致 → 40 分
  S_fit = 100 分

可维护性:
  代码规范: 已配置 Lint → 35 分
  文档: README 完整 + API 文档 → 35 分
  TS 类型: 自带类型定义 → 30 分
  S_maintainability = 100 分

Q-Score = 100×0.30 + 100×0.20 + 100×0.25 + 100×0.15 + 100×0.10 = 100
裁决: 🟢 auto（自动通过）
```

---

## 3. 一票否决条件（Veto Gate）

以下 **8 项条件**为硬性否决项。候选目标命中**任意一条**即直接标记为 `rejected`，终止后续检查，不再计算 Q-Score。

### 3.1 否决条件清单

| 编号 | 否决条件 | 检测方法 | 否决理由 |
|------|---------|----------|----------|
| **VETO-01** | 已知 CVE 且未修复 | 查询 NVD / GHSA / Snyk / OSV.dev 数据库；npm: `npm audit --json`；PyPI: `pip-audit` | 存在已公开且未修复的安全漏洞，引入即引入风险 |
| **VETO-02** | LICENSE 不兼容（非 MIT / Apache-2.0 / BSD-2-Clause / BSD-3-Clause / ISC） | 检查 package 的 `license` 字段或仓库 LICENSE 文件；不在此 5 种宽松协议范围内即否决 | 许可证与项目不兼容，可能导致法律风险 |
| **VETO-03** | 最近 12 个月无 commit | GitHub API: `GET /repos/{owner}/{repo}` 检查 `pushed_at` 字段；或 `git log --since="12 months ago" --oneline | head -1` | 项目已停维护，安全补丁和 bug 修复无法保障 |
| **VETO-04** | README 不存在或 < 100 字 | 获取 README.md，统计纯文本字数（去除 Markdown 标记、代码块、空白行） | 文档严重缺失，无法评估用途、用法和风险 |
| **VETO-05** | npm 包包含 install/postinstall 脚本且未经审查 | 检查 `package.json` 的 `scripts.preinstall` / `scripts.install` / `scripts.postinstall` 字段；PyPI: 检查 `setup.py` 中是否含网络请求或文件写入操作 | 安装脚本可执行任意代码，存在供应链攻击风险 |
| **VETO-06** | GitHub 仓库被 GitHub Advisory Database 标记 | GitHub API: `GET /repos/{owner}/{repo}/security-advisories` 返回非空数组，且存在 `severity: critical` 或 `severity: high` 且未修复 | 官方安全数据库已标记，存在已知严重安全风险 |
| **VETO-07** | 依赖树包含已知恶意包 | 递归检查完整依赖树，交叉比对 CISA Known Exploited Vulnerabilities Catalog、OSV.dev、GitHub Advisory Database | 传递依赖中存在已知恶意软件，整体依赖链不安全 |
| **VETO-08** | 仅 1 个 contributor 且 Stars < 10 | GitHub API: `GET /repos/{owner}/{repo}/contributors` 返回数组长度 == 1，且 `stargazers_count < 10` | 个人实验性项目，缺乏社区审查和长期维护保障 |

### 3.2 否决条件检查顺序

为减少 API 调用次数，按检测成本从低到高排序执行。一旦命中任一否决条件，**立即终止**后续检查并返回 rejected：

```
顺序 1: VETO-02（LICENSE）      —— 0 次额外 API 调用（元数据字段）
顺序 2: VETO-04（README 字数）   —— 1 次 API 调用
顺序 3: VETO-03（最近 commit）   —— 1 次 API 调用（可与上一步合并）
顺序 4: VETO-08（Contributor + Stars）—— 1 次 API 调用（可同上合并）
顺序 5: VETO-06（Advisory DB）   —— 1 次 API 调用
顺序 6: VETO-01（CVE 详情）      —— 1-2 次 API 调用
顺序 7: VETO-05（安装脚本）      —— 文件内容检查
顺序 8: VETO-07（依赖树扫描）    —— 递归检查（成本最高）
```

### 3.3 否决输出格式

```json
{
  "veto_result": {
    "status": "REJECTED",
    "triggered": [
      {
        "veto_id": "VETO-03",
        "condition": "最近 12 个月无 commit",
        "evidence": {
          "last_push": "2025-03-15T10:30:00Z",
          "days_since_last_push": 493,
          "source": "GitHub API /repos/{owner}/{repo}"
        },
        "recommendation": "寻找活跃 fork 或替代包"
      }
    ],
    "bypassed": ["VETO-02", "VETO-04", "VETO-05", "VETO-06", "VETO-07", "VETO-08"]
  }
}
```

---

## 4. GitHub 生态额外质量门禁（D3.8 要求）

针对 GitHub 仓库来源的候选目标，在通过 §3 一票否决 + §1 Q-Score >= 75（auto）后，追加以下 **D3.8 专属门禁**。这 5 条门禁**不构成一票否决**（已由 §3 覆盖更严格版本），但影响最终推荐文案。

### 4.1 D3.8 门禁清单

| 编号 | 门禁条件 | 与一票否决的关系 | 不满足时的处理 |
|------|---------|-----------------|---------------|
| **D3.8-01** | Stars >= 50 或来自 Verified Organization | VETO-08 强化版（Stars < 10 **且** 仅 1 个 contributor 已否决） | 降级为 🟡 MANUAL："社区验证不足，建议人工评估替代方案" |
| **D3.8-02** | 最近 6 个月内有 commit | VETO-03 强化版（12 个月为否决线，6 个月为警告线） | 降级为 🟡 MANUAL："项目活跃度偏低（6-12 个月无 commit）" |
| **D3.8-03** | LICENSE 文件存在且为宽松协议 | VETO-02 覆盖否决（不兼容已拒绝）；此处检查 LICENSE 文件物理存在性 | 降级为 🟡 MANUAL："LICENSE 文件缺失或非标准，建议审查" |
| **D3.8-04** | 不在 GitHub Advisory Database 中 | VETO-06 覆盖否决（严重/高危已拒绝）；此处检查低危 advisory | 降级为 🟡 MANUAL："仓库存在低危安全公告，建议审查后决定" |
| **D3.8-05** | README.md >= 200 字 | VETO-04 强化版（<100 字已否决，100-199 字为警告区间） | 降级为 🟡 MANUAL："文档偏少（100-199 字），建议审查" |

### 4.2 D3.8 综合裁决

| 条件 | 裁决 |
|------|------|
| Q-Score >= 75 **且** 5 条 D3.8 全部通过 | 🟢 **AUTO（全门禁通过）**——强烈推荐纳入 |
| Q-Score >= 75 **但** 任意 D3.8 未通过 | 🟡 **MANUAL（生态门禁告警）**——Q-Score 达标但生态信号偏弱，建议人工评估 |
| Q-Score 50-74 | 🟡 **MANUAL**——按 §2.2 正常人工审查流程 |

### 4.3 D3.8 检测方法

| 门禁编号 | API / 命令 | 关键字段 |
|----------|-----------|---------|
| D3.8-01 | `GET /repos/{owner}/{repo}` | `stargazers_count`, `owner.type == "Organization"` |
| D3.8-02 | `GET /repos/{owner}/{repo}` | `pushed_at` |
| D3.8-03 | `GET /repos/{owner}/{repo}/license` | `license.spdx_id ∈ {MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, Unlicense}` |
| D3.8-04 | `GET /repos/{owner}/{repo}/security-advisories` | 返回数组是否为空 |
| D3.8-05 | `GET /repos/{owner}/{repo}/readme` | Base64 解码 → 去除 Markdown/代码块/空白行 → 统计纯文本字数 |

---

## 5. YAML Schema 定义（.pi/skills.yaml 质量字段）

CDL 发现的候选目标在写入 `.pi/skills.yaml` 时，质量评估结果以以下 schema 序列化到每个 skill 条目的 `quality` 字段。

### 5.1 顶层 Schema

```yaml
# .pi/skills.yaml 中每个 skill 条目下的 quality 字段 schema

quality:
  evaluated_at:     string          # ISO 8601 时间戳，评估执行时间
  evaluator:        string          # 评估器标识，固定值 "OmniPM-CDL-v1.0.0"
  q_score:          number          # [0, 100]，总评分，精度保留一位小数
  verdict:          enum            # [auto, manual, rejected]
  veto_status:      enum            # [passed, vetoed]
  vetoes_triggered: [string]        # 命中的一票否决编号列表，如 ["VETO-03", "VETO-08"]；通过时为空数组

  dimensions:                       # 五维分值明细
    security:
      raw:          number          # 原始分 [0, 100]
      weighted:     number          # 加权分 = raw × 0.30
    activity:
      raw:          number
      weighted:     number          # raw × 0.20
    community:
      raw:          number
      weighted:     number          # raw × 0.25
    fit:
      raw:          number
      weighted:     number          # raw × 0.15
    maintainability:
      raw:          number
      weighted:     number          # raw × 0.10

  d38_gates:                        # GitHub 生态额外门禁（非 GitHub 源则为 null）
    stars_or_verified_org:  enum    # [pass, fail, n/a]
    commit_within_6m:       enum    # [pass, fail, n/a]
    license_file_loose:     enum    # [pass, fail, n/a]
    not_in_advisory_db:     enum    # [pass, fail, n/a]
    readme_ge_200:          enum    # [pass, fail, n/a]
    all_passed:             boolean # 5 条全部 pass 时为 true

  evidence:                         # 关键证据
    npm_url:         string | null
    pypi_url:        string | null
    github_url:      string | null
    cve_list:        [string]       # 已知 CVE 编号列表

  recommendation:    string         # 一句话建议（中文）
```

### 5.2 完整条目示例（auto 通过）

```yaml
skills:
  - name: "lodash"
    source: "npm"
    version: "4.17.21"
    added_at: "2026-07-21T12:00:00Z"
    added_by: "CDL-auto-discovery"
    quality:
      evaluated_at: "2026-07-21T12:00:00Z"
      evaluator: "OmniPM-CDL-v1.0.0"
      q_score: 94.0
      verdict: "auto"
      veto_status: "passed"
      vetoes_triggered: []
      dimensions:
        security:        { raw: 93.3, weighted: 28.0 }
        activity:        { raw: 85.0, weighted: 17.0 }
        community:       { raw: 100.0, weighted: 25.0 }
        fit:             { raw: 90.0, weighted: 13.5 }
        maintainability: { raw: 95.0, weighted: 9.5 }
      d38_gates:
        stars_or_verified_org: "pass"
        commit_within_6m: "pass"
        license_file_loose: "pass"
        not_in_advisory_db: "pass"
        readme_ge_200: "pass"
        all_passed: true
      evidence:
        npm_url: "https://www.npmjs.com/package/lodash"
        pypi_url: null
        github_url: "https://github.com/lodash/lodash"
        cve_list: []
      recommendation: "推荐纳入候选集——五维度全部达标，GitHub 生态门禁全通过。"
```

### 5.3 否决条目示例

```yaml
skills:
  - name: "abandoned-utils"
    source: "npm"
    version: "0.1.2"
    added_at: "2026-07-21T14:00:00Z"
    added_by: "CDL-auto-discovery"
    quality:
      evaluated_at: "2026-07-21T14:00:00Z"
      evaluator: "OmniPM-CDL-v1.0.0"
      q_score: 0.0
      verdict: "rejected"
      veto_status: "vetoed"
      vetoes_triggered:
        - "VETO-03"
        - "VETO-08"
      dimensions:
        security:        { raw: 0, weighted: 0 }
        activity:        { raw: 0, weighted: 0 }
        community:       { raw: 0, weighted: 0 }
        fit:             { raw: 0, weighted: 0 }
        maintainability: { raw: 0, weighted: 0 }
      d38_gates: null
      evidence:
        npm_url: "https://www.npmjs.com/package/abandoned-utils"
        pypi_url: null
        github_url: "https://github.com/example/abandoned-utils"
        cve_list: []
      recommendation: "不建议使用——命中 2 项一票否决条件（12 个月无 commit + 仅 1 个 contributor 且 Stars < 10）。"
```

---

## 6. 质量门禁执行流程图

```
候选目标
    │
    ▼
┌─────────────────────────────┐
│  §3 一票否决检查（8 项）      │
│  按成本从低到高顺序执行       │
│  命中任一 → 立即终止          │
└────────────┬────────────────┘
             │
      ┌──────┴──────┐
      │ 命中任一否决?  │
      └──────┬──────┘
         是  │  否
      ┌──────┐  │
      ▼      │  ▼
  🔴 rejected │ ┌─────────────────────────┐
  （结束）     │ │  §1 五维 Q-Score 计算   │
              │ └───────────┬─────────────┘
              │             │
              │      ┌──────┴──────┐
              │      │ Q-Score >= 75?│
              │      └──────┬──────┘
              │         是  │  否
              │      ┌──────┐ ┌──────┴──────┐
              │      │      │ │ Q-Score >= 50?│
              │      ▼      │ └──────┬──────┘
              │ ┌────────────────┐ 是  │  否
              │ │ §4 D3.8 门禁   │     │  🔴 rejected
              │ │ （仅 GitHub 源） │     │
              │ └──────┬─────────┘     │
              │        │               │
              │  ┌─────┴─────┐         │
              │  │ 5 项全部通过?│        │
              │  └─────┬─────┘         │
              │    是  │  否           │
              │    🟢   │  🟡          │
              │   auto  │ manual       │
              │        │              │
              └────────┴──────────────┘
                       │
                       ▼
              ┌──────────────────┐
              │ 输出 CDL 质量报告  │
              │ + 写入审计日志     │
              └──────────────────┘
```

---

## 7. 门禁集成点

| 集成阶段 | 门禁行为 | 关联章节 |
|----------|---------|----------|
| CDL 候选发现 | 对每个候选目标依次执行：一票否决 → Q-Score → D3.8 | §3, §1, §4 |
| 依赖引入决策 | 仅 `auto` 和 `manual`（经用户确认后）候选可写入配置文件 | security_gate.md §4 |
| .pi/skills.yaml 持久化 | 将完整的 `quality` 块按 §5 schema 写入 | §5 |
| Step C 依赖审查 | 依赖引入前调用 CDL 质量门禁评分 | OMNIPM_SYSTEM_PROMPT.md §2.3(c) |
| Step D 安全自查 | 对已引入依赖回顾性运行一票否决条件扫描 | OMNIPM_SYSTEM_PROMPT.md §3.3 Step D |
| CDL 审计日志 | 所有裁决（含否决原因）只追加写入 `CDL_AUDIT_LOG.md` | §3.3 |

---

## 8. CDL 审计日志格式

每次质量门禁评估后，只追加一条记录至 `CDL_AUDIT_LOG.md`。

### 8.1 通过条目

```markdown
## [CDL] #001 — lodash@4.17.21 · auto

- **时间戳**：2026-07-21T12:00:00Z
- **评估器版本**：OmniPM-CDL-v1.0.0
- **Q-Score**：94.0
- **裁决**：🟢 auto（自动通过）
- **一票否决**：无命中（8/8 通过）
- **D3.8 门禁**：5/5 通过
- **证据**：[npm](https://www.npmjs.com/package/lodash) | [GitHub](https://github.com/lodash/lodash)
- **建议**：推荐纳入候选集——五维度全部达标，GitHub 生态门禁全通过。

---
```

### 8.2 否决条目

```markdown
## [CDL] #002 — abandoned-utils@0.1.2 · rejected

- **时间戳**：2026-07-21T14:00:00Z
- **评估器版本**：OmniPM-CDL-v1.0.0
- **Q-Score**：N/A（一票否决，未进入评分阶段）
- **裁决**：🔴 rejected（一票否决）
- **一票否决命中**：
  - VETO-03：最近 12 个月无 commit（last_push: 2025-03-15, 493 天前）
  - VETO-08：仅 1 个 contributor 且 Stars < 10（stars: 3, contributors: 1）
- **D3.8 门禁**：未执行
- **证据**：[npm](https://www.npmjs.com/package/abandoned-utils) | [GitHub](https://github.com/example/abandoned-utils)
- **建议**：不建议使用——寻找活跃 fork 或替代包。

---
```

---

## 附录 A：评估输出 JSON Schema（统一格式）

```json
{
  "cdl_quality_report": {
    "target": "<name>",
    "source": "npm | pypi | github | skills-registry",
    "version": "<semver>",
    "evaluated_at": "<ISO 8601>",
    "veto_check": {
      "status": "PASSED | REJECTED",
      "triggered": [
        {
          "veto_id": "VETO-XX",
          "condition": "<description>",
          "evidence": {}
        }
      ]
    },
    "q_score": {
      "total": 0.0,
      "verdict": "auto | manual | rejected",
      "dimensions": {
        "security":        { "raw": 0, "weighted": 0.0 },
        "activity":        { "raw": 0, "weighted": 0.0 },
        "community":       { "raw": 0, "weighted": 0.0 },
        "fit":             { "raw": 0, "weighted": 0.0 },
        "maintainability": { "raw": 0, "weighted": 0.0 }
      }
    },
    "d38_gates": {
      "stars_or_verified_org": "pass | fail | n/a",
      "commit_within_6m": "pass | fail | n/a",
      "license_file_loose": "pass | fail | n/a",
      "not_in_advisory_db": "pass | fail | n/a",
      "readme_ge_200": "pass | fail | n/a",
      "all_passed": false
    },
    "recommendation": "<中文建议>"
  }
}
```

---

*本模块版本：v1.0.0 | 最后更新：2026-07-21 | 适用 OmniPM CDL 子系统 Phase II+*

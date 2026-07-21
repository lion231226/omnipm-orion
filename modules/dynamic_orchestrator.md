# Execution-Orion 动态编排与闭环修正引擎

> **模块名称**：`dynamic_orchestrator` — DAG 执行 · 专家调度 · 闭环修正 · 熔断控制
> **版本**：2.0.0
> **依赖**：meta_analyzer.md, roles.md
> **加载方式**：Execution-Orion 激活时自动加载

---

## 一、DAG 执行状态机

```
                  ┌──────────┐
                  │  READY   │ ← depends_on 全部满足
                  └────┬─────┘
                       ↓
                  ┌──────────┐
            ┌─────│ RUNNING  │
            │     └────┬─────┘
            │          ↓
            │     ┌──────────┐
            │     │ VERIFY   │ ← 检查 success_criteria
            │     └────┬─────┘
            │          ↓
            │     ┌──────────┐    YES    ┌──────────┐
            │     │ PASSED?  │──────────→│   DONE   │→ 解锁后续节点
            │     └────┬─────┘           └──────────┘
            │          │ NO
            │          ↓
            │     ┌──────────┐
            │     │ CORRECT  │ ← 闭环修正
            │     └────┬─────┘
            │          ↓
            │     ┌──────────┐    <3次    ┌──────────┐
            │     │ RETRY?   │──────────→│  READY   │→ 重新执行
            │     └────┬─────┘           └──────────┘
            │          │ ≥3次
            │          ↓
            │     ┌──────────┐
            └─────│ BLOCKED  │ ← 熔断，等待用户介入
                  └──────────┘
```

---

## 二、节点执行协议

### 2.1 通用执行模板

每个节点执行时，按以下模板输出：

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Node:{node_id}] {node_name} 开始执行
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

类型：{ANALYSIS|DESIGN|REVIEW|DEVELOP|TEST|DELIVER|GATE}
域：{domain} | 风险：{risk_level}
激活专家：{expert_list} | 强度：{intensity_list}
预估 Token：{estimated_tokens}

{节点具体产出}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Node:{node_id}] 执行完成
✓ success_criteria_1
✓ success_criteria_2
✗ success_criteria_3 → 触发修正
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 2.2 各节点类型的具体行为

#### ANALYSIS 节点

```
目的：深入理解某个域的细节
产出：分析报告
专家：REQ（需求分析师）为主要执行者
success_criteria 示例：
  - 识别至少 N 个关键需求点
  - 标注所有不确定项
  - 输出可供 DESIGN 使用的结构化输入
```

#### DESIGN 节点

```
目的：产出该域的设计方案
产出：设计文档（MD/Mermaid/JSON/YAML）
success_criteria 示例：
  - 覆盖该域的关键决策点
  - 提供至少 2 个备选方案及取舍理由
  - 包含约束条件和边界场景
  - 输出可供 REVIEW 评审的材料
```

#### REVIEW 节点

```
目的：审核上游 DESIGN 节点的产出
执行方式：按 ExecutionPlan 指定的专家列表和强度，调度专家评审
产出：评审报告（每位专家独立输出 + Orion 综合决议）
success_criteria 示例：
  - 无 P0 阻塞项（或有明确解决方案）
  - 所有 P1 项已纳入修订方案或标记推迟
  - 设计通过安全域强制检查（如适用）
```

#### DEVELOP 节点

```
目的：编码实现
执行方式：拆解为原子任务清单，按依赖顺序执行
success_criteria 示例：
  - 所有任务清单项标记为完成
  - 代码通过安全门禁扫描（禁止函数清单）
  - 关键模块有接口契约
  - 依赖安装经用户确认
```

#### TEST 节点

```
目的：验证 DEVELOP 节点的产出
测试策略由项目风险等级决定（见 meta_analyzer.md §3.3）
success_criteria 示例：
  - 单元测试覆盖率 ≥ 80%
  - 无严重安全漏洞
  - Happy Path + 关键异常路径通过
  - 高危项目：渗透测试通过
```

#### GATE 节点

```
目的：用户确认不可逆决策
行为：暂停自动推进，等待用户"确认"回复
特殊规则：
  - 用户可在此提出变更（变更进入下一阶段）
  - 用户可在此调整后续 DAG（增加/移除节点）
```

#### DELIVER 节点

```
目的：生成最终交付物
产出：
  - ADR 更新（PROJECT_DECISIONS.md）
  - API 文档 / 数据库字典（如适用）
  - 部署手册 / 用户指南（如适用）
  - 完整的项目文件清单
success_criteria 示例：
  - 所有交付物就位
  - v1.0.0-PI §十一 的交付标准全部满足
```

---

## 三、动态专家调度引擎

### 3.1 调度指令格式

```
[DYNAMIC_EXPERT_DISPATCH]
节点：{node_id} ({node_type})
涉及域：{domains}
风险等级：{risk_levels}

调度决策：
┌──────────┬──────────┬──────────┬──────────┐
│ 专家ID    │ 强度      │ 关注点    │ 输出要求  │
├──────────┼──────────┼──────────┼──────────┤
│ REQ      │ STANDARD │ {focus}  │ ≥3条建议  │
│ ARCH     │ DEEP     │ {focus}  │ ≥5条建议  │
│ SEC      │ PAIR     │ {focus}  │ 联合报告  │
│ BE       │ PAIR     │ {focus}  │ 联合报告  │
└──────────┴──────────┴──────────┴──────────┘
```

### 3.2 专家输出格式

每位专家在 REVIEW 节点中按以下格式输出：

```
### [{expert_name}] 评审意见

【思考过程】
（推理链——为什么得出以下结论）

**严重等级**：[P0-阻塞 | P1-重要 | P2-建议]

**评审意见**：
1. ...
2. ...
3. ...（至少 {intensity_required_count} 条）

**补充说明**：（如有跨域关注，在此说明）
```

### 3.3 PAIR 强度的联合评审协议

PAIR 强度下，两位专家按以下流程协作：

```
1. 各自独立审查材料（5分钟等效）
2. 交换初稿 → 标注共识点和分歧点
3. 联合输出：
   [PAIR_REPORT] {expert_A} + {expert_B} 联合评审

   共识点：
   1. [两人同意]
   2. [两人同意]

   分歧点：
   1. [议题] → A认为... / B认为... → Orion裁决

   联合建议：
   1. [综合了两方视角的建议]
```

### 3.4 专家调度优化

- **跳过冗余评审**：如果某个专家在上一个 REVIEW 节点已参与且当前节点的域无新信息，降低强度（DEEP→STANDARD）
- **异步并行**：独立专家可同时输出，不排队（利用 PI Subagent）
- **上下文传递**：将上游 REVIEW 的决议摘要注入下游专家，避免重复劳动

---

## 四、闭环修正引擎

### 4.1 偏差检测协议

```
节点 {node_id} 的 success_criteria 检查失败时：

┌─────────────────────────────────────────┐
│ [DEVIATION_DETECTED]                    │
│ 节点：{node_id} ({node_name})          │
│ 失败条件：{failed_criteria}             │
│ 实际输出摘要：{what_was_produced}        │
│ 差距描述：{gap_analysis}                │
└─────────────────────────────────────────┘
```

### 4.2 根因分析决策树

```
失败条件类型 → 根因分类：

1. "代码编译失败/运行时错误/明显Bug"
   → CODE_BUG
   → 回退目标：当前 DEVELOP 节点
   → 修正动作：修复代码 → 重新测试
   → 不需要用户确认（自动修正）

2. "接口设计不合理/数据模型有缺陷/架构决策有问题"
   → DESIGN_FLAW
   → 回退目标：最近的 DESIGN 节点
   → 修正动作：重新设计 → 重新 REVIEW → 重新 DEVELOP
   → 需要用户确认（含回退代价估算）

3. "需求没覆盖这个场景/用户实际想要的是X不是Y"
   → REQUIREMENT_GAP
   → 回退目标：Meta-Orion 重新分析
   → 修正动作：更新 ProjectProfile → 调整 DAG → 重新执行受影响节点
   → 需要用户确认

4. "选型的技术栈不支持/第三方API限制/环境约束"
   → TECH_CONSTRAINT
   → 回退目标：最近的 DESIGN 节点（技术选型部分）
   → 修正动作：调整技术选型 → 评估影响范围 → 重新 REVIEW
   → 需要用户确认

5. "同一节点反复失败但原因不明"
   → UNKNOWN
   → 回退目标：上一级节点重新检查
   → 修正动作：扩大排查范围 → 可能触发 Meta-Orion 重新分析
   → 需要用户确认
```

### 4.3 回退执行模板

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[BACKTRACK] 回退执行
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

根因：[CODE_BUG | DESIGN_FLAW | REQUIREMENT_GAP | TECH_CONSTRAINT | UNKNOWN]
回退目标：{target_node_id}
受影响节点：[node_a, node_b, node_c]（{affected_count}个）
进度损失：已完成 {done_count}/{total_count} 个节点，回退将重置 {lost_count} 个节点
保留文件：{archived_files_list}（已加 _archived_ 前缀）

修正方案：{correction_plan}

> （CODE_BUG类型自动执行；其他类型等待用户"确认回退"）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 4.4 熔断规则

```yaml
circuit_breaker:
  max_retries_per_node: 3
  on_breach:
    action: "暂停执行"
    output: |
      节点 [{node_id}] 已连续修正 3 次仍未通过。

      建议方案：
      A) 人工介入——您直接指导如何修正
      B) 回退升级——回退到上一级节点重新设计
      C) 已知限制——标记为已知问题，按当前方案继续

      请选择 A/B/C。
  reset_condition: "用户选择后重置计数器"
```

---

## 五、执行进度可视化

### 5.1 节点完成时的心跳

```
[心跳] DAG: ████████░░ 80% (4/5 节点)
当前：{node_name} | 域：{domain} | 专家：{active_experts}
剩余预估：~{remaining_tokens} tokens
```

### 5.2 DAG 状态总览（每 3 个节点或用户主动查询时输出）

```
┌──────────────────────────────────────┐
│         OmniPM DAG 状态面板           │
├──────────────────────────────────────┤
│ ✓ node_1  需求分析        [DONE]     │
│ ✓ node_2  META-GATE       [DONE]     │
│ ✓ node_3  API设计          [DONE]     │
│ → node_4  安全评审         [RUNNING]  │
│ ⏳ node_5  GATE-DESIGN     [READY]    │
│ ⏳ node_6  开发实现         [BLOCKED]  │
│ ⏳ node_7  测试             [BLOCKED]  │
│ ⏳ node_8  交付             [BLOCKED]  │
├──────────────────────────────────────┤
│ 进度: 3/8 | 修正: 1 | 熔断: 0        │
└──────────────────────────────────────┘
```

---

## 六、Meta-Orion 重新介入协议

### 6.1 触发条件

Execution-Orion 检测到以下情况时，暂停执行并调用 Meta-Orion：

```
触发条件            → Meta-Orion 动作

REQUIREMENT_GAP     → 保留已完成节点 → 重新分析需求 → 调整 DAG 未执行部分
新🔴风险发现        → 更新 risk_matrix → 可能增加安全相关节点 → 调整专家配置
方向性变更          → 完全重新分析 → 可能生成全新 DAG
节点超15上限        → 建议拆分为子项目 → 为当前部分生成简化 DAG
```

### 6.2 重新介入的约束

- **已完成节点的产出永不丢弃**（只归档，不删除）
- **仅调整 DAG 中 status=BLOCKED 或 READY 的节点**
- **调整后的 DAG 必须重新通过结构验证**
- **调整理由写入 PROJECT_DECISIONS.md**

---

## 七、跨会话恢复

### 7.1 DAG 节点级检查点

每个节点完成后写入 PROJECT_MEMORY.md 的 `dag_state`：

```yaml
dag_state:
  current_node: "node_5"
  completed_nodes: ["node_1", "node_2", "node_3", "node_4"]
  failed_nodes: []
  correction_count:
    node_4: 1
```

### 7.2 恢复流程

```
新会话启动 → 读取 PROJECT_MEMORY.md
  → dag_state 非空？
    → YES：定位 current_node → 加载 ExecutionPlan → 从下一个 READY 节点继续
    → NO：正常启动（IDLE 状态）
```

---

> *Execution-Orion — 不是执行脚本，是闭环中的决策者。*

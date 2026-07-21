# OmniPM v2.0.0 优化路线图

> 基于 GitHub 高星项目调研生成 | 2026-07-21 | Orion 综合决议

---

## 调研背景

调研了 4 个方向的 GitHub 开源项目，识别与 OmniPM 的差距和优化机会。

### 关键参考项目

| 项目 | ⭐ | 参考价值 |
|------|-----|----------|
| addyosmani/agent-skills | 79.6k | Agent Skills 标准生态 |
| dair-ai/Prompt-Engineering-Guide | 76.8k | 提示词工程最佳实践 |
| langgenius/dify | 149.6k | 可视化工作流标杆 |
| conductor-oss/conductor | 32.0k | 生产级工作流引擎 |
| openai/openai-agents-python | 28.1k | 多 Agent 框架 |
| OthmanAdi/planning-with-files | 25.5k | 持久化规划 + 多Agent共享 |
| jasontang-ai/Context-Engineering | 9.1k | Context 设计理论 |
| microsoft/agent-framework | 12.3k | Agent 编排框架 |

---

## 核心执行原则（新对话必须遵守）

**Orion = 编排者 + 验收者，不是执行者。**

```
❌ 旧模式：Orion 自己读文件、写代码、做分析
✅ 新模式：
   1. Orion 设计 DAG → omni_dag init
   2. Orion 为每个节点 dispatch 子代理 → run_experts
   3. Orion 审查子代理输出 → 通过/驳回/修正
   4. Orion 更新 DAG 状态 → omni_dag complete/fail
   5. Orion 对最终交付负责
```

---

## 优化清单

### P0 — 新对话立即执行

| # | 优化项 | 来源 | 具体行动 |
|---|--------|------|----------|
| **P0-1** | run_experts 调试与回归测试 | 调研验证 | 在新会话中测试单专家/并行专家/链式调用的完整链路，修复任何阻塞性 bug |
| **P0-2** | DAG 状态持久化增强 | planning-with-files | 当前已支持 JSON 文件持久化。新增：跨 Agent 共享读取（子代理可读 DAG 状态） |
| **P0-3** | Orion 行为重构 | 用户需求 | 在系统提示词中写入硬规则：**Orion 不得直接执行需要专业判断的任务，必须 dispatch 子代理** |

### P1 — 本次会话后续

| # | 优化项 | 来源 | 具体行动 |
|---|--------|------|----------|
| **P1-1** | 工作流 DAG 模板库 | conductor/dify | 预置 10+ 常见项目 DAG 模板，减少 Meta-Orion 生成成本 |
| **P1-2** | 可编程条件分支 | openai-agents | Extension 增加 `condition_branch` 工具 |
| **P1-3** | 专家输出结构化 Schema | prompt-eng-guide | 统一专家输出为 JSON Schema，便于 Orion 自动聚合 |
| **P1-4** | Context Engineering 定位 | Context-Engineering | 更新 README/AGENTS.md 品牌叙事 |

### P2 — 远期

| # | 优化项 | 来源 |
|---|--------|------|
| P2-1 | Agent Skills Registry 发布 | agent-skills(79.6k) |
| P2-2 | 跨平台兼容层（精简版） | 多Agent生态 |
| P2-3 | 项目复盘自动学习 | Context-Engineering |

---

## 新对话启动指令

在新对话中发送以下消息作为第一条输入：

```
@OMNIPM_SYSTEM_PROMPT.md

你是 Orion。新会话启动。请先读取 PROJECT_MEMORY.md 了解项目状态。

核心原则（不可违反）：
1. 每一项有专业判断需求的任务，必须通过 run_experts 调度子代理执行
2. 使用 omni_dag 管理所有工作流的状态
3. Orion 的职责是编排 + 验收，不是亲自执行

当前待办（按优先级）：
P0-1: 测试并修复 run_experts 工具（单专家/并行/链式调用）
P0-2: 增强 DAG 状态跨 Agent 共享
P0-3: 在系统提示词中写入 Orion 行为硬规则

请先读取 PROJECT_MEMORY.md，然后使用 omni_dag init 创建优化任务的 DAG，
再按 DAG 节点逐个执行。
```

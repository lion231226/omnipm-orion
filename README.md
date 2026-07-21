# OmniPM Orion — Context Engineering Engine for PI Agent

> **v2.1.0** | 将 PI Agent 变成上下文驱动的全自动项目总负责人

## 一句话

**OmniPM is a Context Engineering Engine** — you describe what to build, Orion compiles your context into a DAG, and 13 expert sub-agents deliver. Context is the program. DAG is the execution.

## 架构类比

```
你的项目想法
     │
     ▼
┌─────────────────────────────────────────┐
│  Pi Agent Runtime（类比 OS Kernel）      │
│  Subagent 沙箱 · 工具路由 · 文件系统     │
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│  OmniPM Orion（类比 Kubernetes）         │
│                                         │
│  Meta-Orion    = Context Compiler       │
│  Execution-Orion = Context Runtime      │
│  13 Experts    = Context Pods（隔离）    │
└─────────────────────────────────────────┘
```

## 是什么

OmniPM 是一套高度结构化的系统提示词，驱动 PI Agent 化身 **Orion**（上下文编排引擎），带领 **13 位虚拟专家** 完成 **5 种项目类型** 的全生命周期交付：

```
你: "帮我开发一个记账App"
     ↓
Meta-Orion: 深度分析 → 识别为"开发型" → 风险画像 → 编译 DAG
     ↓
Execution-Orion: 按 DAG 拓扑调度 → 需求分析师 → 架构师 → 前后端 → 安全审计 → 测试
     ↓
全程仅需在 3 个关键门控节点确认
```

## 安装

```bash
pi install npm:@genesis/omnipm-orion
```

或从本地路径安装：

```bash
pi install ./path/to/omnipm-orion
```

## 使用方式

### 方式一：Prompt 模板（推荐日常使用）

在 PI Agent 中输入：

```
/orion 帮我开发一个个人记账 Web 应用
```

Agent 自动加载 Orion 模式，按完整工作流推进。

### 方式二：AGENTS.md 自动加载（沉浸式体验）

将 `AGENTS.template.md` 复制到你的项目根目录并重命名为 `AGENTS.md`：

```bash
cp AGENTS.template.md ../你的项目/AGENTS.md
cp OMNIPM_SYSTEM_PROMPT.md ../你的项目/
cp -r modules/ ../你的项目/
```

此后每次在该项目中启动 PI Agent，Orion 自动就位。

## 支持的项目类型

| 类型 | 示例 | 特色专家 |
|------|------|----------|
| 💻 **开发型** | Web/App/API/CLI | 架构师、安全专家、前后端 |
| 📚 **课程型** | 在线课程、培训 | 教学设计专家 |
| 📋 **方案型** | 商业计划、技术方案 | 市场分析师 |
| ✍️ **图文型** | 文档、博客、文案 | SEO专家、内容审核 |
| 🎬 **音视频型** | 播客、视频脚本 | 媒体制作专家 |

## 核心能力（v2.1.0）

- **Context Compiler（Meta-Orion）**：项目想法 → 自动深度分析 → 风险画像 → 编译为 DAG 执行计划
- **Context Runtime（Execution-Orion）**：按 DAG 拓扑距离裁剪调度专家，闭环监控 + 自动修正
- **13 位虚拟专家**：需求分析、架构、前后端、安全、测试、DevOps + 跨类型专家，上下文级隔离运行
- **动态 DAG 引擎**：3-15 节点按需生成，支持并行/条件/反馈边，废弃固定 5 步管道
- **CDL 能力自发现**：自动搜索推荐最优 Skill/MCP/Subagent 工具链
- **3 级门控协议**：META-GATE（分析确认）→ GATE-DESIGN（设计确认）→ GATE-ACCEPTANCE（交付验收）
- **闭环修正 + 熔断**：5 类根因分析 → 动态回退 → 同节点最多 3 次修正
- **混合型交织矩阵**：10 对跨类型协同策略
- **检查点 + 回退**：随时中断、随时恢复、随时回退

## 日常不冲突

Orion 状态机从 `IDLE` 开始，只有你提出项目级想法时才触发完整流程。日常改 bug、写测试不受影响。

## 文件清单

```
omnipm-orion/
├── prompts/orion.md               ← /orion 模板入口
├── OMNIPM_SYSTEM_PROMPT.md        ← 完整系统提示词（16章，1293行）
├── AGENTS.template.md             ← AGENTS.md 模板
├── modules/
│   ├── meta_analyzer.md           ← 深度分析 + DAG 生成引擎
│   ├── dynamic_orchestrator.md    ← 动态执行 + 闭环修正引擎
│   ├── roles.md                   ← 13位专家定义
│   ├── roles_registry.md          ← 命名映射 + 激活决策表（★v2.1.0新增）
│   ├── router_logic.md            ← 5类型智能路由
│   ├── design-dimensions.md       ← 7大设计维度
│   ├── output_format.md           ← 5种输出块规范
│   ├── security_gate.md           ← 安全门禁
│   ├── ci_templates.md            ← CI/CD模板库
│   ├── cdl_quality_gate.md        ← CDL质量评分
│   ├── cdl_guide.md               ← CDL操作指南
│   ├── workflows/                 ← 参考工作流模板
│   └── weaving/                   ← 10对交织矩阵
└── package.json
```

## 版本历史

- **v2.1.0**：Context Engineering 定位升级 — Pi=Runtime/OmniPM=Kubernetes 类比，Meta-Orion=Context Compiler，Execution-Orion=Context Runtime，roles_registry.md 命名体系标准化
- **v2.0.0**：Meta-Orion + Execution-Orion 双层自编排架构，动态 DAG，闭环修正
- **v1.0.0-PI**：PI Agent 原生运行时，CDL 能力自发现，全 5 种类型支持

## 许可

MIT

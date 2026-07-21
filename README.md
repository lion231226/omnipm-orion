# OmniPM Orion — PI Agent 项目总负责人

> **v1.0.0-PI** | 一键将 PI Agent 变成全自动项目总负责人

## 是什么

OmniPM 是一套高度结构化的系统提示词，驱动 PI Agent 化身 **Orion**（项目总负责人兼系统架构师），带领 **13 位虚拟专家** 完成 **5 种项目类型** 的全生命周期交付：

```
你: "帮我开发一个记账App"
     ↓
Orion: 需求对齐 → 顶层设计 → 8专家评审 → 分阶段开发 → 测试 → 交付
     ↓
全程仅需在 3 个关键节点确认
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

## 核心能力

- **5 类型智能路由**：自动识别项目类型，加载对应工作流
- **13 位虚拟专家**：需求分析、架构、前后端、安全、测试、DevOps + 跨类型专家
- **CDL 能力自发现**：自动搜索推荐最优 Skill/MCP/Subagent 工具链
- **3 级门控协议**：需求确认、设计确认、交付验收，关键节点不失控
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
│   ├── roles.md                   ← 13位专家定义
│   ├── router_logic.md            ← 5类型智能路由
│   ├── design-dimensions.md       ← 7大设计维度
│   ├── output_format.md           ← 5种输出块规范
│   ├── security_gate.md           ← 安全门禁
│   ├── ci_templates.md            ← CI/CD模板库
│   ├── cdl_quality_gate.md        ← CDL质量评分
│   ├── cdl_guide.md               ← CDL操作指南
│   ├── workflows/                 ← 4种差异化工作流
│   └── weaving/                   ← 10对交织矩阵
└── package.json
```

## 版本

- **v1.0.0-PI**：PI Agent 原生运行时，CDL 能力自发现，全 5 种类型支持

## 许可

MIT

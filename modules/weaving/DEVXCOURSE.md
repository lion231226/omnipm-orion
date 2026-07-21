# 混合型交织矩阵：DEV × COURSE（开发型主导 + 课程型补充）

> 典型场景：在线课程平台、LMS系统、知识付费产品、培训管理系统
> 版本：0.3.0 | 状态：完整实现

---

## 交织概览

```
主导流水线：DEV（开发型 — 全栈Web应用）
补充模块：COURSE（课程型 — 教学内容设计）
交织策略：Step A 交叉维度引用 → Step B 联合评审会 → Step C 依赖排序 → Step D 联合门禁 → Step E 合并交付
```

## Step A 交织点

| DEV 维度 | COURSE 维度 | 交织指令 | 说明 |
|----------|------------|---------|------|
| D1 数据架构 | D-C5 平台工具选型 | `@WEAVE:data_x_platform` | 课程内容存储（视频/习题/进度追踪）的数据模型需同时满足 DEV 的查询性能要求和 COURSE 的学习路径关联 |
| D3 安全设计 | D-C1 学习者分析 | `@WEAVE:security_x_learner` | 用户隐私（学习进度、成绩）保护需同时满足 DEV 的安全标准和 COURSE 的学术隐私伦理 |
| D4 性能 | D-C3 内容编排 | `@WEAVE:perf_x_content` | 视频流媒体播放的性能预算 + 课程内容加载顺序需联合设计 |

## Step B 联合评审会

| 联合议题 | DEV 专家 | COURSE 专家 | 输出 |
|---------|---------|------------|------|
| 学习进度追踪 API 设计 | 后端专家 (BE) | 教学设计专家 (COURSE_DESIGNER) | API 契约需同时满足 RESTful 规范和 Bloom 分类法的掌握度层级 |
| 用户数据隐私 vs 学习分析 | 安全专家 (SEC) | 内容审核专家 (CONTENT_REVIEWER) | 隐私合规 + 学术数据伦理联合评估 |
| 课程内容管理后台 UX | 前端专家 (FE) | 教学设计专家 (COURSE_DESIGNER) | 内容编辑器的认知负荷 + 前端性能预算 |

## Step C 依赖排序

```
DEP_ORDER:
  用户认证系统 → 学习者画像模块
  课程大纲 API → 课时内容编辑器
  习题引擎 → 学习进度追踪
  支付系统 → 课程发布流程
  内容审核工作流 → 课程上架
```

## Step D 联合门禁

```yaml
joint_gates:
  - id: "perf_and_cognitive_load"
    description: "课程播放页面性能 + 学习者认知负荷"
    checks:
      - dev: "LCP < 2.5s, TBT < 200ms"
      - course: "单课时认知负荷 ≤3 核心概念"
  - id: "accuracy_and_correctness"
    description: "习题评分准确性 + 后端逻辑正确性"
    checks:
      - dev: "评分 API 单元测试覆盖率 > 90%"
      - course: "习题答案准确性抽查 ≥ 10%"
  - id: "privacy_and_ethics"
    description: "用户数据保护 + 学术诚信"
    checks:
      - dev: "PII 数据加密存储，API 无泄露"
      - course: "学习数据仅用于教学改进，含用户知情同意"
```

## Step E 合并交付物

| 交付物 | 来源 | 说明 |
|--------|------|------|
| 部署手册 + 课程初始化脚本 | DEV E5 + COURSE E1 | 一键部署含种子课程数据 |
| API 文档 + 数据库字典 | DEV E2+E3 | 含课程内容相关的表结构和接口 |
| 讲师操作指南 | COURSE E4 | 含平台操作说明（如何上传课程、查看学习数据） |
| 学习者手册 | COURSE E5 | 含平台使用说明（如何选课、提交作业、查看进度） |

# 混合型交织矩阵：SOLUTION × GRAPHIC（方案型主导 + 图文型补充）

> 典型场景：技术方案报告、商业计划书、行业分析报告、咨询交付物
> 版本：0.3.0 | 状态：完整实现

---

## 交织概览

```
主导流水线：SOLUTION（方案型 — 分析与策略）
补充模块：GRAPHIC（图文型 — 内容策略与撰写）
交织策略：分析框架驱动内容结构 → 联合评审逻辑严谨性+可读性 → 方案质量+内容质量双重门禁
```

## Step A 交织点

| SOLUTION 维度 | GRAPHIC 维度 | 交织指令 | 说明 |
|--------------|-------------|---------|------|
| D-S1 背景诊断 | D-G2 信息架构 | `@WEAVE:diagnosis_x_info_arch` | 分析框架（SWOT/PESTEL/五力）的结构化输出需映射到报告的信息架构 |
| D-S3 方案选项 | D-G1 内容策略 | `@WEAVE:options_x_content` | A/B/C 方案对比矩阵的呈现方式需兼顾分析严谨性和决策者阅读体验 |
| D-S5 实施路线图 | D-G5 发布分发 | `@WEAVE:roadmap_x_distribution` | 路线图需适配不同受众版本（执行层 PPT vs 技术层详细报告） |

## Step B 联合评审会

| 联合议题 | SOLUTION 专家 | GRAPHIC 专家 | 输出 |
|---------|-------------|-------------|------|
| 论证逻辑与表达清晰度 | 市场分析师 (MARKET_ANALYST) | 内容审核专家 (CONTENT_REVIEWER) | 逻辑链完整性 + 非专业读者可理解性 |
| 数据可信度与引用规范 | 需求分析师 (REQ) | SEO专家 (SEO_EXPERT) | 数据来源可靠性 + 引用格式+EEAT 优化 |
| 执行建议的可操作性 | DevOps (OPS) | 内容审核专家 (CONTENT_REVIEWER) | 建议具体性检查 + 行动指令清晰度 |

## Step C 依赖排序

```
DEP_ORDER:
  分析框架选择 → 数据收集清单
  核心论点提炼 → 报告目录结构
  各章节数据填充 → 图表/可视化生成
  方案对比矩阵 → 推荐方案详细展开
  执行摘要撰写（最后） → 全文一致性校对
```

## Step D 联合门禁

```yaml
joint_gates:
  - id: "logic_and_readability"
    description: "论证严谨性 + 可读性"
    checks:
      - solution: "每项结论有≥2项论据支撑, 无跳跃推理, 反面论证完整"
      - graphic: "Flesch可读性分数 ≥ 目标受众水平, 段落长度 ≤ 150字"
  - id: "data_and_citation"
    description: "数据质量 + 引用规范"
    checks:
      - solution: "所有数据点标注来源+时效性, 关键假设显式化"
      - graphic: "引用格式一致, 外部链接可访问, EEAT 要素完整"
  - id: "actionability"
    description: "可执行性 + 受众适配"
    checks:
      - solution: "≥80%的建议含具体下一步动作, 含时间/负责人"
      - graphic: "执行摘要 ≤2页, 面向决策者的关键信息首屏可见"
```

## Step E 合并交付物

| 交付物 | 来源 | 说明 |
|--------|------|------|
| 完整方案报告 | SOLUTION E1 + GRAPHIC | 含封面/目录/摘要/正文/附录/参考文献 |
| 执行层 PPT 简报 | SOLUTION E5 + GRAPHIC | 10-15页，面向决策者，图表为主 |
| 方案对比一页纸 | SOLUTION E2 + GRAPHIC | 可视化 A/B/C 方案对比 |
| 风险评估登记册 | SOLUTION E4 | 含缓解策略和应急预案 |
| 发布/分发策略 | GRAPHIC | 含渠道选择、SEO元数据、推送计划 |

# OmniPM CDL 能力搜索与安装操作指南模块

> **模块名称**：`cdl_guide` —— CDL（Capability Discovery & Loading）能力发现、评估、安装全流程操作指南
> **版本**：0.3.0
> **依赖**：`modules/cdl_quality_gate.md`（Q-Score 评分与分级决策）
> **用途**：在 GATE-REQUIREMENT 确认后，基于项目全景图自动搜索、评估、安装所需外部能力（Skills / MCP / npm 包 / GitHub 仓库），并写入 `.pi/` 配置进行持久化管理。
> **触发时机**：GATE-REQUIREMENT 确认通过 → 项目全景图生成完毕 → 本模块自动加载

---

## 〇、模块索引

| 章节 | 内容 | 说明 |
|------|------|------|
| 一 | CDL 触发时机与前置条件 | 何时启动、依赖哪些前置产物 |
| 二 | 双生态搜索流程 | PI 生态 + GitHub 生态的并行搜索架构 |
| 三 | 搜索关键词生成规则 | 从项目全景图自动提取搜索词的算法 |
| 四 | Q-Score 评估流程 | 引用 `cdl_quality_gate.md` 的五维评分 + 分级决策 |
| 五 | 安装命令模板 | 四种来源的标准化安装命令 |
| 六 | .pi/ 配置文件写入格式 | skills.yaml / mcp.yaml / subagents.yaml Schema |
| 七 | 安装后验证步骤 | 命令可用性检查 + 配置完整性校验 |
| 八 | CDL 裸奔模式（bare-metal） | 跳过全部搜索，纯提示词执行 |
| 九 | Best-effort 策略 | 部分失败不阻塞，降级标记 |
| 十 | 超时策略 | 每生态 30s 超时 + 会话重试 |
| 十一 | npm 安全策略 | --ignore-scripts 默认 + 生命周期脚本审查 |

---

## 一、CDL 触发时机与前置条件

### 1.1 触发链

CDL 能力搜索在以下事件链中自动触发，不依赖用户显式指令：

```
GATE-REQUIREMENT 用户确认通过
    │
    ▼
项目全景图生成（PROJECT_PANORAMA.md）
    │  提取：技术栈、功能需求、非功能约束、部署环境
    │
    ▼
CDL 能力需求清单自动生成
    │  从全景图中提取能力缺口，生成《能力需求清单》
    │
    ▼
CDL 搜索启动（本模块接管）
    ├── 双生态并行搜索（第二章）
    ├── Q-Score 评估（第四章）
    ├── 候选排序 + 用户确认（🟡项）
    └── 安装 + 验证 + 写入配置（第五~七章）
```

### 1.2 前置条件检查

CDL 搜索启动前，Agent 必须确认以下前置条件均已满足：

| 前置条件 | 检查方式 | 不满足时的处理 |
|----------|---------|--------------|
| GATE-REQUIREMENT 已通过 | 检查 PROJECT_MEMORY.md 中 `stage` 为 `PLANNING` 或之后 | 等待 GATE-REQUIREMENT 完成 |
| 项目全景图已生成 | 检查 `PROJECT_PANORAMA.md` 文件存在且非空 | 先生成项目全景图 |
| 技术栈已明确 | 全景图中 `tech_stack` 字段非空 | 从需求规格书中补充 |
| 用户技术水平已记录 | PROJECT_MEMORY.md 中 `user_tech_level` 非空 | 询问用户后补录 |

### 1.3 项目全景图最小 Schema

```yaml
# PROJECT_PANORAMA.md — YAML frontmatter（CDL 提取用）
project_type: "DEV"                           # 项目类型（DEV/COURSE/SOLUTION/GRAPHIC/AV）
tech_stack:                                    # 技术栈
  runtime: "node"                              # node / python / java / go / rust / ...
  framework: "next.js"                         # 前端或后端框架
  database: "postgresql"                       # 主数据库
  orm: "prisma"                                # ORM/ODM（如适用）
  cache: "redis"                               # 缓存（如适用）
  auth: "next-auth"                            # 认证方案（如适用）
  deploy: "docker"                             # 部署方式
functional_requirements:                       # 核心功能需求
  - "用户认证与授权"
  - "RESTful API CRUD"
  - "文件上传与管理"
  - "实时通知推送"
non_functional:                                # 非功能需求
  - "API 响应时间 < 200ms"
  - "99.9% 可用性"
  - "OWASP TOP10 防护"
constraints:                                   # 约束条件
  - "单用户模式 MVP"
  - "预算为零（仅开源方案）"
  - "部署在 Vercel 免费层"
```

---

## 二、双生态搜索流程

### 2.1 架构总览

CDL 将外部能力来源划分为两大生态，搜索阶段**完全并行执行**：

```
                    CDL 搜索启动
                         │
         ┌───────────────┴───────────────┐
         ▼                               ▼
   ┌──────────┐                   ┌──────────┐
   │ PI 生态  │                   │GitHub 生态│
   │ (30s T/O)│                   │ (30s T/O)│
   └────┬─────┘                   └────┬─────┘
        │                              │
   ┌────┴────┬────────┐          ┌─────┴─────┬──────────────┐
   ▼         ▼        ▼          ▼           ▼              ▼
Skills    npm     MCP        Verified    Community    Actions     Dev Container
Registry  Registry Registry   Orgs        repos      Marketplace  templates
```

### 2.2 PI 生态搜索

#### 2.2.1 Skills Registry（信任级别：高）

**搜索命令**：
```bash
npx skills search <关键词1> <关键词2> ... --json
```

**搜索策略**：
- 每个能力需求生成 2-3 组关键词（主关键词 + 同义词扩展）
- 每组关键词独立搜索，结果合并去重
- 示例：需求 "Supabase 数据库操作" → 搜索 `"supabase database"`, `"supabase orm"`, `"postgres managed"`

**结果解析**：
```json
{
  "name": "supabase/agent-skills",
  "description": "Supabase database management, migrations, and queries",
  "installs": 25000,
  "source": "skills-registry"
}
```

#### 2.2.2 npm Registry（信任级别：中高）

**搜索命令**：
```bash
npm search <关键词> --json --long 2>/dev/null
```

**搜索限制**：
- 最多返回 10 条结果
- 排除已弃用包（`deprecated` 字段）
- 排除周下载量 < 100 的包
- 关键词过滤：排除与 `mcp-server` / `skill` / `plugin` 无关的通用库

**结果解析**：
```json
{
  "name": "@supabase/mcp-server-supabase",
  "version": "2.1.0",
  "description": "MCP server for Supabase",
  "weeklyDownloads": 52000,
  "source": "npm"
}
```

#### 2.2.3 MCP Registry（信任级别：中高）

**搜索方式**：通过 `npm search` 搜索 `mcp-server` 前缀的包：

```bash
npm search "mcp server <关键词>" --json --long 2>/dev/null
```

**额外筛选**：
- 包名必须以 `mcp-server-` 或 `@` scope + `mcp-server-` 开头
- 或描述中包含 "MCP server" 字样

### 2.3 GitHub 生态搜索

#### 2.3.1 Verified Orgs（信任级别：中高）

从已验证组织白名单（定义在 `cdl_quality_gate.md` §1.1）中搜索：

```bash
gh search repos "<关键词>" org:<白名单组织> --sort stars --limit 5 --json nameWithOwner,description,stargazersCount,updatedAt,license
```

白名单组织列表：
```
anthropic, supabase, earendil-works, vercel, cloudflare,
microsoft, google, facebook, airbnb, hashicorp, tailwindlabs,
prisma, trpc, t3-oss, shadcn, langchain
```

#### 2.3.2 Community Repos（信任级别：中）

社区仓库搜索（排除已验证组织）：

```bash
gh search repos "<关键词>" --sort stars --limit 10 --json nameWithOwner,description,stargazersCount,updatedAt,license,isFork,isArchived
```

**结果过滤**（客户端侧）：
- 排除已归档仓库（`isArchived: true`）
- 排除 Fork 仓库（`isFork: true`）
- 排除 Stars < 5 的个人仓库（进入"强化审查"通道）
- 排除不含 LICENSE 的仓库

#### 2.3.3 GitHub Actions Marketplace（信任级别：中高）

```bash
gh search repos "<关键词> path:.github/actions" --sort stars --limit 5
```

或通过 GitHub Marketplace API：
```bash
gh api "https://api.github.com/search/repositories?q=<关键词>+topic:github-actions&sort=stars&per_page=5"
```

#### 2.3.4 Dev Container Templates（信任级别：中高）

```bash
gh search repos "<关键词> path:.devcontainer" --sort stars --limit 5
```

### 2.4 搜索结果合并与去重协议

两生态搜索完成后，执行合并：

```
合并规则：
1. 按「能力名称 + 主要功能」计算语义相似度
2. 相似度 ≥ 0.85 的两条结果视为同一能力 → 保留评分更高者
3. 去重后按 final_rank 排序：
   final_rank = source_priority_boost + Q-Score
   source_priority_boost:
     Skills Registry: +15
     Verified Org:    +12
     npm Registry:    +10
     MCP Registry:    +10
     Actions Market:  +8
     Dev Container:   +8
     Community Repo:  +0
     个人实验性仓库:  -10
4. 每类需求保留 Top 3 候选
```

---

## 三、搜索关键词生成规则

### 3.1 关键词提取流水线

CDL 从项目全景图中自动提取搜索关键词，不需要用户手动指定：

```
项目全景图（PROJECT_PANORAMA.md）
    │
    ├── 来源 1: tech_stack 字段
    │   提取：runtime, framework, database, orm, cache, auth, deploy 的值
    │   示例：{runtime: "node"} → ["node", "nodejs", "node.js"]
    │
    ├── 来源 2: functional_requirements 字段
    │   提取：每个功能项的名词短语 + 动词短语
    │   示例："用户认证与授权" → ["authentication", "auth", "oauth", "user management"]
    │
    ├── 来源 3: non_functional 字段
    │   提取：涉及具体技术方案的需求
    │   示例："OWASP TOP10 防护" → ["security", "owasp", "helmet"]
    │
    └── 来源 4: constraints 字段
        提取：平台/服务约束对应的能力需求
        示例："部署在 Vercel" → ["vercel", "vercel deploy", "edge functions"]
```

### 3.2 关键词扩展规则

基础关键词生成后，执行以下扩展：

| 扩展类型 | 规则 | 示例 |
|----------|------|------|
| **同义词扩展** | 每组词扩展 2-3 个同义表达 | `auth` → `authentication`, `login`, `identity` |
| **生态系统扩展** | 技术栈值 + 通用后缀 | `next.js` → `nextjs plugin`, `next.js integration`, `nextjs tool` |
| **动词扩展** | 功能需求 + 操作动词 | `file upload` → `upload files`, `file management`, `storage` |
| **缩写展开** | 常见缩写双向映射 | `DB` ↔ `database`, `API` ↔ `rest api`, `CI/CD` ↔ `continuous integration` |

### 3.3 关键词分组与优先级

所有关键词按以下优先级分组，高频词在搜索中加权：

| 优先级 | 来源 | 权重 | 说明 |
|--------|------|------|------|
| P0（必搜） | tech_stack 核心值 | ×3 | 技术栈主关键词（如 `next.js`, `postgresql`） |
| P1（优先） | functional_requirements 关键词 | ×2 | 功能需求直接对应的能力词 |
| P2（补充） | non_functional + constraints | ×1 | 非功能需求与约束衍生的词 |

### 3.4 搜索词生成示例

**输入（项目全景图片段）**：
```yaml
tech_stack:
  runtime: "node"
  framework: "next.js"
  database: "postgresql"
  orm: "prisma"
  auth: "next-auth"
functional_requirements:
  - "用户认证与授权"
  - "文件上传与管理"
```

**输出（生成的搜索词分组）**：

```
能力需求 #1: 数据库操作
  P0: "prisma" "postgresql" "database"
  P1: "orm" "database client" "migration"
  P2: "supabase" "connection pool"

能力需求 #2: 用户认证
  P0: "next-auth" "auth"
  P1: "authentication" "oauth" "login"
  P2: "session management" "jwt"

能力需求 #3: 文件管理
  P0: "upload" "storage"
  P1: "file management" "file upload" "asset"
  P2: "cdn" "image optimization"
```

---

## 四、Q-Score 评估流程

### 4.1 引用关系

CDL 的候选能力评分体系完整定义在 `modules/cdl_quality_gate.md` 中。本章仅描述评估执行流程，具体评分标准、阈值、一票否决条件详见该模块。

**加载指令**：
```
@LOAD:modules/cdl_quality_gate.md
```

### 4.2 评估执行流程

```
对每个候选能力：
    │
    ├── Step 0: 一票否决检查（cdl_quality_gate.md §3.2）
    │   检查 8 项条件，任一命中 → 🔴 直接拒绝，跳过评分
    │
    ├── Step 1: GitHub 额外审查（仅源 4/5，cdl_quality_gate.md §3.3）
    │   检查 6 项条件，任一不满足 → 🔴 拒绝
    │
    ├── Step 2: 五维评分（cdl_quality_gate.md §二）
    │   ├── 安全性（权重 30%）—— 含一票否决子项
    │   ├── 活跃度与维护（权重 20%）
    │   ├── 社区验证（权重 25%）
    │   ├── 功能匹配度（权重 15%）
    │   └── 可维护性（权重 10%）
    │
    ├── Step 3: 计算 final_rank
    │   final_rank = source_priority_boost + Q-Score
    │
    └── Step 4: 分级决策（cdl_quality_gate.md §3.1）
        ├── 🟢 Q ≥ 75 → 自动安装
        ├── 🟡 50 ≤ Q < 75 → 展示评估报告，等待用户确认
        └── 🔴 Q < 50 → 拒绝，输出理由 + 替代推荐
```

### 4.3 评估输出格式

每个候选能力的评估结果使用以下统一格式输出：

```
┌──────────────────────────────────────────────────────────────┐
│ 能力需求: <能力需求名称>                                      │
│                                                              │
│ 🥇 <能力名称>                     Q=<分数> <🟢/🟡/🔴>        │
│    来源: <Skills Registry / npm / GitHub / MCP>              │
│    安全: <✅/⚠️> <安全摘要>                                   │
│    社区: <社区数据摘要>                                       │
│    匹配: <匹配度说明>                                         │
│    <决策动作>                                                 │
└──────────────────────────────────────────────────────────────┘
```

---

## 五、安装命令模板

### 5.1 Skills Registry 能力

```bash
# 安装
npx skills add <skill-name>

# 指定版本（推荐）
npx skills add <skill-name>@<version>

# 示例
npx skills add supabase/agent-skills
npx skills add code-review@1.2.0
```

**安装前检查**：
- 确认 `npx skills` 命令可用（`npx skills --version`）
- 确认目标 skill 名称在 Registry 中存在（`npx skills search <name>`）

### 5.2 npm 包

```bash
# 安装（带安全策略，详见第十一章）
npm install -D <package-name> --ignore-scripts --save-exact

# 指定版本
npm install -D <package-name>@<version> --ignore-scripts --save-exact

# 示例
npm install -D @supabase/mcp-server-supabase --ignore-scripts --save-exact
npm install -D @modelcontextprotocol/server-filesystem --ignore-scripts --save-exact
```

**安装前检查**：
- `npm view <package-name> --json` 确认包存在
- 检查 `deprecated` 字段（如已弃用则拒绝）
- 检查 `license` 字段（无 LICENSE 则触发一票否决）

### 5.3 MCP Server

```bash
# MCP Server 以 npm 包形式安装
npm install -D <mcp-server-package> --ignore-scripts --save-exact

# 安装后需在 .pi/mcp.yaml 中配置连接参数（见第六章）

# 示例
npm install -D @anthropic/mcp-server-puppeteer --ignore-scripts --save-exact
```

### 5.4 GitHub 仓库

```bash
# 浅克隆（仅最新版本，减少磁盘占用）
gh repo clone <owner/repo> --depth 1 <target-dir>

# 或使用 git clone（当 gh CLI 不可用时）
git clone --depth 1 https://github.com/<owner>/<repo>.git <target-dir>

# 示例
gh repo clone supabase/supabase-js --depth 1 ./.pi/modules/supabase-js
```

**克隆目标目录规范**：
- Skills/工具类：`.pi/modules/<repo-name>/`
- 模板/脚手架：`.pi/templates/<repo-name>/`
- Dev Container：`.devcontainer/`（直接覆盖或合并）

### 5.5 安装命令通用规则

1. **所有包安装默认 `--save-exact`**：锁定精确版本，防止自动升级引入不兼容变更。
2. **所有包安装默认 `--ignore-scripts`**：禁止自动执行生命周期脚本（详见第十一章）。
3. **版本号从搜索结果中提取**：优先使用最新稳定版（不含 `alpha`/`beta`/`rc` 标签）。
4. **安装失败自动重试一次**：间隔 3 秒后重试，仍失败则进入 best-effort 降级（第九章）。

---

## 六、.pi/ 配置文件写入格式

### 6.1 目录结构

```
项目根目录/
├── .pi/
│   ├── skills.yaml        # 已安装 Skills 注册表
│   ├── mcp.yaml           # 已安装 MCP Server 注册表
│   ├── subagents.yaml     # 已注册子代理配置
│   ├── config.yaml        # CDL 全局配置（白名单扩展等）
│   └── modules/           # 克隆的 GitHub 模块存放目录
│       └── ...
```

### 6.2 skills.yaml Schema

```yaml
# .pi/skills.yaml — 已安装 Skills 注册表
# 由 CDL 自动维护，禁止手动编辑

skills:
  - name: "supabase/agent-skills"            # Skill 完整名称，必填
    version: "2.1.0"                         # 安装版本，必填
    installed_at: "2026-07-21T10:30:00Z"     # ISO 8601 安装时间，必填
    verified: true                           # 安装后验证是否通过，必填
    verified_at: "2026-07-21T10:30:15Z"      # 验证时间，verified=true 时必填
    failure_reason: null                     # 安装失败原因，verified=false 时必填
    q_score: 92                              # Q-Score 评分
    source: "skills-registry"                # 来源：skills-registry
    source_url: null                         # 来源 URL（Skills 为空）
    triggers:                                # 触发条件（何时加载此 skill）
      - "supabase"
      - "database migration"
      - "row level security"
    notes: "Supabase 数据库迁移与查询"        # 备注

  - name: "code-review"
    version: "1.2.0"
    installed_at: "2026-07-21T10:31:00Z"
    verified: true
    verified_at: "2026-07-21T10:31:10Z"
    failure_reason: null
    q_score: 88
    source: "skills-registry"
    source_url: null
    triggers:
      - "code review"
      - "pull request"
    notes: "自动化代码审查"
```

### 6.3 mcp.yaml Schema

```yaml
# .pi/mcp.yaml — 已安装 MCP Server 注册表
# 由 CDL 自动维护，禁止手动编辑

mcp_servers:
  - name: "supabase"                                     # MCP Server 名称，必填
    package: "@supabase/mcp-server-supabase"             # npm 包名，必填
    version: "2.1.0"                                     # 安装版本，必填
    installed_at: "2026-07-21T10:30:00Z"
    verified: true
    verified_at: "2026-07-21T10:30:20Z"
    failure_reason: null
    q_score: 90
    source: "npm"
    source_url: "https://www.npmjs.com/package/@supabase/mcp-server-supabase"
    command: "npx"                                       # 启动命令
    args:                                                # 启动参数
      - "-y"
      - "@supabase/mcp-server-supabase"
    env:                                                 # 环境变量（敏感值用占位符）
      - "SUPABASE_URL=${SUPABASE_PROJECT_URL}"
      - "SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}"
    triggers:
      - "supabase"
      - "database"
    notes: "Supabase 数据库 MCP Server"

  - name: "filesystem"
    package: "@modelcontextprotocol/server-filesystem"
    version: "1.0.0"
    installed_at: "2026-07-21T10:32:00Z"
    verified: false
    verified_at: null
    failure_reason: "安装超时：npm registry 返回 503"
    q_score: 75
    source: "npm"
    source_url: "https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem"
    command: "npx"
    args:
      - "-y"
      - "@modelcontextprotocol/server-filesystem"
      - "/path/to/allowed/directory"
    env: []
    triggers:
      - "filesystem"
      - "file access"
    notes: "文件系统访问 MCP Server（安装失败，已降级）"
```

### 6.4 subagents.yaml Schema

```yaml
# .pi/subagents.yaml — 已注册子代理配置
# 由 CDL 自动维护，禁止手动编辑

subagents:
  - name: "security-scanner"                   # 子代理名称
    type: "mcp"                                # 类型：mcp / skill / custom
    source_path: ".pi/modules/security-scanner" # 来源路径
    installed_at: "2026-07-21T10:33:00Z"
    verified: true
    verified_at: "2026-07-21T10:33:05Z"
    failure_reason: null
    q_score: 85
    source: "github"
    source_url: "https://github.com/example/security-scanner"
    triggers:
      - "security audit"
      - "vulnerability scan"
    notes: "安全扫描子代理"
```

### 6.5 写入规范

1. **所有 `.pi/` 文件为 YAML 格式**，使用 2 空格缩进。
2. **写入模式为只追加**：新安装的能力追加到对应数组末尾，不修改已有条目。
3. **每次写入后立即校验**：读取文件 → 检查 YAML 语法有效性 → 确认新增条目存在。
4. **写入失败处理**：重试一次 → 仍失败则告警并记录到 PROJECT_MEMORY.md。
5. **敏感信息保护**：`env` 字段中的值使用 `${ENV_VAR_NAME}` 占位符，禁止直接写入真实凭据。

---

## 七、安装后验证步骤

### 7.1 验证矩阵

每种来源的安装完成后，按以下矩阵执行验证：

| 来源 | 验证命令 | 成功标志 | 超时 |
|------|---------|---------|------|
| Skills Registry | `npx skills list \| grep <name>` 或 `npx skills info <name>` | 输出包含已安装 skill 名称 | 10s |
| npm 包 | `npm list <package> --depth=0` | 输出包含包名和版本号 | 10s |
| npm 包（备用） | `npx <package> --version` | 返回版本号（0 退出码） | 15s |
| MCP Server | 检查 `.pi/mcp.yaml` 配置完整性 | YAML 解析通过 + 必填字段齐全 | 5s |
| GitHub 仓库 | `gh repo view <owner/repo> --json name` 或 `git -C <dir> log -1` | 返回仓库名或最新提交 | 10s |

### 7.2 验证流程

```
安装完成
    │
    ├── Step 1: 执行对应验证命令
    │
    ├── Step 2: 检查退出码 + 输出内容
    │    ├── ✅ 成功 → 标记 verified: true + verified_at
    │    └── ❌ 失败 → 重试一次（间隔 3s）
    │         ├── ✅ 重试成功 → 标记 verified: true
    │         └── ❌ 重试失败 → 标记 verified: false + failure_reason（第九章）
    │
    └── Step 3: 写入 .pi/ 配置文件
```

### 7.3 验证失败分类

| 失败类别 | 典型原因 | 处理方式 |
|----------|---------|---------|
| **命令不可用** | `npx` / `gh` CLI 未安装 | 提示用户安装对应 CLI 工具 |
| **网络错误** | DNS 解析失败、registry 不可达 | 标记 `search_status: timeout`，下次会话重试 |
| **权限不足** | 无写入 `.pi/` 目录权限 | 提示用户检查文件权限 |
| **包不存在** | 包名拼写错误或已下架 | 标记为安装失败，降级到备选方案 |
| **版本冲突** | 与已有依赖版本不兼容 | 记录冲突详情，提示用户手动解决 |

---

## 八、CDL 裸奔模式（bare-metal mode）

### 8.1 模式说明

CDL 裸奔模式是一种**完全跳过外部搜索与安装**的运行模式。在此模式下，Agent 不执行任何 `npx skills search`、`npm search`、`gh search repos` 等命令，所有能力通过**提示词内置知识**直接实现。

### 8.2 激活方式

**方式一：环境变量**
```bash
export CDL_MODE=baremetal
```

**方式二：项目配置文件**
```yaml
# .pi/config.yaml
cdl:
  mode: baremetal
```

**方式三：用户显式声明**
```
用户："切换到裸奔模式" / "跳过能力搜索" / "不使用外部工具"
```

### 8.3 裸奔模式行为

| 正常模式 | 裸奔模式 |
|----------|---------|
| 搜索 Skills Registry | **跳过** — 使用内置知识替代 |
| 搜索 npm Registry | **跳过** — 使用内置知识替代 |
| 搜索 GitHub 仓库 | **跳过** — 使用内置知识替代 |
| Q-Score 评估 | **跳过** — 所有候选标记 `mode: baremetal` |
| 安装能力 | **跳过** — 不执行任何安装命令 |
| 写入 .pi/ 配置 | **仍写入** — 记录裸奔模式标记 |
| .pi/ 配置格式 | `source: "baremetal"`, `verified: false`, `failure_reason: "裸奔模式"` |

### 8.4 裸奔模式配置记录示例

```yaml
# .pi/skills.yaml（裸奔模式）
skills:
  - name: "supabase-operations"
    version: "baremetal"
    installed_at: "2026-07-21T10:30:00Z"
    verified: false
    verified_at: null
    failure_reason: "baremetal-mode: no external installation performed"
    q_score: null
    source: "baremetal"
    source_url: null
    triggers:
      - "supabase"
    notes: "裸奔模式 — 通过提示词内置知识实现 Supabase 操作"
```

### 8.5 裸奔模式退出

```bash
# 退出裸奔模式
export CDL_MODE=auto          # 或 unset CDL_MODE

# 或修改 .pi/config.yaml
cdl:
  mode: auto                    # 恢复自动搜索
```

退出后，CDL 在下次会话启动或下一阶段开始时重新执行能力发现。

---

## 九、Best-effort 策略

### 9.1 核心原则

CDL 采用 **Best-effort（尽力而为）** 策略：部分能力安装失败**不阻塞项目主流程**。Agent 继续执行，未安装的能力由提示词内置知识兜底。

### 9.2 失败降级链

```
安装失败
    │
    ├── 重试一次（间隔 3s）
    │
    ├── 仍失败 → 标记 verified: false + failure_reason
    │
    ├── 检查是否有 🟡/🔴 备选方案
    │    ├── 有 → 尝试备选方案（走相同安装流程）
    │    └── 无 → 进入提示词兜底
    │
    └── 提示词兜底：
         Agent 在后续阶段中，使用内置知识模拟该能力的功能。
         在 PROJECT_MEMORY.md 中记录能力缺口。
```

### 9.3 失败记录规范

```yaml
# .pi/skills.yaml 中的失败条目
- name: "supabase/agent-skills"
  version: null
  installed_at: "2026-07-21T10:30:00Z"
  verified: false
  verified_at: null
  failure_reason: "npm registry 连接超时 (30s), 错误码: ETIMEDOUT"
  q_score: 92                     # 评分仍保留（搜索阶段已完成）
  source: "skills-registry"
  source_url: null
  triggers:
    - "supabase"
  notes: "评分通过但因网络问题安装失败，已降级为提示词兜底"
```

### 9.4 会话末汇总

每个阶段结束时，CDL 输出能力安装状态汇总：

```
[CDL 能力安装状态]
🟢 已安装: 3 项  (supabase/agent-skills, code-review, frontend-design)
🔴 安装失败: 1 项 (filesystem-mcp: 网络超时)
⚪ 裸奔模式: 0 项
────────────────────────────────────────
成功率: 75% (3/4) | 提示词兜底: 1 项
```

---

## 十、超时策略

### 10.1 超时配置

| 操作 | 超时时间 | 说明 |
|------|---------|------|
| Skills Registry 搜索 | 30s | `npx skills search` 单次调用 |
| npm Registry 搜索 | 30s | `npm search` 单次调用 |
| GitHub 仓库搜索 | 30s | `gh search repos` 单次调用 |
| npm 包安装 | 60s | `npm install`（含依赖下载） |
| GitHub 仓库克隆 | 60s | `gh repo clone --depth 1` |
| 安装后验证 | 15s | 单条验证命令 |

### 10.2 超时处理协议

```
搜索/安装命令启动
    │
    ├── 在超时时间内完成 → 正常处理结果
    │
    └── 超过超时时间
         │
         ├── 终止该命令（SIGTERM → SIGKILL 级联）
         │
         ├── 标记 search_status: timeout
         │
         ├── 该生态其他搜索继续（不受影响）
         │
         └── 输出超时记录：
              [CDL 超时] Skills Registry 搜索超时 (30s)
              已标记为 timeout，将在下次会话启动时自动重试。
```

### 10.3 超时状态持久化

```yaml
# PROJECT_MEMORY.md — last_checkpoint 扩展
last_checkpoint:
  state: "DESIGN"
  step: "A"
  sub_step: "CDL 能力搜索"
  timestamp: "2026-07-21T10:30:00Z"
  cdl_status:
    skills_registry:
      search_status: "completed"     # completed / timeout / failed
      candidates_found: 5
    npm_registry:
      search_status: "timeout"
      candidates_found: 0
    github_verified:
      search_status: "completed"
      candidates_found: 3
    github_community:
      search_status: "completed"
      candidates_found: 8
```

### 10.4 下次会话重试

新会话启动时，Agent 检查 `cdl_status` 中的 `search_status: timeout` 条目：

1. 自动重新搜索标记为 `timeout` 的生态。
2. 新结果与上次成功结果合并。
3. 更新 `cdl_status`，清除 `timeout` 标记。
4. 若连续 3 次超时，标记为 `search_status: permanently_failed`，不再自动重试，提示用户手动排查网络问题。

---

## 十一、npm 安全策略

### 11.1 默认行为：禁止生命周期脚本

CDL 安装 npm 包时**默认添加 `--ignore-scripts` 标志**，阻止 `preinstall`、`install`、`postinstall` 等生命周期脚本自动执行。

```bash
# ✅ 正确：始终带 --ignore-scripts
npm install -D <package> --ignore-scripts --save-exact

# ❌ 禁止：不带 --ignore-scripts
npm install -D <package> --save-exact
```

**安全理由**：生命周期脚本在 `npm install` 时以当前用户权限运行，是供应链攻击的主要载体（如 `postinstall` 脚本可执行任意代码、窃取环境变量、写入恶意文件）。

### 11.2 需要生命周期脚本时的处理

当某个包**确实需要**生命周期脚本才能正常工作时（如 `prisma` 的 `prisma generate`、`sharp` 的原生编译），执行以下审查流程：

#### Step 1: 提取脚本内容

```bash
# 查看包的 package.json 中的 scripts 字段
npm view <package> scripts --json
```

#### Step 2: 输出脚本内容预览

```
⚠️ [CDL npm 安全审查] <package-name> 需要执行生命周期脚本
───────────────────────────────────────────────────────────
该包定义了以下安装时脚本：

  preinstall:  "node ./scripts/preinstall.js"
  postinstall: "node ./scripts/generate.js"

脚本内容预览：

  ### preinstall.js（前 20 行）
  const os = require('os');
  const platform = os.platform();
  // 检测操作系统平台
  ...

  ### postinstall.js（前 20 行）
  const { execSync } = require('child_process');
  execSync('npx prisma generate');
  ...

安全评估：
  ✅ preinstall.js  — 仅检测操作系统（无网络/文件写入）
  ⚠️  postinstall.js — 执行 npx prisma generate（生成客户端代码）
───────────────────────────────────────────────────────────
> 这些脚本将在安装时以您的用户权限运行。
> 请回复"确认运行脚本"以继续安装，或"拒绝"跳过此包。
```

#### Step 3: 用户二次确认

- 用户必须明确回复**"确认运行脚本"**（遵循 §1.4 确认信号字典）。
- 非确认信号触发二次确认：回复"您的意思是允许执行上述生命周期脚本？[是/否]"
- 用户拒绝 → 包标记为 `verified: false`，`failure_reason: "用户拒绝生命周期脚本"`

#### Step 4: 带脚本安装

```bash
# 用户确认后执行（移除 --ignore-scripts）
npm install -D <package> --save-exact
```

### 11.3 脚本风险分级

| 风险等级 | 脚本特征 | 处理方式 |
|----------|---------|---------|
| **🟢 低风险** | 仅 `postinstall` 运行原生编译（如 `node-gyp rebuild`） | 标准审查（一次性预览 + 确认） |
| **🟡 中风险** | 脚本访问网络（下载二进制、调用 API） | **强化审查**：展示完整脚本内容 + 下载 URL |
| **🔴 高风险** | 脚本包含 `curl`/`wget` 管道到 shell、读写 `~/.ssh`、修改系统配置、使用 `eval()` | **直接拒绝**，不进入审查流程。提示用户寻找替代方案。 |

### 11.4 安装后脚本审计

安装完成后，CDL 可选择性审计已执行脚本的副作用：

```bash
# 检查最近修改的文件（异常文件写入检测）
find . -newer .pi/skills.yaml -type f | grep -v node_modules | grep -v .git
```

若发现异常，立即告警并提示用户审查。

---

## 十二、CDL 全局配置

### 12.1 .pi/config.yaml 完整 Schema

```yaml
# .pi/config.yaml — CDL 全局配置

cdl:
  # 运行模式：auto（默认）/ baremetal（裸奔）
  mode: auto

  # 搜索超时配置（单位：秒）
  timeout:
    search: 30          # 单生态搜索超时
    install: 60         # 单个包安装超时
    verify: 15          # 单条验证超时

  # 重试策略
  retry:
    max_attempts: 2     # 最大尝试次数（首次 + 1 次重试）
    delay_seconds: 3    # 重试间隔

  # 永久失败阈值（达到此次数后不再自动重试）
  permanent_failure_threshold: 3

  # GitHub 已验证组织白名单扩展（追加到内置白名单）
  trusted_orgs_extra:
    - "my-company"      # 替换为你的组织名

  # npm 安全策略
  npm:
    ignore_scripts: true              # 默认启用（不可关闭的核心安全策略）
    require_confirmation: true        # 生命周期脚本需二次确认
    auto_approve_native_build: false  # 原生编译脚本仍需审查

  # 裸奔模式
  baremetal:
    fallback_strategy: "prompt-only"  # 提示词兜底策略
    log_skipped_capabilities: true    # 记录所有跳过的能力

  # 日志
  logging:
    level: "info"         # debug / info / warn / error
    output_file: null     # 写入文件路径（null = 仅输出到控制台）
```

### 12.2 配置优先级

当同一配置项在多个位置定义时：

1. 环境变量（最高优先级）：`CDL_MODE=baremetal`
2. 项目 `.pi/config.yaml`：`cdl.mode: baremetal`
3. CDL 内置默认值（最低优先级）：`mode: auto`

---

## 十三、Agent 行为规范

### 13.1 搜索阶段

- [ ] 确认 GATE-REQUIREMENT 已通过
- [ ] 确认 PROJECT_PANORAMA.md 已生成
- [ ] 提取技术栈和功能需求 → 生成搜索关键词（第三章）
- [ ] 检查 CDL_MODE 是否为 `baremetal`（如是则跳至 §13.5）
- [ ] 双生态并行搜索（第二章）—— 各自 30s 超时
- [ ] 合并去重（§2.4）
- [ ] 对每个候选执行 Q-Score 评分（第四章）
- [ ] 输出候选列表

### 13.2 用户确认阶段（仅 🟡 项）

- [ ] 🟢 项（Q ≥ 75）：直接安装，输出一行摘要
- [ ] 🟡 项（50 ≤ Q < 75）：展示完整评分卡，等待用户"确认"
- [ ] 🔴 项（Q < 50 或一票否决）：输出拒绝理由 + 替代推荐

### 13.3 安装阶段

- [ ] 使用正确的安装命令模板（第五章）
- [ ] npm 包强制 `--ignore-scripts --save-exact`
- [ ] 安装超时 60s
- [ ] 安装失败自动重试一次

### 13.4 验证阶段

- [ ] 执行安装后验证（第七章）
- [ ] 标记 `verified: true/false` + `failure_reason`
- [ ] 写入 `.pi/` 配置文件（第六章）
- [ ] 输出会话安装汇总（§9.4）

### 13.5 裸奔模式

- [ ] 跳过全部搜索与安装
- [ ] 输出裸奔模式声明
- [ ] 所有能力标记 `source: "baremetal"` + `verified: false`
- [ ] 仍写入 `.pi/` 配置记录

---

## 附录A：CDL 全流程状态机

```
IDLE
  │ GATE-REQUIREMENT 确认通过
  ▼
PANORAMA_GENERATION          # 生成项目全景图
  │ PROJECT_PANORAMA.md 生成完毕
  ▼
CDL_KEYWORD_EXTRACTION       # 提取搜索关键词
  │
  ▼
CDL_SEARCHING                # 双生态并行搜索
  │
  ├── [CDL_MODE=baremetal] → CDL_BAREMETAL_SKIP
  │
  ├── [全部超时] → CDL_TIMEOUT_RETRY     # 下次会话重试
  │
  └── [搜索完成] →
      ▼
CDL_EVALUATING               # Q-Score 评估
  │
  ├── [全部 🔴] → CDL_FALLBACK_PROMPT   # 提示词兜底
  │
  └── [有候选] →
      ▼
CDL_USER_CONFIRM             # 🟡 项等待用户确认
  │
  ▼
CDL_INSTALLING               # 安装
  │
  ├── [部分失败] → 标记 + 继续（Best-effort）
  │
  └── [安装完成] →
      ▼
CDL_VERIFYING                # 验证 + 写入配置
  │
  ▼
CDL_COMPLETE                 # 进入 Step A 设计阶段
```

---

## 附录B：常见问题与恢复路径

| 问题 | 原因 | 恢复路径 |
|------|------|---------|
| `npx skills` 命令不存在 | Node.js 未安装或版本过低 | 提示用户安装 Node.js ≥ 18 |
| `npm search` 返回空 | npm registry 不可达 | 切换到 GitHub 生态搜索作为替代 |
| `gh` CLI 未认证 | 未运行 `gh auth login` | 提示用户认证，或降级为浏览器手动搜索 |
| 所有生态搜索均超时 | 网络连接问题 | 建议用户切换到裸奔模式 `CDL_MODE=baremetal` |
| `.pi/` 目录写入权限不足 | 文件系统权限限制 | 提示用户检查目录权限 |
| YAML 写入后格式损坏 | 特殊字符未转义 | 重新生成 `.pi/` 文件，使用 `yaml.safe_dump` 等效输出 |
| 安装包与已有依赖冲突 | 版本不兼容 | 记录冲突详情，标记 `verified: false` |

---

## 附录C：缩略语速查

| 缩写 | 全称 | 说明 |
|------|------|------|
| CDL | Capability Discovery & Loading | 能力发现与加载 |
| Q-Score | Quality Score | 五维质量评分 |
| PI | Plugin Interface | 插件接口生态（Skills + npm + MCP） |
| T/O | Timeout | 超时 |
| MVP | Minimum Viable Product | 最小可行产品 |

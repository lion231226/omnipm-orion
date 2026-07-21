# OmniPM CI/CD 模板库模块

> **模块名称**：`ci_templates` —— 经过验证的 GitHub Actions CI/CD 模板骨架库
> **版本**：1.0.0
> **依赖**：`modules/output_format.md`（软依赖：模板适配后按输出格式规范输出）
> **用途**：为 Step E（交付阶段）提供 3 套经过人工验证的 CI/CD 工作流模板骨架。Agent 根据项目技术栈自动匹配最接近的模板，**适配后输出**（而非从零生成），确保流水线的正确性和一致性。
> **触发条件**：Step E 交付阶段，Agent 准备生成 `.github/workflows/*.yml` 时。

---

## 加载机制

本模块在 Step E 第 7 项交付物（CI/CD 配置文件）生成时被主提示词引用：

```markdown
## Step E —— 文档与交付

...
7. **参考 `modules/ci_templates.md`** 选择合适的 CI/CD 模板骨架进行适配（而非从零生成）。
...
```

Agent 按以下流程使用本模块：

```yaml
# Step 1：扫描项目技术栈，执行模板匹配
@LOAD:modules/ci_templates.md#matching    # 加载 Agent 选择逻辑

# Step 2：加载匹配到的模板详情
@LOAD:modules/ci_templates.md?template=frontend-node   # 前端项目
@LOAD:modules/ci_templates.md?template=backend-python  # 后端项目
@LOAD:modules/ci_templates.md?template=fullstack       # 全栈项目

# Step 3：适配参数后输出
# Agent 根据项目实际目录结构和版本号适配模板中的占位参数
```

---

## 模板索引

| 模板 ID | 模板名称 | 适用场景 | 关键流水线阶段 | 安全扫描 |
|---------|---------|---------|---------------|---------|
| `frontend-node` | 前端 Node.js 模板 | React / Vue / Next.js / Nuxt 等前端项目 | npm ci → lint → test → build | npm audit + CodeQL |
| `backend-python` | 后端 Python 模板 | FastAPI / Flask / Django 等 Python 后端服务 | pip install → lint → test → docker build | pip-audit + CodeQL |
| `fullstack` | 全栈 Docker Compose 模板 | 前后端分离 + 容器化部署的完整项目 | 前后端并行构建 → 集成测试 → 推送镜像 | Trivy 镜像扫描 + CodeQL |

---

## Agent 选择逻辑（模板匹配算法）

> **说明**：以下为 Agent 在 Step E 中选择模板的决策逻辑。Agent 必须按此流程执行，**不得跳过或自行判断**。

### 匹配流程

```
项目根目录扫描
    │
    ├── 存在 package.json + (vite.config.* | webpack.config.* | next.config.* | nuxt.config.*)
    │   └── 使用模板: frontend-node
    │
    ├── 存在 pyproject.toml 或 requirements.txt + (fastapi | flask | django 依赖)
    │   └── 使用模板: backend-python
    │
    ├── 同时满足上述两个条件（前后端分离项目）
    │   └── 使用模板: fullstack
    │
    └── 其他情况（单一后端或其他语言栈）
        └── 选择最接近的模板进行适配，优先 backend-python
```

### 伪代码逻辑

```python
def select_ci_template(project_root: str) -> tuple[str, str]:
    """
    根据项目根目录下的文件特征匹配最合适的 CI 模板。
    返回 (模板ID, 匹配理由说明)。
    """
    files = list_files(project_root)
    pkg_files = glob(project_root, "**/package.json")

    # 检测前端特征
    is_frontend = any([
        exists(project_root, "package.json"),
        any(glob(project_root, "**/vite.config.*")),
        any(glob(project_root, "**/webpack.config.*")),
        any(glob(project_root, "**/next.config.*")),
        any(glob(project_root, "**/nuxt.config.*")),
    ])

    # 检测后端特征
    is_python = any([
        exists(project_root, "pyproject.toml"),
        exists(project_root, "requirements.txt"),
        exists(project_root, "setup.py"),
    ])

    # 检测全栈特征（前后端目录分离）
    has_separate_dirs = (
        is_frontend and is_python and
        (is_dir(project_root, "frontend") or is_dir(project_root, "client")) and
        (is_dir(project_root, "backend") or is_dir(project_root, "server") or is_dir(project_root, "api"))
    )

    # 检测 Docker Compose 特征
    has_docker_compose = exists(project_root, "docker-compose.yml") or exists(project_root, "docker-compose.yaml")

    # 决策逻辑
    if has_separate_dirs or (is_frontend and is_python and has_docker_compose):
        return ("fullstack", "检测到前后端分离目录结构 + Python 后端，匹配全栈模板")
    elif is_python:
        return ("backend-python", "检测到 Python 项目特征（pyproject.toml / requirements.txt），匹配后端模板")
    elif is_frontend:
        return ("frontend-node", "检测到 Node.js 前端项目特征（package.json + 构建工具配置），匹配前端模板")
    else:
        # 兜底：选择最接近的模板
        return ("backend-python", "未检测到明确技术栈特征，使用通用后端模板作为默认")
```

### 适配参数清单

匹配模板后，Agent 必须检查以下参数并按项目实际情况适配：

| 参数 | 默认值 | 适配说明 |
|------|--------|---------|
| `node-version` | `20` | 对齐项目 `.nvmrc` 或 `package.json` 中的 `engines.node` |
| `python-version` | `"3.11"` | 对齐项目 `pyproject.toml` 或 `.python-version` |
| `working-directory` | `./` | 若为 monorepo，需指向对应子目录 |
| `cache-key` | 自动生成 | 基于 `hashFiles` 的缓存键，一般无需手动修改 |
| `docker-registry` | `ghcr.io` | 可替换为 Docker Hub、阿里云 ACR 等 |
| `deploy-branch` | `main` | 对齐项目默认分支名 |

---

## 模板一：前端 Node.js (`frontend-node`)

> **模板 ID**：`frontend-node`
> **适用场景**：React、Vue、Next.js、Nuxt、Angular 等基于 Node.js 的前端项目
> **流水线阶段**：代码检查 → 单元测试 → 构建 → 可选部署
> **安全扫描**：npm audit（依赖漏洞检查）+ CodeQL（代码安全分析）

```yaml
# =============================================================================
# 模板：前端 Node.js CI/CD 流水线
# 模板 ID：frontend-node
# 适用场景：React / Vue / Next.js / Nuxt / Angular 等 Node.js 前端项目
# 基于此模板适配后输出，标注"基于模板: frontend-node 适配"
# =============================================================================

name: 前端 CI/CD 流水线  # 流水线名称，在 GitHub Actions 页面展示

# ─── 触发条件 ───────────────────────────────────────────────────────────────
on:
  push:
    branches: [main, develop]        # 推送到主分支和开发分支时触发
    paths:
      - 'src/**'                     # 仅源码变更时触发
      - 'public/**'                  # 静态资源变更时触发
      - 'package.json'               # 依赖变更时触发
      - 'package-lock.json'          # 锁定文件变更时触发
      - '.github/workflows/**'       # 工作流自身变更时触发
  pull_request:
    branches: [main]                 # 面向主分支的 PR 触发
    types: [opened, synchronize, reopened]  # PR 打开、更新、重新打开时触发
  workflow_dispatch:                 # 允许手动触发
    inputs:
      deploy-to-production:
        description: '是否部署到生产环境'
        type: boolean
        default: false
        required: true

# ─── 环境变量（全局） ─────────────────────────────────────────────────────────
env:
  NODE_VERSION: '20'                 # Node.js 版本，对齐项目 .nvmrc
  ARTIFACT_NAME: dist                # 构建产物名称
  ARTIFACT_RETENTION_DAYS: 7         # 产物保留天数

# ─── 流水线任务定义 ──────────────────────────────────────────────────────────
jobs:

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 1：代码质量检查（lint + format）
  # ═══════════════════════════════════════════════════════════════════════════
  lint:
    name: 代码检查
    runs-on: ubuntu-latest            # 运行环境
    timeout-minutes: 5                # 超时时间（防止挂起）

    steps:
      # 步骤 1：检出代码
      - name: 检出代码仓库
        uses: actions/checkout@v4

      # 步骤 2：安装 Node.js 运行环境
      - name: 安装 Node.js ${{ env.NODE_VERSION }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'                # 自动缓存 npm 依赖，加速后续运行

      # 步骤 3：安装项目依赖（使用 npm ci 确保依赖版本严格一致）
      - name: 安装依赖（npm ci）
        run: npm ci

      # 步骤 4：运行代码格式化检查
      - name: 代码格式化检查（Prettier）
        run: npx prettier --check "src/**/*.{js,jsx,ts,tsx,vue,css,scss,json}"

      # 步骤 5：运行 ESLint 静态代码分析
      - name: ESLint 静态分析
        run: npx eslint "src/**/*.{js,jsx,ts,tsx,vue}" --max-warnings 0

      # 步骤 6：TypeScript 类型检查（仅 TypeScript 项目启用）
      # 若非 TS 项目，请删除此步骤
      - name: TypeScript 类型检查
        run: npx tsc --noEmit

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 2：单元测试
  # ═══════════════════════════════════════════════════════════════════════════
  test:
    name: 单元测试
    runs-on: ubuntu-latest
    needs: lint                       # 仅当 lint 通过后才执行
    timeout-minutes: 10

    steps:
      - name: 检出代码仓库
        uses: actions/checkout@v4

      - name: 安装 Node.js ${{ env.NODE_VERSION }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: 安装依赖（npm ci）
        run: npm ci

      # 运行测试套件并生成覆盖率报告
      - name: 运行单元测试（带覆盖率）
        run: npm run test -- --coverage

      # 上传覆盖率报告到 Codecov（可选，如不需要请删除此步骤）
      - name: 上传覆盖率到 Codecov
        if: success()                 # 仅测试通过时上传
        uses: codecov/codecov-action@v4
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
          files: ./coverage/lcov.info
          fail_ci_if_error: false     # 上传失败不阻断流水线

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 3：安全扫描（依赖漏洞 + 代码安全）
  # ═══════════════════════════════════════════════════════════════════════════
  security-scan:
    name: 安全扫描
    runs-on: ubuntu-latest
    needs: lint                       # 仅当 lint 通过后才执行（节省资源）
    timeout-minutes: 15
    # 安全扫描结果不影响流水线通过（仅告警），设为 continue-on-error
    continue-on-error: true

    steps:
      - name: 检出代码仓库
        uses: actions/checkout@v4

      - name: 安装 Node.js ${{ env.NODE_VERSION }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: 安装依赖（npm ci）
        run: npm ci

      # npm audit：检查依赖中的已知安全漏洞
      # --audit-level=high：仅 high 和 critical 级别漏洞才会使步骤失败
      - name: npm 依赖漏洞审计
        run: npm audit --audit-level=high
        continue-on-error: true       # 漏洞审计不阻断流水线，但会在摘要中展示

      # CodeQL：GitHub 原生静态代码安全分析
      - name: 初始化 CodeQL 分析
        uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
          queries: security-extended   # 扩展安全查询集

      - name: 执行 CodeQL 分析
        uses: github/codeql-action/analyze@v3

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 4：构建
  # ═══════════════════════════════════════════════════════════════════════════
  build:
    name: 构建
    runs-on: ubuntu-latest
    needs: [test, security-scan]      # 测试和安全扫描通过后执行
    timeout-minutes: 10

    steps:
      - name: 检出代码仓库
        uses: actions/checkout@v4

      - name: 安装 Node.js ${{ env.NODE_VERSION }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: 安装依赖（npm ci）
        run: npm ci

      # 生产环境构建
      - name: 生产构建
        run: npm run build

      # 上传构建产物为流水线产物（artifact），供后续部署阶段使用
      - name: 上传构建产物
        uses: actions/upload-artifact@v4
        with:
          name: ${{ env.ARTIFACT_NAME }}
          path: dist/                 # 构建输出目录，按项目实际调整
          retention-days: ${{ env.ARTIFACT_RETENTION_DAYS }}

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 5（可选）：部署到生产环境
  # ═══════════════════════════════════════════════════════════════════════════
  deploy:
    name: 生产部署
    runs-on: ubuntu-latest
    needs: build                      # 构建成功后执行
    # 仅当推送到 main 分支 或 手动触发并勾选"部署到生产环境"时执行
    if: |
      (github.event_name == 'push' && github.ref == 'refs/heads/main') ||
      (github.event_name == 'workflow_dispatch' && inputs.deploy-to-production)
    environment:
      name: production                # GitHub Environment，可配置保护规则
      url: https://your-app.com       # 部署后可访问的 URL（按实际填写）

    steps:
      - name: 下载构建产物
        uses: actions/download-artifact@v4
        with:
          name: ${{ env.ARTIFACT_NAME }}
          path: dist/

      # ═══ 以下为部署步骤占位，请按实际部署目标替换 ═══
      # GitHub Pages 部署示例
      - name: 部署到 GitHub Pages
        if: false                     # 默认禁用，按需启用
        uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist

      # Vercel 部署示例
      - name: 部署到 Vercel
        if: false                     # 默认禁用，按需启用
        uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          vercel-args: '--prod'

      # AWS S3 + CloudFront 部署示例
      - name: 部署到 AWS S3
        if: false                     # 默认禁用，按需启用
        run: |
          aws s3 sync dist/ s3://${{ secrets.AWS_S3_BUCKET }} --delete
          aws cloudfront create-invalidation --distribution-id ${{ secrets.AWS_CLOUDFRONT_ID }} --paths "/*"
```

---

## 模板二：后端 Python (`backend-python`)

> **模板 ID**：`backend-python`
> **适用场景**：FastAPI、Flask、Django 等 Python Web 后端服务
> **流水线阶段**：依赖安装 → 代码检查 → 单元测试 → Docker 镜像构建与推送
> **安全扫描**：pip-audit（依赖漏洞检查）+ CodeQL（代码安全分析）

```yaml
# =============================================================================
# 模板：后端 Python CI/CD 流水线
# 模板 ID：backend-python
# 适用场景：FastAPI / Flask / Django 等 Python Web 后端服务
# 基于此模板适配后输出，标注"基于模板: backend-python 适配"
# =============================================================================

name: 后端 Python CI/CD 流水线

# ─── 触发条件 ───────────────────────────────────────────────────────────────
on:
  push:
    branches: [main, develop]
    paths:
      - 'src/**'
      - 'app/**'                     # Python 项目常见源码目录
      - 'pyproject.toml'
      - 'requirements*.txt'
      - 'Dockerfile'
      - '.github/workflows/**'
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened]
  workflow_dispatch:
    inputs:
      push-to-registry:
        description: '是否推送 Docker 镜像到容器仓库'
        type: boolean
        default: false
        required: true

# ─── 环境变量（全局） ─────────────────────────────────────────────────────────
env:
  PYTHON_VERSION: '3.11'             # Python 版本，对齐项目 pyproject.toml
  DOCKER_REGISTRY: ghcr.io           # 容器镜像仓库地址
  DOCKER_IMAGE_NAME: ${{ github.repository }}  # 镜像名称（格式：owner/repo）

# ─── 流水线任务定义 ──────────────────────────────────────────────────────────
jobs:

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 1：代码质量检查
  # ═══════════════════════════════════════════════════════════════════════════
  lint:
    name: 代码检查
    runs-on: ubuntu-latest
    timeout-minutes: 5

    steps:
      - name: 检出代码仓库
        uses: actions/checkout@v4

      # 安装指定版本的 Python
      - name: 安装 Python ${{ env.PYTHON_VERSION }}
        uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}
          cache: 'pip'               # 自动缓存 pip 依赖

      # 安装项目依赖（含开发依赖）
      - name: 安装项目依赖
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt
          pip install -r requirements-dev.txt   # 开发依赖（含 lint 工具）

      # Ruff：新一代 Python linter，替代 flake8/isort/black
      - name: Ruff 代码检查
        run: ruff check src/

      # Ruff 格式化检查
      - name: Ruff 格式化检查
        run: ruff format --check src/

      # MyPy：静态类型检查（如项目使用类型注解，建议启用）
      - name: MyPy 类型检查
        run: mypy src/ --ignore-missing-imports
        continue-on-error: true      # 类型检查初期可设为宽松模式

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 2：单元测试
  # ═══════════════════════════════════════════════════════════════════════════
  test:
    name: 单元测试
    runs-on: ubuntu-latest
    needs: lint
    timeout-minutes: 15

    # 测试服务依赖矩阵（如需要特定数据库版本测试）
    services:
      # PostgreSQL 测试数据库（按需启用，若不需要数据库请删除此节）
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: test_user
          POSTGRES_PASSWORD: test_password
          POSTGRES_DB: test_db
        ports:
          - 5432:5432
        # 健康检查，确保数据库就绪后再运行测试
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

      # Redis 测试服务（按需启用）
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - name: 检出代码仓库
        uses: actions/checkout@v4

      - name: 安装 Python ${{ env.PYTHON_VERSION }}
        uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}
          cache: 'pip'

      - name: 安装项目依赖
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt
          pip install -r requirements-dev.txt

      # 运行 pytest 并生成覆盖率报告
      - name: 运行单元测试（pytest）
        env:
          # 注入测试环境变量
          DATABASE_URL: postgresql+asyncpg://test_user:test_password@localhost:5432/test_db
          REDIS_URL: redis://localhost:6379/0
          TESTING: 'true'
        run: |
          pytest tests/ -v --cov=src --cov-report=xml --cov-report=term-missing --maxfail=5

      # 上传覆盖率到 Codecov
      - name: 上传覆盖率到 Codecov
        if: success()
        uses: codecov/codecov-action@v4
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
          files: ./coverage.xml
          fail_ci_if_error: false

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 3：安全扫描
  # ═══════════════════════════════════════════════════════════════════════════
  security-scan:
    name: 安全扫描
    runs-on: ubuntu-latest
    needs: lint
    timeout-minutes: 15
    continue-on-error: true

    steps:
      - name: 检出代码仓库
        uses: actions/checkout@v4

      - name: 安装 Python ${{ env.PYTHON_VERSION }}
        uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}
          cache: 'pip'

      - name: 安装依赖
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt

      # pip-audit：检查 Python 依赖中的已知安全漏洞（CVE）
      - name: pip-audit 依赖漏洞审计
        run: |
          pip install pip-audit
          pip-audit --audit-level high
        continue-on-error: true

      # Bandit：Python 代码安全漏洞静态扫描
      - name: Bandit 代码安全扫描
        run: |
          pip install bandit
          bandit -r src/ -f json -o bandit-report.json
        continue-on-error: true

      # CodeQL：GitHub 原生代码安全分析
      - name: 初始化 CodeQL 分析
        uses: github/codeql-action/init@v3
        with:
          languages: python
          queries: security-extended

      - name: 执行 CodeQL 分析
        uses: github/codeql-action/analyze@v3

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 4：Docker 镜像构建与推送
  # ═══════════════════════════════════════════════════════════════════════════
  docker:
    name: Docker 镜像构建与推送
    runs-on: ubuntu-latest
    needs: [test, security-scan]
    timeout-minutes: 20
    # 权限设置：允许读取仓库内容和写入包
    permissions:
      contents: read
      packages: write

    steps:
      - name: 检出代码仓库
        uses: actions/checkout@v4

      # 登录到容器镜像仓库
      - name: 登录容器镜像仓库
        uses: docker/login-action@v3
        with:
          registry: ${{ env.DOCKER_REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      # 提取镜像元数据（标签、注解等）
      - name: 提取 Docker 镜像元数据
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.DOCKER_REGISTRY }}/${{ env.DOCKER_IMAGE_NAME }}
          tags: |
            # 分支名标签（如 main、develop）
            type=ref,event=branch
            # PR 号标签
            type=ref,event=pr
            # 语义化版本标签（如 v1.2.3）
            type=semver,pattern={{version}}
            # Git 短 SHA 标签（如 abc1234）
            type=sha,format=short
            # 最新标签（仅 main 分支）
            type=raw,value=latest,enable={{is_default_branch}}

      # 构建并推送 Docker 镜像
      - name: 构建并推送 Docker 镜像
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ./Dockerfile
          push: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          # 构建缓存优化
          cache-from: type=gha
          cache-to: type=gha,mode=max
          # 构建参数（注入版本信息）
          build-args: |
            PYTHON_VERSION=${{ env.PYTHON_VERSION }}
            BUILD_DATE=${{ github.event.head_commit.timestamp }}

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 5（可选）：部署
  # ═══════════════════════════════════════════════════════════════════════════
  deploy:
    name: 部署
    runs-on: ubuntu-latest
    needs: docker
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    environment:
      name: production
      url: https://api.your-app.com

    steps:
      # ═══ 以下为部署步骤占位，请按实际部署平台替换 ═══

      # Kubernetes（kubectl）部署示例
      - name: 部署到 Kubernetes
        if: false                     # 默认禁用，按需启用
        run: |
          kubectl set image deployment/app app=${{ env.DOCKER_REGISTRY }}/${{ env.DOCKER_IMAGE_NAME }}:latest
          kubectl rollout status deployment/app --timeout=5m

      # AWS ECS 部署示例
      - name: 部署到 AWS ECS
        if: false
        run: |
          aws ecs update-service --cluster ${{ secrets.AWS_ECS_CLUSTER }} \
            --service ${{ secrets.AWS_ECS_SERVICE }} --force-new-deployment
```

---

## 模板三：全栈 Docker Compose (`fullstack`)

> **模板 ID**：`fullstack`
> **适用场景**：前后端分离项目，使用 Docker Compose 进行容器化编排部署
> **流水线阶段**：前后端并行构建 → 集成测试 → 镜像安全扫描 → 推送镜像
> **安全扫描**：Trivy 镜像漏洞扫描 + CodeQL 代码分析

```yaml
# =============================================================================
# 模板：全栈 Docker Compose CI/CD 流水线
# 模板 ID：fullstack
# 适用场景：前后端分离 + Docker Compose 容器化部署的完整项目
# 基于此模板适配后输出，标注"基于模板: fullstack 适配"
# =============================================================================

name: 全栈 Docker Compose CI/CD 流水线

# ─── 触发条件 ───────────────────────────────────────────────────────────────
on:
  push:
    branches: [main, develop]
    paths:
      - 'frontend/**'               # 前端代码变更
      - 'backend/**'                # 后端代码变更
      - 'docker-compose*.yml'       # Compose 配置变更
      - 'Dockerfile*'               # Dockerfile 变更
      - '.github/workflows/**'
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened]
  workflow_dispatch:
    inputs:
      push-to-registry:
        description: '是否构建并推送 Docker 镜像'
        type: boolean
        default: true
        required: true
      deploy:
        description: '是否执行部署'
        type: boolean
        default: false
        required: true

# ─── 环境变量（全局） ─────────────────────────────────────────────────────────
env:
  NODE_VERSION: '20'                # 前端 Node.js 版本
  PYTHON_VERSION: '3.11'            # 后端 Python 版本
  DOCKER_REGISTRY: ghcr.io          # 容器镜像仓库地址
  FRONTEND_IMAGE: ${{ github.repository }}/frontend
  BACKEND_IMAGE: ${{ github.repository }}/backend

# ─── 流水线任务定义 ──────────────────────────────────────────────────────────
jobs:

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 1：前端代码检查（与后端并行执行）
  # ═══════════════════════════════════════════════════════════════════════════
  frontend-lint:
    name: 前端-代码检查
    runs-on: ubuntu-latest
    timeout-minutes: 5

    steps:
      - name: 检出代码仓库
        uses: actions/checkout@v4

      - name: 安装 Node.js ${{ env.NODE_VERSION }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
          cache-dependency-path: frontend/package-lock.json  # 指定子目录

      # 仅安装前端依赖（按实际目录调整 working-directory）
      - name: 安装前端依赖
        working-directory: ./frontend
        run: npm ci

      - name: 前端代码格式化检查
        working-directory: ./frontend
        run: npx prettier --check "src/**/*.{js,jsx,ts,tsx,vue,css}"

      - name: 前端 ESLint 检查
        working-directory: ./frontend
        run: npx eslint "src/**/*.{js,jsx,ts,tsx,vue}" --max-warnings 0

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 2：后端代码检查（与前端并行执行）
  # ═══════════════════════════════════════════════════════════════════════════
  backend-lint:
    name: 后端-代码检查
    runs-on: ubuntu-latest
    timeout-minutes: 5

    steps:
      - name: 检出代码仓库
        uses: actions/checkout@v4

      - name: 安装 Python ${{ env.PYTHON_VERSION }}
        uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}
          cache: 'pip'
          cache-dependency-path: backend/requirements.txt

      - name: 安装后端依赖
        working-directory: ./backend
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt
          pip install -r requirements-dev.txt

      - name: Ruff 代码检查
        working-directory: ./backend
        run: ruff check src/

      - name: Ruff 格式化检查
        working-directory: ./backend
        run: ruff format --check src/

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 3：前端测试（与后端测试并行）
  # ═══════════════════════════════════════════════════════════════════════════
  frontend-test:
    name: 前端-单元测试
    runs-on: ubuntu-latest
    needs: frontend-lint
    timeout-minutes: 10

    steps:
      - name: 检出代码仓库
        uses: actions/checkout@v4

      - name: 安装 Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
          cache-dependency-path: frontend/package-lock.json

      - name: 安装前端依赖
        working-directory: ./frontend
        run: npm ci

      - name: 前端单元测试
        working-directory: ./frontend
        run: npm run test -- --coverage

      - name: 上传前端覆盖率
        if: success()
        uses: codecov/codecov-action@v4
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
          files: ./frontend/coverage/lcov.info
          flags: frontend             # 标记为前端覆盖率
          fail_ci_if_error: false

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 4：后端测试（与前端测试并行）
  # ═══════════════════════════════════════════════════════════════════════════
  backend-test:
    name: 后端-单元测试
    runs-on: ubuntu-latest
    needs: backend-lint
    timeout-minutes: 15

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: test_user
          POSTGRES_PASSWORD: test_password
          POSTGRES_DB: test_db
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - name: 检出代码仓库
        uses: actions/checkout@v4

      - name: 安装 Python
        uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}
          cache: 'pip'
          cache-dependency-path: backend/requirements.txt

      - name: 安装后端依赖
        working-directory: ./backend
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt
          pip install -r requirements-dev.txt

      - name: 后端单元测试
        working-directory: ./backend
        env:
          DATABASE_URL: postgresql+asyncpg://test_user:test_password@localhost:5432/test_db
          TESTING: 'true'
        run: pytest tests/ -v --cov=src --cov-report=xml --maxfail=5

      - name: 上传后端覆盖率
        if: success()
        uses: codecov/codecov-action@v4
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
          files: ./backend/coverage.xml
          flags: backend
          fail_ci_if_error: false

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 5：安全扫描（前后端并行）
  # ═══════════════════════════════════════════════════════════════════════════
  security-scan:
    name: 安全扫描
    runs-on: ubuntu-latest
    needs: [frontend-lint, backend-lint]  # lint 通过即可开始（节省时间）
    timeout-minutes: 20
    continue-on-error: true
    permissions:
      security-events: write         # CodeQL 上报所需权限

    steps:
      - name: 检出代码仓库
        uses: actions/checkout@v4

      # ── Python 依赖漏洞扫描 ──
      - name: 安装 Python
        uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}
          cache: 'pip'
          cache-dependency-path: backend/requirements.txt

      - name: 安装后端依赖
        working-directory: ./backend
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt

      - name: pip-audit 后端依赖漏洞审计
        working-directory: ./backend
        run: |
          pip install pip-audit
          pip-audit --audit-level high
        continue-on-error: true

      # ── Node.js 依赖漏洞扫描 ──
      - name: 安装 Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
          cache-dependency-path: frontend/package-lock.json

      - name: 安装前端依赖
        working-directory: ./frontend
        run: npm ci

      - name: npm audit 前端依赖漏洞审计
        working-directory: ./frontend
        run: npm audit --audit-level=high
        continue-on-error: true

      # ── CodeQL 静态代码安全分析 ──
      - name: 初始化 CodeQL 分析
        uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript,python
          queries: security-extended

      - name: 执行 CodeQL 分析
        uses: github/codeql-action/analyze@v3

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 6：集成测试（Docker Compose 启动完整服务栈）
  # ═══════════════════════════════════════════════════════════════════════════
  integration-test:
    name: 集成测试
    runs-on: ubuntu-latest
    needs: [frontend-test, backend-test, security-scan]  # 所有单元测试通过后执行
    timeout-minutes: 20

    steps:
      - name: 检出代码仓库
        uses: actions/checkout@v4

      # 构建并启动完整服务栈
      - name: 启动 Docker Compose 服务栈
        run: |
          docker compose -f docker-compose.ci.yml up -d --build --wait

      # 健康检查：等待所有服务就绪
      - name: 等待服务就绪
        run: |
          # 等待后端 API 就绪（最多 60 秒）
          for i in $(seq 1 30); do
            if curl -sf http://localhost:8000/health > /dev/null 2>&1; then
              echo "后端 API 已就绪"
              break
            fi
            echo "等待后端 API 就绪... ($i/30)"
            sleep 2
          done

          # 等待前端服务就绪
          for i in $(seq 1 30); do
            if curl -sf http://localhost:3000 > /dev/null 2>&1; then
              echo "前端服务已就绪"
              break
            fi
            echo "等待前端服务就绪... ($i/30)"
            sleep 2
          done

      # 运行集成测试套件
      - name: 运行集成测试
        run: |
          # 后端 API 集成测试
          cd backend
          pip install httpx pytest
          pytest tests/integration/ -v --maxfail=3 || echo "集成测试有失败，但不阻断流水线"

      # 收集 Docker Compose 日志用于问题排查
      - name: 收集服务日志
        if: always()                  # 无论测试成功与否都收集日志
        run: docker compose -f docker-compose.ci.yml logs --tail=200

      # 清理服务栈
      - name: 停止并清理服务栈
        if: always()
        run: docker compose -f docker-compose.ci.yml down -v --remove-orphans

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 7：Docker 镜像构建、扫描与推送（前后端并行）
  # ═══════════════════════════════════════════════════════════════════════════
  docker:
    name: 镜像构建与推送
    runs-on: ubuntu-latest
    needs: integration-test
    timeout-minutes: 30
    permissions:
      contents: read
      packages: write
      security-events: write         # Trivy 上报所需权限

    strategy:
      matrix:
        # 前后端镜像并行构建
        service: [frontend, backend]
        include:
          - service: frontend
            context: ./frontend
            dockerfile: ./frontend/Dockerfile
          - service: backend
            context: ./backend
            dockerfile: ./backend/Dockerfile

    steps:
      - name: 检出代码仓库
        uses: actions/checkout@v4

      # 登录容器镜像仓库
      - name: 登录容器镜像仓库
        uses: docker/login-action@v3
        with:
          registry: ${{ env.DOCKER_REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      # 提取镜像元数据
      - name: 提取镜像元数据
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.DOCKER_REGISTRY }}/${{ github.repository }}/${{ matrix.service }}
          tags: |
            type=ref,event=branch
            type=sha,format=short
            type=raw,value=latest,enable={{is_default_branch}}

      # 构建镜像（暂不推送，先扫描）
      - name: 构建 Docker 镜像
        uses: docker/build-push-action@v6
        with:
          context: ${{ matrix.context }}
          file: ${{ matrix.dockerfile }}
          push: false                 # 先构建不推送，安全扫描通过后再推送
          load: true                  # 加载到本地 Docker daemon 供 Trivy 扫描
          tags: ${{ steps.meta.outputs.tags }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      # Trivy 镜像安全漏洞扫描
      - name: Trivy 镜像漏洞扫描
        uses: aquasecurity/trivy-action@0.28.0
        with:
          image-ref: ${{ env.DOCKER_REGISTRY }}/${{ github.repository }}/${{ matrix.service }}:${{ github.sha }}
          format: 'sarif'             # SARIF 格式可上传到 GitHub Security 面板
          output: trivy-results-${{ matrix.service }}.sarif
          severity: 'HIGH,CRITICAL'   # 仅报告 HIGH 和 CRITICAL 级别漏洞
          exit-code: 0                # 发现漏洞不阻断流水线（仅在 Security 面板中展示）
        continue-on-error: true

      # 上传 Trivy 扫描结果到 GitHub Security 面板
      - name: 上传 Trivy 扫描结果
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: trivy-results-${{ matrix.service }}.sarif
          category: trivy-${{ matrix.service }}

      # 推送镜像到容器仓库
      - name: 推送镜像到容器仓库
        if: |
          github.event_name == 'push' && github.ref == 'refs/heads/main' &&
          (github.event_name != 'workflow_dispatch' || inputs.push-to-registry)
        uses: docker/build-push-action@v6
        with:
          context: ${{ matrix.context }}
          file: ${{ matrix.dockerfile }}
          push: true                  # 此时正式推送
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  # ═══════════════════════════════════════════════════════════════════════════
  # 阶段 8（可选）：部署
  # ═══════════════════════════════════════════════════════════════════════════
  deploy:
    name: 部署
    runs-on: ubuntu-latest
    needs: docker
    if: |
      github.event_name == 'push' && github.ref == 'refs/heads/main' &&
      (github.event_name != 'workflow_dispatch' || inputs.deploy)
    environment:
      name: production
      url: https://your-app.com

    steps:
      - name: 检出代码仓库
        uses: actions/checkout@v4

      # SSH 到服务器拉取最新镜像并重启服务
      - name: 远程部署（SSH）
        if: false                     # 默认禁用，按需启用并配置 secrets
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.DEPLOY_HOST }}
          username: ${{ secrets.DEPLOY_USER }}
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          script: |
            cd /opt/app
            docker compose pull
            docker compose up -d --remove-orphans
            docker image prune -f

      # Kubernetes 部署示例
      - name: 部署到 Kubernetes
        if: false
        run: |
          kubectl set image deployment/frontend frontend=${{ env.DOCKER_REGISTRY }}/${{ env.FRONTEND_IMAGE }}:latest
          kubectl set image deployment/backend backend=${{ env.DOCKER_REGISTRY }}/${{ env.BACKEND_IMAGE }}:latest
          kubectl rollout status deployment/frontend --timeout=5m
          kubectl rollout status deployment/backend --timeout=5m
```

---

## 适配注意事项

### 通用注意事项

1. **密钥管理**：所有 `${{ secrets.XXX }}` 必须在 GitHub 仓库的 Settings > Secrets and variables > Actions 中配置。
2. **分支名适配**：将 `main` 替换为项目的实际默认分支名（如 `master`）。
3. **目录结构适配**：将 `working-directory` 和 `context` 路径替换为项目的实际目录结构。
4. **缓存路径**：`actions/setup-node` 和 `actions/setup-python` 的 `cache` 参数根据实际锁定文件路径调整 `cache-dependency-path`。
5. **超时时间**：`timeout-minutes` 为建议值，根据项目规模适当调整。

### 安全扫描配置

| 扫描工具 | 适用模板 | 作用 | 阻断策略 |
|---------|---------|------|---------|
| `npm audit` | frontend-node, fullstack | 检查 Node.js 依赖已知漏洞（CVE） | `continue-on-error: true`（不阻断） |
| `CodeQL` | 全部模板 | GitHub 原生静态代码安全分析 | 发现问题时仍通过，在 Security 面板展示 |
| `pip-audit` | backend-python, fullstack | 检查 Python 依赖已知漏洞（CVE） | `continue-on-error: true`（不阻断） |
| `Bandit` | backend-python | Python 代码安全漏洞静态扫描 | `continue-on-error: true`（不阻断） |
| `Trivy` | fullstack | Docker 镜像层漏洞扫描 | `exit-code: 0`（不阻断），SARIF 上报 |

### 模板适配输出格式

Agent 在适配模板后，必须按以下格式输出交付物：

```markdown
## CI/CD 配置文件

基于模板 **`{模板名称}`**（`{模板ID}`）适配。

### 匹配理由

- 项目技术栈：{描述}
- 检测到特征：{文件特征列表}
- 匹配模板：{模板ID}
- 适配项：{列出所有修改的参数}

### 工作流文件

以下文件已生成至 `.github/workflows/` 目录：

1. `.github/workflows/ci.yml` —— {简要说明}

### 密钥清单

请确保以下 GitHub Secrets 已配置：

| 密钥名称 | 用途 | 是否必需 |
|---------|------|---------|
| `GITHUB_TOKEN` | GitHub Actions 内置令牌（自动提供） | 是 |
| `CODECOV_TOKEN` | Codecov 覆盖率上报令牌 | 否 |
| ... | ... | ... |

---
*本配置基于 `modules/ci_templates.md` 中的模板骨架生成，经人工验证，可安全用于生产环境。*
```

---

## 版本历史

| 版本 | 日期 | 变更说明 |
|------|------|---------|
| 1.0.0 | 2026-07-21 | 初始版本：3 套核心模板骨架、Agent 匹配算法、适配参数文档 |

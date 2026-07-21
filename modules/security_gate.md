# OmniPM 安全检查门禁模块

> **引用关系**：主提示词 §2.3（代码生成安全约束）和 §9.1（交付前安全审计）引用本模块。
> **用途**：在代码生成、审查、交付各阶段执行自动化安全检查，拦截已知危险模式。

---

## 1. 禁止函数清单与安全替代方案

以下函数/模式在生成或审查的代码中**一律禁止**。检测到即阻断，并提示安全替代方案。

| 序号 | 危险函数/模式 | 风险类别 | 安全替代方案 | 说明 |
|------|-------------|---------|-------------|------|
| 1 | `exec()` | 任意代码执行 | `subprocess.run(cmd, shell=False)` | 禁止将字符串作为代码执行 |
| 2 | `eval()` | 任意表达式求值 | `ast.literal_eval()` 或 `json.loads()` | 仅允许字面量数据结构解析 |
| 3 | `os.system()` | Shell 注入 | `subprocess.run(cmd, shell=False)` | 禁止通过 Shell 执行命令 |
| 4 | `subprocess.call(shell=True)` | Shell 注入 | `subprocess.run(cmd, shell=False)` | 禁止 Shell 模式，必须使用列表参数 |
| 5 | `subprocess.Popen(shell=True)` | Shell 注入 | `subprocess.Popen(cmd, shell=False)` | 同上 |
| 6 | `os.popen()` | Shell 注入 | `subprocess.run(cmd, shell=False, capture_output=True)` | 已废弃接口，必须替换 |
| 7 | `__import__()` | 动态导入注入 | `importlib.import_module()` | 禁止字符串驱动的模块导入 |
| 8 | `compile()` + `exec()` 组合 | 编译后执行 | 不允许，直接拒绝 | 无合法使用场景 |
| 9 | `pickle.loads()` 接受不可信数据 | 反序列化攻击 | `json.loads()` 或签名验证后的 pickle | 仅限可信来源 |
| 10 | `yaml.load()` 使用默认 Loader | YAML 反序列化攻击 | `yaml.safe_load()` | 禁止执行 YAML 中的 Python 标签 |
| 11 | `assert` 用于业务逻辑校验 | 生产环境断言被跳过 | `if ... raise ValueError(...)` | assert 在 `-O` 模式下被移除 |
| 12 | `input()` 在服务端代码中 | 阻塞/注入 | 使用框架参数绑定或 API 请求体解析 | 服务端无交互终端 |
| 13 | `eval()` — TypeScript/JavaScript | 任意表达式求值 | 显式逻辑重构（`if`/`switch`/对象映射替代动态求值） | 禁止将字符串作为代码执行 |
| 14 | `new Function()` — TypeScript/JavaScript | 动态函数构造 | 显式函数定义（`function foo() {}` 或箭头函数） | 等价于 eval，禁止动态构造可执行代码 |
| 15 | `import()` 动态导入（用户输入拼接）— TS/JS | 动态代码加载 | 静态 `import` 语句（`import { X } from 'module'`） | 禁止将用户输入拼接到动态 import 路径中 |
| 16 | `child_process.exec(string参数)` — Node.js | Shell 注入 | `child_process.spawn(cmd, [arg1, arg2], { shell: false })` | 禁止以字符串形式将用户输入传入 exec |
| 17 | `fs.readFile()` 路径拼接用户输入 — Node.js | 目录遍历 | `path.resolve(baseDir, userInput)` + 白名单路径验证 | 必须对用户输入做路径规范化和范围校验 |
| 18 | `JSON.parse()` 无 try-catch — TS/JS | 拒绝服务/异常崩溃 | `try { JSON.parse(s); } catch (e) { ... }` + 输入长度限制 | 恶意超长/畸形 JSON 可导致进程崩溃 |

### 检测正则（门禁用）

```
\bexec\s*\(
\beval\s*\(
\bos\.system\s*\(
\bos\.popen\s*\(
\bsubprocess\.(call|Popen)\s*\([^)]*shell\s*=\s*True
\b__import__\s*\(
\bcompile\s*\([^)]*\)[^)]*\bexec\s*\(
\bpickle\.(loads|load)\s*\(
\byaml\.load\s*\(\s*(?!.*Loader\s*=\s*yaml\.SafeLoader)
\bassert\s+(?!.*test_|.*unittest|.*pytest)
```

---

## 2. SQL 注入防护模板

### 2.1 核心原则

**永远不要将用户输入直接拼接到 SQL 语句中。** 所有数据库交互必须使用参数化查询。

### 2.2 多语言参数化示例

| 语言/库 | 正确写法（参数化） | 禁止写法（拼接） |
|---------|------------------|----------------|
| Python (psycopg2) | `cursor.execute("SELECT * FROM users WHERE email = %s", (email,))` | `cursor.execute(f"SELECT * FROM users WHERE email = '{email}'")` |
| Python (PyMySQL) | `cursor.execute("SELECT * FROM users WHERE email = %(email)s", {"email": email})` | `cursor.execute("SELECT * FROM users WHERE email = '%s'" % email)` |
| JavaScript (mysql2) | `connection.execute("SELECT * FROM users WHERE email = ?", [email])` | `` connection.execute(`SELECT * FROM users WHERE email = '${email}'`) `` |
| JavaScript (pg) | `pool.query("SELECT * FROM users WHERE email = $1 AND status = $2", [email, status])` | `pool.query("SELECT * FROM users WHERE email = '" + email + "'")` |
| Java (JDBC) | `PreparedStatement stmt = conn.prepareStatement("SELECT * FROM users WHERE email = ?"); stmt.setString(1, email);` | `Statement stmt = conn.createStatement(); stmt.executeQuery("SELECT * FROM users WHERE email = '" + email + "'")` |

### 2.3 动态表名/列名处理（白名单校验）

当确实需要动态表名/列名时（如排序字段），必须使用白名单：

```python
ALLOWED_COLUMNS = {"id", "username", "email", "created_at"}
ALLOWED_DIRECTIONS = {"ASC", "DESC"}

def safe_order_by(column: str, direction: str = "ASC") -> str:
    if column not in ALLOWED_COLUMNS:
        raise ValueError(f"非法的排序列: {column}")
    if direction.upper() not in ALLOWED_DIRECTIONS:
        raise ValueError(f"非法的排序方向: {direction}")
    return f'"{column}" {direction.upper()}'
```

---

## 3. 敏感信息检测规则

### 3.1 检测正则表

| 类别 | 正则表达式 | 风险 |
|------|-----------|------|
| AWS Access Key ID | `AKIA[0-9A-Z]{16}` | 严重 |
| AWS Secret Key | `(?i)aws(.{0,20})?(secret|key).{0,20}['\"']?[0-9a-zA-Z\/+]{40}['\"']?` | 严重 |
| GitHub PAT | `ghp_[0-9a-zA-Z]{36}` | 严重 |
| GitHub OAuth | `gho_[0-9a-zA-Z]{36}` | 严重 |
| GitHub App Token | `ghu_[0-9a-zA-Z]{36}` | 严重 |
| Slack Token | `xox[baprs]-[0-9a-zA-Z\-]{10,}` | 高 |
| JWT Token | `eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}` | 高 |
| 私钥头(全类型) | `-----BEGIN\s(RSA|DSA|EC|OPENSSH|PGP).*PRIVATE\s(KEY|KEY\sBLOCK)-----` | 严重 |
| Google API Key | `AIza[0-9A-Za-z\-_]{35}` | 高 |
| Stripe Live Key | `sk_live_[0-9a-zA-Z]{24}` | 严重 |
| Stripe Test Key | `sk_test_[0-9a-zA-Z]{24}` | 中 |
| 密码/密钥键值对 | `(?i)(password|passwd|pwd|secret|token)\s*[:=]\s*['\"][^'\""]{4,}['\"]` | 高 |
| 连接字符串(含密码) | `(?i)(mongodb|mysql|postgresql|redis)://[^:]+:[^@]+@` | 严重 |
| 硬编码 API Key | `(?i)(api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*['\"][A-Za-z0-9\-_]{16,}['\"]` | 高 |

### 3.2 熵检测规则

高熵字符串通常是密钥/令牌的强信号。对长度 > 20 的字符串计算 Shannon 熵 `H(X) = -Σ p(x_i) * log₂(p(x_i))`：

- **熵 > 4.5**：高风险（疑似密钥/令牌）
- **熵 3.5 ~ 4.5**：需人工审查
- **熵 < 3.5**：低风险，忽略

```python
import math
from collections import Counter

def shannon_entropy(data: str) -> float:
    if not data:
        return 0.0
    n = len(data)
    freq = Counter(data)
    return -sum((c / n) * math.log2(c / n) for c in freq.values())

def classify_entropy(data: str) -> str:
    if len(data) < 20:
        return "忽略（长度不足）"
    e = shannon_entropy(data)
    if e > 4.5:
        return "高风险（疑似密钥/令牌）"
    if e > 3.5:
        return "需人工审查"
    return "低风险"
```

### 3.3 全局扫描命令

```bash
grep -rEn \
  -e 'AKIA[0-9A-Z]{16}' -e 'ghp_[0-9a-zA-Z]{36}' \
  -e '-----BEGIN.*PRIVATE KEY-----' -e 'sk_live_[0-9a-zA-Z]{24}' \
  -e '(?i)(password|passwd|pwd|secret|token)\s*[:=]\s*['\''"]['\'"]' \
  --exclude-dir={node_modules,.git,venv,__pycache__,dist,build,target} .
```

---

## 4. 依赖审查清单

### 4.1 npm 与 pip 验证步骤对照

| 步骤 | npm | pip |
|------|-----|-----|
| 防误植攻击 | 访问 npmjs.com 核对包名拼写 | 访问 pypi.org 核对包名拼写 |
| 下载量/流行度 | `npm view {pkg} downloads` | PyPI 页面 "Statistics" 栏 |
| 最后维护时间 | `npm view {pkg} time --json` | `pip index versions {pkg}` 或 Release history |
| 审查维护者 | `npm view {pkg} maintainers` | 检查 GitHub/GitLab 主页 |
| 已知漏洞 | `npm audit --production` | `pip-audit` 或 `safety check` |
| 许可证 | `npx license-checker --summary` | `pip show {pkg}` → License |
| 安装脚本审查 | 检查 preinstall/postinstall 脚本 | 审查 setup.py 是否含 exec/eval/subprocess |
| 版本锁定 | 提交 package-lock.json | 精确版本 requirements.txt 或 Pipfile.lock |
| 完整性校验 | npm 自动校验 shasum | `pip hash {pkg}` → 写入 requirements.txt |
| 依赖树 | `npm ls {pkg}` | `pipdeptree` 或 `pip show {pkg}` |

### 4.2 危险信号（任一命中则拒绝引入）

- 包名与知名包仅差 1-2 个字符（如 `requsts` vs `requests`）
- 周下载量 < 100 且维护者为单人
- 超过 365 天未更新
- `setup.py` 或 `preinstall`/`postinstall` 脚本包含网络请求或文件写入
- GitHub 仓库无 Star、无 Issue、无 README
- 许可证为 "UNKNOWN" 或缺少 LICENSE 文件

---

## 5. 输入净化规则

### 5.1 通用处理流程

```
输入 → 编码检测 → 规范化(Unicode NFC) → 长度限制 → 类型校验 → 格式校验 → 特殊字符转义 → 业务处理
```

### 5.2 上下文转义对照表

| 输出上下文 | Python 转义函数 | 说明 |
|------------|----------------|------|
| HTML 文本/属性 | `html.escape(s, quote=True)` | 防止 XSS，属性加引号包裹 |
| XML 内容 | `xml.sax.saxutils.escape(s)` + 标签包裹 | 见 §5.3 |
| URL 参数 | `urllib.parse.quote(s, safe='')` | 防止 URL 注入 |
| Shell 参数 | `shlex.quote(s)` | 防止命令注入 |
| SQL 值 | 参数化查询（占位符） | 绝不用转义替代参数化 |
| JSON 值 | `json.dumps(s)` | 自动转义 |
| CSV 字段 | `csv.writer` + `quoting=csv.QUOTE_ALL` | 防止公式注入 |
| 正则表达式 | `re.escape(s)` | 防止 ReDoS |
| LDAP 查询 | 自定义转义 `*()\&` 等特殊字符 | 防止 LDAP 注入 |

### 5.3 XML 标签包裹

```python
import xml.sax.saxutils as saxutils

def xml_sanitize(user_input: str, tag_name: str) -> str:
    if not tag_name.isidentifier():
        raise ValueError(f"非法的标签名: {tag_name}")
    safe = saxutils.escape(user_input, {'"': '&quot;', "'": '&apos;'})
    return f"<{tag_name}>{safe}</{tag_name}>"
```

### 5.4 HTML 特殊字符转义表

| 字符 | 实体 | 十进制 | 十六进制 |
|------|------|--------|---------|
| `&` | `&amp;` | `&#38;` | `&#x26;` |
| `<` | `&lt;` | `&#60;` | `&#x3C;` |
| `>` | `&gt;` | `&#62;` | `&#x3E;` |
| `"` | `&quot;` | `&#34;` | `&#x22;` |
| `'` | `&apos;` | `&#39;` | `&#x27;` |
| `/` | `&#x2F;` | `&#47;` | `&#x2F;` |
| `` ` `` | `&#96;` | `&#96;` | `&#x60;` |
| `=` | `&#61;` | `&#61;` | `&#x3D;` |

### 5.5 文件路径净化（防目录遍历）

```python
import os

def sanitize_path(user_input: str, base_dir: str) -> str:
    cleaned = user_input.replace('\x00', '').lstrip('/\\')
    full_path = os.path.realpath(os.path.join(base_dir, cleaned))
    if not full_path.startswith(os.path.realpath(base_dir) + os.sep):
        raise ValueError("路径遍历攻击被阻止")
    return full_path
```

---

## 6. 代码执行前确认模板

当 AI 生成的代码包含 `subprocess.run()`、`os.exec*`、`multiprocessing` 等外部进程调用时，执行前触发此确认：

```
============================================================
  OmniPM 安全检查门禁 —— 代码执行前确认
============================================================
风险等级：{高/中/低}
操作描述：{对即将执行的操作的简要说明}
涉及函数：{函数名列表}
待执行命令：{命令原文}

风险分析：
  - 是否涉及网络访问：{是/否}
  - 是否涉及文件系统写入：{是/否}
  - 是否涉及系统配置变更：{是/否}
  - 是否需要管理员权限：{是/否}
  - 输入是否来自用户：{是/否}
  - 是否经过输入净化(§5)：{是/否/不适用}

安全检查清单：
  [ ] 命令参数已拆分为列表（shell=False）
  [ ] 无用户输入直接拼接到命令中
  [ ] 工作目录已确认安全 / 环境变量已最小化
  [ ] 超时限制已设置 / 错误处理已包含

============================================================
  请输入 "确认" 以继续执行，或 "拒绝" 以取消。
============================================================
```

审计日志格式：

```
[2026-01-01 12:00:00] CONFIRMED user=admin action=subprocess_run cmd=["git","status"] risk=低 hash=a1b2c3
[2026-01-01 12:05:00] REJECTED  user=admin action=os_system    cmd="rm -rf /tmp/*"     risk=高 hash=d4e5f6
```

---

## 7. 门禁集成点

| 集成阶段 | 门禁行为 | 对应主提示词引用 |
|----------|---------|----------------|
| 代码生成 | 禁止生成包含 §1 危险函数的代码 | §2.3 |
| 文件保存前 | 扫描敏感信息（§3），命中则阻断保存 | §9.1 |
| 代码审查时 | 检查 SQL 拼接（§2），标记为阻断性缺陷 | §9.1 |
| 依赖引入 | 审查清单（§4）全部通过才允许写入配置文件 | §9.1 |
| 代码执行前 | 触发确认模板（§6），高风险操作必须人工确认 | §9.1 |

---

## 8. 门禁输出格式（统一 JSON）

```json
{
  "gate": "OmniPM-security-gate",
  "timestamp": "2026-01-01T12:00:00Z",
  "status": "PASSED | BLOCKED | WARNING",
  "findings": [
    {
      "severity": "CRITICAL | HIGH | MEDIUM | LOW",
      "rule": "RULE-001",
      "category": "dangerous_function | sql_injection | secret_leak | input_taint | dependency_risk",
      "file": "src/main.py",
      "line": 42,
      "match": "exec(user_input)",
      "message": "禁止使用 exec()。请改用 subprocess.run(shell=False)。",
      "remediation": "将 exec(user_input) 替换为 subprocess.run(shlex.split(user_input), shell=False)"
    }
  ],
  "summary": { "total": 0, "critical": 0, "high": 0, "medium": 0, "low": 0 }
}
```

---

## 9. PI 命令注入防护

### 9.1 核心原则

PI（Prompt-Injection）环境中，`!` 前缀命令在 Agent-Shell 桥接层被转发执行。**用户输入在进入 `!` 命令前必须经过白名单校验**，禁止在 `!` 命令字符串中直接拼接未净化的用户输入。

### 9.2 禁止模式

| 序号 | 危险模式 | 风险类别 | 安全替代方案 | 说明 |
|------|---------|---------|-------------|------|
| 1 | `!echo {user_input}` | 命令注入 | 先对 `user_input` 做白名单/正则校验，通过后才拼入命令 | 用户输入可能包含 `$(...)` 或 `` `...` `` 命令替换 |
| 2 | `!git commit -m "{user_input}"` | Shell 元字符注入 | 将用户输入写入临时文件后使用 `git commit -F <file>` | 防止 `"` 闭合后追加 `&& rm -rf /` |
| 3 | `!npm run {user_input}` | 任意脚本执行 | 白名单限制可执行的 script 名称，不允许自定义参数 | 防止执行 `package.json` 中未定义的任意命令 |
| 4 | `!docker run {user_input}` | 容器逃逸风险 | 固定镜像名和参数列表，用户输入仅限白名单内的标签值 | 防止挂载宿主机目录或提权参数 |
| 5 | `!curl {user_input}` | SSRF / 数据泄露 | 白名单限制目标域名/IP 范围，禁止原始 URL 传入 | 防止内网探测或数据外传 |

### 9.3 白名单校验模板

```python
import re

ALLOWED_PATTERNS = {
    "filename": re.compile(r'^[a-zA-Z0-9_\-.]+$'),        # 仅允许合法文件名
    "commit_msg": re.compile(r'^[a-zA-Z0-9 .,;:!?\-]{1,200}$'),  # 限制提交信息字符集和长度
    "tag": re.compile(r'^[a-z0-9][a-z0-9.\-]{0,127}$'),   # Docker/容器标签格式
    "url": re.compile(r'^https://trusted-domain\.com/[\w\-./]+$'),  # 固定域名的白名单 URL
}

def validate_user_input(value: str, pattern_key: str) -> str:
    """对用户输入执行白名单校验，不通过则拒绝并记录。"""
    pattern = ALLOWED_PATTERNS.get(pattern_key)
    if pattern is None:
        raise ValueError(f"未知的校验模式: {pattern_key}")
    if not pattern.fullmatch(value):
        raise ValueError(f"输入 '{value}' 未通过白名单校验（模式: {pattern_key}）")
    return value
```

### 9.4 审计日志

所有 `!` 命令执行前必须记录审计日志，格式如下：

```
[2026-01-01 12:00:00] PI_CMD user=admin pattern=filename input="report.txt" result=PASS
[2026-01-01 12:01:00] PI_CMD user=admin pattern=commit_msg input="fix: $(whoami)" result=BLOCKED reason="含命令替换字符"
```

---

## 附录A：常见绕过手法与对策

| 绕过手法 | 示例 | 检测对策 |
|----------|-----|---------|
| 字符串拼接隐藏函数名 | `getattr(__builtins__, 'e'+'x'+'e'+'c')` | 跟踪 `getattr` + `__builtins__` 组合 |
| base64 编码隐藏 | `exec(base64.b64decode(...))` | 检测 `base64.decode` + `exec` 组合 |
| 字符串反转 | `exec(code[::-1])` | 依赖语义分析/SAST 工具 |
| 反射调用 | `method.invoke(obj, args)` | Java/.NET 需专项检测 |
| 混淆导入 | `__builtins__.__dict__['__import__']` | 检测 `__builtins__.__dict__` 访问 |

> **注意**：本门禁模块不保证100%覆盖率。强烈建议结合 SAST 工具（Bandit、Semgrep、CodeQL）深度扫描。


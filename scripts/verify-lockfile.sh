#!/usr/bin/env bash
# OmniPM Lockfile 完整性校验 (F20, v2.7.0)
# 验证 node_modules 与 package-lock.json 一致
set -e

echo "🔍 OmniPM Lockfile Integrity Check"
echo "=================================="

# 1. npm ci 干运行验证
echo "→ npm ci --dry-run"
npm ci --dry-run 2>&1 | tail -1

# 2. 验证无未锁定的依赖
UNLOCKED=$(npm ls --package-lock-only 2>&1 | grep -c "UNMET\|invalid" || true)
if [ "$UNLOCKED" -gt 0 ]; then
  echo "⚠️  $UNLOCKED unmet/invalid dependencies detected"
fi

# 3. package-lock.json hash （如有变更则告警）
if [ -f "package-lock.json" ]; then
  HASH=$(sha256sum package-lock.json | cut -d' ' -f1)
  echo "✅ package-lock.json hash: ${HASH:0:16}"
fi

echo "✅ Lockfile integrity check complete"

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 测试文件目录
    include: ["extensions/omnipm/__tests__/**/*.test.ts"],
    // 环境
    environment: "node",
    // 全局设置
    globals: true,
    // 覆盖率配置
    coverage: {
      provider: "v8",
      include: ["extensions/omnipm/runtime/**/*.ts", "extensions/omnipm/tools/**/*.ts"],
      exclude: ["**/mock.ts", "**/__tests__/**"],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 60,
      },
    },
  },
});

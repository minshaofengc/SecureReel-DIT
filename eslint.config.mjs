import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // build/ 里是打包资源与应用图标生成脚本（一次性工具，非应用源码）
  // `**/._*` = macOS 在外置盘（exFAT）生成的 AppleDouble 伴随文件。eslint 不读 .gitignore，
  //            不显式排除的话，任何编辑都会重新生成 `._` 文件并把 lint（进而 verify 门禁）弄红。
  //
  // `electron.vite.config.*.mjs` = electron-vite 构建时在项目根写的**临时配置**
  // （名字里带毫秒时间戳），正常情况它自己删掉。本机上它经常删不掉（删除被
  // 安全代理拦下），于是每构建一次就多一个，下一次 lint 直接红 ——
  // 报的是 `'process' is not defined`，看起来像源码写错了，实际是个垃圾文件。
  // 它不在源码树里，也不该被 lint，显式排掉。
  {
    ignores: [
      'out/**',
      'dist/**',
      'release/**',
      'node_modules/**',
      '*.config.js',
      'electron.vite.config.*.mjs',
      'build/**',
      '**/._*'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node }
    },
    rules: {
      // 生产代码禁止 console.log —— 统一走结构化 logger
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' }
  }
)

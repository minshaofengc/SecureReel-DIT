import js from '@eslint/js';
import globals from 'globals';
import hooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  {ignores:['node_modules/**','android/**','ios/**','**/._*','*.config.js','.eslintrc.js']},
  js.configs.recommended,...tseslint.configs.recommended,
  {files:['**/*.ts','**/*.tsx'],languageOptions:{globals:{...globals.es2023,...globals.jest},parserOptions:{ecmaFeatures:{jsx:true}}},plugins:{'react-hooks':hooks},rules:{...hooks.configs.recommended.rules,'no-console':['error',{allow:['warn','error']}]}},
  {files:['*.mjs','*.js'],languageOptions:{globals:globals.node}},
);

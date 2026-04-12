<script setup lang="ts">
</script>

<template>
  <RouterView />
</template>

<style>
/* Element Plus 主题变量 - GitHub 风格 */
:root {
  /* 主色 */
  --el-color-primary: #0969da;
  --el-color-primary-light-3: #218bff;
  --el-color-primary-light-5: #58a6ff;
  --el-color-primary-light-7: #8bc4ff;
  --el-color-primary-light-8: #b3daff;
  --el-color-primary-light-9: #d9ebff;
  --el-color-primary-dark-2: #0550ae;

  /* 成功 */
  --el-color-success: #1a7f37;
  --el-color-success-light-3: #3fb950;
  --el-color-success-light-5: #56d364;
  --el-color-success-light-7: #8bc4ff;
  --el-color-success-light-8: #b3daff;
  --el-color-success-light-9: #d9ebff;
  --el-color-success-dark-2: #116329;

  /* 警告 */
  --el-color-warning: #9a6700;
  --el-color-warning-light-3: #d29922;
  --el-color-warning-light-5: #e3b341;
  --el-color-warning-light-7: #f0ce72;
  --el-color-warning-light-8: #f5d99a;
  --el-color-warning-light-9: #faf4c8;
  --el-color-warning-dark-2: #7d4e00;

  /* 危险 */
  --el-color-danger: #cf222e;
  --el-color-danger-light-3: #f85149;
  --el-color-danger-light-5: #ff8182;
  --el-color-danger-light-7: #ffb1b1;
  --el-color-danger-light-8: #ffc9c9;
  --el-color-danger-light-9: #ffe3e3;
  --el-color-danger-dark-2: #a40e26;


  /* 信息 */
  --el-color-info: #57606a;
  --el-color-info-light-3: #8c959f;
  --el-color-info-light-5: #b1bac4;
  --el-color-info-light-7: #d0d7de;
  --el-color-info-light-8: #d8dee4;
  --el-color-info-light-9: #e9ebef;
  --el-color-info-dark-2: #424a53;

  /* 边框 */
  --el-border-color: #d1d5da;
  --el-border-color-light: #e1e4e8;
  --el-border-color-lighter: #eee;

  /* 填充 */
  --el-fill-color: #f6f8fa;
  --el-fill-color-light: #fafbfc;
  --el-fill-color-lighter: #fafbfc;
  --el-fill-color-blank: #ffffff;


  /* 文字 */
  --el-text-color-primary: #24292e;
  --el-text-color-regular: #57606a;
  --el-text-color-secondary: #8c959f;
  --el-text-color-placeholder: #8c959f;


  /* 背景 */
  --el-bg-color: #ffffff;
  --el-bg-color-page: #f6f8fa;
  --el-bg-color-overlay: #ffffff;


  /* 圆角 */
  --el-border-radius-base: 6px;
  --el-border-radius-small: 4px;
  --el-border-radius-large: 8px;
  --el-border-radius-round: 20px;


  /* 阴影 */
  --el-box-shadow: 0 1px 3px rgba(31, 35, 40, 0.12);
  --el-box-shadow-light: 0 1px 2px rgba(31, 35, 40, 0.08);
}

/* CSS Variables - GitHub Style */
:root {
  --color-primary: #24292e;
  --color-border: #d1d5da;
  --color-accent-blue: #0969da;
  --color-accent-blue-subtle: #ddf4ff;
  --color-accent-green: #1a7f37;
  --color-accent-green-subtle: #dafbe1;
  --color-accent-red: #cf222e;
  --color-accent-red-subtle: #ffebe9;
  --color-accent-yellow: #9a6700;
  --color-accent-yellow-subtle: #fff8c5;
  --color-accent-orange: #bc4c00;
  --color-accent-orange-subtle: #fff1e5;
  --color-bg: #ffffff;
  --color-bg-subtle: #f6f8fa;
  --color-text: #24292e;
  --color-text-secondary: #57606a;
  --radius: 6px;
}


* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: var(--color-text);
  background: var(--color-bg);
}
</style>

import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'JSON Forge',
    description: '在浏览器本地格式化、压缩、搜索和比较 JSON。',
    action: { default_title: '打开 JSON Forge' },
  },
});

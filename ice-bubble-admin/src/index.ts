/**
 * ice-bubble Admin API
 * ice-bubble 管理后台 API 服务入口
 */
import { startAdmin } from './bootstrap.js';

startAdmin().catch((error) => {
    console.error('Failed to start admin', { error });
    process.exit(1);
});

// functions/icon.js
// 站点图标代理端点：/icon?url=<domain>
// 首屏图标统一走这里，同源连接复用 + 长缓存，不再直连第三方 favicon 服务。
import { handleIconRequest } from './lib/icon-proxy';

export const onRequest = ({ request }) => handleIconRequest(request);

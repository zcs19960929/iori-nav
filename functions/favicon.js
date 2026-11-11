// functions/favicon.js
// /favicon 是早期 ICON_API 的写法。项目里一直没有对应路由，请求会落到静态资源
// 兜底并返回未渲染的 index.html 模板（200 + 一堆 {{SITE_NAME}} 占位符），
// 配成图标地址时就是一张坏图。这里补上真正的路由，复用 /icon 的实现。
import { handleIconRequest } from './lib/icon-proxy';

export const onRequest = ({ request }) => handleIconRequest(request);

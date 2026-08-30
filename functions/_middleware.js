// 维护模式中间件（推荐方案，替代 _worker.js）
// 与 functions/gitalk-proxy.js 共存，不会禁用 Functions 目录。
// 在 Cloudflare 后台设置环境变量 MAINTENANCE_MODE=true 即进入维护模式，
// 所有请求（含静态资源与 /gitalk-proxy）返回 503；未设置或为 false 时正常放行。
export async function onRequest(context) {
  if (context.env.MAINTENANCE_MODE === 'true') {
    return new Response('网站维护中，请稍后再访问。', { status: 503 });
  }
  return context.next();
}

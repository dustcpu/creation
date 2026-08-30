// Gitalk OAuth 代理 —— Cloudflare Pages Function
// 部署后路由：https://YOUR_DOMAIN/gitalk-proxy
// 作用：
//   1. 绕过 GitHub OAuth access_token 接口的 CORS 限制
//   2. 在服务端持有 clientSecret，前端不再暴露该密钥

const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

// 处理 CORS 预检（OPTIONS）
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// 处理 Gitalk 的 access_token 请求（POST）
export async function onRequestPost(context) {
  try {
    const body = await context.request.json();

    // client_secret 固定用服务端值，忽略前端可能传入的内容
    const params = new URLSearchParams({
      code: body.code || '',
      client_id: body.client_id || '',
      client_secret: GITHUB_CLIENT_SECRET,
    });

    const githubRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });

    const data = await githubRes.json();

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err && err.message) }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
}

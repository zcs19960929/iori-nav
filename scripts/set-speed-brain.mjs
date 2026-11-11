// scripts/set-speed-brain.mjs
//
// 开关 Cloudflare Speed Brain（Speed > Settings > Content Optimization）。
//
// 为什么这个项目一定要关掉它：
//   Speed Brain 会在 HTML 响应上加 `speculation-rules: /cdn-cgi/speculation`，
//   浏览器每次导航都要额外拉一次这个不缓存的规则文件（跨境链路上实测 3~20s）。
//   而官方限制写明「预取不会作用于经过 Worker 的路由」，本站全部路由都在 Worker
//   里渲染 —— 也就是说预取永远成功不了，只剩这条纯开销的请求。
//
// 用法：
//   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ZONE_ID=yyy node scripts/set-speed-brain.mjs off
//   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ZONE_ID=yyy node scripts/set-speed-brain.mjs on
//
// API Token 需要 Zone Settings Write（或 Zone Settings Edit）权限。

const API_BASE = 'https://api.cloudflare.com/client/v4';

function readConfig() {
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID || process.env.CF_ZONE_ID;
  const target = (process.argv[2] || 'off').toLowerCase();

  if (!token || !zoneId) {
    console.error('缺少环境变量：需要 CLOUDFLARE_API_TOKEN 与 CLOUDFLARE_ZONE_ID');
    process.exit(1);
  }
  if (target !== 'on' && target !== 'off') {
    console.error(`参数只能是 on 或 off，收到：${target}`);
    process.exit(1);
  }

  return { token, zoneId, target };
}

async function callApi(token, path, init = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const detail = (payload.errors || []).map(e => `${e.code} ${e.message}`).join('; ');
    throw new Error(`Cloudflare API ${response.status}: ${detail || 'unknown error'}`);
  }
  return payload;
}

async function main() {
  const { token, zoneId, target } = readConfig();
  const path = `/zones/${zoneId}/settings/speed_brain`;

  const updated = await callApi(token, path, {
    method: 'PATCH',
    body: JSON.stringify({ value: target }),
  });
  console.log(`已提交 speed_brain=${target}，当前值：${updated.result?.value ?? 'unknown'}`);

  const current = await callApi(token, path);
  const value = current.result?.value;
  console.log(`回读确认：speed_brain=${value}`);

  if (value !== target) {
    console.error('回读值与应用值不一致，请到 Dashboard 手动确认（Speed > Settings > Content Optimization）。');
    process.exit(2);
  }

  if (target === 'off') {
    console.log('生效后可用以下命令确认响应头已消失：');
    console.log('  curl -sI https://你的域名/ | grep -i speculation || echo "已无 speculation-rules 头"');
  }
}

main().catch(e => {
  console.error(`失败：${e.message}`);
  process.exit(1);
});

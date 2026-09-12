# 几何岛屿 · Geometric Islands v1.3.0

纪念碑谷风格的单页个人博客：海洋 Canvas 背景 + 漂流几何体 + 漂流瓶 + 想法流（Markdown / 搜索）+ 相册（灯箱）+ 底部评论区（Gitalk）。

本目录是**去除原作者隐私信息**后的开源/分享版本，你可以直接拿去部署成自己的博客。

---

## 更新日志

### v1.3.0（2026-09-09）

**新增**
- 想法流：Markdown 渲染（GFM）、实时搜索、登录后编辑帖子
- 相册灯箱：左右切换按钮 + 键盘 ← →
- 回到顶部按钮、加载状态 spinner、超大图上传预警
- favicon（内联 SVG，无额外文件）
- 漂流几何体数量随屏幕宽度自适应（6~14 个）
- 一个隐藏彩蛋

**优化**
- 9 处系统弹窗改为浮动 toast
- 四季主题秒切，昼夜保持 1s 平滑过渡
- 水面线与主渲染循环的 GC 优化
- 漂流几何体碰撞检测补全 Y 方向
- GitHub API 请求改为分批并发

**修复与适配**
- 无痕模式下整站白屏（本地存储读取容错）
- 移动端岛屿跑出屏幕、碰撞盒随缩放错位
- 无效 URL hash 导致白屏
- 适配 `prefers-reduced-motion`、切后台自动暂停动画

---

## 一、文件结构

```
index.html            页面骨架（含 Hero SVG、想法流、相册、底部 Gitalk 评论区）
style.css             全站样式（昼夜 × 四季主题变量）
app.js                前端逻辑（海洋、漂流瓶、想法流、相册、鼠标轨迹粒子、点击粒子彩蛋、GitHub Issues 数据层）
functions/
  gitalk-proxy.js     GitHub OAuth 代理（服务端持有 clientSecret）
  _middleware.js      维护中间件（MAINTENANCE_MODE=true 时全站 503）
_headers              Cloudflare Pages 缓存/路由配置
_routes.json          Pages 路由排除配置
```

---

## 二、功能特性

**视觉与主题**
- 昼夜 × 四季共 5 套主题配色，左侧面板悬停展开切换；四季秒切、昼夜 1s 平滑过渡
- 海洋 Canvas 背景 + 漂流几何体，数量随屏幕宽度自适应（6~14 个）
- 鼠标轨迹粒子：春（花瓣）/ 夏（蒲公英）/ 秋（落叶）/ 冬（细雪）/ 夜（星尘），随主题自动切换
- 已适配 `prefers-reduced-motion`：系统开启「减弱动态效果」时自动停掉装饰动画与粒子生成

**内容**
- 想法流：Markdown 渲染（GFM + 换行即换行）、实时搜索（150ms 防抖）、登录后可直接编辑帖子
- 相册：灯箱大图查看，支持左右按钮与键盘 ← → 切换
- 评论区：底部 Gitalk 为全站级；想法流每篇帖子另有独立评论区
- 漂流瓶：在海洋空白处悬停会浮出几何体；悬停漂流几何体 0.8s 会浮起并冒出一条真实评论

**交互细节**
- 错误提示全部改为右下角浮动 toast（删除确认保留原生 `confirm`，需要用户明确选择）
- 加载时显示旋转圆环 spinner；回到顶部按钮滚动半屏后淡入
- 上传图片超过 10MB 时提前预警，避免超大原图压缩卡顿
- 无效的 URL hash 自动回退到首页，不会白屏

> 站里还藏了一个彩蛋，留给你自己发现。

---

## 三、部署前必须替换的占位符

代码里用以下占位符代替了原作者的私人信息，请全部改成你自己的：

| 占位符 | 含义 | 出现在 |
|---|---|---|
| `YOUR_GITHUB_USERNAME` | 你的 GitHub 用户名 | `index.html`、`app.js` 的 CONFIG |
| `YOUR_REPO_NAME` | 存放博客数据的仓库名（用来当数据库） | `index.html`、`app.js` 的 CONFIG |
| `YOUR_GITHUB_CLIENT_ID` | 你的 GitHub OAuth App 的 Client ID | `index.html`、`app.js` 的 CONFIG |
| `YOUR_DOMAIN` | 你的站点域名（含末尾斜杠） | `app.js` 的 redirectURI、`index.html` 的 proxy |
| `你的名字` | 博客展示用昵称 | `index.html` 的 Hero 与页脚 |

> 相册图片地址由 `CONFIG.owner/repo/branch` 拼接，替换后会自动指向你的仓库，无需单独改。

---

## 四、快速部署（Cloudflare Pages）

1. 在 GitHub 新建一个**公开**仓库（相册依赖 jsDelivr CDN，需公开；见下方限制），用于存放博客数据（Issues 当数据库）。
2. 在 GitHub 创建一个 **OAuth App**：
   - Authorization callback URL 填 `https://YOUR_DOMAIN/`（必须与 `app.js` 的 `redirectURI` 完全一致）。
   - 记下 Client ID。
3. 在 Cloudflare Pages 新建项目，关联该仓库，构建命令留空、输出目录设为仓库根目录。
4. **设置环境变量**：`GITHUB_CLIENT_SECRET = 你的 OAuth App 的 Client Secret`（在 Pages 项目 Settings → Environment variables 里配，**不要写进代码**）。
5. 部署后，底部评论区、想法流、相册会自动读写你的仓库 Issues / 图片。

---

## 五、功能限制与注意事项（重要）

- **评论/Gitalk 需自建服务**：登录依赖 `functions/gitalk-proxy.js` 这个服务端代理来交换 OAuth token。本地直接打开 `index.html` 无法登录评论，必须部署到 Cloudflare Pages（或自行改写成其他后端）。
- **相册需公开仓库**：相册图片走 `cdn.jsdelivr.net/gh/...`，jsDelivr 只支持公开仓库。若用私有仓库，照片会加载失败——要么改用公开仓库，要么把图片源换成其他 CDN/对象存储。
- **redirectURI / proxy 必须一致**：二者都指向 `YOUR_DOMAIN`，且 `redirectURI` 末尾斜杠不能丢，否则 GitHub OAuth 会因为 `redirect_uri` 不匹配而拒绝授权。
- **Markdown 渲染依赖两个 CDN 库**：想法流与评论的 Markdown 由 `marked.js`（解析为 HTML）+ `DOMPurify`（净化 HTML）共同处理，均走 jsDelivr CDN、放在 `</body>` 前不阻塞首屏。
  - **任一库加载失败，就会整体回退成「换行即换行」的纯文本渲染**。这是刻意为之：先解析后净化，中间任何一环缺失都宁可放弃排版，也绝不把未净化的 HTML 交给浏览器（评论对任何 GitHub 登录用户开放，属不可信输入）。页面不会报错，但标题、代码块、表格、引用等样式会失效。
  - 需要离线或内网部署时，把 `marked.min.js` 与 `purify.min.js` 下载到本地，改 `index.html` 里的两个 `src` 为相对路径即可。
- **本地预览**：直接双击 `index.html` 只能看静态页面与海洋动画；想法流/相册/评论需联网并配置好 GitHub 仓库后才生效。

---

## 六、隐私说明

本分享版已移除原作者的 GitHub 用户名、私有仓库名、OAuth Client ID、真实域名，以及博客昵称；原 `clientSecret` 已改为读取环境变量，源码中不再出现任何密钥明文。你可以放心分享。

---

## 七、致谢

- [BASpark](https://github.com/DoomVoss/BASpark) —— 本项目使用了该开源项目中的部分源码
  （站内点击粒子特效，即那个隐藏彩蛋，移植自这个「蔚蓝档案同款桌面动效工具」）。
  非常感谢原作者 DoomVoss 的创作与开源分享。

---

## 八、写在最后

作者的本职是搞硬件的，并不擅长前端开发，这个网站纯粹是出于兴趣做出来的。之所以是现在这个样子，是因为很喜欢《纪念碑谷》那类「理科生的浪漫」——用最简单的几何线条，搭一个安静又不太讲道理的世界。

网站至今仍有不少不足之处，很多开发工作由 AI 智能体代劳；作者更多扮演创意的提供者和审核者的角色，负责决定「它应该是什么样子」。

整个站里最大的创意，也许是背景那片等距多边形海洋，和「捞起漂流瓶、读到一条随机评论」这个交互——这是盯着海面发呆时自己想出来的点子。也谢谢身边人一直以来的支持。

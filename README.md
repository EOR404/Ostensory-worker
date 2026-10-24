# Ostensory Worker

一个可以独立部署在 Cloudflare Workers 上的轻量图床：

- 图片原文件写入 **R2**
- 图片信息写入 **D1**
- 上传页和图库由 Worker 直接提供
- 同一个 Worker 还可以作为 Ostensory-server 的远程存储后端

没有常驻服务器，个人小站在 Cloudflare 免费额度内通常可以零成本运行；实际额度以 Cloudflare 官网当前政策为准。

## 它长什么样

- `/`：图库和上传页
- `/i/<图片ID>`：公开图片地址
- `/api/health`：健康检查
- `/api/images`：图片列表
- `/api/upload`：管理员上传
- `/api/storage/*`：给 Ostensory-server 用的私有对象网关

上传页不需要登录即可浏览；上传和删除需要 `ADMIN_TOKEN`。`PUBLIC_UPLOAD=1` 可以开放匿名上传，但**不建议**在公开站点开启。

## 部署前准备

需要：

1. 一个 Cloudflare 账号
2. Node.js 20 或更新版本
3. 一个 R2 存储桶
4. 一个 D1 数据库

### 1. 创建 R2 存储桶

在 Cloudflare 控制台进入 **R2 Object Storage**，创建一个桶，例如：

```text
ostensory-images
```

保持桶为私有，不需要开启公开访问；图片由 Worker 读取后返回。

### 2. 创建 D1 数据库

进入 **Workers & Pages → D1**，创建一个数据库，例如：

```text
ostensory-worker
```

记下数据库 ID。

### 3. 修改配置

打开 `wrangler.toml`：

```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "ostensory-images"

[[d1_databases]]
binding = "DB"
database_name = "ostensory-worker"
database_id = "你的 D1 数据库 ID"
```

如果 R2 桶和 D1 名称不同，一起改掉。

### 4. 安装依赖并登录

```bash
cd worker
npm install
npx wrangler login
```

### 5. 初始化数据库

```bash
npm run db:init
```

本地开发可以先跑：

```bash
npm run db:init:local
```

### 6. 设置管理员 Token

生成一个足够长的随机字符串，例如：

```bash
openssl rand -hex 32
```

然后写入 Worker Secret，不要写进 `wrangler.toml` 或仓库：

```bash
npx wrangler secret put ADMIN_TOKEN
```

### 7. 部署

```bash
npm run deploy
```

部署完成后会得到一个 `*.workers.dev` 地址。打开首页，点“设置 Token”，填入刚才的 `ADMIN_TOKEN`，就可以上传了。

### 8. 绑定自己的域名（可选）

在 Cloudflare 控制台进入 Worker 的 **Settings → Domains & Routes**，添加自定义域名。建议开启 HTTPS，图片地址会使用同一个域名。

## 配置项

`wrangler.toml` 里的 `[vars]`：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MAX_UPLOAD_MB` | `20` | 图库单文件上限 |
| `MAX_STORAGE_MB` | `100` | `/api/storage/*` 单次对象上限；受 Workers 请求体限制，免费计划通常不要超过 100 MB |
| `PUBLIC_UPLOAD` | `0` | `1` 时允许匿名上传，删除仍需 Token |
| `CORS_ORIGIN` | 未设置 | 允许跨域的来源；不设置时为 `*`，仅影响 API |

`ADMIN_TOKEN` 必须通过 `wrangler secret put` 设置。

## 接入 Ostensory-server

在服务端后台进入 **存储**，新增“Cloudflare Worker”：

- 地址：你的 Worker 地址，例如 `https://ostensory-worker.example.workers.dev`
- Token：与 Worker 的 `ADMIN_TOKEN` 一致
- 路径前缀：例如 `ostensory`，避免和 Worker 自己图库的对象混在一起
- 容量上限、切换阈值、顺序按需要设置

服务端会通过下面这组接口读写对象：

```text
PUT    /api/storage/<key>
GET    /api/storage/<key>
HEAD   /api/storage/<key>
DELETE /api/storage/<key>
```

请求头使用：

```text
Authorization: Bearer <ADMIN_TOKEN>
```

这些对象不会出现在 Worker 自己的图库里，因为图库只读取 D1 中的 `images` 表；存储网关只读写 R2 的 `storage/` 前缀。

## 本地开发

```bash
npm install
npm run db:init:local
npx wrangler dev
```

把 `.dev.vars.example` 复制成 `.dev.vars`，该文件已被 `.gitignore` 排除：

```text
ADMIN_TOKEN=dev-token-change-me
```

然后访问 Wrangler 输出的本地地址。

## 目录

```text
worker/
├─ public/
│  ├─ index.html     图库和上传界面
│  ├─ app.js         上传、列表、复制、删除
│  └─ style.css
├─ src/
│  └─ index.js       Worker API、R2/D1 读写
├─ schema.sql        D1 表结构
├─ wrangler.toml     Cloudflare 配置
└─ package.json
```

## 安全与边界

- `ADMIN_TOKEN` 只放在 Worker Secret 和服务端存储配置里，不写进仓库、不发给浏览器以外的第三方。
- 浏览器里的 Token 只存 `sessionStorage`，关闭标签页后清除。
- R2 桶保持私有；公开图片通过 `/i/<id>` 读取。
- 公开图库会暴露图片地址和文件名；需要私密图片时不要使用这个 Worker 的公开图库，改用服务端的密码/地区限制。
- 当前 Worker 不生成缩略图，列表直接加载原图；大量高清图时建议后续加图片变换或缩略图任务。
- 免费额度、请求体大小和 R2 操作次数以 Cloudflare 当前官方文档为准。

## License

MIT
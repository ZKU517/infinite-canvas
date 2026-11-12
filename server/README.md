# Infinite Canvas 自建服务端

前端默认使用浏览器本地存储；接入本目录的服务端后，**账号、画布、素材、配置、提示词、日志全部存到服务器**，
浏览器只负责界面与 AI 接口直连（AI Key 仍在前端直接请求，不经过本服务）。

- 依赖：仅 Node 内置模块（`node:http`、`fs`、`crypto`），**无第三方依赖**，`node server.js` 即可运行。
- 端口：默认 `3081`。
- 前端：同一份 `web/` 产物（`web/dist`），由本服务托管静态资源。

## 目录结构

```
server/
├── server.js          # 多用户 + 会话 + KV/Blob 存储 + 写入版本锁 + 快照 + 静态托管
├── seed.js            # 可选：从旧 WebDAV 快照目录迁移数据
├── export-blobs.js    # 可选：把媒体 blob 导出为普通图片文件
├── recover-canvas.js  # 可选：把未被引用的图片重建为一个画布项目
├── docker-compose.yml
└── .env.example
```

服务端数据目录（挂载到容器 `/data`）：

```
data/
├── secret                     # 会话签名密钥（重启不失效，勿删）
├── snapshot-config.json       # 快照配置（enabled / intervalMinutes / keep）
├── snapshots/<name>/          # 快照（硬链接，未变化的图片不重复占空间）
├── users/<userId>.json        # 账号（scrypt 密码哈希 + admin 标记）
└── data/<userId>/
    ├── kv/<namespace>/<key>.json   # 配置 / 画布 / 资产 / 插件 / 日志 / 提示词
    └── blob/<namespace>/<key>      # 图片 / 视频 / 缩略图（+ .meta 记录 MIME）
```

## 快速开始（Docker）

```bash
# 1. 构建前端
cd web
npm ci
npm run build          # 产物在 web/dist

# 2. 启动服务端（在仓库根目录）
docker compose -f server/docker-compose.yml up -d
```

打开 `http://<服务器IP>:3081`，第一个注册的账号自动成为管理员。

## 直接运行（不使用 Docker）

```bash
cd server
PORT=3081 DATA_DIR=./data STATIC_DIR=../web/dist node server.js
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3081` | 监听端口 |
| `DATA_DIR` | `./data` | 数据目录（`users/`、`data/`、`snapshots/`、`secret`） |
| `STATIC_DIR` | `./dist` | 前端产物目录（需指向 `web/dist`） |
| `ALLOW_REGISTRATION` | `true` | 是否允许注册，设为 `false` 后只能由管理员创建账号 |
| `ADMIN_USERS` | 空 | 逗号分隔的用户名，额外指定为管理员；首个注册用户默认就是管理员 |
| `SESSION_TTL_DAYS` | `30` | 登录会话有效期（天） |
| `MAX_BLOB_BYTES` | `5368709120` | 单个 blob 上传上限（默认 5GB） |

## 数据保护（三层）

1. **写入版本锁**：`app_state` 的写入必须带 `If-Match: <ETag>`，版本不一致返回 `409`；
   前端收到后自动静默加载最新数据，避免"旧页面整份覆盖服务器数据"。
2. **空数据覆盖拦截**：用空状态覆盖 ≥2KB 的已有存储会被拒绝（`409 refuse_empty_overwrite`）。
3. **上一版备份**：每次覆盖前保留 `<key>.json.bak`，可用 `GET /api/kv/<ns>/<key>?backup=1` 取回。

此外有**定时快照**作为兜底，默认每 60 分钟一次、保留 24 份（硬链接实现，几乎不额外占用空间），
可在「配置 → 备份与快照」中调整间隔与保留份数、手动创建、一键恢复（恢复前会自动先备份当前数据）。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | 注册（`ALLOW_REGISTRATION=false` 时禁用） |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/auth/me` | 当前用户（含 `admin` 标记） |
| POST | `/api/auth/change-password` | 修改密码 |
| GET/PUT/DELETE | `/api/kv/<ns>/<key>` | JSON 数据（`app_state` 带版本锁） |
| GET/PUT/DELETE | `/api/blob/<ns>/<key>` | 二进制数据（图片/视频/缩略图） |
| GET | `/api/meta` | 当前用户数据是否已初始化 |
| GET/PUT | `/api/admin/snapshots/config` | 快照配置（仅管理员） |
| GET/POST | `/api/admin/snapshots` | 快照列表 / 立即创建（仅管理员） |
| POST | `/api/admin/snapshots/restore` | 恢复快照（仅管理员） |
| GET | `/healthz` | 健康检查 |

## 可选工具

```bash
# 从旧 WebDAV 备份目录迁移（SEED_SRC 指向包含 canvas/、assets/ 的目录）
DATA_DIR=/data SEED_SRC=/backup SEED_USER=admin SEED_PASSWORD=your-password node seed.js

# 把媒体 blob 导出为可直接浏览的图片文件
DATA_DIR=/data USER_ID=<userId> OUT_DIR=/out node export-blobs.js

# 把未被引用的图片重建为一个画布项目
DATA_DIR=/data USER_ID=<userId> node recover-canvas.js
```

## 安全提示

- 本服务默认按**局域网自建**设计：HTTP 明文传输，请勿直接暴露到公网；对外访问请放在 HTTPS 反向代理之后，
  或经 Tailscale / Cloudflare Tunnel 等加密通道。
- 生产使用务必修改初始密码，并按需关闭开放注册。
- `data/` 内含账号、AI Key 与全部创作数据，注意备份与访问权限。

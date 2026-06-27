# billAnalysisServer 生产部署

与 lims-uniapp-server 相同模式：**GitHub Actions 构建镜像 → ghcr.io → 服务器 pull + compose**。

## 服务器首次准备

在 `DEPLOY_PATH`（如 `/opt/bill-analysis-server`）放置：

- `docker-compose.prod.yml`
- `docker-compose.prod.hostnetwork.yml`（若 PostgreSQL 只监听 127.0.0.1）
- `deploy/remote-deploy.sh`（`chmod +x`）
- `.env`（参考仓库根目录 `.env.example`）

可从本仓库复制上述文件，或 `git clone` 后只保留部署所需文件。

### `.env` 示例

```env
PORT=4000
DATABASE_URL=postgresql://user:pass@host.docker.internal:5432/bill_analysis?schema=public
WX_APP_ID=你的AppId
WX_APP_SECRET=你的AppSecret
```

- 数据库在**宿主机**且用 bridge 网络：主机用 `host.docker.internal`，不要用 `localhost`。
- 数据库仅 `127.0.0.1` 监听：`.env` 用 `127.0.0.1`，部署时设置 `COMPOSE_UP_FILE=docker-compose.prod.hostnetwork.yml`。

### 拉取私有镜像

```bash
echo <GITHUB_PAT> | docker login ghcr.io -u <github用户名> --password-stdin
```

PAT 需 `read:packages` 权限。

## GitHub Actions 配置

**Variables**（Settings → Actions → Variables）：

| 名称 | 说明 |
|------|------|
| `DEPLOY_HOST` | 服务器1 SSH 主机 |
| `DEPLOY_USER` | 服务器1 SSH 用户 |
| `DEPLOY_PATH` | 服务器1 上的部署目录 |
| `DEPLOY_HOST_2` | 服务器2 SSH 主机（可选，留空则跳过服务器2） |
| `DEPLOY_USER_2` | 服务器2 SSH 用户（可选） |
| `DEPLOY_PATH_2` | 服务器2 上的部署目录（可选） |

未设置 `DEPLOY_HOST` 时只构建推送镜像，不 SSH 部署；未设置 `DEPLOY_HOST_2` 时仅部署服务器1。

**Secrets**：

| 名称 | 说明 |
|------|------|
| `DEPLOY_SSH_PASSWORD` | 服务器1 SSH 密码 |
| `DEPLOY_SSH_PASSWORD_2` | 服务器2 SSH 密码（可选） |

> 两台服务器的 `deploy-server-1` / `deploy-server-2` 两个 job **并行**执行（`needs: build-and-push`），互不阻塞；任意一台失败不影响另一台完成部署。

（旧版 `SSH_HOST` / `PROJECT_PATH` / `DATABASE_URL` 等已不再使用，请改用上表并在服务器 `.env` 中配置数据库与微信。）

## 手动部署

```bash
cd "$DEPLOY_PATH"
export DOCKER_IMAGE=ghcr.io/<owner>/bill-analysis-server:<tag>
bash deploy/remote-deploy.sh
```

## 与 lims 同机、同域名（xinde8888.com）

服务器上 **lims 已占用 `127.0.0.1:3000`**，billAnalysis 使用 **`127.0.0.1:4000`**（`docker-compose.prod.yml` 已绑定本机端口）。

### 路径分工（同一 `www.xinde8888.com`，按项目前缀区分）

| 对外路径 | 后端 | 说明 |
|----------|------|------|
| `/api/bill-analysis/*` | `:4000` | 账单解析（`API_PREFIX=api/bill-analysis`） |
| `/api/*`（其余，如 lims） | `:3000` | lims，`proxy_pass` 带尾部 `/` **去掉** `/api` |

账单接口示例：`POST /api/bill-analysis/auth/login`、`GET /api/bill-analysis/statements/history`  

lims 可后续改为 `/api/lims/*` 与账单对称；当前仍为 `/api` + 模块路径。

### 上传文件 URL（Nginx 静态）

| URL 前缀 | 宿主机目录 |
|----------|------------|
| `/uploads/lims/` | `/var/www/lim/lims-nest-server/public/uploads/` |
| `/uploads/bill-analysis/` | `$DEPLOY_PATH/uploads/`（如 `/opt/bill-analysis-server/uploads/`） |
| `/uploads/`（无项目名） | 兼容旧 lims 链接，仍指向 lims 目录 |

生产 compose 已使用 `./uploads` 绑定挂载，部署后请在 `DEPLOY_PATH` 下 `mkdir -p uploads`。

lims 新文件建议使用 `/uploads/lims/...`；账单若对外提供文件链接，使用 `/uploads/bill-analysis/...`。

### Nginx

在现有站点配置里，把 **bill 的 `location` 块放在 lims 的 `location /api/` 之前**（见仓库根目录 `lims` 示例文件）。修改后：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 部署目录建议

与 lims 分开，例如：

- lims：`/var/www/lim/...`（现有）
- bill：`/opt/bill-analysis-server`（`DEPLOY_PATH`，仅 compose + `.env` + `deploy/`）

### 小程序

`billAnalysisTaro` 的 `.env.production` 中：

```text
TARO_APP_API_BASE=https://www.xinde8888.com
```

小程序请求基址为 `https://www.xinde8888.com/api/bill-analysis`（由 `config/api.ts` 拼接 `API_PREFIX`）。

微信公众平台 → 开发管理 → 服务器域名：request 合法域名需包含 `https://www.xinde8888.com`（与 lims 相同，一般已配置）。

## 本地开发

```bash
cp .env.example .env
docker compose up -d --build
```

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
| `DEPLOY_HOST` | SSH 主机 |
| `DEPLOY_USER` | SSH 用户 |
| `DEPLOY_PATH` | 服务器上的部署目录 |

未设置 `DEPLOY_HOST` 时只构建推送镜像，不 SSH 部署。

**Secrets**：

| 名称 | 说明 |
|------|------|
| `DEPLOY_SSH_PASSWORD` | SSH 密码 |

（旧版 `SSH_HOST` / `PROJECT_PATH` / `DATABASE_URL` 等已不再使用，请改用上表并在服务器 `.env` 中配置数据库与微信。）

## 手动部署

```bash
cd "$DEPLOY_PATH"
export DOCKER_IMAGE=ghcr.io/<owner>/bill-analysis-server:<tag>
bash deploy/remote-deploy.sh
```

## 本地开发

```bash
cp .env.example .env
docker compose up -d --build
```

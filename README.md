# Fanren Sync

**本项目主要用于 SillyTavern 角色卡 《凡人修仙传》 云存档功能。**

`Fanren Sync` 是一个简单、安全、可自托管的 JSON 数据同步服务。

- **Python 版**: 基于 FastAPI 构建
- **Deno 版**: 基于 Deno + Deno KV 构建 (用于 Deno Deploy)


## ✨ 功能特性

**Python 版 (FastAPI)**
- **安全认证**: 所有 API 请求都需要通过 URL 路径中包含的密码进行验证。
- **简单易用**: 提供四个核心 API 端点 (`list`, `load`, `save`, `delete`)，轻松实现数据的增删改查。
- **轻量高效**: 使用 FastAPI 构建，性能卓越，资源占用少。
- **异步处理**: 基于 `aiofiles` 进行异步文件操作，高并发场景下表现更佳。
- **易于部署**: 支持常规部署、Docker 和 Docker Compose 多种部署方式。
- **安全设计**:
  - 过滤存档名称，有效防止路径遍历攻击。
  - 根目录访问限制，保护服务不被随意探测。

**Deno 版 (Deno Deploy)**
- 所有 Python 版的 API 功能，保持完全兼容
- 使用 Deno KV (Deno Database) 进行数据存储
- 零配置持久化，数据自动保存
- 原生支持 Deno Deploy 边缘部署
- 无需 Docker，直接部署

## ⚡ 一键部署

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/XQ9UAD)

[![Deploy on Deno Deploy](https://deno.com/deno-deploy-button.svg)](https://dash.deno.com/new)

Deno Deploy 部署说明：
1. Fork 本仓库
2. 在 [Deno Deploy](https://dash.deno.com/new) 中创建新项目
3. 选择你的仓库，入口文件设置为 `main.ts`
4. 在设置中添加环境变量 `SYNC_PASSWORD`

## 🚀 快速开始

---

### Python 版 (FastAPI)

#### 1. 环境准备

- Python 3.8+
- Git

#### 2. 安装

```bash
# 克隆项目
git clone https://github.com/foamcold/fanren-sync
cd fanren-sync

# 安装依赖
pip install -r requirements.txt
```

#### 3. 配置

我们提供了一个环境变量示例文件 `.env.example`。你需要将它复制一份，并重命名为 `.env`，然后修改里面的密码。

```bash
# 复制示例文件
cp .env.example .env
```

然后，编辑新建的 `.env` 文件，设置你的同步密码：

```env
# .env
SYNC_PASSWORD=your_password
```
**警告**: 请务必使用一个强大且随机的密码，不要使用默认密码。

#### 4. 运行 (开发环境)

```bash
python main.py
```
服务将以开发模式启动在 `http://localhost:8000`。

---

### Deno 版 (用于 Deno Deploy)

#### 1. 环境准备

- Deno 1.40+
- Git

#### 2. 运行 (开发环境)

```bash
# 克隆项目
git clone https://github.com/foamcold/fanren-sync
cd fanren-sync

# 设置密码并运行
export SYNC_PASSWORD=your_password
deno task start
```

或者使用开发模式（自动重载）：

```bash
export SYNC_PASSWORD=your_password
deno task dev
```

服务将启动在 `http://localhost:8000`。

#### 3. 部署到 Deno Deploy

1. Fork 本仓库
2. 访问 https://dash.deno.com/new
3. 选择你的仓库，设置入口文件为 `main.ts`
4. 在项目设置中添加环境变量 `SYNC_PASSWORD`
5. 点击 "Deploy"

Deno 版使用 Deno KV (Deno Database) 进行数据存储，无需额外配置持久化。

## 🐳 生产部署指南

### 方法二：使用 Docker

你可以直接使用我们发布在 Docker Hub 上的镜像来运行服务。

**AMD64 架构 (x86_64)**:
```bash
docker run -d \
  --name fanren-sync \
  -p 8000:8000 \
  -e SYNC_PASSWORD="your_password" \
  -v $(pwd)/data:/app/data \
  foamcold/fanren-sync:amd
```

**ARM64 架构 (Apple Silicon / Raspberry Pi)**:
```bash
docker run -d \
  --name fanren-sync \
  -p 8000:8000 \
  -e SYNC_PASSWORD="your_password" \
  -v $(pwd)/data:/app/data \
  foamcold/fanren-sync:arm
```

参数说明：
- `-d`: 后台运行
- `-p`: 端口映射
- `-e`: 设置环境变量
- `-v`: 将本地的 `data` 目录挂载到容器中，实现数据持久化

### 方法三：使用 Docker Compose

这是最推荐的生产部署方式。它会自动处理镜像拉取、环境变量注入和数据持久化。

**AMD64 架构 (x86_64)**:
```yaml
version: '3'
services:
  app:
    image: foamcold/fanren-sync:amd
    container_name: fanren-sync
    environment:
      - SYNC_PASSWORD=${SYNC_PASSWORD}
    ports:
      - "8000:8000"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

**ARM64 架构 (Apple Silicon / Raspberry Pi)**:
```yaml
version: '3'
services:
  app:
    image: foamcold/fanren-sync:arm
    container_name: fanren-sync
    environment:
      - SYNC_PASSWORD=${SYNC_PASSWORD}
    ports:
      - "8000:8000"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

将上述内容保存为 `docker-compose.yml`，然后运行：
```bash
# 设置密码并启动
export SYNC_PASSWORD="your_password"
docker-compose up -d
```

## 📚 API 使用说明

所有 API 的 URL 基础路径为 `http://<your-host>:<port>/<your-password>`。

以下示例中，我们假设 `SYNC_PASSWORD` 为 `your_password`。

客户端需要使用的基础 URL 示例：
`http://localhost:8000/your_password`

---

### 列出所有存档

- **方法**: `GET`
- **路径**: `/api/list`
- **示例**: `GET http://localhost:8000/your_password/api/list`
- **成功响应**:
  ```json
  {
    "success": true,
    "archives": ["test_data_1", "my_notes"]
  }
  ```

---

### 加载存档

- **方法**: `GET`
- **路径**: `/api/load`
- **参数**: `archiveName` (Query String)
- **示例**: `GET http://localhost:8000/your_password/api/load?archiveName=test_data_1`
- **成功响应**:
  ```json
  {
    "success": true,
    "data": { "key": "value", "notes": [1, 2, 3] }
  }
  ```
- **失败响应 (未找到)**:
  ```json
  {
    "detail": "存档未找到"
  }
  ```

---

### 保存存档

- **方法**: `POST`
- **路径**: `/api/save`
- **请求体**:
  ```json
  {
    "archiveName": "test_data_1",
    "data": { "key": "new value", "notes": [4, 5, 6] }
  }
  ```
  *(注：如果 `archiveName` 缺失，会尝试从 `data._internalName` 获取)*
- **示例**: `POST http://localhost:8000/your_password/api/save`
- **成功响应**:
  ```json
  {
    "success": true,
    "message": "存档已成功保存"
  }
  ```

---

### 删除存档

- **方法**: `DELETE`
- **路径**: `/api/delete`
- **参数**: `archiveName` (Query String)
- **示例**: `DELETE http://localhost:8000/your_password/api/delete?archiveName=test_data_1`
- **成功响应**:
  ```json
  {
    "success": true,
    "message": "存档已成功删除"
  }
  ```

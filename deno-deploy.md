# Deno Deploy 部署指南

## 快速部署

### 方法一：通过 Deno Deploy Dashboard 部署

1. **Fork 本仓库** 到你的 GitHub 账号

2. **访问 Deno Deploy**
   - 打开 https://dash.deno.com/new
   - 点击 "Select repository"
   - 选择你 fork 的仓库

3. **配置项目**
   - Project name: `fanren-sync` (或你喜欢的名字)
   - Entrypoint: `main.ts`
   - Production branch: `main`

4. **配置 Unstable 特性设置 (重要)**
   - 创建项目后，进入项目 **Settings**
   - 找到 **Build & Runtime** 或 **Runtime** 配置部分
   - 在 "Deploy flags" 或 "Unstable APIs" 中添加 `--unstable-kv`
   - 或者在 "Unstable features" 中启用 "kv"

5. **设置环境变量**
   - 在 Settings 中找到 "Environment Variables" 部分
   - 添加：`SYNC_PASSWORD` = `your_secure_password`

6. **重新部署 (Redeploy)**

### 方法二：使用 Deno CLI 部署

```bash
# 安装 deployctl (如果还没有)
deno install -A -r https://deno.land/x/deploy/deployctl.ts

# 设置密码
export SYNC_PASSWORD=your_secure_password

# 部署
deployctl deploy --project=fanren-sync --prod main.ts
```

## 本地开发测试

```bash
# 设置密码
export SYNC_PASSWORD=your_password

# 运行
deno task start

# 或开发模式（自动重载）
deno task dev
```

## API 使用

API 与 Python 版完全一致：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/{password}/api/list` | 列出所有存档 |
| GET | `/{password}/api/load?archiveName=<name>` | 加载存档 |
| POST | `/{password}/api/save` | 保存存档 |
| DELETE | `/{password}/api/delete?archiveName=<name>` | 删除存档 |

### 示例

```bash
# 列出存档
curl https://your-project.deno.dev/your_password/api/list

# 保存存档
curl -X POST https://your-project.deno.dev/your_password/api/save \
  -H "Content-Type: application/json" \
  -d '{"archiveName": "test", "data": {"hello": "world"}}'

# 加载存档
curl https://your-project.deno.dev/your_password/api/load?archiveName=test

# 删除存档
curl -X DELETE https://your-project.deno.dev/your_password/api/delete?archiveName=test
```

## 数据存储

Deno 版使用 **Deno KV (Deno Database)** 进行数据存储：

- 数据自动持久化，无需额外配置
- 全球边缘网络，低延迟访问
- 内置加密和备份
- 无需管理数据库服务器

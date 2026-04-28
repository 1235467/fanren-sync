import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import "jsr:@std/dotenv/load"; // 自动加载 .env 文件
import pg from "npm:pg"; // 引入 PostgreSQL 官方客户端

// --- 配置 ---
const syncPassword = Deno.env.get("SYNC_PASSWORD") || Deno.env.get("sync_password");

// 初始化 PostgreSQL 连接池
// Deno Deploy 会自动读取环境变量中的 DATABASE_URL，无需手动传参
// 但为了兼容本地 .env 读取，我们显式传入
const pool = new pg.Pool({
  connectionString: Deno.env.get("DATABASE_URL"),
  // Neon Serverless 建议设置适当的超时，避免僵尸连接
  connectionTimeoutMillis: 5000, 
});

// --- 初始化数据库表 ---
async function initDB() {
  const client = await pool.connect();
  try {
    // 自动创建 cloud_saves 表。利用 JSONB 类型容纳一切未知结构
    await client.query(`
      CREATE TABLE IF NOT EXISTS cloud_saves (
        id SERIAL PRIMARY KEY,
        archive_name TEXT UNIQUE NOT NULL,
        data JSONB NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch (err) {
    console.error("初始化数据库失败:", err);
  } finally {
    client.release();
  }
}
// 启动时自动建表
await initDB();

// --- 应用实例 ---
const app = new Hono();

// --- 自定义日志中间件 ---
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  
  const now = new Date();
  const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  
  try {
    let decodedUrl = decodeURIComponent(c.req.url);
    decodedUrl = decodedUrl.replace("0.0.0.0", "localhost").replace("127.0.0.1", "localhost");
    console.log(`${timeStr} - INFO - ${c.req.method} ${decodedUrl} - Status: ${c.res.status} - ${ms}ms`);
  } catch (_e) {
    console.log(`${timeStr} - INFO - ${c.req.method} ${c.req.url} - Status: ${c.res.status} - ${ms}ms`);
  }
});

// --- CORS 配置 ---
app.use("*", cors({
  origin: "*", 
  allowMethods: ["*"],
  allowHeaders: ["*"],
  credentials: true,
}));

// --- 异常处理 ---
app.onError((err, c) => {
  console.error("服务器错误:", err);
  const status = (err as any).status || 500;
  return c.json({ 
    success: false, 
    error: err.message || "服务器内部错误" 
  }, status);
});

// --- 安全辅助函数 ---
function sanitizeFilename(filename: string): string {
  const sanitized = filename.replace(/[^\p{L}\p{N}_\-]/gu, '');
  return sanitized.substring(0, 100);
}

// --- API 路由定义 ---
const api = new Hono();

// 密码验证依赖 (中间件)
api.use("*", async (c, next) => {
  const password = c.req.param("password");
  if (!syncPassword || password !== syncPassword) {
    return c.json({ success: false, error: "无效的访问密码" }, 403);
  }
  await next();
});

// GET /list
api.get("/list", async (c) => {
  try {
    // 从数据库查出所有的存档名
    const result = await pool.query("SELECT archive_name FROM cloud_saves ORDER BY updated_at DESC");
    const archives = result.rows.map(row => row.archive_name);
    return c.json({ success: true, archives });
  } catch (e: any) {
    return c.json({ success: false, error: `无法列出存档: ${e.message}` }, 500);
  }
});

// GET /load
api.get("/load", async (c) => {
  const archiveName = c.req.query("archiveName");
  if (!archiveName) return c.json({ success: false, error: "Missing archiveName query" }, 400);

  const safeFilename = sanitizeFilename(archiveName);
  try {
    // 根据存档名查找 JSONB 数据
    const result = await pool.query("SELECT data FROM cloud_saves WHERE archive_name = $1", [safeFilename]);
    
    if (result.rowCount === 0) {
      return c.json({ success: false, error: "存档未找到" }, 404);
    }
    
    // pg 驱动会自动将 JSONB 字段解析为 JavaScript 对象，直接返回即可
    return c.json({ success: true, data: result.rows[0].data });
  } catch (e: any) {
    return c.json({ success: false, error: `无法加载存档: ${e.message}` }, 500);
  }
});

// POST /save
api.post("/save", async (c) => {
  try {
    const payload = await c.req.json();
    let archiveName = payload.archiveName;
    
    if (!archiveName && payload.data && typeof payload.data === "object") {
      archiveName = payload.data._internalName;
    }
    
    if (!archiveName) {
      return c.json({ 
        success: false, 
        error: "Archive name is required (in body 'archiveName' or 'data._internalName')" 
      }, 400);
    }

    const safeFilename = sanitizeFilename(archiveName);
    console.log(`正在保存存档: 原始名称='${archiveName}', 安全名称='${safeFilename}'`);

    // 使用 Postgres 的 UPSERT 语法：有则更新，无则插入
    // 注意：pg 驱动会自动将 payload.data 序列化存入 JSONB 字段
    await pool.query(
      `INSERT INTO cloud_saves (archive_name, data) 
       VALUES ($1, $2) 
       ON CONFLICT (archive_name) 
       DO UPDATE SET data = EXCLUDED.data, updated_at = CURRENT_TIMESTAMP`,
      [safeFilename, payload.data]
    );
    
    return c.json({ success: true, message: "存档已成功保存" });
  } catch (e: any) {
    console.error("保存存档失败:", e);
    return c.json({ success: false, error: `无法保存存档: ${e.message}` }, 500);
  }
});

// DELETE /delete
api.delete("/delete", async (c) => {
  const archiveName = c.req.query("archiveName");
  if (!archiveName) return c.json({ success: false, error: "Missing archiveName query" }, 400);

  const safeFilename = sanitizeFilename(archiveName);
  try {
    const result = await pool.query("DELETE FROM cloud_saves WHERE archive_name = $1", [safeFilename]);
    
    if (result.rowCount === 0) {
      return c.json({ success: false, error: "存档未找到" }, 404);
    }

    return c.json({ success: true, message: "存档已成功删除" });
  } catch (e: any) {
    return c.json({ success: false, error: `无法删除存档: ${e.message}` }, 500);
  }
});

// --- 全局路由 ---
app.get("/favicon.ico", () => new Response(null, { status: 204 }));

app.get("/", (c) => {
  return c.json({
    success: true,
    message: "Fanren Sync 服务正在运行。请使用正确的 API 路径和密码进行访问。",
  }, 200);
});

// 挂载密码保护的路由
app.route("/:password/api", api);

// --- 横幅打印 ---
function printBanner(host: string, port: number, version: string, storageMode: string) {
  const contentLines = [
    `Fanren-Sync v${version} 启动成功`,
    ``,
    `数据存储: ${storageMode}`,
    `服务地址: http://${host === "0.0.0.0" ? "localhost" : host}:${port}`
  ];

  const getWidth = (s: string) => s.split('').reduce((acc, c) => acc + (c.match(/[\u4e00-\u9fff]/) ? 2 : 1), 0);
  
  let maxWidth = 40;
  for (const line of contentLines) maxWidth = Math.max(maxWidth, getWidth(line));
  const boxWidth = maxWidth + 4;

  console.log(`┌${'─'.repeat(boxWidth)}┐`);
  for (const line of contentLines) {
    const padding = boxWidth - getWidth(line);
    if (line.includes("启动成功")) {
      const leftPad = Math.floor(padding / 2);
      console.log(`│${' '.repeat(leftPad)}${line}${' '.repeat(padding - leftPad)}│`);
    } else {
      console.log(`│  ${line}${' '.repeat(padding - 2)}│`);
    }
  }
  console.log(`└${'─'.repeat(boxWidth)}┘`);
}

// --- 服务启动 ---
if (!syncPassword) {
  console.error("错误: 环境变量 SYNC_PASSWORD 未设置。");
  console.error("请在项目根目录创建一个 .env 文件并设置 SYNC_PASSWORD。");
} else if (!Deno.env.get("DATABASE_URL")) {
  console.error("错误: 环境变量 DATABASE_URL 未设置。");
  console.error("请设置连接到 Neon (Postgres) 的连接字符串。");
} else {
  const port = 8000;
  printBanner("0.0.0.0", port, "0.2.0", "PostgreSQL (Neon)");
  
  Deno.serve({ port, hostname: "0.0.0.0" }, app.fetch);
}

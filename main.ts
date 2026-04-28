import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import "jsr:@std/dotenv/load"; 
import pg from "npm:pg"; 

// --- 配置 ---
const syncPassword = Deno.env.get("SYNC_PASSWORD") || Deno.env.get("sync_password");

// 初始化 PostgreSQL 连接池
const pool = new pg.Pool({
  connectionString: Deno.env.get("DATABASE_URL"),
  connectionTimeoutMillis: 5000, 
});

// --- 初始化数据库表 ---
async function initDB() {
  const client = await pool.connect();
  try {
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
  return c.json({ success: false, error: err.message || "服务器内部错误" }, status);
});

// --- 辅助函数 ---
function sanitizeFilename(filename: string): string {
  const sanitized = filename.replace(/[^\p{L}\p{N}_\-]/gu, '');
  return sanitized.substring(0, 100);
}

// 生成时间后缀 (格式: 20260428_150531)
function generateTimeSuffix(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// --- API 路由定义 ---
const api = new Hono();

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
    // 按时间倒序返回，最新的版本会在最前面
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
    const result = await pool.query("SELECT data FROM cloud_saves WHERE archive_name = $1", [safeFilename]);
    if (result.rowCount === 0) return c.json({ success: false, error: "存档未找到" }, 404);
    return c.json({ success: true, data: result.rows[0].data });
  } catch (e: any) {
    return c.json({ success: false, error: `无法加载存档: ${e.message}` }, 500);
  }
});

// POST /save (核心修改：版本控制与重复检查)
api.post("/save", async (c) => {
  try {
    const payload = await c.req.json();
    let baseArchiveName = payload.archiveName;
    
    if (!baseArchiveName && payload.data && typeof payload.data === "object") {
      baseArchiveName = payload.data._internalName;
    }
    if (!baseArchiveName) {
      return c.json({ success: false, error: "Archive name is required" }, 400);
    }

    const safeBaseName = sanitizeFilename(baseArchiveName);
    const timeSuffix = generateTimeSuffix();
    let finalArchiveName = `${safeBaseName}_${timeSuffix}`; // 例如: player1_20260428_150531
    
    // --- 检查重复循环 ---
    // 如果该名字已存在（同一秒内发起了多次保存），则追加 _1, _2 等后缀
    let counter = 1;
    while (true) {
      const checkRes = await pool.query("SELECT id FROM cloud_saves WHERE archive_name = $1", [finalArchiveName]);
      if (checkRes.rowCount === 0) {
        break; // 名字唯一，跳出循环
      }
      finalArchiveName = `${safeBaseName}_${timeSuffix}_${counter}`;
      counter++;
    }

    console.log(`正在保存版本化存档: 基础名称='${safeBaseName}', 最终名称='${finalArchiveName}'`);

    // 此时名字绝对唯一，直接 INSERT 即可，不再需要 ON CONFLICT 覆盖
    await pool.query(
      `INSERT INTO cloud_saves (archive_name, data) VALUES ($1, $2)`,
      [finalArchiveName, payload.data]
    );
    
    return c.json({ success: true, message: "存档新版本已成功保存", savedName: finalArchiveName });
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
    if (result.rowCount === 0) return c.json({ success: false, error: "存档未找到" }, 404);
    return c.json({ success: true, message: "存档已成功删除" });
  } catch (e: any) {
    return c.json({ success: false, error: `无法删除存档: ${e.message}` }, 500);
  }
});

// --- 全局路由 ---
app.get("/favicon.ico", () => new Response(null, { status: 204 }));
app.get("/", (c) => c.json({ success: true, message: "Fanren Sync 运行中 (Postgres版本控制生效中)" }, 200));
app.route("/:password/api", api);

// --- 服务启动 ---
if (!syncPassword || !Deno.env.get("DATABASE_URL")) {
  console.error("错误: 请确保设置了 SYNC_PASSWORD 和 DATABASE_URL 环境变量。");
} else {
  const port = 8000;
  console.log(`🚀 Fanren-Sync v0.3.0 (Postgres Versioned) 启动于端口 ${port}`);
  Deno.serve({ port, hostname: "0.0.0.0" }, app.fetch);
}

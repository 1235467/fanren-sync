import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import "jsr:@std/dotenv/load"; 
import pg from "npm:pg"; 

// --- 配置 ---
const syncPassword = Deno.env.get("SYNC_PASSWORD") || Deno.env.get("sync_password");
// 每个存档最多保留的历史版本数
const MAX_VERSIONS = 30;
// 3f870fd 版本控制产生的污染行后缀特征: name_20260428_150531 / name_20260428_150531_1
// 注意: Postgres POSIX 正则不支持 \d, 必须用 [0-9]
const POLLUTION_PATTERN = "_[0-9]{8}_[0-9]{6}(_[0-9]+)?$";

// 初始化 PostgreSQL 连接池
const pool = new pg.Pool({
  connectionString: Deno.env.get("DATABASE_URL"),
  connectionTimeoutMillis: 5000, 
});

// --- 初始化数据库表 ---
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 主表: 每个存档一行, 同名覆盖 (与旧版 main.py 的文件行为一致)
    await client.query(`
      CREATE TABLE IF NOT EXISTS cloud_saves (
        id SERIAL PRIMARY KEY,
        archive_name TEXT UNIQUE NOT NULL,
        data JSONB NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 版本表: 每次保存追加一条历史版本, 对卡片透明
    await client.query(`
      CREATE TABLE IF NOT EXISTS cloud_save_versions (
        id SERIAL PRIMARY KEY,
        archive_name TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_versions_name ON cloud_save_versions (archive_name, id DESC);
    `);

    // --- 一次性迁移: 清理 3f870fd 产生的带时间后缀的污染行 (幂等) ---
    // 1) 将污染行导入版本表 (基础名去掉时间后缀)
    await client.query(`
      INSERT INTO cloud_save_versions (archive_name, data, created_at)
      SELECT regexp_replace(archive_name, $1, ''), data, updated_at
      FROM cloud_saves
      WHERE archive_name ~ $1;
    `, [POLLUTION_PATTERN]);

    // 2) 若基础名在主表不存在, 用该存档最新的一个污染行恢复为主表行
    await client.query(`
      INSERT INTO cloud_saves (archive_name, data, updated_at)
      SELECT DISTINCT ON (base) base, data, updated_at
      FROM (
        SELECT regexp_replace(archive_name, $1, '') AS base, data, updated_at
        FROM cloud_saves
        WHERE archive_name ~ $1
      ) t
      ORDER BY base, updated_at DESC
      ON CONFLICT (archive_name) DO NOTHING;
    `, [POLLUTION_PATTERN]);

    // 3) 数据已安全复制, 删除污染行
    await client.query(`
      DELETE FROM cloud_saves WHERE archive_name ~ $1;
    `, [POLLUTION_PATTERN]);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
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

// POST /save (同名覆盖主表 + 追加历史版本, 一个事务)
api.post("/save", async (c) => {
  let client;
  try {
    const payload = await c.req.json();
    let archiveName = payload.archiveName;
    
    if (!archiveName && payload.data && typeof payload.data === "object") {
      archiveName = payload.data._internalName;
    }
    if (!archiveName) {
      return c.json({ success: false, error: "Archive name is required" }, 400);
    }

    const safeFilename = sanitizeFilename(archiveName);
    console.log(`正在保存存档: 原始名称='${archiveName}', 安全名称='${safeFilename}'`);

    client = await pool.connect();
    await client.query("BEGIN");

    // 1) 主表同名覆盖 (恢复旧版行为, 卡片端依赖稳定存档名)
    await client.query(
      `INSERT INTO cloud_saves (archive_name, data) 
       VALUES ($1, $2) 
       ON CONFLICT (archive_name) 
       DO UPDATE SET data = EXCLUDED.data, updated_at = CURRENT_TIMESTAMP`,
      [safeFilename, payload.data]
    );

    // 2) 版本表追加历史版本
    await client.query(
      `INSERT INTO cloud_save_versions (archive_name, data) VALUES ($1, $2)`,
      [safeFilename, payload.data]
    );

    // 3) 裁剪历史版本, 只保留最近 MAX_VERSIONS 条
    await client.query(
      `DELETE FROM cloud_save_versions 
       WHERE archive_name = $1 AND id NOT IN (
         SELECT id FROM cloud_save_versions WHERE archive_name = $1 ORDER BY id DESC LIMIT $2
       )`,
      [safeFilename, MAX_VERSIONS]
    );

    await client.query("COMMIT");
    return c.json({ success: true, message: "存档已成功保存", savedName: safeFilename });
  } catch (e: any) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("保存存档失败:", e);
    return c.json({ success: false, error: `无法保存存档: ${e.message}` }, 500);
  } finally {
    if (client) client.release();
  }
});

// GET /versions (列出一个存档的历史版本, 供回滚使用)
api.get("/versions", async (c) => {
  const archiveName = c.req.query("archiveName");
  if (!archiveName) return c.json({ success: false, error: "Missing archiveName query" }, 400);

  const safeFilename = sanitizeFilename(archiveName);
  try {
    const result = await pool.query(
      `SELECT id, created_at FROM cloud_save_versions WHERE archive_name = $1 ORDER BY id DESC`,
      [safeFilename]
    );
    return c.json({ success: true, versions: result.rows });
  } catch (e: any) {
    return c.json({ success: false, error: `无法列出版本: ${e.message}` }, 500);
  }
});

// GET /load_version (按版本 id 加载历史版本)
api.get("/load_version", async (c) => {
  const id = c.req.query("id");
  if (!id || !/^[0-9]+$/.test(id)) return c.json({ success: false, error: "Missing or invalid id query" }, 400);

  try {
    const result = await pool.query(
      `SELECT archive_name, data, created_at FROM cloud_save_versions WHERE id = $1`,
      [Number(id)]
    );
    if (result.rowCount === 0) return c.json({ success: false, error: "版本未找到" }, 404);
    return c.json({ success: true, archiveName: result.rows[0].archive_name, createdAt: result.rows[0].created_at, data: result.rows[0].data });
  } catch (e: any) {
    return c.json({ success: false, error: `无法加载版本: ${e.message}` }, 500);
  }
});

// DELETE /delete (同时删除该存档的全部历史版本)
api.delete("/delete", async (c) => {
  const archiveName = c.req.query("archiveName");
  if (!archiveName) return c.json({ success: false, error: "Missing archiveName query" }, 400);

  const safeFilename = sanitizeFilename(archiveName);
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const result = await client.query("DELETE FROM cloud_saves WHERE archive_name = $1", [safeFilename]);
    await client.query("DELETE FROM cloud_save_versions WHERE archive_name = $1", [safeFilename]);
    await client.query("COMMIT");

    if (result.rowCount === 0) return c.json({ success: false, error: "存档未找到" }, 404);
    return c.json({ success: true, message: "存档已成功删除" });
  } catch (e: any) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    return c.json({ success: false, error: `无法删除存档: ${e.message}` }, 500);
  } finally {
    if (client) client.release();
  }
});

// --- 全局路由 ---
app.get("/favicon.ico", () => new Response(null, { status: 204 }));
app.get("/", (c) => c.json({ success: true, message: "Fanren Sync 运行中 (Postgres 同名覆盖 + 版本历史)" }, 200));
app.route("/:password/api", api);

// --- 服务启动 ---
if (!syncPassword || !Deno.env.get("DATABASE_URL")) {
  console.error("错误: 请确保设置了 SYNC_PASSWORD 和 DATABASE_URL 环境变量。");
} else {
  const port = 8000;
  console.log(`🚀 Fanren-Sync v0.4.0 (Postgres Latest+Versions) 启动于端口 ${port}`);
  Deno.serve({ port, hostname: "0.0.0.0" }, app.fetch);
}

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
// 不传 connectionString 时 pg 会自动读取 PGHOST/PGUSER/PGPASSWORD/PGDATABASE 等环境变量
// (兼容 Deno Deploy 托管 PostgreSQL 的注入方式)
const pool = new pg.Pool({
  ...(Deno.env.get("DATABASE_URL") ? { connectionString: Deno.env.get("DATABASE_URL") } : {}),
  connectionTimeoutMillis: 5000, 
});

// --- 初始化数据库表 (惰性: 首次请求时才执行) ---
// Deno Deploy 的 Warm up 阶段没有数据库环境变量和网络, 顶层连接会导致部署失败,
// 所以这里绝不在模块加载时调用, 而是由 ensureDB 在首个请求到来时触发。
async function initDB() {
  let client;
  try {
    client = await pool.connect();
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
    console.log("数据库初始化/迁移完成");
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("初始化数据库失败:", err);
    throw err; // 抛出以便 ensureDB 标记失败、下次请求重试
  } finally {
    if (client) client.release();
  }
}

// 每个 isolate 只初始化一次; 失败则重置, 允许后续请求重试
let dbInitPromise: Promise<void> | null = null;
function ensureDB(): Promise<void> {
  if (!dbInitPromise) {
    dbInitPromise = initDB();
    dbInitPromise.catch(() => { dbInitPromise = null; });
  }
  return dbInitPromise;
}

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
  try {
    await ensureDB();
  } catch (e: any) {
    return c.json({ success: false, error: `数据库不可用: ${e.message}` }, 503);
  }
  await next();
});

// GET /list
api.get("/list", async (c) => {
  try {
    const result = await pool.query("SELECT archive_name FROM cloud_saves ORDER BY updated_at DESC");
    const archives = result.rows.map((row: any) => row.archive_name);
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

// --- 版本管理网页 (与 API 同密码路径, 供浏览器直接访问) ---
function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 清理对话正文: 数据本身已是卡片 regex 清理后的 HTML, 这里再去掉残留的结构标签和危险内容
function sanitizeStoryHtml(html: unknown): string {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<(iframe|object|embed|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?story_(plot|body)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '');
}

function pageHead(title: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} - Fanren Sync</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:0 auto;padding:16px 20px;color:#222;line-height:1.7}
h1{font-size:1.25rem;margin:8px 0}
a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
table{border-collapse:collapse;width:100%;margin:12px 0}
td,th{border-bottom:1px solid #e5e5e5;padding:6px 8px;text-align:left;font-size:.92rem}
.msg{border:1px solid #e0e0e0;border-radius:8px;padding:10px 14px;margin:12px 0;white-space:pre-wrap;word-break:break-word}
.msg.user{background:#f4f8ff}
.who{font-size:.78rem;color:#777;margin-bottom:6px}
button{padding:3px 12px;cursor:pointer}
.banner{background:#fff8e6;border:1px solid #f0e0b0;border-radius:8px;padding:8px 14px;margin:12px 0;font-size:.9rem}
.muted{color:#777;font-size:.85rem}
</style></head><body>`;
}

// 渲染一份存档数据的完整对话
function renderConversation(data: any): string {
  const logs = Array.isArray(data?.logs) ? data.logs : [];
  const parts: string[] = [];
  let shown = 0;
  for (const log of logs) {
    if (!log || typeof log.content !== 'string' || !log.content.trim()) continue;
    const who = log.type === 'user' ? '玩家' : 'AI';
    const time = String(log.timestamp || '').replace('T', ' ').slice(0, 16);
    parts.push(
      `<div class="msg${log.type === 'user' ? ' user' : ''}">` +
      `<div class="who">${who}${time ? ' · ' + escapeHtml(time) : ''}</div>` +
      `<div>${sanitizeStoryHtml(log.content)}</div></div>`
    );
    shown++;
  }
  if (shown === 0) return '<p class="muted">（此存档中没有对话记录）</p>';
  return `<p class="muted">共 ${shown} 条对话</p>` + parts.join('\n');
}

// 网页密码校验: 失败时返回 403 页面
function checkPagePassword(c: any): Response | null {
  if (!syncPassword || c.req.param("password") !== syncPassword) {
    return c.html('<h1>403</h1><p>无效的访问密码</p>', 403);
  }
  return null;
}

// 带尾斜杠时重定向, 避免手动输入 URL 404
app.get("/:password/", (c) => c.redirect(`/${c.req.param("password")}`, 301));

// GET /:password — 存档总览
app.get("/:password", async (c) => {
  const denied = checkPagePassword(c);
  if (denied) return denied;
  try { await ensureDB(); } catch (e: any) { return c.html(`<h1>503</h1><p>数据库不可用: ${escapeHtml(e.message)}</p>`, 503); }
  try {
    const result = await pool.query(`
      SELECT s.archive_name, s.updated_at,
             COALESCE(jsonb_array_length(s.data->'logs'), 0) AS log_count,
             (SELECT count(*) FROM cloud_save_versions v WHERE v.archive_name = s.archive_name) AS version_count
      FROM cloud_saves s ORDER BY s.updated_at DESC
    `);
    const pw = encodeURIComponent(c.req.param("password")!);
    const rows = result.rows.map((r: any) => {
      const name = encodeURIComponent(r.archive_name);
      return `<tr><td>${escapeHtml(r.archive_name)}</td>` +
        `<td>${new Date(r.updated_at).toLocaleString('zh-CN', { hour12: false })}</td>` +
        `<td>${r.log_count}</td><td>${r.version_count}</td>` +
        `<td><a href="/${pw}/view?name=${name}">查看当前</a> · <a href="/${pw}/versions?name=${name}">历史版本</a></td>` +
        `<td><form method="post" action="/${pw}/delete_archive" style="display:inline" onsubmit="return confirm('确定删除存档「${escapeHtml(r.archive_name)}」吗？其全部历史版本也会一并删除，不可恢复。')">` +
        `<input type="hidden" name="name" value="${escapeHtml(r.archive_name)}"><button>删除</button></form></td></tr>`;
    }).join('\n');
    return c.html(pageHead('存档总览') +
      `<h1>云存档总览</h1>` +
      (rows
        ? `<table><tr><th>存档</th><th>更新时间</th><th>对话数</th><th>历史版本</th><th>操作</th><th>删除</th></tr>${rows}</table>`
        : '<p class="muted">暂无存档</p>') +
      `</body></html>`);
  } catch (e: any) {
    return c.html(`<h1>错误</h1><p>${escapeHtml(e.message)}</p>`, 500);
  }
});

// GET /:password/versions?name= — 一个存档的历史版本列表
app.get("/:password/versions", async (c) => {
  const denied = checkPagePassword(c);
  if (denied) return denied;
  try { await ensureDB(); } catch (e: any) { return c.html(`<h1>503</h1><p>数据库不可用: ${escapeHtml(e.message)}</p>`, 503); }
  const name = c.req.query("name");
  if (!name) return c.html('<h1>400</h1><p>缺少 name 参数</p>', 400);
  try {
    const result = await pool.query(
      `SELECT id, created_at, COALESCE(jsonb_array_length(data->'logs'), 0) AS log_count
       FROM cloud_save_versions WHERE archive_name = $1 ORDER BY id DESC`,
      [name]
    );
    const pw = encodeURIComponent(c.req.param("password")!);
    const encName = encodeURIComponent(name);
    const rows = result.rows.map((r: any, i: number) =>
      `<tr><td>#${r.id} <span class="muted">(倒数第 ${i + 1} 版)</span></td>` +
      `<td>${new Date(r.created_at).toLocaleString('zh-CN', { hour12: false })}</td>` +
      `<td>${r.log_count}</td>` +
      `<td><a href="/${pw}/view_version?id=${r.id}">查看对话</a></td>` +
      `<td><form method="post" action="/${pw}/rollback" style="display:inline" onsubmit="return confirm('确定回滚到此版本吗？不会删除任何历史版本，当前内容也会保留为一条新版本。')">` +
      `<input type="hidden" name="id" value="${r.id}"><button>回滚</button></form></td>` +
      `<td><form method="post" action="/${pw}/delete_version" style="display:inline" onsubmit="return confirm('确定删除这个历史版本吗？不可恢复。')">` +
      `<input type="hidden" name="id" value="${r.id}"><button>删除</button></form></td></tr>`
    ).join('\n');
    return c.html(pageHead(`历史版本 - ${name}`) +
      `<p><a href="/${pw}">← 返回总览</a></p><h1>${escapeHtml(name)}</h1>` +
      `<p><a href="/${pw}/view?name=${encName}">查看当前最新版本</a></p>` +
      (rows
        ? `<table><tr><th>版本</th><th>保存时间</th><th>对话数</th><th>对话</th><th>回滚</th><th>删除</th></tr>${rows}</table>`
        : '<p class="muted">暂无历史版本</p>') +
      `</body></html>`);
  } catch (e: any) {
    return c.html(`<h1>错误</h1><p>${escapeHtml(e.message)}</p>`, 500);
  }
});

// GET /:password/view?name= — 查看当前最新版本的对话
app.get("/:password/view", async (c) => {
  const denied = checkPagePassword(c);
  if (denied) return denied;
  try { await ensureDB(); } catch (e: any) { return c.html(`<h1>503</h1><p>数据库不可用: ${escapeHtml(e.message)}</p>`, 503); }
  const name = c.req.query("name");
  if (!name) return c.html('<h1>400</h1><p>缺少 name 参数</p>', 400);
  try {
    const result = await pool.query("SELECT data FROM cloud_saves WHERE archive_name = $1", [name]);
    if (result.rowCount === 0) return c.html('<h1>404</h1><p>存档未找到</p>', 404);
    const pw = encodeURIComponent(c.req.param("password")!);
    const data = result.rows[0].data;
    const title = data?._internalName || name;
    return c.html(pageHead(`${title} - 当前版本`) +
      `<p><a href="/${pw}/versions?name=${encodeURIComponent(name)}">← 返回版本列表</a></p>` +
      `<h1>${escapeHtml(title)} <span class="muted">(当前最新)</span></h1>` +
      renderConversation(data) + `</body></html>`);
  } catch (e: any) {
    return c.html(`<h1>错误</h1><p>${escapeHtml(e.message)}</p>`, 500);
  }
});

// GET /:password/view_version?id= — 查看某个历史版本的对话
app.get("/:password/view_version", async (c) => {
  const denied = checkPagePassword(c);
  if (denied) return denied;
  try { await ensureDB(); } catch (e: any) { return c.html(`<h1>503</h1><p>数据库不可用: ${escapeHtml(e.message)}</p>`, 503); }
  const id = c.req.query("id");
  if (!id || !/^[0-9]+$/.test(id)) return c.html('<h1>400</h1><p>缺少或非法的 id 参数</p>', 400);
  try {
    const result = await pool.query(
      "SELECT archive_name, data, created_at FROM cloud_save_versions WHERE id = $1", [Number(id)]
    );
    if (result.rowCount === 0) return c.html('<h1>404</h1><p>版本未找到</p>', 404);
    const pw = encodeURIComponent(c.req.param("password")!);
    const row = result.rows[0];
    const data = row.data;
    const title = data?._internalName || row.archive_name;
    const time = new Date(row.created_at).toLocaleString('zh-CN', { hour12: false });
    return c.html(pageHead(`${title} - 版本 #${id}`) +
      `<p><a href="/${pw}/versions?name=${encodeURIComponent(row.archive_name)}">← 返回版本列表</a></p>` +
      `<h1>${escapeHtml(title)}</h1>` +
      `<div class="banner">这是历史版本 #${id}，保存于 ${time}。` +
      `<form method="post" action="/${pw}/rollback" style="display:inline" onsubmit="return confirm('确定回滚到此版本吗？')">` +
      `<input type="hidden" name="id" value="${id}"> <button>回滚到此版本</button></form></div>` +
      renderConversation(data) + `</body></html>`);
  } catch (e: any) {
    return c.html(`<h1>错误</h1><p>${escapeHtml(e.message)}</p>`, 500);
  }
});

// POST /:password/rollback — 把指定历史版本恢复为当前最新 (原最新内容保留为新的历史版本)
app.post("/:password/rollback", async (c) => {
  const denied = checkPagePassword(c);
  if (denied) return denied;
  try { await ensureDB(); } catch (e: any) { return c.html(`<h1>503</h1><p>数据库不可用: ${escapeHtml(e.message)}</p>`, 503); }
  const body = await c.req.parseBody();
  const id = String(body["id"] || "");
  if (!/^[0-9]+$/.test(id)) return c.html('<h1>400</h1><p>非法的版本 id</p>', 400);

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const vres = await client.query(
      "SELECT archive_name, data FROM cloud_save_versions WHERE id = $1", [Number(id)]
    );
    if (vres.rowCount === 0) {
      await client.query("ROLLBACK");
      return c.html('<h1>404</h1><p>版本未找到</p>', 404);
    }
    const { archive_name, data } = vres.rows[0];

    // 1) 目标版本覆盖为当前最新
    await client.query(
      `INSERT INTO cloud_saves (archive_name, data) VALUES ($1, $2)
       ON CONFLICT (archive_name) DO UPDATE SET data = EXCLUDED.data, updated_at = CURRENT_TIMESTAMP`,
      [archive_name, data]
    );
    // 2) 这次回滚本身也记为一条历史版本, 保证历史连续
    await client.query(
      `INSERT INTO cloud_save_versions (archive_name, data) VALUES ($1, $2)`,
      [archive_name, data]
    );
    // 3) 裁剪
    await client.query(
      `DELETE FROM cloud_save_versions WHERE archive_name = $1 AND id NOT IN (
         SELECT id FROM cloud_save_versions WHERE archive_name = $1 ORDER BY id DESC LIMIT $2)`,
      [archive_name, MAX_VERSIONS]
    );
    await client.query("COMMIT");

    const pw = encodeURIComponent(c.req.param("password")!);
    return c.redirect(`/${pw}/versions?name=${encodeURIComponent(archive_name)}`, 303);
  } catch (e: any) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    return c.html(`<h1>错误</h1><p>${escapeHtml(e.message)}</p>`, 500);
  } finally {
    if (client) client.release();
  }
});

// POST /:password/delete_archive — 网页上手动删除整个存档 (含全部历史版本)
app.post("/:password/delete_archive", async (c) => {
  const denied = checkPagePassword(c);
  if (denied) return denied;
  try { await ensureDB(); } catch (e: any) { return c.html(`<h1>503</h1><p>数据库不可用: ${escapeHtml(e.message)}</p>`, 503); }
  const body = await c.req.parseBody();
  const name = String(body["name"] || "");
  if (!name) return c.html('<h1>400</h1><p>缺少 name 参数</p>', 400);

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("DELETE FROM cloud_saves WHERE archive_name = $1", [name]);
    await client.query("DELETE FROM cloud_save_versions WHERE archive_name = $1", [name]);
    await client.query("COMMIT");
    const pw = encodeURIComponent(c.req.param("password")!);
    return c.redirect(`/${pw}`, 303);
  } catch (e: any) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    return c.html(`<h1>错误</h1><p>${escapeHtml(e.message)}</p>`, 500);
  } finally {
    if (client) client.release();
  }
});

// POST /:password/delete_version — 网页上手动删除单个历史版本
app.post("/:password/delete_version", async (c) => {
  const denied = checkPagePassword(c);
  if (denied) return denied;
  try { await ensureDB(); } catch (e: any) { return c.html(`<h1>503</h1><p>数据库不可用: ${escapeHtml(e.message)}</p>`, 503); }
  const body = await c.req.parseBody();
  const id = String(body["id"] || "");
  if (!/^[0-9]+$/.test(id)) return c.html('<h1>400</h1><p>非法的版本 id</p>', 400);

  try {
    const result = await pool.query(
      "DELETE FROM cloud_save_versions WHERE id = $1 RETURNING archive_name", [Number(id)]
    );
    if (result.rowCount === 0) return c.html('<h1>404</h1><p>版本未找到</p>', 404);
    const pw = encodeURIComponent(c.req.param("password")!);
    return c.redirect(`/${pw}/versions?name=${encodeURIComponent(result.rows[0].archive_name)}`, 303);
  } catch (e: any) {
    return c.html(`<h1>错误</h1><p>${escapeHtml(e.message)}</p>`, 500);
  }
});

// --- 全局路由 ---
app.get("/favicon.ico", () => new Response(null, { status: 204 }));
app.get("/", (c) => c.json({ success: true, message: "Fanren Sync 运行中 (Postgres 同名覆盖 + 版本历史)" }, 200));
app.route("/:password/api", api);

// --- 服务启动 ---
// 无条件启动: Deno Deploy 的 Warm up 阶段环境变量可能尚未注入,
// 若此时拒绝启动会导致整个部署失败; 缺配置时 API/网页会各自返回 403/503。
if (!syncPassword) {
  console.error("警告: SYNC_PASSWORD 未设置, 所有 API 和网页将返回 403。");
}
if (!Deno.env.get("DATABASE_URL") && !Deno.env.get("PGHOST")) {
  console.error("警告: DATABASE_URL 未设置, 数据库将在首次请求时按 pg 默认环境变量连接。");
}
const port = 8000;
console.log(`🚀 Fanren-Sync v0.4.1 (Postgres Latest+Versions) 启动于端口 ${port}`);
Deno.serve({ port, hostname: "0.0.0.0" }, app.fetch);

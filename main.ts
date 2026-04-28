import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import "jsr:@std/dotenv/load"; // 自动加载 .env 文件
import { get as getBlob, set as setBlob, remove as removeBlob } from "jsr:@kitsonk/kv-toolbox/blob";

// --- 配置 ---
// 优先读取大写 SYNC_PASSWORD，兼容小写 sync_password
const syncPassword = Deno.env.get("SYNC_PASSWORD") || Deno.env.get("sync_password");

// 初始化 Deno KV
const kv = await Deno.openKv();
const KV_PREFIX = "archives";

// --- 应用实例 ---
const app = new Hono();

// --- 自定义日志中间件 (替代原版 Uvicorn TranslationFilter) ---
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  
  // 格式化时间
  const now = new Date();
  const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  
  try {
    // 解码 URL 并清理本地 IP 显示
    let decodedUrl = decodeURIComponent(c.req.url);
    decodedUrl = decodedUrl.replace("0.0.0.0", "localhost").replace("127.0.0.1", "localhost");
    console.log(`${timeStr} - INFO - ${c.req.method} ${decodedUrl} - Status: ${c.res.status} - ${ms}ms`);
  } catch (_e) {
    console.log(`${timeStr} - INFO - ${c.req.method} ${c.req.url} - Status: ${c.res.status} - ${ms}ms`);
  }
});

// --- CORS 配置 ---
app.use("*", cors({
  origin: "*", // 允许所有来源
  allowMethods: ["*"],
  allowHeaders: ["*"],
  credentials: true,
}));

// --- 异常处理 ---
app.onError((err, c) => {
  console.error("服务器错误:", err);
  // HTTP 异常统一格式
  const status = (err as any).status || 500;
  return c.json({ 
    success: false, 
    error: err.message || "服务器内部错误" 
  }, status);
});

// --- 安全辅助函数 ---
function sanitizeFilename(filename: string): string {
  // 清理文件名，允许 Unicode 字母、数字、下划线和连字符
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
    const archives = new Set<string>();
    // 列出该前缀下的所有键
    const entries = kv.list({ prefix: [KV_PREFIX] });
    for await (const entry of entries) {
      // Deno KV 存储结构形如 ["archives", "存档名", ...]
      const name = entry.key[1] as string;
      if (name) archives.add(name);
    }
    return c.json({ success: true, archives: Array.from(archives) });
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
    // 使用 blob 从 KV 提取切片数据
    const dataUint8 = await getBlob(kv, [KV_PREFIX, safeFilename]);
    if (!dataUint8 || dataUint8.length === 0) {
      return c.json({ success: false, error: "存档未找到" }, 404);
    }
    
    // Uint8Array 转 JSON Object
    const dataStr = new TextDecoder().decode(dataUint8);
    const jsonData = JSON.parse(dataStr);
    
    return c.json({ success: true, data: jsonData });
  } catch (e: any) {
    return c.json({ success: false, error: `无法加载存档: ${e.message}` }, 500);
  }
});

// POST /save
api.post("/save", async (c) => {
  try {
    const payload = await c.req.json();
    let archiveName = payload.archiveName;
    
    // 如果顶级没有 archiveName，尝试从内部获取
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

    // 将 JSON 转为 Uint8Array 以利用 blob 切片存储
    const dataStr = JSON.stringify(payload.data);
    const dataUint8 = new TextEncoder().encode(dataStr);

    await setBlob(kv, [KV_PREFIX, safeFilename], dataUint8);
    
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
    // 检查是否存在
    const exists = await getBlob(kv, [KV_PREFIX, safeFilename]);
    if (!exists || exists.length === 0) {
      return c.json({ success: false, error: "存档未找到" }, 404);
    }

    await removeBlob(kv, [KV_PREFIX, safeFilename]);
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
} else {
  const port = 8000;
  printBanner("0.0.0.0", port, "0.1.0", "Deno KV (kv-toolbox)");
  
  // 启动原生 Deno Http Server
  Deno.serve({ port, hostname: "0.0.0.0" }, app.fetch);
}

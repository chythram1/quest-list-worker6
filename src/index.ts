type Theme = "cosmic-candy" | "jungle-pop" | "midnight-arcade";
type Priority = "spark" | "zap" | "boss";

interface Env {
  TODO_DB: D1Database;
  TODO_KV: KVNamespace;
  TODO_BUCKET: R2Bucket;
  APP_NAME: string;
  DEFAULT_THEME: string;
  MAX_ATTACHMENT_BYTES: string;
  ADMIN_TOKEN?: string;
}

interface TodoRow {
  id: string;
  title: string;
  notes: string;
  completed: number;
  priority: Priority;
  emoji: string;
  attachment_key: string | null;
  attachment_name: string | null;
  attachment_type: string | null;
  created_at: string;
  updated_at: string;
}

const themes: Theme[] = ["cosmic-candy", "jungle-pop", "midnight-arcade"];
const priorities: Priority[] = ["spark", "zap", "boss"];
const emojiPool = ["✨", "🚀", "🦄", "🌈", "🍕", "🧃", "🪩", "🐙", "🌟", "🎮", "🛸", "🍄"];
const vibes = [
  "Tiny wins count double today.",
  "Side quests are still quests.",
  "The goblins fear your checklist.",
  "Ship it with sparkles.",
  "Hydrate, then conquer.",
  "A completed task is a defeated mini-boss."
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/" && request.method === "GET") {
        return htmlResponse(renderApp(env));
      }

      if (url.pathname === "/api/config" && request.method === "GET") {
        return getConfig(env);
      }

      if (url.pathname === "/api/theme" && request.method === "POST") {
        return saveTheme(request, env);
      }

      if (url.pathname === "/api/todos" && request.method === "GET") {
        return listTodos(env);
      }

      if (url.pathname === "/api/todos" && request.method === "POST") {
        return createTodo(request, env);
      }

      if (url.pathname === "/api/admin/stats" && request.method === "GET") {
        return adminStats(request, env);
      }

      const todoMatch = url.pathname.match(/^\/api\/todos\/([^/]+)(?:\/(attachment))?$/);
      if (todoMatch) {
        const id = decodeURIComponent(todoMatch[1]);
        const target = todoMatch[2];

        if (!target && request.method === "PATCH") {
          return updateTodo(request, env, id);
        }

        if (!target && request.method === "DELETE") {
          return deleteTodo(env, id);
        }

        if (target === "attachment" && request.method === "POST") {
          return uploadAttachment(request, env, id);
        }

        if (target === "attachment" && request.method === "GET") {
          return downloadAttachment(env, id);
        }

        if (target === "attachment" && request.method === "DELETE") {
          return deleteAttachment(env, id);
        }
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, error.status);
      }

      const message = error instanceof Error ? error.message : "Unknown error";
      return json({ error: message }, 500);
    }
  }
};

async function getConfig(env: Env): Promise<Response> {
  const theme = await getTheme(env);
  const vibe = await getDailyVibe(env);

  return json({
    appName: env.APP_NAME || "Quest List",
    theme,
    themes,
    vibe,
    maxAttachmentBytes: getMaxAttachmentBytes(env)
  });
}

async function saveTheme(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const theme = isRecord(body) ? body.theme : undefined;
  if (!isTheme(theme)) {
    return json({ error: "Choose a valid theme." }, 400);
  }

  await env.TODO_KV.put("app:theme", theme);
  return json({ theme });
}

async function listTodos(env: Env): Promise<Response> {
  const result = await env.TODO_DB.prepare(
    `SELECT * FROM todos
     ORDER BY completed ASC,
       CASE priority WHEN 'boss' THEN 0 WHEN 'zap' THEN 1 ELSE 2 END ASC,
       created_at DESC`
  ).all<TodoRow>();

  return json({ todos: (result.results || []).map(toTodo) });
}

async function createTodo(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const data: Record<string, unknown> = isRecord(body) ? body : {};
  const title = normalizeText(data.title, 120);
  if (!title) {
    return json({ error: "A quest needs a title." }, 400);
  }

  const priority = isPriority(data.priority) ? data.priority : "spark";
  const emoji = normalizeEmoji(data.emoji);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await env.TODO_DB.prepare(
    `INSERT INTO todos (id, title, notes, completed, priority, emoji, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
  )
    .bind(id, title, normalizeText(data.notes, 500), priority, emoji, now, now)
    .run();

  const todo = await getTodo(env, id);
  return json({ todo: toTodo(todo) }, 201);
}

async function updateTodo(request: Request, env: Env, id: string): Promise<Response> {
  const existing = await getTodo(env, id);
  const body = await readJson(request);
  const data: Record<string, unknown> = isRecord(body) ? body : {};

  const title = data.title === undefined ? existing.title : normalizeText(data.title, 120);
  if (!title) {
    return json({ error: "A quest needs a title." }, 400);
  }

  const notes = data.notes === undefined ? existing.notes : normalizeText(data.notes, 500);
  const completed = data.completed === undefined
    ? existing.completed
    : data.completed === true
      ? 1
      : data.completed === false
        ? 0
        : existing.completed;
  const priority = data.priority === undefined ? existing.priority : isPriority(data.priority) ? data.priority : existing.priority;
  const emoji = data.emoji === undefined ? existing.emoji : normalizeEmoji(data.emoji);
  const updatedAt = new Date().toISOString();

  await env.TODO_DB.prepare(
    `UPDATE todos
     SET title = ?, notes = ?, completed = ?, priority = ?, emoji = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(title, notes, completed, priority, emoji, updatedAt, id)
    .run();

  const updated = await getTodo(env, id);
  return json({ todo: toTodo(updated) });
}

async function deleteTodo(env: Env, id: string): Promise<Response> {
  const existing = await getTodo(env, id);
  if (existing.attachment_key) {
    await env.TODO_BUCKET.delete(existing.attachment_key);
  }

  await env.TODO_DB.prepare("DELETE FROM todos WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function uploadAttachment(request: Request, env: Env, id: string): Promise<Response> {
  const existing = await getTodo(env, id);
  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return json({ error: "Upload a file using multipart field 'file'." }, 400);
  }

  const maxBytes = getMaxAttachmentBytes(env);
  if (file.size > maxBytes) {
    return json({ error: `Attachment is too large. Max size is ${maxBytes} bytes.` }, 413);
  }

  if (existing.attachment_key) {
    await env.TODO_BUCKET.delete(existing.attachment_key);
  }

  const safeName = sanitizeFileName(file.name || "quest-prize");
  const key = `todos/${id}/${crypto.randomUUID()}-${safeName}`;
  await env.TODO_BUCKET.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: { todoId: id, originalName: safeName }
  });

  await env.TODO_DB.prepare(
    `UPDATE todos
     SET attachment_key = ?, attachment_name = ?, attachment_type = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(key, safeName, file.type || "application/octet-stream", new Date().toISOString(), id)
    .run();

  const updated = await getTodo(env, id);
  return json({ todo: toTodo(updated) });
}

async function downloadAttachment(env: Env, id: string): Promise<Response> {
  const todo = await getTodo(env, id);
  if (!todo.attachment_key) {
    return json({ error: "This quest has no attachment." }, 404);
  }

  const object = await env.TODO_BUCKET.get(todo.attachment_key);
  if (!object) {
    return json({ error: "Attachment was not found in R2." }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-disposition", `inline; filename="${encodeHeaderValue(todo.attachment_name || "attachment")}"`);
  return new Response(object.body, { headers });
}

async function deleteAttachment(env: Env, id: string): Promise<Response> {
  const todo = await getTodo(env, id);
  if (todo.attachment_key) {
    await env.TODO_BUCKET.delete(todo.attachment_key);
  }

  await env.TODO_DB.prepare(
    `UPDATE todos
     SET attachment_key = NULL, attachment_name = NULL, attachment_type = NULL, updated_at = ?
     WHERE id = ?`
  )
    .bind(new Date().toISOString(), id)
    .run();

  const updated = await getTodo(env, id);
  return json({ todo: toTodo(updated) });
}

async function adminStats(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN) {
    return json({ error: "ADMIN_TOKEN is not configured." }, 503);
  }

  const auth = request.headers.get("authorization");
  const headerToken = request.headers.get("x-admin-token");
  const bearerToken = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  if (bearerToken !== env.ADMIN_TOKEN && headerToken !== env.ADMIN_TOKEN) {
    return json({ error: "Unauthorized" }, 401);
  }

  const stats = await env.TODO_DB.prepare(
    `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN attachment_key IS NOT NULL THEN 1 ELSE 0 END) AS with_attachments
     FROM todos`
  ).first<{ total: number; completed: number | null; with_attachments: number | null }>();

  return json({
    total: stats?.total || 0,
    completed: stats?.completed || 0,
    withAttachments: stats?.with_attachments || 0,
    theme: await getTheme(env),
    vibe: await getDailyVibe(env)
  });
}

async function getTodo(env: Env, id: string): Promise<TodoRow> {
  const todo = await env.TODO_DB.prepare("SELECT * FROM todos WHERE id = ?").bind(id).first<TodoRow>();
  if (!todo) {
    throw new HttpError("Quest not found.", 404);
  }

  return todo;
}

async function getTheme(env: Env): Promise<Theme> {
  const stored = await env.TODO_KV.get("app:theme");
  if (stored && isTheme(stored)) {
    return stored;
  }

  return isTheme(env.DEFAULT_THEME) ? env.DEFAULT_THEME : "cosmic-candy";
}

async function getDailyVibe(env: Env): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `app:vibe:${day}`;
  const existing = await env.TODO_KV.get(key);
  if (existing) {
    return existing;
  }

  const vibe = vibes[Math.floor(Math.random() * vibes.length)];
  await env.TODO_KV.put(key, vibe, { expirationTtl: 60 * 60 * 48 });
  return vibe;
}

function toTodo(row: TodoRow) {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    completed: row.completed === 1,
    priority: row.priority,
    emoji: row.emoji,
    attachment: row.attachment_key
      ? {
          name: row.attachment_name,
          type: row.attachment_type,
          url: `/api/todos/${encodeURIComponent(row.id)}/attachment`
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError("Request body must be valid JSON.", 400);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeEmoji(value: unknown): string {
  const text = normalizeText(value, 8);
  return text || emojiPool[Math.floor(Math.random() * emojiPool.length)];
}

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && themes.includes(value as Theme);
}

function isPriority(value: unknown): value is Priority {
  return typeof value === "string" && priorities.includes(value as Priority);
}

function getMaxAttachmentBytes(env: Env): number {
  const parsed = Number.parseInt(env.MAX_ATTACHMENT_BYTES || "1048576", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1048576;
}

function sanitizeFileName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 80);
  return sanitized || "quest-prize";
}

function encodeHeaderValue(value: string): string {
  return value.replace(/["\\\r\n]/g, "_");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-admin-token"
  };
}

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function renderApp(env: Env): string {
  const appName = escapeHtml(env.APP_NAME || "Quest List");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${appName}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #fff7ad;
      --panel: rgba(255, 255, 255, 0.76);
      --ink: #221536;
      --muted: #6c5a7f;
      --primary: #ff4fb8;
      --secondary: #5b35ff;
      --accent: #00c2ff;
      --good: #00b894;
      --danger: #ff3864;
      --shadow: 0 24px 70px rgba(61, 24, 93, 0.22);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    body[data-theme="jungle-pop"] {
      --bg: #d7ff70;
      --panel: rgba(246, 255, 225, 0.82);
      --ink: #0d311f;
      --muted: #4d7349;
      --primary: #f36f21;
      --secondary: #168b4b;
      --accent: #13bdb4;
      --good: #168b4b;
      --danger: #e94343;
      --shadow: 0 24px 70px rgba(15, 88, 37, 0.2);
    }

    body[data-theme="midnight-arcade"] {
      color-scheme: dark;
      --bg: #09071f;
      --panel: rgba(23, 20, 58, 0.86);
      --ink: #f8f7ff;
      --muted: #b8afe8;
      --primary: #ff4fd8;
      --secondary: #8e7dff;
      --accent: #00f0ff;
      --good: #54ffa6;
      --danger: #ff6b8a;
      --shadow: 0 24px 70px rgba(0, 240, 255, 0.13);
    }

    * { box-sizing: border-box; }

    body {
      min-height: 100vh;
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, color-mix(in srgb, var(--primary), transparent 58%), transparent 34rem),
        radial-gradient(circle at bottom right, color-mix(in srgb, var(--accent), transparent 50%), transparent 30rem),
        linear-gradient(135deg, var(--bg), color-mix(in srgb, var(--bg), white 20%));
    }

    button, input, textarea, select {
      font: inherit;
    }

    button {
      border: 0;
      cursor: pointer;
    }

    .shell {
      width: min(1160px, calc(100% - 28px));
      margin: 0 auto;
      padding: 34px 0 48px;
    }

    .hero {
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      gap: 18px;
      align-items: stretch;
      margin-bottom: 18px;
    }

    .hero-card, .composer, .board, .stat-card {
      border: 2px solid color-mix(in srgb, var(--ink), transparent 88%);
      border-radius: 30px;
      background: var(--panel);
      box-shadow: var(--shadow);
      backdrop-filter: blur(16px);
    }

    .hero-card {
      position: relative;
      overflow: hidden;
      padding: 32px;
    }

    .hero-card:after {
      content: "";
      position: absolute;
      inset: auto -70px -120px auto;
      width: 260px;
      height: 260px;
      border-radius: 999px;
      background: repeating-conic-gradient(from 20deg, var(--primary) 0 14deg, var(--accent) 14deg 28deg, var(--secondary) 28deg 42deg);
      opacity: 0.28;
      animation: spin 18s linear infinite;
    }

    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--accent), transparent 82%);
      color: var(--ink);
      font-weight: 800;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      font-size: 0.76rem;
    }

    h1 {
      position: relative;
      z-index: 1;
      margin: 18px 0 10px;
      max-width: 760px;
      font-size: clamp(3rem, 9vw, 7.6rem);
      line-height: 0.82;
      letter-spacing: -0.09em;
    }

    .hero p {
      position: relative;
      z-index: 1;
      max-width: 650px;
      margin: 0;
      color: var(--muted);
      font-size: 1.08rem;
    }

    .controls {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 14px;
    }

    .stat-card {
      padding: 20px;
    }

    .stat-card strong {
      display: block;
      margin-top: 8px;
      font-size: 2.1rem;
      line-height: 1;
    }

    .stat-card span {
      color: var(--muted);
      font-size: 0.9rem;
      font-weight: 700;
    }

    .theme-card {
      grid-column: span 2;
    }

    .theme-card select {
      width: 100%;
      margin-top: 10px;
      padding: 13px 14px;
      border: 2px solid color-mix(in srgb, var(--secondary), transparent 65%);
      border-radius: 16px;
      color: var(--ink);
      background: color-mix(in srgb, var(--panel), white 22%);
      font-weight: 800;
    }

    .layout {
      display: grid;
      grid-template-columns: 380px 1fr;
      gap: 18px;
      align-items: start;
    }

    .composer {
      position: sticky;
      top: 18px;
      padding: 22px;
    }

    .composer h2, .board h2 {
      margin: 0 0 14px;
      font-size: 1.55rem;
      letter-spacing: -0.04em;
    }

    .field {
      display: grid;
      gap: 7px;
      margin-bottom: 14px;
    }

    label {
      color: var(--muted);
      font-size: 0.83rem;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    input[type="text"], textarea, select {
      width: 100%;
      border: 2px solid color-mix(in srgb, var(--ink), transparent 84%);
      border-radius: 18px;
      padding: 13px 14px;
      color: var(--ink);
      background: color-mix(in srgb, var(--panel), white 28%);
      outline: none;
      transition: border-color 150ms, transform 150ms;
    }

    textarea {
      min-height: 94px;
      resize: vertical;
    }

    input:focus, textarea:focus, select:focus {
      border-color: var(--accent);
      transform: translateY(-1px);
    }

    .mini-grid {
      display: grid;
      grid-template-columns: 100px 1fr;
      gap: 10px;
    }

    .primary-btn, .ghost-btn, .danger-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      border-radius: 16px;
      padding: 11px 14px;
      font-weight: 950;
      transition: transform 150ms, filter 150ms;
    }

    .primary-btn {
      width: 100%;
      color: white;
      background: linear-gradient(135deg, var(--primary), var(--secondary));
      box-shadow: 0 13px 26px color-mix(in srgb, var(--primary), transparent 72%);
    }

    .ghost-btn {
      color: var(--ink);
      background: color-mix(in srgb, var(--accent), transparent 78%);
    }

    .danger-btn {
      color: white;
      background: var(--danger);
    }

    button:hover {
      transform: translateY(-2px) rotate(-0.4deg);
      filter: saturate(1.1);
    }

    .board {
      min-height: 520px;
      padding: 22px;
    }

    .board-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }

    .progress-wrap {
      width: min(280px, 42vw);
      height: 16px;
      overflow: hidden;
      border: 2px solid color-mix(in srgb, var(--ink), transparent 86%);
      border-radius: 999px;
      background: color-mix(in srgb, var(--panel), transparent 10%);
    }

    .progress {
      width: 0%;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--good), var(--accent), var(--primary));
      transition: width 300ms ease;
    }

    .todos {
      display: grid;
      gap: 13px;
    }

    .todo {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 14px;
      padding: 16px;
      border: 2px solid color-mix(in srgb, var(--ink), transparent 88%);
      border-radius: 24px;
      background: color-mix(in srgb, var(--panel), white 16%);
    }

    .todo.done {
      opacity: 0.7;
    }

    .emoji {
      display: grid;
      place-items: center;
      width: 54px;
      height: 54px;
      border-radius: 18px;
      background: linear-gradient(135deg, color-mix(in srgb, var(--accent), transparent 45%), color-mix(in srgb, var(--primary), transparent 45%));
      font-size: 1.7rem;
    }

    .todo h3 {
      margin: 1px 0 6px;
      font-size: 1.15rem;
    }

    .todo.done h3 {
      text-decoration: line-through;
    }

    .notes {
      margin: 0 0 10px;
      color: var(--muted);
      white-space: pre-wrap;
    }

    .meta, .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      border-radius: 999px;
      padding: 6px 10px;
      background: color-mix(in srgb, var(--secondary), transparent 82%);
      color: var(--ink);
      font-size: 0.78rem;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .actions {
      margin-top: 12px;
    }

    .actions button, .file-label {
      min-height: 38px;
      border-radius: 14px;
      padding: 9px 11px;
      font-size: 0.88rem;
      font-weight: 900;
    }

    .file-label {
      display: inline-flex;
      align-items: center;
      background: color-mix(in srgb, var(--primary), transparent 82%);
      cursor: pointer;
    }

    .file-label input {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }

    .empty {
      display: grid;
      place-items: center;
      min-height: 330px;
      border: 2px dashed color-mix(in srgb, var(--ink), transparent 75%);
      border-radius: 24px;
      color: var(--muted);
      text-align: center;
      padding: 28px;
    }

    .toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 3;
      max-width: 360px;
      border-radius: 18px;
      padding: 13px 15px;
      color: white;
      background: linear-gradient(135deg, var(--secondary), var(--primary));
      box-shadow: var(--shadow);
      transform: translateY(140%);
      transition: transform 220ms;
      font-weight: 800;
    }

    .toast.show { transform: translateY(0); }

    .confetti {
      position: fixed;
      inset: 0;
      pointer-events: none;
      overflow: hidden;
    }

    .confetti i {
      position: absolute;
      top: -20px;
      width: 10px;
      height: 16px;
      border-radius: 5px;
      background: var(--primary);
      animation: fall 1100ms ease-in forwards;
    }

    @keyframes spin { to { transform: rotate(1turn); } }
    @keyframes fall { to { transform: translateY(110vh) rotate(620deg); opacity: 0; } }

    @media (max-width: 860px) {
      .hero, .layout { grid-template-columns: 1fr; }
      .composer { position: static; }
      .controls { grid-template-columns: 1fr 1fr; }
    }

    @media (max-width: 560px) {
      .shell { width: min(100% - 18px, 1160px); padding-top: 14px; }
      .hero-card, .composer, .board, .stat-card { border-radius: 22px; }
      .hero-card { padding: 22px; }
      .controls { grid-template-columns: 1fr; }
      .theme-card { grid-column: auto; }
      .board-head { align-items: flex-start; flex-direction: column; }
      .progress-wrap { width: 100%; }
      .todo { grid-template-columns: 1fr; }
      .mini-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body data-theme="cosmic-candy">
  <div class="shell">
    <section class="hero">
      <div class="hero-card">
        <span class="eyebrow">R2 loot + KV vibes + D1 quests</span>
        <h1>${appName}</h1>
        <p id="vibe">Loading today&apos;s vibe...</p>
      </div>
      <div class="controls">
        <div class="stat-card"><span>Total quests</span><strong id="total">0</strong></div>
        <div class="stat-card"><span>Vanquished</span><strong id="completed">0</strong></div>
        <div class="stat-card theme-card">
          <span>Theme stored in KV</span>
          <select id="themeSelect" aria-label="Theme"></select>
        </div>
      </div>
    </section>

    <main class="layout">
      <form class="composer" id="todoForm">
        <h2>Summon a quest</h2>
        <div class="field">
          <label for="title">Quest title</label>
          <input id="title" name="title" type="text" maxlength="120" placeholder="Defeat inbox dragon" required>
        </div>
        <div class="field">
          <label for="notes">Quest notes</label>
          <textarea id="notes" name="notes" maxlength="500" placeholder="Optional clues, spells, or snack reminders"></textarea>
        </div>
        <div class="mini-grid">
          <div class="field">
            <label for="emoji">Emoji</label>
            <input id="emoji" name="emoji" type="text" maxlength="8" placeholder="✨">
          </div>
          <div class="field">
            <label for="priority">Difficulty</label>
            <select id="priority" name="priority">
              <option value="spark">Spark</option>
              <option value="zap">Zap</option>
              <option value="boss">Boss fight</option>
            </select>
          </div>
        </div>
        <button class="primary-btn" type="submit">Add quest</button>
      </form>

      <section class="board">
        <div class="board-head">
          <h2>Quest board</h2>
          <div class="progress-wrap" title="Completion progress"><div class="progress" id="progress"></div></div>
        </div>
        <div class="todos" id="todos"></div>
      </section>
    </main>
  </div>

  <div class="toast" id="toast"></div>
  <div class="confetti" id="confetti"></div>

  <script>
    const state = { todos: [], config: null };
    const $ = (selector) => document.querySelector(selector);

    const priorityLabels = {
      spark: "Spark",
      zap: "Zap",
      boss: "Boss fight"
    };

    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: options.body instanceof FormData
          ? options.headers
          : { "content-type": "application/json", ...(options.headers || {}) }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "The quest gremlins caused trouble.");
      return data;
    }

    async function init() {
      const [config, todos] = await Promise.all([
        api("/api/config"),
        api("/api/todos")
      ]);
      state.config = config;
      state.todos = todos.todos;
      document.body.dataset.theme = config.theme;
      $("#vibe").textContent = config.vibe;
      renderThemes();
      renderTodos();
    }

    function renderThemes() {
      const select = $("#themeSelect");
      select.innerHTML = state.config.themes.map((theme) => {
        const label = theme.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
        return '<option value="' + escapeHtml(theme) + '">' + escapeHtml(label) + '</option>';
      }).join("");
      select.value = state.config.theme;
    }

    function renderTodos() {
      const total = state.todos.length;
      const completed = state.todos.filter((todo) => todo.completed).length;
      $("#total").textContent = total;
      $("#completed").textContent = completed;
      $("#progress").style.width = total ? Math.round((completed / total) * 100) + "%" : "0%";

      const container = $("#todos");
      if (!total) {
        container.innerHTML = '<div class="empty"><div><h3>No quests yet</h3><p>Summon your first tiny adventure from the left panel.</p></div></div>';
        return;
      }

      container.innerHTML = state.todos.map((todo) => {
        const notesHtml = todo.notes ? '<p class="notes">' + escapeHtml(todo.notes) + '</p>' : "";
        const attachmentHtml = todo.attachment
          ? '<a class="pill" href="' + escapeHtml(todo.attachment.url) + '" target="_blank" rel="noreferrer">Loot: ' + escapeHtml(todo.attachment.name || "attachment") + '</a>'
          : '<span class="pill">No loot yet</span>';
        const deleteAttachmentHtml = todo.attachment ? '<button class="ghost-btn" data-action="delete-attachment">Drop loot</button>' : "";

        return [
          '<article class="todo ' + (todo.completed ? "done" : "") + '" data-id="' + escapeHtml(todo.id) + '">',
          '<div class="emoji">' + escapeHtml(todo.emoji) + '</div>',
          '<div>',
          '<h3>' + escapeHtml(todo.title) + '</h3>',
          notesHtml,
          '<div class="meta">',
          '<span class="pill">' + escapeHtml(priorityLabels[todo.priority] || todo.priority) + '</span>',
          attachmentHtml,
          '</div>',
          '<div class="actions">',
          '<button class="ghost-btn" data-action="toggle">' + (todo.completed ? "Revive" : "Vanquish") + '</button>',
          '<label class="file-label">Add loot<input type="file" data-action="upload"></label>',
          deleteAttachmentHtml,
          '<button class="danger-btn" data-action="delete">Banish</button>',
          '</div>',
          '</div>',
          '</article>'
        ].join("");
      }).join("");
    }

    async function refreshTodos() {
      const data = await api("/api/todos");
      state.todos = data.todos;
      renderTodos();
    }

    $("#todoForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const formEl = event.currentTarget;
      const form = new FormData(formEl);
      try {
        await api("/api/todos", {
          method: "POST",
          body: JSON.stringify({
            title: form.get("title"),
            notes: form.get("notes"),
            emoji: form.get("emoji"),
            priority: form.get("priority")
          })
        });
        formEl.reset();
        await refreshTodos();
        toast("Quest summoned.");
      } catch (error) {
        toast(error.message);
      }
    });

    $("#themeSelect").addEventListener("change", async (event) => {
      const select = event.currentTarget;
      const theme = select.value;
      document.body.dataset.theme = theme;
      try {
        await api("/api/theme", { method: "POST", body: JSON.stringify({ theme }) });
        toast("Theme saved to KV.");
      } catch (error) {
        toast(error.message);
      }
    });

    $("#todos").addEventListener("click", async (event) => {
      const target = event.target;
      const button = target && target.closest ? target.closest("button") : null;
      if (!button) return;
      const card = button.closest(".todo");
      if (!card) return;
      const todo = state.todos.find((item) => item.id === card.dataset.id);
      if (!todo) return;

      try {
        if (button.dataset.action === "toggle") {
          await api("/api/todos/" + encodeURIComponent(todo.id), {
            method: "PATCH",
            body: JSON.stringify({ completed: !todo.completed })
          });
          if (!todo.completed) burstConfetti();
          await refreshTodos();
        }

        if (button.dataset.action === "delete") {
          await api("/api/todos/" + encodeURIComponent(todo.id), { method: "DELETE" });
          await refreshTodos();
          toast("Quest banished.");
        }

        if (button.dataset.action === "delete-attachment") {
          await api("/api/todos/" + encodeURIComponent(todo.id) + "/attachment", { method: "DELETE" });
          await refreshTodos();
          toast("Loot dropped.");
        }
      } catch (error) {
        toast(error.message);
      }
    });

    $("#todos").addEventListener("change", async (event) => {
      const input = event.target;
      if (!input || !input.dataset || !input.files) return;
      if (input.dataset.action !== "upload") return;
      const card = input.closest(".todo");
      const todoId = card && card.dataset.id;
      const file = input.files[0];
      if (!todoId) return;
      if (!file) return;
      if (file.size > state.config.maxAttachmentBytes) {
        toast("Loot is too mighty. Max " + state.config.maxAttachmentBytes + " bytes.");
        input.value = "";
        return;
      }

      const body = new FormData();
      body.append("file", file);
      try {
        await api("/api/todos/" + encodeURIComponent(todoId) + "/attachment", { method: "POST", body });
        await refreshTodos();
        toast("Loot stashed in R2.");
      } catch (error) {
        toast(error.message);
      } finally {
        input.value = "";
      }
    });

    function toast(message) {
      const el = $("#toast");
      el.textContent = message;
      el.classList.add("show");
      clearTimeout(window.toastTimer);
      window.toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
    }

    function burstConfetti() {
      const root = $("#confetti");
      root.innerHTML = Array.from({ length: 42 }, (_, index) => {
        const left = Math.random() * 100;
        const delay = Math.random() * 240;
        const color = ["var(--primary)", "var(--accent)", "var(--secondary)", "var(--good)"][index % 4];
        return '<i style="left:' + left + '%; animation-delay:' + delay + 'ms; background:' + color + '"></i>';
      }).join("");
      setTimeout(() => root.innerHTML = "", 1500);
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"]/g, (char) => {
        if (char === "&") return "&amp;";
        if (char === "<") return "&lt;";
        if (char === ">") return "&gt;";
        return "&quot;";
      });
    }

    init().catch((error) => toast(error.message));
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char] || char);
}

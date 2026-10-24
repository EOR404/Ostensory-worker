/**
 * Ostensory Worker
 *
 * A small, self-contained image host for Cloudflare:
 *   - R2 stores the original files
 *   - D1 stores image metadata
 *   - Static assets under public/ provide the gallery and upload UI
 *   - /api/storage/* is a private object gateway used by Ostensory-server
 *
 * Required bindings: BUCKET (R2), DB (D1), ASSETS (static assets)
 * Required secret:   ADMIN_TOKEN
 */

const IMAGE_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);
const MAX_FILES = 20;
const DEFAULT_MAX_UPLOAD_MB = 20;
const DEFAULT_MAX_STORAGE_MB = 100;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(env) });
      }
      if (url.pathname === "/api/health") {
        return json({
          ok: true,
          service: "Ostensory-worker",
          upload_enabled: Boolean(env.ADMIN_TOKEN) || env.PUBLIC_UPLOAD === "1",
          public_upload: env.PUBLIC_UPLOAD === "1",
        }, 200, env);
      }
      if (url.pathname.startsWith("/api/storage/")) {
        return storageGateway(request, env, url);
      }
      if (url.pathname.startsWith("/api/")) {
        return api(request, env, url);
      }
      if (url.pathname.startsWith("/i/")) {
        return serveImage(request, env, url);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, 500, env);
    }
  },
};

async function api(request, env, url) {
  if (url.pathname === "/api/images" && request.method === "GET") {
    return listImages(env, url);
  }
  if (url.pathname === "/api/upload" && request.method === "POST") {
    return uploadImages(request, env);
  }
  const deleteMatch = url.pathname.match(/^\/api\/images\/([^/]+)$/);
  if (deleteMatch && request.method === "DELETE") {
    return deleteImage(request, env, decodeURIComponent(deleteMatch[1]));
  }
  return json({ error: "Not found" }, 404, env);
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Admin-Token",
    "Access-Control-Max-Age": "86400",
  };
}

function json(value, status, env) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(env),
    },
  });
}

function authorized(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const bearer = request.headers.get("authorization") || "";
  const supplied = bearer.toLowerCase().startsWith("bearer ")
    ? bearer.slice(7).trim()
    : (request.headers.get("x-admin-token") || "").trim();
  return constantTimeEqual(supplied, env.ADMIN_TOKEN);
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a[i] || 0) ^ (b[i] || 0);
  }
  return diff === 0;
}

function requireAdmin(request, env) {
  if (env.PUBLIC_UPLOAD === "1" && request.method === "POST") return null;
  if (authorized(request, env)) return null;
  return json({ error: "需要管理员 Token" }, 401, env);
}

function cleanKey(raw) {
  const key = (raw || "").replace(/^\/+/, "");
  if (!key || key.split("/").some((part) => part === ".." || part === "")) {
    return null;
  }
  return key;
}

function safeName(value, fallback = "image") {
  const name = String(value || "").split(/[\\/]/).pop().trim();
  return name || fallback;
}

function extensionFor(file) {
  const byType = IMAGE_TYPES.get(file.type);
  if (byType) return byType;
  const name = safeName(file.name);
  const match = name.match(/\.([a-z0-9]+)$/i);
  const ext = match ? match[1].toLowerCase() : "";
  return ext === "jpeg" ? "jpg" : ext;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function uploadImages(request, env) {
  const authError = requireAdmin(request, env);
  if (authError) return authError;

  const maxMb = Number(env.MAX_UPLOAD_MB || DEFAULT_MAX_UPLOAD_MB);
  const maxBytes = Math.max(1, maxMb) * 1024 * 1024;
  const form = await request.formData();
  const files = [...form.getAll("files"), ...form.getAll("file")].filter(
    (item) => item && typeof item === "object" && "arrayBuffer" in item,
  );
  if (files.length === 0) {
    return json({ error: "没有收到文件" }, 400, env);
  }
  if (files.length > MAX_FILES) {
    return json({ error: `一次最多上传 ${MAX_FILES} 个文件` }, 400, env);
  }

  const created = [];
  const duplicates = [];
  const errors = [];
  for (const file of files) {
    const filename = safeName(file.name);
    const ext = extensionFor(file);
    if (!IMAGE_TYPES.has(file.type) || !["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
      errors.push(`${filename}: 只支持 PNG/JPG/WebP/GIF`);
      continue;
    }
    if (file.size > maxBytes) {
      errors.push(`${filename}: 超过 ${maxMb} MB`);
      continue;
    }
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      errors.push(`${filename}: 读取失败`);
      continue;
    }
    if (bytes.byteLength === 0) {
      errors.push(`${filename}: 空文件`);
      continue;
    }
    const normalizedExt = ext === "jpeg" ? "jpg" : ext;
    const sha = await sha256Hex(bytes);
    const existing = await env.DB.prepare(
      "SELECT id, object_key, filename, mime, size, created_at FROM images WHERE sha256 = ? LIMIT 1",
    ).bind(sha).first();
    if (existing) {
      duplicates.push({ ...existing, url: `/i/${existing.id}` });
      continue;
    }
    const objectKey = `images/${sha.slice(0, 2)}/${sha}.${normalizedExt}`;
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await env.BUCKET.put(objectKey, bytes, {
      httpMetadata: {
        contentType: file.type,
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
    try {
      await env.DB.prepare(
        "INSERT INTO images(id, sha256, object_key, filename, mime, size, created_at) VALUES(?,?,?,?,?,?,?)",
      ).bind(id, sha, objectKey, filename, file.type, bytes.byteLength, createdAt).run();
    } catch (error) {
      await env.BUCKET.delete(objectKey).catch(() => {});
      throw error;
    }
    created.push({
      id,
      filename,
      mime: file.type,
      size: bytes.byteLength,
      created_at: createdAt,
      url: `/i/${id}`,
    });
  }

  const status = created.length || duplicates.length ? 200 : 400;
  return json({ created, duplicates, errors }, status, env);
}

async function listImages(env, url) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 48)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const { results } = await env.DB.prepare(
    "SELECT id, filename, mime, size, created_at FROM images ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
  ).bind(limit, offset).all();
  const items = (results || []).map((row) => ({ ...row, url: `/i/${row.id}` }));
  return json({ items, next_offset: items.length === limit ? offset + limit : null }, 200, env);
}

async function deleteImage(request, env, id) {
  const authError = requireAdmin(request, env);
  if (authError) return authError;
  const row = await env.DB.prepare(
    "SELECT object_key FROM images WHERE id = ?",
  ).bind(id).first();
  if (!row) return json({ error: "图片不存在" }, 404, env);
  await env.BUCKET.delete(row.object_key);
  await env.DB.prepare("DELETE FROM images WHERE id = ?").bind(id).run();
  return json({ ok: true }, 200, env);
}

async function serveImage(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "Method not allowed" }, 405, env);
  }
  const id = decodeURIComponent(url.pathname.slice(3));
  if (!id) return json({ error: "Not found" }, 404, env);
  const row = await env.DB.prepare(
    "SELECT object_key, mime, size, created_at FROM images WHERE id = ?",
  ).bind(id).first();
  if (!row) return json({ error: "图片不存在" }, 404, env);
  const object = request.method === "HEAD"
    ? await env.BUCKET.head(row.object_key)
    : await env.BUCKET.get(row.object_key);
  if (!object) return json({ error: "文件不存在" }, 404, env);
  const headers = new Headers({
    "Content-Type": row.mime || "application/octet-stream",
    "Content-Length": String(row.size || object.size || 0),
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "ETag": `"${row.object_key}"`,
  });
  if (request.method === "HEAD") {
    return new Response(null, { headers });
  }
  return new Response(object.body, { headers });
}

async function storageGateway(request, env, url) {
  const authError = requireAdmin(request, env);
  if (authError) return authError;
  const rawKey = url.pathname.slice("/api/storage/".length);
  const key = cleanKey(decodeURIComponent(rawKey));
  if (!key) return json({ error: "非法路径" }, 400, env);
  const objectKey = `storage/${key}`;

  if (request.method === "PUT") {
    const maxMb = Number(env.MAX_STORAGE_MB || DEFAULT_MAX_STORAGE_MB);
    const maxBytes = Math.max(1, maxMb) * 1024 * 1024;
    const length = Number(request.headers.get("content-length") || 0);
    if (length > maxBytes) return json({ error: "文件过大" }, 413, env);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) return json({ error: "空文件" }, 400, env);
    if (bytes.byteLength > maxBytes) return json({ error: "文件过大" }, 413, env);
    await env.BUCKET.put(objectKey, bytes, {
      httpMetadata: {
        contentType: request.headers.get("content-type") || "application/octet-stream",
        cacheControl: "private, max-age=31536000, immutable",
      },
    });
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const object = request.method === "HEAD"
      ? await env.BUCKET.head(objectKey)
      : await env.BUCKET.get(objectKey);
    if (!object) return json({ error: "文件不存在" }, 404, env);
    const headers = new Headers({
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Length": String(object.size || 0),
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(env),
    });
    if (request.method === "HEAD") return new Response(null, { headers });
    return new Response(object.body, { headers });
  }
  if (request.method === "DELETE") {
    await env.BUCKET.delete(objectKey);
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }
  return json({ error: "Method not allowed" }, 405, env);
}
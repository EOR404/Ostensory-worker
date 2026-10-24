-- Ostensory Worker schema (Cloudflare D1)
CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_images_created
    ON images(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_images_sha
    ON images(sha256);
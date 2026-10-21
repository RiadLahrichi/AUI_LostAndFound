-- Found in AUI: database schema
--
-- Running this file deletes the tables and creates them again, empty.
-- Business rules from the original design (CSC 3326 report):
--   * a user can report many items, an item is reported by one user
--   * every item belongs to one category, categories can have subcategories
--   * an item can have many photos
--   * an item can have only one active claim at a time
--   * a user receives notifications, and a notification can point to an item

CREATE EXTENSION IF NOT EXISTS vector;  -- pgvector: adds the "vector" column type

DROP VIEW IF EXISTS item_details, claimed_items;
DROP TABLE IF EXISTS notifications, claims, photos, items, categories, users CASCADE;


-- "user" is a reserved word in PostgreSQL, so the table is called "users".
CREATE TABLE users (
    user_id       SERIAL PRIMARY KEY,
    first_name    VARCHAR(100) NOT NULL,
    last_name     VARCHAR(100) NOT NULL,
    email         VARCHAR(255) NOT NULL UNIQUE CHECK (email LIKE '%@aui.ma'),
    password_hash VARCHAR(255) NOT NULL,  -- never the password itself, only its bcrypt hash
    role          VARCHAR(20)  NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'staff', 'admin')),
    created_at    TIMESTAMP    NOT NULL DEFAULT NOW()
);


-- A category can have a parent category: "Phones" is inside "Electronics".
-- parent_id points back to this same table (a recursive relationship).
CREATE TABLE categories (
    category_id SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL UNIQUE,
    parent_id   INTEGER REFERENCES categories (category_id)
);


-- Lost items and found items live in the same table. "kind" says which one it is,
-- so a lost item and a found item can be compared with each other.
CREATE TABLE items (
    item_id     SERIAL PRIMARY KEY,
    kind        VARCHAR(5)   NOT NULL CHECK (kind IN ('lost', 'found')),
    title       VARCHAR(150) NOT NULL,
    description TEXT         NOT NULL,
    category_id INTEGER      NOT NULL REFERENCES categories (category_id),
    location    VARCHAR(150) NOT NULL,
    event_date  DATE         NOT NULL,  -- the day it was lost, or the day it was found
    status      VARCHAR(10)  NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'returned')),
    reported_by INTEGER      NOT NULL REFERENCES users (user_id),
    -- 384 numbers that describe the meaning of the title and description.
    -- They come from the all-MiniLM-L6-v2 model (see src/embeddings.js).
    embedding   vector(384),
    created_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);


CREATE TABLE photos (
    photo_id    SERIAL PRIMARY KEY,
    item_id     INTEGER      NOT NULL REFERENCES items (item_id) ON DELETE CASCADE,
    file_path   VARCHAR(255) NOT NULL,
    uploaded_at TIMESTAMP    NOT NULL DEFAULT NOW()
);


-- Someone saying "this found item is mine". The finder approves or rejects it.
CREATE TABLE claims (
    claim_id    SERIAL PRIMARY KEY,
    item_id     INTEGER     NOT NULL REFERENCES items (item_id) ON DELETE CASCADE,
    claimant_id INTEGER     NOT NULL REFERENCES users (user_id),
    message     TEXT        NOT NULL,  -- proof of ownership, e.g. "it has a red sticker on the back"
    status      VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at  TIMESTAMP   NOT NULL DEFAULT NOW()
);

-- Business rule: an item can have only one active claim at a time.
-- A normal UNIQUE constraint would forbid a second claim forever. This "partial" index
-- only looks at pending and approved claims, so a new claim is allowed after a rejection.
CREATE UNIQUE INDEX one_active_claim_per_item ON claims (item_id)
    WHERE status IN ('pending', 'approved');


CREATE TABLE notifications (
    notification_id SERIAL PRIMARY KEY,
    user_id         INTEGER   NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    item_id         INTEGER   REFERENCES items (item_id) ON DELETE CASCADE,  -- optional
    message         TEXT      NOT NULL,
    is_read         BOOLEAN   NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);


-- Indexes for the most common lookups.
CREATE INDEX items_kind_status ON items (kind, status);
CREATE INDEX notifications_user ON notifications (user_id, is_read);

-- HNSW index for vector search. Without it, PostgreSQL compares the search vector with
-- every row. With it, it finds the closest vectors quickly, at the cost of being
-- approximate. It only starts to matter with thousands of items.
CREATE INDEX items_embedding ON items USING hnsw (embedding vector_cosine_ops);

-- Index for keyword search (full-text search). It must use exactly the same
-- expression as the keyword search in src/search.js, or PostgreSQL won't use it.
CREATE INDEX items_text ON items USING gin (to_tsvector('english', title || ' ' || description));


-- A category and all its subcategories, at any depth: category_tree(1) returns
-- Electronics, Phones, Headphones... It follows parent_id with a recursive query.
CREATE OR REPLACE FUNCTION category_tree(root_id INTEGER) RETURNS SETOF INTEGER AS $$
    WITH RECURSIVE tree AS (
        SELECT category_id FROM categories WHERE category_id = root_id
        UNION ALL
        SELECT c.category_id FROM categories c JOIN tree t ON c.parent_id = t.category_id
    )
    SELECT category_id FROM tree;
$$ LANGUAGE sql;


-- Every item with its category name and the name of the person who reported it.
-- The API reads from this view instead of repeating the same joins everywhere.
CREATE VIEW item_details AS
SELECT i.item_id, i.kind, i.title, i.description, i.location, i.event_date, i.status,
       i.created_at, i.reported_by, i.category_id,
       c.name AS category,
       u.first_name || ' ' || u.last_name AS reporter_name
FROM items i
JOIN categories c ON c.category_id = i.category_id
JOIN users u ON u.user_id = i.reported_by;


-- Items whose claim was approved, with who claimed them (fixed version of the original view).
CREATE VIEW claimed_items AS
SELECT i.item_id, i.title, i.event_date, i.location, c.created_at AS claimed_at,
       u.first_name || ' ' || u.last_name AS claimant_name, u.email AS claimant_email
FROM items i
JOIN claims c ON c.item_id = i.item_id AND c.status = 'approved'
JOIN users u ON u.user_id = c.claimant_id;

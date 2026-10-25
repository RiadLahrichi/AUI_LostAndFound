// The ways to look for items (open items only):
//   listItems      newest first
//   keywordSearch  full-text search, needs shared words ("earbuds" won't find "AirPods")
//   semanticSearch compares embeddings, finds similar meaning
//   similarItems   closest items of the opposite kind to a given item
// kind and categoryId are optional filters, null means no filter.
const { embed, toSql } = require('./embeddings');

// Shared WHERE conditions. $1 is the kind and $2 the category in every query.
const FILTERS = `i.status = 'open'
    AND ($1::text IS NULL OR i.kind = $1)
    AND ($2::int IS NULL OR i.category_id IN (SELECT category_tree($2)))`;

// Results below this similarity are hidden. In the evaluation every right match
// scored above 0.3, and about 60% of unrelated pairs scored below 0.25.
const MIN_SIMILARITY = 0.25;

const PHOTO = `(SELECT p.file_path FROM photos p WHERE p.item_id = i.item_id ORDER BY p.photo_id LIMIT 1) AS photo`;

async function listItems(db, { kind = null, categoryId = null, limit = 20 } = {}) {
    const { rows } = await db.query(`
        SELECT d.*, ${PHOTO}
        FROM items i
        JOIN item_details d ON d.item_id = i.item_id
        WHERE ${FILTERS}
        ORDER BY i.created_at DESC
        LIMIT $3`,
        [kind, categoryId, limit]);
    return rows;
}

async function keywordSearch(db, text, { kind = null, categoryId = null, limit = 20 } = {}) {
    // plainto_tsquery joins the words with & (all words needed). I replace it with |
    // so one shared word is enough, and ts_rank puts items with more shared words first.
    const { rows } = await db.query(`
        SELECT d.*, ${PHOTO}, ts_rank(to_tsvector('english', i.title || ' ' || i.description), query) AS rank
        FROM items i
        JOIN item_details d ON d.item_id = i.item_id
        CROSS JOIN to_tsquery('english', replace(plainto_tsquery('english', $3)::text, '&', '|')) AS query
        WHERE to_tsvector('english', i.title || ' ' || i.description) @@ query
          AND ${FILTERS}
        ORDER BY rank DESC
        LIMIT $4`,
        [kind, categoryId, text, limit]);
    return rows;
}

async function semanticSearch(db, text, { kind = null, categoryId = null, limit = 20 } = {}) {
    const vector = toSql(await embed(text));
    // <=> is cosine distance, so 1 - distance is the similarity
    const { rows } = await db.query(`
        SELECT d.*, ${PHOTO}, 1 - (i.embedding <=> $3::vector) AS similarity
        FROM items i
        JOIN item_details d ON d.item_id = i.item_id
        WHERE i.embedding IS NOT NULL
          AND 1 - (i.embedding <=> $3::vector) >= $5
          AND ${FILTERS}
        ORDER BY i.embedding <=> $3::vector
        LIMIT $4`,
        [kind, categoryId, vector, limit, MIN_SIMILARITY]);
    return rows;
}

async function similarItems(db, itemId, limit = 3) {
    // like semanticSearch, but with the stored embedding of the item
    const { rows } = await db.query(`
        SELECT d.*, ${PHOTO}, 1 - (i.embedding <=> target.embedding) AS similarity
        FROM items target
        JOIN items i ON i.kind <> target.kind
        JOIN item_details d ON d.item_id = i.item_id
        WHERE target.item_id = $1
          AND i.status = 'open'
          AND i.embedding IS NOT NULL
          AND 1 - (i.embedding <=> target.embedding) >= $3
        ORDER BY i.embedding <=> target.embedding
        LIMIT $2`,
        [itemId, limit, MIN_SIMILARITY]);
    return rows;
}

module.exports = { listItems, keywordSearch, semanticSearch, similarItems };

// Categories, items (list, search, details, post, change status).
const express = require('express');
const { pool } = require('../db');
const { embed, itemText, toSql } = require('../embeddings');
const { listItems, keywordSearch, semanticSearch, similarItems } = require('../search');
const { upload } = require('../uploads');
const requireLogin = require('../require-login');

const router = express.Router();

// Turns a value from the URL or a form into a positive whole number, or null
function toId(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}

// Today's date on this computer as YYYY-MM-DD (toISOString would give the UTC date)
function today() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
}

// Only 'lost' and 'found' are valid kinds. Anything else means "both".
function toKind(value) {
    return value === 'lost' || value === 'found' ? value : null;
}

router.get('/categories', async (req, res) => {
    // Subcategories come right after their parent: Electronics, Electronics / Phones, ...
    const { rows } = await pool.query(`
        SELECT c.category_id, c.name, parent.name AS parent
        FROM categories c
        LEFT JOIN categories parent ON parent.category_id = c.parent_id
        ORDER BY COALESCE(parent.name, c.name), c.parent_id NULLS FIRST, c.name`);
    res.json(rows);
});

// Newest open items, for the home page and for browsing by category
router.get('/items', async (req, res) => {
    const items = await listItems(pool, {
        kind: toKind(req.query.kind),
        categoryId: toId(req.query.categoryId),
        limit: Math.min(toId(req.query.limit) || 20, 100),
    });
    res.json(items);
});

// The logged-in user's own items (written before /items/:id, otherwise
// Express would read "mine" as an item id)
router.get('/items/mine', requireLogin, async (req, res) => {
    const { rows } = await pool.query(`
        SELECT d.*,
               (SELECT COUNT(*) FROM claims c WHERE c.item_id = d.item_id AND c.status = 'pending')::int AS pending_claims
        FROM item_details d
        WHERE d.reported_by = $1
        ORDER BY d.created_at DESC`,
        [req.session.userId]);
    res.json(rows);
});

// /api/search?q=black earbuds&mode=semantic&kind=found&categoryId=2
router.get('/search', async (req, res) => {
    const text = (req.query.q || '').trim();
    const filters = { kind: toKind(req.query.kind), categoryId: toId(req.query.categoryId) };

    if (!text) {
        return res.json(await listItems(pool, filters));
    }
    if (req.query.mode === 'keyword') {
        return res.json(await keywordSearch(pool, text, filters));
    }
    res.json(await semanticSearch(pool, text, filters));
});

router.get('/items/:id', async (req, res) => {
    const itemId = toId(req.params.id);
    const { rows } = await pool.query('SELECT * FROM item_details WHERE item_id = $1', [itemId]);
    const item = rows[0];
    if (!item) {
        return res.status(404).json({ error: 'This item does not exist.' });
    }

    const userId = req.session.userId;
    const isOwner = userId === item.reported_by;
    const photos = await pool.query('SELECT file_path FROM photos WHERE item_id = $1 ORDER BY photo_id', [itemId]);
    const similar = await similarItems(pool, itemId, 3);

    // The finder sees every claim on their item. The claimant's email is only
    // shown once the claim is approved.
    let claims = [];
    if (isOwner) {
        const result = await pool.query(`
            SELECT c.claim_id, c.message, c.status, c.created_at,
                   u.first_name || ' ' || u.last_name AS claimant_name,
                   CASE WHEN c.status = 'approved' THEN u.email END AS claimant_email
            FROM claims c JOIN users u ON u.user_id = c.claimant_id
            WHERE c.item_id = $1
            ORDER BY c.created_at DESC`,
            [itemId]);
        claims = result.rows;
    }

    // Other users see their own claim on this item, if they made one
    let myClaim = null;
    if (userId && !isOwner) {
        const result = await pool.query(
            'SELECT status, created_at FROM claims WHERE item_id = $1 AND claimant_id = $2 ORDER BY created_at DESC LIMIT 1',
            [itemId, userId]);
        myClaim = result.rows[0] || null;
    }

    res.json({ item, photos: photos.rows.map((p) => p.file_path), similar, isOwner, claims, myClaim });
});

// Post a lost or found item. The form is sent as multipart/form-data because it can contain a photo.
router.post('/items', requireLogin, upload.single('photo'), async (req, res) => {
    const body = req.body || {};
    const kind = toKind(body.kind);
    const title = (body.title || '').trim();
    const description = (body.description || '').trim();
    const location = (body.location || '').trim();
    const categoryId = toId(body.categoryId);
    const eventDate = body.eventDate || '';

    if (!kind) {
        return res.status(400).json({ error: 'Choose if you lost or found the item.' });
    }
    if (!title || !description || !location || !categoryId) {
        return res.status(400).json({ error: 'Title, description, category and location are required.' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || eventDate > today()) {
        return res.status(400).json({ error: 'The date must be today or a day in the past.' });
    }

    // The embedding is computed here, before the insert, so the matching
    // trigger in the database can use it right away
    const embedding = toSql(await embed(itemText(title, description)));
    const { rows } = await pool.query(
        `INSERT INTO items (kind, title, description, category_id, location, event_date, reported_by, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING item_id`,
        [kind, title, description, categoryId, location, eventDate, req.session.userId, embedding]);
    const itemId = rows[0].item_id;

    if (req.file) {
        await pool.query('INSERT INTO photos (item_id, file_path) VALUES ($1, $2)', [itemId, `/uploads/${req.file.filename}`]);
    }

    // Show the poster the closest items right away
    const similar = await similarItems(pool, itemId, 3);
    res.status(201).json({ itemId, similar });
});

// The person who posted an item marks it returned (or open again).
// The status-change trigger refuses changes that make no sense, like returned -> open.
router.patch('/items/:id/status', requireLogin, async (req, res) => {
    const status = (req.body || {}).status;
    if (status !== 'returned' && status !== 'open') {
        return res.status(400).json({ error: 'The status can only be set to returned or open.' });
    }
    const { rowCount } = await pool.query(
        'UPDATE items SET status = $1 WHERE item_id = $2 AND reported_by = $3',
        [status, toId(req.params.id), req.session.userId]);
    if (rowCount === 0) {
        return res.status(404).json({ error: 'You can only change the status of your own items.' });
    }
    res.json({ ok: true });
});

module.exports = router;

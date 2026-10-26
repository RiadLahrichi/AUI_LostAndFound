// Claiming a found item, and the finder approving or rejecting the claim.
//
// Most rules are checked by the database itself (db/triggers.sql and the
// one_active_claim_per_item index), so these routes stay short.
const express = require('express');
const { pool } = require('../db');
const requireLogin = require('../require-login');

const router = express.Router();

router.post('/items/:id/claims', requireLogin, async (req, res) => {
    const message = ((req.body || {}).message || '').trim();
    if (message.length < 10) {
        return res.status(400).json({ error: 'Describe something only the owner would know (at least 10 characters).' });
    }
    // If the item can't be claimed, a trigger raises an error, which server.js turns into a message
    const { rows } = await pool.query(
        'INSERT INTO claims (item_id, claimant_id, message) VALUES ($1, $2, $3) RETURNING claim_id',
        [req.params.id, req.session.userId, message]);
    res.status(201).json({ claimId: rows[0].claim_id });
});

// Only the person who posted the item can decide, and only on a pending claim
router.patch('/claims/:id', requireLogin, async (req, res) => {
    const status = (req.body || {}).status;
    if (status !== 'approved' && status !== 'rejected') {
        return res.status(400).json({ error: 'The decision must be approved or rejected.' });
    }
    const { rowCount } = await pool.query(`
        UPDATE claims c SET status = $1
        FROM items i
        WHERE c.claim_id = $2
          AND c.item_id = i.item_id
          AND i.reported_by = $3
          AND c.status = 'pending'`,
        [status, req.params.id, req.session.userId]);
    if (rowCount === 0) {
        return res.status(404).json({ error: 'No pending claim on one of your items with this id.' });
    }
    res.json({ ok: true });
});

module.exports = router;

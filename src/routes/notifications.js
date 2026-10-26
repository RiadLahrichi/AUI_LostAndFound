// The logged-in user's notifications. They are created by the triggers in
// db/triggers.sql, so there is no route to create one.
const express = require('express');
const { pool } = require('../db');
const requireLogin = require('../require-login');

const router = express.Router();

router.get('/notifications', requireLogin, async (req, res) => {
    const { rows } = await pool.query(
        `SELECT notification_id, item_id, message, is_read, created_at
         FROM notifications
         WHERE user_id = $1
         ORDER BY created_at DESC, notification_id DESC`,
        [req.session.userId]);
    res.json(rows);
});

router.post('/notifications/read', requireLogin, async (req, res) => {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.session.userId]);
    res.json({ ok: true });
});

module.exports = router;

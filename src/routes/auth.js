// Sign up, log in, log out, and "who am I".
//
// After login, the user's id is stored in the session. The browser only keeps a
// cookie with the session id, so it can't change who it is logged in as.
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

const router = express.Router();

router.post('/signup', async (req, res) => {
    const body = req.body || {};  // Express leaves req.body empty when nothing was sent
    const firstName = (body.firstName || '').trim();
    const lastName = (body.lastName || '').trim();
    const email = (body.email || '').trim().toLowerCase();
    const password = body.password || '';

    if (!firstName || !lastName) {
        return res.status(400).json({ error: 'First and last name are required.' });
    }
    if (!email.endsWith('@aui.ma')) {
        return res.status(400).json({ error: 'Only @aui.ma email addresses can sign up.' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'The password needs at least 8 characters.' });
    }

    // bcrypt adds a random salt and hashes the password slowly on purpose,
    // which makes guessing passwords from a stolen database very expensive
    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
        `INSERT INTO users (first_name, last_name, email, password_hash)
         VALUES ($1, $2, $3, $4) RETURNING user_id, first_name`,
        [firstName, lastName, email, passwordHash]);

    req.session.userId = rows[0].user_id;
    res.status(201).json({ userId: rows[0].user_id, firstName: rows[0].first_name });
});

router.post('/login', async (req, res) => {
    const body = req.body || {};
    const email = (body.email || '').trim().toLowerCase();
    const password = body.password || '';

    const { rows } = await pool.query('SELECT user_id, first_name, password_hash FROM users WHERE email = $1', [email]);
    const user = rows[0];
    // The same message for a wrong email and a wrong password, so nobody can
    // find out which emails have an account
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ error: 'Wrong email or password.' });
    }

    req.session.userId = user.user_id;
    res.json({ userId: user.user_id, firstName: user.first_name });
});

router.post('/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
});

// Used by every page to show the right menu. user is null when logged out.
router.get('/me', async (req, res) => {
    if (!req.session.userId) {
        return res.json({ user: null });
    }
    const { rows } = await pool.query(
        `SELECT user_id, first_name, last_name, email, role,
                (SELECT COUNT(*) FROM notifications n WHERE n.user_id = u.user_id AND NOT n.is_read)::int AS unread
         FROM users u WHERE user_id = $1`,
        [req.session.userId]);
    res.json({ user: rows[0] || null });
});

module.exports = router;

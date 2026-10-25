// Middleware that rejects the request if nobody is logged in
function requireLogin(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Please log in first.' });
    }
    next();
}

module.exports = requireLogin;

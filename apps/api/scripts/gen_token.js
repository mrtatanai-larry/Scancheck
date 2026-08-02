const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

// Load the JWT secret used by the server (repo‑root .runtime/data/.jwt_secret)
const secretPath = path.resolve(__dirname, '..', '..', '..', '.runtime', 'data', '.jwt_secret');
const secret = fs.readFileSync(secretPath, 'utf8').trim();

const payload = { id: 1, username: 'admin' };
const token = jwt.sign(payload, secret, { expiresIn: '1h' });
console.log(token);

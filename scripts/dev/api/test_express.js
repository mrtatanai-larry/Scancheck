const express = require('express');
console.log('Express required successfully');
const app = express();
console.log('App created successfully');
app.get('/', (req, res) => res.send('OK'));
const server = app.listen(3001, () => {
    console.log('Test server listening on port 3001');
    process.exit(0);
});

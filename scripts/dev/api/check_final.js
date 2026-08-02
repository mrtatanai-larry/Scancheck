const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('scancheck.db');
db.all("SELECT * FROM received_papers ORDER BY timestamp DESC LIMIT 5", (err, records) => {
    if (err) {
        console.error(err);
    } else {
        console.log("Latest 5 received papers:");
        console.log(JSON.stringify(records, null, 2));
    }
    db.close();
});

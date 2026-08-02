const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('.runtime/data/scancheck.db');

db.serialize(() => {
    db.run("ALTER TABLE scans ADD COLUMN entry_type TEXT", (err) => {
        if (err) console.log("entry_type in scans already exists or error: " + err.message);
        else console.log("entry_type added to scans");
    });
    db.run("ALTER TABLE scans ADD COLUMN special_equity_group TEXT", (err) => {
        if (err) console.log("special_equity_group in scans already exists or error: " + err.message);
        else console.log("special_equity_group added to scans");
    });
    db.run("ALTER TABLE subject_records ADD COLUMN entry_type TEXT", (err) => {
        if (err) console.log("entry_type in subject_records already exists or error: " + err.message);
        else console.log("entry_type added to subject_records");
    });
    db.run("ALTER TABLE subject_records ADD COLUMN special_equity_group TEXT", (err) => {
        if (err) console.log("special_equity_group in subject_records already exists or error: " + err.message);
        else console.log("special_equity_group added to subject_records");
    });
});

db.close();

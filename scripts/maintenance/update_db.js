const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('.runtime/data/scancheck.db');

async function addColumnIfNotExists(db, tableName, columnName, columnType) {
    return new Promise((resolve, reject) => {
        db.get(`PRAGMA table_info(${tableName})`, (err, rows) => {
            if (err) {
                console.error(`Error checking schema for ${tableName}:`, err);
                return reject(err);
            }
            const columnExists = rows.some(row => row.name === columnName);
            if (!columnExists) {
                db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`, (err) => {
                    if (err) {
                        console.error(`Error adding column ${columnName} to ${tableName}:`, err);
                        return reject(err);
                    }
                    console.log(`Column ${columnName} added to ${tableName}`);
                    resolve();
                });
            } else {
                console.log(`Column ${columnName} already exists in ${tableName}`);
                resolve();
            }
        });
    });
}

db.serialize(async () => {
    try {
        await addColumnIfNotExists(db, "scans", "entry_type", "TEXT");
        await addColumnIfNotExists(db, "scans", "special_equity_group", "TEXT");
        await addColumnIfNotExists(db, "subject_records", "entry_type", "TEXT");
        await addColumnIfNotExists(db, "subject_records", "special_equity_group", "TEXT");
    } catch (e) {
        console.error("Migration failed:", e);
    } finally {
        db.close();
    }
});

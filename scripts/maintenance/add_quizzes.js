const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', '..', '.runtime', 'data', 'scancheck.db');
const db = new sqlite3.Database(dbPath);

const departments = [
    "Bachelor of Science in Criminology",
    "Bachelor of Elementary Education",
    "Bachelor of Secondary Education",
    "Bachelor of Science in Hospitality Management",
    "Bachelor of Science in Business Administration",
    "Bachelor of Science in Information Technology"
];

db.serialize(() => {
    departments.forEach(dept => {
        const title = `${dept} Entrance Exam`;
        db.get("SELECT id FROM quizzes WHERE title = ?", [title], (err, row) => {
            if (err) {
                console.error(err.message);
                return;
            }
            if (!row) {
                const questionCount = 100;
                const options = 4;
                const answers = JSON.stringify(new Array(100).fill(0).map(() => ['A', 'B', 'C', 'D'][Math.floor(Math.random() * 4)]));
                
                db.run("INSERT INTO quizzes (title, question_count, options, correct_answers) VALUES (?, ?, ?, ?)",
                    [title, questionCount, options, answers],
                    function(err) {
                        if (err) {
                            console.error(`Error adding ${title}:`, err.message);
                        } else {
                            console.log(`✅ Added quiz: ${title} (ID: ${this.lastID})`);
                        }
                    }
                );
            } else {
                console.log(`ℹ️ Quiz already exists: ${title} (ID: ${row.id})`);
            }
        });
    });
});

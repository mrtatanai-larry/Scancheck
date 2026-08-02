const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');

const dbPath = path.join(__dirname, 'scancheck.db');
const db = new sqlite3.Database(dbPath);

async function seed() {
    console.log('Seeding database with example data...');

    // 1. Add an admin user if not exists
    const hashedPassword = await bcrypt.hash('changeme', 10);
    db.run(`INSERT OR IGNORE INTO users (username, password) VALUES (?, ?)`, ['admin', hashedPassword]);

    // 2. Add Quizzes for each department
    const departments = [
        "Bachelor of Science in Criminology",
        "Bachelor of Elementary Education",
        "Bachelor of Secondary Education",
        "Bachelor of Science in Hospitality Management",
        "Bachelor of Science in Business Administration",
        "Bachelor of Science in Information Technology"
    ];

    for (const dept of departments) {
        const title = `${dept} Entrance Exam`;
        const questionCount = 100;
        const options = 4;
        const answers = JSON.stringify(new Array(100).fill(0).map(() => ['A', 'B', 'C', 'D'][Math.floor(Math.random() * 4)]));

        db.run(`INSERT INTO quizzes (title, question_count, options, correct_answers) VALUES (?, ?, ?, ?)`, 
            [title, questionCount, options, answers], 
            function(err) {
                if (err) return console.error(err.message);
                const quizId = this.lastID;
                console.log(`Added quiz: ${title} (ID: ${quizId})`);

                // 3. Add sample records for each quiz
                const students = [
                    { id: '2026-0001', name: 'John Doe' },
                    { id: '2026-0002', name: 'Jane Smith' },
                    { id: '2026-0003', name: 'Bob Johnson' }
                ];

                students.forEach(student => {
                    const score = Math.floor(Math.random() * 30) + 70; // Score between 70-100
                    const percentage = (score / 100) * 100;
                    
                    // Add to records
                    db.run(`INSERT INTO records (student_id, quiz_id, score, total_questions, percentage) VALUES (?, ?, ?, ?, ?)`,
                        [student.id, quizId, score, 100, percentage]);

                    // Add to scans
                    const studentAnswers = JSON.stringify(new Array(100).fill(0).map(() => ['A', 'B', 'C', 'D'][Math.floor(Math.random() * 4)]));
                    const entryTypes = ["New Student", "Transferee", "Passinhon", "Non-Passinhon"];
                    const equityGroups = ["PWDs", "IPs", "Solo Parent", "Magna Carta"];
                    const entryType = entryTypes[Math.floor(Math.random() * entryTypes.length)];
                    const equityGroup = Math.random() > 0.7 ? equityGroups[Math.floor(Math.random() * equityGroups.length)] : null;

                    db.run(`INSERT INTO scans (quiz_id, student_name, answers, score, total_questions, percentage, status, entry_type, special_equity_group) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [quizId, student.name, studentAnswers, score, 100, percentage, percentage >= 70 ? 'Passinhon' : 'Non-passinhon', entryType, equityGroup]);
                });
            }
        );
    }

    // 4. Add some systems
    db.run(`INSERT INTO systems (name, description) VALUES (?, ?)`, 
        ['Passi City College OMR', 'Official Optical Mark Recognition system for the 2026 Entrance Examinations.']);
    
    console.log('✅ Seeding initiated. Please wait a moment for all records to be inserted.');
}

seed();

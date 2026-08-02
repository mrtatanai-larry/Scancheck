const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(REPO_ROOT, '.runtime', 'data', 'scancheck.db');

if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}`);
    process.exit(1);
}

const db = new sqlite3.Database(DB_PATH);

const query = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});

const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) { err ? reject(err) : resolve(this); });
});

async function fix() {
    try {
        console.log('Starting subject data recovery fix...');
        
        // 1. Recover multi-subject scans (100 questions)
        const multiScans = await query('SELECT * FROM scans WHERE total_questions = 100');
        console.log(`Found ${multiScans.length} multi-subject scans.`);

        const subjectBoundaries = {
            MATH: { start: 0, end: 19 },
            ENG: { start: 20, end: 39 },
            SCI: { start: 40, end: 59 },
            SOC: { start: 60, end: 79 },
            FIL: { start: 80, end: 99 }
        };

        const subjectCodes = ['MATH', 'ENG', 'SCI', 'SOC', 'FIL'];

        for (const scan of multiScans) {
            console.log(`- Processing 100-q scan ID: ${scan.id} (${scan.student_name})`);
            
            let answers;
            try {
                answers = JSON.parse(scan.answers);
            } catch (e) {
                console.warn(`  ! Could not parse answers for scan ${scan.id}`);
                continue;
            }

            if (!Array.isArray(answers) || answers.length < 100) {
                console.warn(`  ! Scan ${scan.id} has invalid answers array length.`);
                continue;
            }

            const quizId = scan.quiz_id;
            let allCorrectAnswers = null;
            if (quizId) {
                const quizRows = await query('SELECT correct_answers FROM quizzes WHERE id = ?', [quizId]);
                if (quizRows[0]?.correct_answers) {
                    try {
                        allCorrectAnswers = JSON.parse(quizRows[0].correct_answers);
                    } catch (e) {}
                }
                
                if (!allCorrectAnswers) {
                    const keyRows = await query(
                        'SELECT question_number, correct_answer FROM answer_keys WHERE quiz_id = ? ORDER BY question_number ASC',
                        [quizId]
                    );
                    if (keyRows.length > 0) {
                        const maxN = Math.max(...keyRows.map(r => r.question_number));
                        allCorrectAnswers = new Array(maxN).fill('');
                        for (const r of keyRows) {
                            allCorrectAnswers[r.question_number - 1] = r.correct_answer;
                        }
                    }
                }
            }

            const subjectResults = {};
            for (const [subject, range] of Object.entries(subjectBoundaries)) {
                const subjectAnswers = answers.slice(range.start, range.end + 1);
                let correctAnswers = [];
                
                if (allCorrectAnswers && allCorrectAnswers.length > range.start) {
                    correctAnswers = allCorrectAnswers.slice(range.start, range.end + 1);
                }
                
                if (correctAnswers.length < 20) {
                    const subjectRows = await query('SELECT id FROM subjects WHERE code = ?', [subject]);
                    if (subjectRows.length > 0) {
                        const subjectId = subjectRows[0].id;
                        const answerKeys = await query(
                            'SELECT question_number, correct_answer FROM answer_keys WHERE subject_id = ? ORDER BY question_number ASC',
                            [subjectId]
                        );
                        const fallback = new Array(20).fill('A');
                        answerKeys.forEach(key => {
                            if (key.question_number >= 1 && key.question_number <= 20) {
                                fallback[key.question_number - 1] = key.correct_answer;
                            }
                        });
                        correctAnswers = [...correctAnswers, ...fallback.slice(correctAnswers.length)];
                    }
                }

                let score = 0;
                for (let i = 0; i < 20; i++) {
                    const studentAns = String(subjectAnswers[i] || '').trim().toUpperCase();
                    const correctAns = String(correctAnswers[i] || '').trim().toUpperCase();
                    if (studentAns && correctAns && studentAns === correctAns) {
                        score++;
                    }
                }
                
                const percentage = (score / 20) * 100;
                subjectResults[subject] = { score, percentage: percentage.toFixed(1) };
            }

            // Update scans table
            await run(
                `UPDATE scans SET 
                    math_score = ?, math_percentage = ?, math_status = ?,
                    english_score = ?, english_percentage = ?, english_status = ?,
                    science_score = ?, science_percentage = ?, science_status = ?,
                    social_score = ?, social_percentage = ?, social_status = ?,
                    filipino_score = ?, filipino_percentage = ?, filipino_status = ?,
                    subject_scores = ?, score_breakdown = ?
                WHERE id = ?`,
                [
                    subjectResults.MATH.score, subjectResults.MATH.percentage, parseFloat(subjectResults.MATH.percentage) >= 75 ? 'PASS' : 'FAIL',
                    subjectResults.ENG.score, subjectResults.ENG.percentage, parseFloat(subjectResults.ENG.percentage) >= 75 ? 'PASS' : 'FAIL',
                    subjectResults.SCI.score, subjectResults.SCI.percentage, parseFloat(subjectResults.SCI.percentage) >= 75 ? 'PASS' : 'FAIL',
                    subjectResults.SOC.score, subjectResults.SOC.percentage, parseFloat(subjectResults.SOC.percentage) >= 75 ? 'PASS' : 'FAIL',
                    subjectResults.FIL.score, subjectResults.FIL.percentage, parseFloat(subjectResults.FIL.percentage) >= 75 ? 'PASS' : 'FAIL',
                    JSON.stringify({
                        MATH: subjectResults.MATH.percentage,
                        ENG: subjectResults.ENG.percentage,
                        SCI: subjectResults.SCI.percentage,
                        SOC: subjectResults.SOC.percentage,
                        FIL: subjectResults.FIL.percentage
                    }),
                    JSON.stringify({
                        MATH: subjectResults.MATH.score,
                        ENG: subjectResults.ENG.score,
                        SCI: subjectResults.SCI.score,
                        SOC: subjectResults.SOC.score,
                        FIL: subjectResults.FIL.score
                    }),
                    scan.id
                ]
            );

            // Populate subject_records
            for (const subCode of subjectCodes) {
                const subjectInfoRows = await query('SELECT id, name FROM subjects WHERE code = ?', [subCode]);
                if (subjectInfoRows.length === 0) continue;
                const subjectInfo = subjectInfoRows[0];
                const res = subjectResults[subCode];

                const existing = await query('SELECT id FROM subject_records WHERE scan_id = ? AND subject_code = ?', [scan.id, subCode]);
                if (existing.length === 0) {
                    await run(
                        `INSERT INTO subject_records (student_id, student_name, subject_id, 
                         subject_code, subject_name, score, total_questions, percentage, status, scan_id,
                         entry_type, special_equity_group, room_no, seat_no, timestamp) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            scan.student_id || 'N/A', scan.student_name, subjectInfo.id, subCode, 
                            subjectInfo.name, res.score, 20, res.percentage, 
                            parseFloat(res.percentage) >= 75 ? 'PASS' : 'FAIL', scan.id,
                            scan.entry_type || null, 
                            scan.special_equity_group || null,
                            scan.room_no || null,
                            scan.seat_no || null,
                            scan.timestamp
                        ]
                    );
                } else {
                    await run(
                        `UPDATE subject_records SET 
                            score = ?, percentage = ?, status = ?
                         WHERE id = ?`,
                        [res.score, res.percentage, parseFloat(res.percentage) >= 75 ? 'PASS' : 'FAIL', existing[0].id]
                    );
                }
            }
        }

        // 2. Recover single-subject scans
        const singleScans = await query(`
            SELECT s.*, q.subject_id, sub.code as subject_code, sub.name as subject_name
            FROM scans s
            JOIN quizzes q ON s.quiz_id = q.id
            JOIN subjects sub ON q.subject_id = sub.id
            WHERE s.total_questions < 100
        `);
        console.log(`Found ${singleScans.length} single-subject scans.`);

        for (const scan of singleScans) {
            console.log(`- Processing single-sub scan ID: ${scan.id} (${scan.student_name}, ${scan.subject_code})`);
            
            const subCode = scan.subject_code.toLowerCase();
            let fieldPrefix = '';
            if (subCode.includes('math')) fieldPrefix = 'math';
            else if (subCode.includes('english') || subCode.includes('eng')) fieldPrefix = 'english';
            else if (subCode.includes('science') || subCode.includes('sci')) fieldPrefix = 'science';
            else if (subCode.includes('social') || subCode.includes('soc')) fieldPrefix = 'social';
            else if (subCode.includes('filipino') || subCode.includes('fil')) fieldPrefix = 'filipino';

            if (fieldPrefix) {
                await run(
                    `UPDATE scans SET 
                        ${fieldPrefix}_score = ?, ${fieldPrefix}_percentage = ?, ${fieldPrefix}_status = ?, ${fieldPrefix}_total = ?
                    WHERE id = ?`,
                    [scan.score, scan.percentage, scan.status, scan.total_questions, scan.id]
                );
            }

            const existing = await query('SELECT id FROM subject_records WHERE scan_id = ? AND subject_code = ?', [scan.id, scan.subject_code]);
            if (existing.length === 0) {
                await run(
                    `INSERT INTO subject_records (student_id, student_name, subject_id, 
                     subject_code, subject_name, score, total_questions, percentage, status, scan_id,
                     entry_type, special_equity_group, room_no, seat_no, timestamp) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        scan.student_id || 'N/A', scan.student_name, scan.subject_id, scan.subject_code, 
                        scan.subject_name, scan.score, scan.total_questions, scan.percentage, 
                        scan.status, scan.id,
                        scan.entry_type || null, 
                        scan.special_equity_group || null,
                        scan.room_no || null,
                        scan.seat_no || null,
                        scan.timestamp
                    ]
                );
            }
        }
        
        console.log('Successfully updated all subject data.');
    } catch (err) {
        console.error('Error during fix:', err);
    } finally {
        db.close();
    }
}

fix();

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const paths = require('./config/paths');

class Database {
    constructor() {
        this.db = null;
        this.dbPath = paths.dbPath;
        const dbDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        this.ensureWritableDatabasePath();
    }

    ensureWritableDatabasePath() {
        const dbDir = path.dirname(this.dbPath);
        fs.accessSync(dbDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);

        if (fs.existsSync(this.dbPath)) {
            fs.chmodSync(this.dbPath, fs.statSync(this.dbPath).mode | 0o600);
            fs.accessSync(this.dbPath, fs.constants.R_OK | fs.constants.W_OK);
        }

        for (const suffix of ['-journal', '-wal', '-shm']) {
            const sidecarPath = `${this.dbPath}${suffix}`;
            if (fs.existsSync(sidecarPath)) {
                fs.chmodSync(sidecarPath, fs.statSync(sidecarPath).mode | 0o600);
                fs.accessSync(sidecarPath, fs.constants.R_OK | fs.constants.W_OK);
            }
        }
    }

    init() {
        return new Promise((resolve, reject) => {
            if (this.db) {
                resolve();
                return;
            }

            this.ensureWritableDatabasePath();
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                console.log('Connected to SQLite database');
                this.configurePragmas()
                    .then(() => this.assertWritable())
                    .then(() => this.createTables())
                    .then(resolve)
                    .catch(reject);
            });
        });
    }

    close() {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                resolve();
                return;
            }

            const currentDb = this.db;
            this.db = null;
            currentDb.close((err) => {
                if (err) {
                    this.db = currentDb;
                    reject(err);
                    return;
                }
                resolve();
            });
        });
    }

    assertWritable() {
        return new Promise((resolve, reject) => {
            this.db.exec('PRAGMA query_only = OFF; BEGIN IMMEDIATE; ROLLBACK;', (err) => {
                if (err) {
                    err.message = `SQLite database is not writable at ${this.dbPath}: ${err.message}`;
                    reject(err);
                    return;
                }
                resolve();
            });
        });
    }

    configurePragmas() {
        return new Promise((resolve, reject) => {
            // WAL allows concurrent reads while a write is in progress; busy_timeout
            // avoids SQLITE_BUSY when overlapping writes occur (e.g. upload vs backup);
            // foreign_keys enforces the declared FOREIGN KEY constraints.
            this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;', (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            });
        });
    }

    async createTables() {
        try {
            const tableQueries = [
                `CREATE TABLE IF NOT EXISTS subjects (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    code TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    description TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`,

                `CREATE TABLE IF NOT EXISTS quizzes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    subject_id INTEGER,
                    title TEXT NOT NULL,
                    question_count INTEGER NOT NULL,
                    options INTEGER NOT NULL,
                    format TEXT DEFAULT 'multi-subject',
                    subject_config TEXT,
                    correct_answers TEXT,
                    archived INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (subject_id) REFERENCES subjects (id)
                )`,
                
                `CREATE TABLE IF NOT EXISTS answer_keys (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    subject_id INTEGER,
                    quiz_id INTEGER,
                    question_number INTEGER NOT NULL,
                    correct_answer TEXT NOT NULL,
                    FOREIGN KEY (subject_id) REFERENCES subjects (id),
                    FOREIGN KEY (quiz_id) REFERENCES quizzes (id),
                    UNIQUE(quiz_id, question_number)
                )`,

                `CREATE TABLE IF NOT EXISTS scans (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sheet_id TEXT,
                    student_id TEXT,
                    student_name TEXT NOT NULL,
                    quiz_id INTEGER,
                    answers TEXT NOT NULL,
                    score INTEGER NOT NULL,
                    total_score INTEGER,
                    total_questions INTEGER NOT NULL,
                    percentage REAL NOT NULL,
                    overall_percentage REAL,
                    score_breakdown TEXT,
                    subject_scores TEXT,
                    status TEXT,
                    overall_status TEXT,
                    photo TEXT,
                    image_path TEXT,
                    thumbnail_path TEXT,
                    scanned_by TEXT,
                    department TEXT,
                    course TEXT,
                    room_no TEXT,
                    seat_no TEXT,
                    exam_date_time TEXT,
                    entry_type TEXT,
                    residency_type TEXT,
                    special_equity_group TEXT,
                    proctor_status TEXT,
                    math_score INTEGER DEFAULT 0,
                    english_score INTEGER DEFAULT 0,
                    science_score INTEGER DEFAULT 0,
                    social_score INTEGER DEFAULT 0,
                    filipino_score INTEGER DEFAULT 0,
                    math_total INTEGER DEFAULT 20,
                    english_total INTEGER DEFAULT 20,
                    science_total INTEGER DEFAULT 20,
                    social_total INTEGER DEFAULT 20,
                    filipino_total INTEGER DEFAULT 20,
                    math_percentage REAL DEFAULT 0,
                    english_percentage REAL DEFAULT 0,
                    science_percentage REAL DEFAULT 0,
                    social_percentage REAL DEFAULT 0,
                    filipino_percentage REAL DEFAULT 0,
                    math_status TEXT DEFAULT 'FAIL',
                    english_status TEXT DEFAULT 'FAIL',
                    science_status TEXT DEFAULT 'FAIL',
                    social_status TEXT DEFAULT 'FAIL',
                    filipino_status TEXT DEFAULT 'FAIL',
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (quiz_id) REFERENCES quizzes (id)
                )`,

                `CREATE TABLE IF NOT EXISTS scan_images (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scan_id INTEGER NOT NULL,
                    original_filename TEXT NOT NULL,
                    storage_path TEXT NOT NULL,
                    thumbnail_path TEXT,
                    file_size INTEGER,
                    mime_type TEXT,
                    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (scan_id) REFERENCES scans (id)
                )`,

                `CREATE TABLE IF NOT EXISTS subject_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    student_id TEXT NOT NULL,
                    student_name TEXT NOT NULL,
                    subject_id INTEGER NOT NULL,
                    subject_code TEXT NOT NULL,
                    subject_name TEXT NOT NULL,
                    score INTEGER NOT NULL,
                    total_questions INTEGER NOT NULL,
                    percentage REAL NOT NULL,
                    status TEXT NOT NULL,
                    entry_type TEXT,
                    residency_type TEXT,
                    special_equity_group TEXT,
                    room_no TEXT,
                    seat_no TEXT,
                    exam_date_time TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    scan_id INTEGER,
                    FOREIGN KEY (subject_id) REFERENCES subjects (id),
                    FOREIGN KEY (scan_id) REFERENCES scans (id)
                )`,

                `CREATE TABLE IF NOT EXISTS records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sheet_id TEXT,
                    student_id TEXT,
                    student_name TEXT NOT NULL,
                    quiz_id INTEGER,
                    quiz_title TEXT,
                    score INTEGER,
                    total_questions INTEGER,
                    percentage REAL,
                    status TEXT,
                    entry_type TEXT,
                    residency_type TEXT,
                    special_equity_group TEXT,
                    subject_code TEXT,
                    course TEXT,
                    age TEXT,
                    room_no TEXT,
                    seat_no TEXT,
                    exam_date_time TEXT,
                    answers TEXT,
                    raw_text TEXT,
                    image_path TEXT,
                    source_received_paper_id INTEGER,
                    review_status TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (quiz_id) REFERENCES quizzes (id)
                )`,

                `CREATE TABLE IF NOT EXISTS systems (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    description TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`,

                `CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    password TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`,

                `CREATE TABLE IF NOT EXISTS received_papers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sheet_id TEXT,
                    student_id TEXT,
                    exam_id TEXT,
                    student_name TEXT NOT NULL,
                    course TEXT NOT NULL,
                    age INTEGER,
                    room_no TEXT,
                    seat_no TEXT,
                    exam_date_time TEXT,
                    entry_type TEXT,
                    residency_type TEXT,
                    equity_group TEXT,
                    image_file_name TEXT,
                    image_path TEXT NOT NULL,
                    sender_ip TEXT,
                    device_id TEXT,
                    image_hash TEXT,
                    is_scanned INTEGER DEFAULT 0,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )`,

                `CREATE TABLE IF NOT EXISTS ai_omr_usage (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    request_id TEXT,
                    layout_id TEXT,
                    exam_id TEXT,
                    provider TEXT,
                    model TEXT,
                    strategy TEXT,
                    question_count INTEGER,
                    request_count INTEGER,
                    input_tokens INTEGER,
                    output_tokens INTEGER,
                    total_tokens INTEGER,
                    thoughts_tokens INTEGER,
                    processing_time_ms INTEGER,
                    review_count INTEGER,
                    success INTEGER DEFAULT 0,
                    error_code TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )`,

                `CREATE TABLE IF NOT EXISTS ai_layout_profiles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    layout_id TEXT NOT NULL UNIQUE,
                    strategy TEXT,
                    model TEXT,
                    section_size INTEGER,
                    image_detail TEXT,
                    verification_mode TEXT,
                    prompt_version TEXT,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`
            ];

            const indexQueries = [
                `CREATE INDEX IF NOT EXISTS idx_scans_quiz_id ON scans(quiz_id)`,
                `CREATE INDEX IF NOT EXISTS idx_scans_student_id ON scans(student_id)`,
                `CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scans(timestamp)`,
                `CREATE INDEX IF NOT EXISTS idx_records_student_id ON records(student_id)`,
                `CREATE INDEX IF NOT EXISTS idx_records_timestamp ON records(timestamp)`,
                `CREATE INDEX IF NOT EXISTS idx_records_status ON records(status)`,
                `CREATE INDEX IF NOT EXISTS idx_subject_records_student_subject ON subject_records(student_id, subject_id)`,
                `CREATE INDEX IF NOT EXISTS idx_quizzes_subject_id ON quizzes(subject_id)`,
                `CREATE INDEX IF NOT EXISTS idx_ai_omr_usage_timestamp ON ai_omr_usage(timestamp)`,
                `CREATE INDEX IF NOT EXISTS idx_ai_omr_usage_layout_id ON ai_omr_usage(layout_id)`,
                `CREATE INDEX IF NOT EXISTS idx_ai_layout_profiles_layout_id ON ai_layout_profiles(layout_id)`
            ];

            // Run table queries sequentially
            for (const query of tableQueries) {
                await this.run(query).catch(err => console.warn('Table creation warning:', err.message));
            }

            // Run migrations
            await this.migrate();

            // Run index queries
            for (const query of indexQueries) {
                await this.run(query).catch(err => console.warn('Index creation warning:', err.message));
            }

            // Seed subjects
            await this.seedSubjects();
            await this.ensureDefaultAdminUser();

            console.log('✅ Database initialized, migrated and seeded successfully');
        } catch (error) {
            console.error('❌ Database initialization failed:', error);
            throw error;
        }
    }

    async seedSubjects() {
        const subjects = [
            ['ENG', 'English', 'Language proficiency and comprehension'],
            ['SCI', 'Science', 'Scientific knowledge and reasoning'],
            ['MATH', 'Mathematics', 'Numerical and analytical skills assessment'],
            ['GEN', 'General Knowledge', 'General awareness and information'],
            ['ABS', 'Abstract Reasoning', 'Logical and abstract thinking assessment']
        ];

        for (const [code, name, desc] of subjects) {
            await this.run('INSERT OR IGNORE INTO subjects (code, name, description) VALUES (?, ?, ?)', [code, name, desc]);
        }
    }

    async ensureDefaultAdminUser() {
        const bootstrapFlag = String(process.env.SCANCHECK_BOOTSTRAP_ADMIN || 'true').trim().toLowerCase();
        if (['0', 'false', 'no', 'off'].includes(bootstrapFlag)) {
            return;
        }

        const userCountRows = await this.query('SELECT COUNT(*) as total FROM users');
        const hasExistingUsers = Number(userCountRows[0]?.total || 0) > 0;
        if (hasExistingUsers) {
            return;
        }

        const username = String(process.env.SCANCHECK_DEFAULT_ADMIN_USERNAME || 'admin').trim();
        const password = String(process.env.SCANCHECK_DEFAULT_ADMIN_PASSWORD || 'admin111');
        if (!username || !password) {
            console.warn('⚠️ Skipping default admin bootstrap because username/password is empty');
            return;
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await this.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword]);
        console.log(`✅ Default admin bootstrapped: ${username}`);
    }

    async migrate() {
        const tables = ['scans', 'records', 'quizzes', 'answer_keys', 'subject_records', 'received_papers'];
        for (const table of tables) {
            const columns = await this.query(`PRAGMA table_info(${table})`);
            const columnNames = columns.map(c => c.name);
            
            if (table === 'received_papers') {
                if (!columnNames.includes('sheet_id')) await this.run(`ALTER TABLE received_papers ADD COLUMN sheet_id TEXT`);
                if (!columnNames.includes('student_id')) await this.run(`ALTER TABLE received_papers ADD COLUMN student_id TEXT`);
                if (!columnNames.includes('exam_id')) await this.run(`ALTER TABLE received_papers ADD COLUMN exam_id TEXT`);
                if (!columnNames.includes('image_file_name')) await this.run(`ALTER TABLE received_papers ADD COLUMN image_file_name TEXT`);
                if (!columnNames.includes('sender_ip')) await this.run(`ALTER TABLE received_papers ADD COLUMN sender_ip TEXT`);
                if (!columnNames.includes('device_id')) await this.run(`ALTER TABLE received_papers ADD COLUMN device_id TEXT`);
                if (!columnNames.includes('image_hash')) await this.run(`ALTER TABLE received_papers ADD COLUMN image_hash TEXT`);
                if (!columnNames.includes('entry_type')) await this.run(`ALTER TABLE received_papers ADD COLUMN entry_type TEXT`);
                if (!columnNames.includes('residency_type')) await this.run(`ALTER TABLE received_papers ADD COLUMN residency_type TEXT`);
                if (!columnNames.includes('equity_group')) await this.run(`ALTER TABLE received_papers ADD COLUMN equity_group TEXT`);
                if (!columnNames.includes('age')) await this.run(`ALTER TABLE received_papers ADD COLUMN age INTEGER`);
                if (!columnNames.includes('room_no')) await this.run(`ALTER TABLE received_papers ADD COLUMN room_no TEXT`);
                if (!columnNames.includes('seat_no')) await this.run(`ALTER TABLE received_papers ADD COLUMN seat_no TEXT`);
                if (!columnNames.includes('exam_date_time')) await this.run(`ALTER TABLE received_papers ADD COLUMN exam_date_time TEXT`);
                if (!columnNames.includes('is_scanned')) await this.run(`ALTER TABLE received_papers ADD COLUMN is_scanned INTEGER DEFAULT 0`);
            }
            if (table === 'subject_records') {
                if (!columnNames.includes('entry_type')) await this.run(`ALTER TABLE subject_records ADD COLUMN entry_type TEXT`);
                if (!columnNames.includes('residency_type')) await this.run(`ALTER TABLE subject_records ADD COLUMN residency_type TEXT`);
                if (!columnNames.includes('special_equity_group')) await this.run(`ALTER TABLE subject_records ADD COLUMN special_equity_group TEXT`);
                if (!columnNames.includes('room_no')) await this.run(`ALTER TABLE subject_records ADD COLUMN room_no TEXT`);
                if (!columnNames.includes('seat_no')) await this.run(`ALTER TABLE subject_records ADD COLUMN seat_no TEXT`);
                if (!columnNames.includes('exam_date_time')) await this.run(`ALTER TABLE subject_records ADD COLUMN exam_date_time TEXT`);
            }
            if (table === 'ai_omr_usage') {
                if (!columnNames.includes('thoughts_tokens')) await this.run(`ALTER TABLE ai_omr_usage ADD COLUMN thoughts_tokens INTEGER`);
            }

            if (table === 'scans') {
                if (!columnNames.includes('sheet_id')) await this.run(`ALTER TABLE scans ADD COLUMN sheet_id TEXT`);
                if (!columnNames.includes('student_id')) await this.run(`ALTER TABLE scans ADD COLUMN student_id TEXT`);
                if (!columnNames.includes('total_score')) await this.run(`ALTER TABLE scans ADD COLUMN total_score INTEGER`);
                if (!columnNames.includes('score_breakdown')) await this.run(`ALTER TABLE scans ADD COLUMN score_breakdown TEXT`);
                if (!columnNames.includes('subject_scores')) await this.run(`ALTER TABLE scans ADD COLUMN subject_scores TEXT`);
                if (!columnNames.includes('status')) await this.run(`ALTER TABLE scans ADD COLUMN status TEXT`);
                if (!columnNames.includes('overall_percentage')) await this.run(`ALTER TABLE scans ADD COLUMN overall_percentage REAL`);
                if (!columnNames.includes('overall_status')) await this.run(`ALTER TABLE scans ADD COLUMN overall_status TEXT`);
                if (!columnNames.includes('image_path')) await this.run(`ALTER TABLE scans ADD COLUMN image_path TEXT`);
                if (!columnNames.includes('thumbnail_path')) await this.run(`ALTER TABLE scans ADD COLUMN thumbnail_path TEXT`);
                if (!columnNames.includes('scanned_by')) await this.run(`ALTER TABLE scans ADD COLUMN scanned_by TEXT`);
                if (!columnNames.includes('department')) await this.run(`ALTER TABLE scans ADD COLUMN department TEXT`);
                if (!columnNames.includes('course')) await this.run(`ALTER TABLE scans ADD COLUMN course TEXT`);
                if (!columnNames.includes('room_no')) await this.run(`ALTER TABLE scans ADD COLUMN room_no TEXT`);
                if (!columnNames.includes('seat_no')) await this.run(`ALTER TABLE scans ADD COLUMN seat_no TEXT`);
                if (!columnNames.includes('exam_date_time')) await this.run(`ALTER TABLE scans ADD COLUMN exam_date_time TEXT`);
                // New subject columns
                if (!columnNames.includes('general_score')) await this.run(`ALTER TABLE scans ADD COLUMN general_score INTEGER DEFAULT 0`);
                if (!columnNames.includes('general_total')) await this.run(`ALTER TABLE scans ADD COLUMN general_total INTEGER DEFAULT 20`);
                if (!columnNames.includes('general_percentage')) await this.run(`ALTER TABLE scans ADD COLUMN general_percentage REAL DEFAULT 0`);
                if (!columnNames.includes('general_status')) await this.run(`ALTER TABLE scans ADD COLUMN general_status TEXT DEFAULT 'FAIL'`);
                if (!columnNames.includes('abstract_score')) await this.run(`ALTER TABLE scans ADD COLUMN abstract_score INTEGER DEFAULT 0`);
                if (!columnNames.includes('abstract_total')) await this.run(`ALTER TABLE scans ADD COLUMN abstract_total INTEGER DEFAULT 20`);
                if (!columnNames.includes('abstract_percentage')) await this.run(`ALTER TABLE scans ADD COLUMN abstract_percentage REAL DEFAULT 0`);
                if (!columnNames.includes('abstract_status')) await this.run(`ALTER TABLE scans ADD COLUMN abstract_status TEXT DEFAULT 'FAIL'`);
                if (!columnNames.includes('entry_type')) await this.run(`ALTER TABLE scans ADD COLUMN entry_type TEXT`);
                if (!columnNames.includes('residency_type')) await this.run(`ALTER TABLE scans ADD COLUMN residency_type TEXT`);
                if (!columnNames.includes('special_equity_group')) await this.run(`ALTER TABLE scans ADD COLUMN special_equity_group TEXT`);
                if (!columnNames.includes('proctor_status')) await this.run(`ALTER TABLE scans ADD COLUMN proctor_status TEXT`);
                
                // Subject-specific columns
                const subjects = ['math', 'english', 'science', 'social', 'filipino'];
                for (const sub of subjects) {
                    if (!columnNames.includes(`${sub}_score`)) await this.run(`ALTER TABLE scans ADD COLUMN ${sub}_score INTEGER DEFAULT 0`);
                    if (!columnNames.includes(`${sub}_total`)) await this.run(`ALTER TABLE scans ADD COLUMN ${sub}_total INTEGER DEFAULT 20`);
                    if (!columnNames.includes(`${sub}_percentage`)) await this.run(`ALTER TABLE scans ADD COLUMN ${sub}_percentage REAL DEFAULT 0`);
                    if (!columnNames.includes(`${sub}_status`)) await this.run(`ALTER TABLE scans ADD COLUMN ${sub}_status TEXT DEFAULT 'FAIL'`);
                }
            }
            if (table === 'records') {
                if (!columnNames.includes('sheet_id')) await this.run(`ALTER TABLE records ADD COLUMN sheet_id TEXT`);
                if (!columnNames.includes('student_name')) await this.run(`ALTER TABLE records ADD COLUMN student_name TEXT`);
                if (!columnNames.includes('quiz_title')) await this.run(`ALTER TABLE records ADD COLUMN quiz_title TEXT`);
                if (!columnNames.includes('status')) await this.run(`ALTER TABLE records ADD COLUMN status TEXT`);
                if (!columnNames.includes('entry_type')) await this.run(`ALTER TABLE records ADD COLUMN entry_type TEXT`);
                if (!columnNames.includes('residency_type')) await this.run(`ALTER TABLE records ADD COLUMN residency_type TEXT`);
                if (!columnNames.includes('special_equity_group')) await this.run(`ALTER TABLE records ADD COLUMN special_equity_group TEXT`);
                if (!columnNames.includes('subject_code')) await this.run(`ALTER TABLE records ADD COLUMN subject_code TEXT`);
                if (!columnNames.includes('subject')) await this.run(`ALTER TABLE records ADD COLUMN subject TEXT`);
                if (!columnNames.includes('section')) await this.run(`ALTER TABLE records ADD COLUMN section TEXT`);
                if (!columnNames.includes('course')) await this.run(`ALTER TABLE records ADD COLUMN course TEXT`);
                if (!columnNames.includes('age')) await this.run(`ALTER TABLE records ADD COLUMN age TEXT`);
                if (!columnNames.includes('room_no')) await this.run(`ALTER TABLE records ADD COLUMN room_no TEXT`);
                if (!columnNames.includes('seat_no')) await this.run(`ALTER TABLE records ADD COLUMN seat_no TEXT`);
                if (!columnNames.includes('exam_date_time')) await this.run(`ALTER TABLE records ADD COLUMN exam_date_time TEXT`);
                if (!columnNames.includes('answers')) await this.run(`ALTER TABLE records ADD COLUMN answers TEXT`);
                if (!columnNames.includes('raw_text')) await this.run(`ALTER TABLE records ADD COLUMN raw_text TEXT`);
                if (!columnNames.includes('image_path')) await this.run(`ALTER TABLE records ADD COLUMN image_path TEXT`);
                if (!columnNames.includes('source_received_paper_id')) await this.run(`ALTER TABLE records ADD COLUMN source_received_paper_id INTEGER`);
                if (!columnNames.includes('review_status')) await this.run(`ALTER TABLE records ADD COLUMN review_status TEXT`);
            }

            if (table === 'quizzes') {
                if (!columnNames.includes('subject_id')) await this.run(`ALTER TABLE quizzes ADD COLUMN subject_id INTEGER`);
                if (!columnNames.includes('format')) await this.run(`ALTER TABLE quizzes ADD COLUMN format TEXT DEFAULT 'multi-subject'`);
                if (!columnNames.includes('subject_config')) await this.run(`ALTER TABLE quizzes ADD COLUMN subject_config TEXT`);
                if (!columnNames.includes('archived')) await this.run(`ALTER TABLE quizzes ADD COLUMN archived INTEGER DEFAULT 0`);
            }

            if (table === 'answer_keys') {
                if (!columnNames.includes('subject_id')) await this.run(`ALTER TABLE answer_keys ADD COLUMN subject_id INTEGER`);
            }
        }
    }

    // Generic query method
    query(sql, params = []) {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                return reject(new Error('Database connection is closed.'));
            }
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    // Generic run method (for INSERT, UPDATE, DELETE)
    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                return reject(new Error('Database connection is closed.'));
            }
            this.db.run(sql, params, function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id: this.lastID, changes: this.changes });
                }
            });
        });
    }

    // Backup the database while running
    backup(destinationPath) {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                return reject(new Error('Database connection is closed.'));
            }
            this.db.run(`VACUUM INTO ?`, [destinationPath], (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }
}

module.exports = new Database();

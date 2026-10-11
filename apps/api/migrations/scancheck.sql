-- Enhanced Database Schema for 5 Subjects

-- 1. Subjects Table (Defines the 5 subjects)
CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,        -- e.g., ENG, SCI, MATH, GEN, ABS
    name TEXT NOT NULL,               -- e.g., Mathematics, English, Science
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Quizzes Table (Now includes subject_id)
CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER NOT NULL,      -- Links to specific subject
    title TEXT NOT NULL,
    question_count INTEGER NOT NULL,
    options INTEGER NOT NULL,
    correct_answers TEXT,             -- JSON string of answers
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subject_id) REFERENCES subjects (id)
);

-- 3. Scans Table (Main OMR Results with 5 subject scores)
CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_id TEXT,
    student_id TEXT,
    student_name TEXT NOT NULL,
    quiz_id INTEGER,                  -- Optional: if scanning specific quiz
    answers TEXT NOT NULL,            -- JSON array of all answers
    score_breakdown TEXT NOT NULL,    -- JSON: {math: 45, english: 38, ...}
    
    -- Subject scores (individual)
    math_score INTEGER DEFAULT 0,
    english_score INTEGER DEFAULT 0,
    science_score INTEGER DEFAULT 0,
    social_score INTEGER DEFAULT 0,
    filipino_score INTEGER DEFAULT 0,
    
    -- Subject totals
    math_total INTEGER DEFAULT 20,
    english_total INTEGER DEFAULT 20,
    science_total INTEGER DEFAULT 20,
    social_total INTEGER DEFAULT 20,
    filipino_total INTEGER DEFAULT 20,
    
    -- Percentages
    math_percentage REAL DEFAULT 0,
    english_percentage REAL DEFAULT 0,
    science_percentage REAL DEFAULT 0,
    social_percentage REAL DEFAULT 0,
    filipino_percentage REAL DEFAULT 0,
    
    -- Status per subject
    math_status TEXT DEFAULT 'FAIL',
    english_status TEXT DEFAULT 'FAIL',
    science_status TEXT DEFAULT 'FAIL',
    social_status TEXT DEFAULT 'FAIL',
    filipino_status TEXT DEFAULT 'FAIL',
    
    -- Overall scores
    total_score INTEGER NOT NULL,
    total_questions INTEGER NOT NULL,
    percentage REAL NOT NULL,
    overall_percentage REAL,
    status TEXT NOT NULL,             -- Passinhon/Non-passinhon
    overall_status TEXT,
    
    -- New Student Info Fields
    entry_type TEXT,                  -- New Student, Transferee, Passinhon, Non-Passinhon
    special_equity_group TEXT,        -- PWDs, IPs, Solo Parent, Magna Carta of the Poor
    
    -- Image data
    photo TEXT,                       -- Base64 image
    image_path TEXT,                  -- Path to stored image file
    thumbnail_path TEXT,              -- Path to thumbnail
    
    -- Additional metadata
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    scanned_by TEXT,
    department TEXT,
    course TEXT,
    
    FOREIGN KEY (quiz_id) REFERENCES quizzes (id)
);

-- 3.1 scan_images table for better image management
CREATE TABLE IF NOT EXISTS scan_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id INTEGER NOT NULL,
    original_filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    thumbnail_path TEXT,
    file_size INTEGER,
    mime_type TEXT,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (scan_id) REFERENCES scans (id)
);

-- 4. Subject Records Table (Individual subject performance)
CREATE TABLE IF NOT EXISTS subject_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    student_name TEXT NOT NULL,
    subject_id INTEGER NOT NULL,
    subject_code TEXT NOT NULL,
    subject_name TEXT NOT NULL,
    score INTEGER NOT NULL,
    total_questions INTEGER NOT NULL,
    percentage REAL NOT NULL,
    status TEXT NOT NULL,             -- Passinhon/Non-passinhon per subject
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    scan_id INTEGER,                  -- Link to original scan
    entry_type TEXT,
    special_equity_group TEXT,
    FOREIGN KEY (subject_id) REFERENCES subjects (id),
    FOREIGN KEY (scan_id) REFERENCES scans (id)
);

-- 5. Answer Keys Table (Subject-specific answer keys)
CREATE TABLE IF NOT EXISTS answer_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER NOT NULL,
    quiz_id INTEGER,
    question_number INTEGER NOT NULL,
    correct_answer TEXT NOT NULL,
    FOREIGN KEY (subject_id) REFERENCES subjects (id),
    FOREIGN KEY (quiz_id) REFERENCES quizzes (id),
    UNIQUE(subject_id, question_number)
);

-- 6. Insert Default Subjects
INSERT OR IGNORE INTO subjects (code, name, description) VALUES
('ENG', 'English', 'Language proficiency and comprehension'),
('SCI', 'Science', 'Scientific knowledge and reasoning'),
('MATH', 'Mathematics', 'Numerical and analytical skills assessment'),
('GEN', 'General Knowledge', 'General awareness and information'),
('ABS', 'Abstract Reasoning', 'Logical and abstract thinking assessment');

-- 7. Create Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_scans_student_id ON scans(student_id);
CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scans(timestamp);
CREATE INDEX IF NOT EXISTS idx_scans_status ON scans(status);
CREATE INDEX IF NOT EXISTS idx_scans_department ON scans(department);
CREATE INDEX IF NOT EXISTS idx_scans_overall_status ON scans(overall_status);
CREATE INDEX IF NOT EXISTS idx_subject_records_student_subject ON subject_records(student_id, subject_id);
CREATE INDEX IF NOT EXISTS idx_subject_records_timestamp ON subject_records(timestamp);
CREATE INDEX IF NOT EXISTS idx_quizzes_subject_id ON quizzes(subject_id);

CREATE TABLE IF NOT EXISTS ai_omr_usage (
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
);

CREATE TABLE IF NOT EXISTS ai_layout_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    layout_id TEXT NOT NULL UNIQUE,
    strategy TEXT,
    model TEXT,
    section_size INTEGER,
    image_detail TEXT,
    verification_mode TEXT,
    prompt_version TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_omr_usage_timestamp ON ai_omr_usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_ai_omr_usage_layout_id ON ai_omr_usage(layout_id);
CREATE INDEX IF NOT EXISTS idx_ai_layout_profiles_layout_id ON ai_layout_profiles(layout_id);

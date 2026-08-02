# ScanCheck System - Complete Flow Diagram

## 🎯 Overview

This document provides visual representations of the complete system flow.

---

## 📊 Main System Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SCANCHECK SYSTEM                             │
│                      Complete Processing Flow                        │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        📱 MOBILE APP                                 │
│                     (Image Capture Only)                             │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ 1. Capture Image
                                │    - Open camera
                                │    - Align answer sheet
                                │    - Take photo
                                │    - Convert to Bitmap
                                ↓
                    ┌───────────────────────┐
                    │   Local Image File    │
                    │   (Bitmap format)     │
                    └───────────────────────┘
                                │
                                │ 2. Convert & Prepare
                                │    - Compress image
                                │    - Encode as base64
                                │    - Add metadata
                                ↓
                    ┌───────────────────────┐
                    │   Upload Package      │
                    │   {                   │
                    │     studentId,        │
                    │     studentName,      │
                    │     quizId,           │
                    │     photo: base64,    │
                    │     questionCount     │
                    │   }                   │
                    └───────────────────────┘
                                │
                                │ 3. HTTP POST
                                │    /api/scans/process
                                │    (60 second timeout)
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│                        ☁️ WEB SERVER                                 │
│                   (Complete OMR Processing)                          │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ 4. Receive Request
                                │    - Extract base64 data
                                │    - Validate image format
                                │    - Convert to buffer
                                ↓
                    ┌───────────────────────┐
                    │   Image Buffer        │
                    │   (Raw binary data)   │
                    └───────────────────────┘
                                │
                                │ 5. Preprocess Image
                                │    - Convert to grayscale
                                │    - Normalize brightness
                                │    - Apply threshold (128)
                                ↓
                    ┌───────────────────────┐
                    │   Binary Image        │
                    │   (Black & White)     │
                    └───────────────────────┘
                                │
                                │ 6. Detect Document
                                │    - Find boundaries
                                │    - Resize to 800x1000
                                │    - (Future: perspective correction)
                                ↓
                    ┌───────────────────────┐
                    │   Warped Image        │
                    │   (Straightened)      │
                    └───────────────────────┘
                                │
                                │ 7. Detect Bubbles
                                │    - Calculate grid layout
                                │    - For each question:
                                │      * Check each option
                                │      * Count dark pixels
                                │      * Calculate fill ratio
                                │      * Select most filled
                                ↓
                    ┌───────────────────────┐
                    │   Answers Array       │
                    │   ["A","B","C","D"...]│
                    └───────────────────────┘
                                │
                                │ 8. Detect Metadata
                                │    - Proctor status
                                │    - Entry type
                                │    - Equity group
                                ↓
                    ┌───────────────────────┐
                    │   Complete OMR Data   │
                    │   {                   │
                    │     answers: [...],   │
                    │     proctorStatus,    │
                    │     entryType,        │
                    │     equityGroup       │
                    │   }                   │
                    └───────────────────────┘
                                │
                                │ 9. Get Answer Key
                                │    - Query database
                                │    - Get correct answers
                                ↓
                    ┌───────────────────────┐
                    │   Correct Answers     │
                    │   ["A","C","B","D"...]│
                    └───────────────────────┘
                                │
                                │ 10. Calculate Scores
                                │     - Compare answers
                                │     - Count correct
                                │     - Calculate percentage
                                │     - Per-subject (if multi)
                                │     - Overall score
                                ↓
                    ┌───────────────────────┐
                    │   Score Results       │
                    │   {                   │
                    │     score: 85,        │
                    │     total: 100,       │
                    │     percentage: 85%,  │
                    │     status: Passinhon │
                    │   }                   │
                    └───────────────────────┘
                                │
                                │ 11. Store Image
                                │     - Save original
                                │     - Generate thumbnail
                                │     - Get file paths
                                ↓
                    ┌───────────────────────┐
                    │   Stored Files        │
                    │   /uploads/images/... │
                    │   /uploads/thumbs/... │
                    └───────────────────────┘
                                │
                                │ 12. Save to Database
                                │     - Insert into scans
                                │     - Insert subject_records
                                │     - Store all data
                                ↓
                    ┌───────────────────────┐
                    │   Database Record     │
                    │   (scans table)       │
                    │   - ID: 123           │
                    │   - Student info      │
                    │   - Answers (JSON)    │
                    │   - Scores            │
                    │   - Image paths       │
                    │   - Timestamp         │
                    └───────────────────────┘
                                │
                                │ 13. Return Results
                                │     - Format JSON response
                                │     - Include all scores
                                │     - Send to mobile app
                                ↓
┌─────────────────────────────────────────────────────────────────────┐
│                        📱 MOBILE APP                                 │
│                      (Display Results)                               │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ 14. Receive Response
                                │     - Parse JSON
                                │     - Extract scores
                                ↓
                    ┌───────────────────────┐
                    │   Results Dialog      │
                    │   ┌─────────────────┐ │
                    │   │ Score: 85/100   │ │
                    │   │ Percentage: 85% │ │
                    │   │ Status: Pass    │ │
                    │   │                 │ │
                    │   │ [Scan Again]    │ │
                    │   │ [Done]          │ │
                    │   └─────────────────┘ │
                    └───────────────────────┘
                                │
                                │ 15. User Action
                                │     - Scan another sheet
                                │     - Or exit
                                ↓
                            [END]

┌─────────────────────────────────────────────────────────────────────┐
│                        💻 WEB DASHBOARD                              │
│                    (Real-time Monitoring)                            │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ Auto-refresh every 5 seconds
                                │ GET /api/scans
                                ↓
                    ┌───────────────────────┐
                    │   All Scan Results    │
                    │   - Recent scans      │
                    │   - Statistics        │
                    │   - Reports           │
                    │   - Export options    │
                    └───────────────────────┘
```

---

## 🔍 Detailed Component Breakdown

### **1. Mobile App - Image Capture**

```
┌──────────────────────────────────────┐
│         ScanActivity.kt              │
├──────────────────────────────────────┤
│                                      │
│  processScan()                       │
│    ↓                                 │
│  capture.takePicture()               │
│    ↓                                 │
│  ImageUtils.imageProxyToBitmap()     │
│    ↓                                 │
│  uploadImageForProcessing()          │
│    ↓                                 │
│  POST /api/scans/process             │
│                                      │
└──────────────────────────────────────┘
```

### **2. Server - OMR Processing**

```
┌──────────────────────────────────────┐
│         api.js                       │
├──────────────────────────────────────┤
│                                      │
│  POST /api/scans/process             │
│    ↓                                 │
│  Extract image buffer                │
│    ↓                                 │
│  omrProcessor.processAnswerSheet()   │
│    ↓                                 │
│  calculateScores()                   │
│    ↓                                 │
│  processAndStoreImage()              │
│    ↓                                 │
│  database.run(INSERT INTO scans)     │
│    ↓                                 │
│  res.json(results)                   │
│                                      │
└──────────────────────────────────────┘

┌──────────────────────────────────────┐
│      omr-processor.js                │
├──────────────────────────────────────┤
│                                      │
│  processAnswerSheet()                │
│    ↓                                 │
│  preprocessImage()                   │
│    ├─ sharp.grayscale()              │
│    ├─ sharp.normalize()              │
│    └─ sharp.threshold(128)           │
│    ↓                                 │
│  detectAndWarpDocument()             │
│    └─ sharp.resize(800, 1000)        │
│    ↓                                 │
│  detectBubbles()                     │
│    ├─ Calculate grid layout          │
│    ├─ For each question:             │
│    │   ├─ For each option:           │
│    │   │   ├─ Get bubble region      │
│    │   │   ├─ Count dark pixels      │
│    │   │   └─ Calculate fill ratio   │
│    │   └─ Select most filled         │
│    └─ Return answers array           │
│    ↓                                 │
│  detectProctorStatus()               │
│  detectEntryType()                   │
│  detectEquityGroup()                 │
│    ↓                                 │
│  Return complete OMR result          │
│                                      │
└──────────────────────────────────────┘
```

### **3. Database Storage**

```
┌──────────────────────────────────────┐
│         SQLite Database              │
├──────────────────────────────────────┤
│                                      │
│  scans table:                        │
│    - id (PRIMARY KEY)                │
│    - student_id                      │
│    - student_name                    │
│    - quiz_id                         │
│    - answers (JSON)                  │
│    - total_score                     │
│    - percentage                      │
│    - status                          │
│    - image_path                      │
│    - thumbnail_path                  │
│    - timestamp                       │
│    - entry_type                      │
│    - special_equity_group            │
│    - (subject scores...)             │
│                                      │
│  subject_records table:              │
│    - id (PRIMARY KEY)                │
│    - scan_id (FOREIGN KEY)           │
│    - student_id                      │
│    - subject_code                    │
│    - score                           │
│    - percentage                      │
│    - status                          │
│    - timestamp                       │
│                                      │
└──────────────────────────────────────┘
```

---

## 🎨 Bubble Detection Algorithm

```
┌─────────────────────────────────────────────────────────────┐
│              Bubble Detection Process                        │
└─────────────────────────────────────────────────────────────┘

Input: Warped image (800x1000 pixels)
       Question count (e.g., 100)
       Options per question (e.g., 4)

Step 1: Calculate Grid Layout
┌─────────────────────────────────────┐
│  rowHeight = imageHeight / questions │
│  colWidth = imageWidth / options     │
│                                      │
│  Example (100 questions, 4 options): │
│    rowHeight = 1000 / 100 = 10px     │
│    colWidth = 800 / 4 = 200px        │
└─────────────────────────────────────┘

Step 2: For Each Question (row)
┌─────────────────────────────────────┐
│  For row = 0 to questionCount-1:    │
│    maxFill = 0                       │
│    selectedOption = ""               │
│                                      │
│    For col = 0 to options-1:         │
│      ↓                               │
└─────────────────────────────────────┘

Step 3: Calculate Bubble Region
┌─────────────────────────────────────┐
│  bubbleX = col * colWidth + 20%      │
│  bubbleY = row * rowHeight + 20%     │
│  bubbleWidth = colWidth * 60%        │
│  bubbleHeight = rowHeight * 60%      │
│                                      │
│  Example (Question 1, Option A):     │
│    bubbleX = 0 * 200 + 40 = 40       │
│    bubbleY = 0 * 10 + 2 = 2          │
│    bubbleWidth = 200 * 0.6 = 120     │
│    bubbleHeight = 10 * 0.6 = 6       │
└─────────────────────────────────────┘

Step 4: Count Dark Pixels
┌─────────────────────────────────────┐
│  darkPixels = 0                      │
│  totalPixels = 0                     │
│                                      │
│  For each pixel in bubble region:    │
│    brightness = (R + G + B) / 3      │
│    if brightness < 128:              │
│      darkPixels++                    │
│    totalPixels++                     │
│                                      │
│  fillRatio = darkPixels / totalPixels│
└─────────────────────────────────────┘

Step 5: Select Option
┌─────────────────────────────────────┐
│  if fillRatio > maxFill AND          │
│     fillRatio > 0.30:                │
│    maxFill = fillRatio               │
│    selectedOption = optionLetter[col]│
│                                      │
│  Example:                            │
│    Option A: fillRatio = 0.15 ❌     │
│    Option B: fillRatio = 0.85 ✅     │
│    Option C: fillRatio = 0.10 ❌     │
│    Option D: fillRatio = 0.05 ❌     │
│    → Selected: "B"                   │
└─────────────────────────────────────┘

Step 6: Store Answer
┌─────────────────────────────────────┐
│  answers[row] = selectedOption       │
│                                      │
│  If no option > 30% threshold:       │
│    answers[row] = ""  (blank)        │
└─────────────────────────────────────┘

Output: answers = ["A", "B", "C", "D", "", "A", ...]
```

---

## 📊 Score Calculation Flow

```
┌─────────────────────────────────────────────────────────────┐
│              Score Calculation Process                       │
└─────────────────────────────────────────────────────────────┘

Input: Detected answers = ["A", "B", "C", "D", ...]
       Quiz ID = 1

Step 1: Get Correct Answers
┌─────────────────────────────────────┐
│  SELECT correct_answers              │
│  FROM quizzes                        │
│  WHERE id = quizId                   │
│    ↓                                 │
│  correctAnswers = ["A", "C", "C", ...]│
└─────────────────────────────────────┘

Step 2: Compare Answers
┌─────────────────────────────────────┐
│  score = 0                           │
│                                      │
│  For i = 0 to questionCount-1:       │
│    studentAns = answers[i].toUpper() │
│    correctAns = correctAnswers[i]    │
│                                      │
│    if studentAns == correctAns:      │
│      score++                         │
│                                      │
│  Example:                            │
│    Q1: "A" == "A" ✅ score = 1       │
│    Q2: "B" != "C" ❌ score = 1       │
│    Q3: "C" == "C" ✅ score = 2       │
│    ...                               │
└─────────────────────────────────────┘

Step 3: Calculate Percentage
┌─────────────────────────────────────┐
│  percentage = (score / total) * 100  │
│                                      │
│  Example:                            │
│    score = 85                        │
│    total = 100                       │
│    percentage = 85.0%                │
└─────────────────────────────────────┘

Step 4: Determine Status
┌─────────────────────────────────────┐
│  if percentage >= 70:                │
│    status = "Passinhon"              │
│  else:                               │
│    status = "Non-passinhon"          │
│                                      │
│  if proctorStatus is set:            │
│    status = proctorStatus (override) │
└─────────────────────────────────────┘

Step 5: Multi-Subject Breakdown (if applicable)
┌─────────────────────────────────────┐
│  Subjects:                           │
│    MATH: Q1-20   (answers[0-19])     │
│    ENG:  Q21-40  (answers[20-39])    │
│    SCI:  Q41-60  (answers[40-59])    │
│    SOC:  Q61-80  (answers[60-79])    │
│    FIL:  Q81-100 (answers[80-99])    │
│                                      │
│  For each subject:                   │
│    Calculate score (0-20)            │
│    Calculate percentage              │
│    Determine status (Pass/Fail)      │
└─────────────────────────────────────┘

Output: 
{
  score: 85,
  totalQuestions: 100,
  percentage: 85.0,
  status: "Passinhon",
  subjectScores: {
    MATH: { score: 18, percentage: 90, status: "Passinhon" },
    ENG: { score: 17, percentage: 85, status: "Passinhon" },
    ...
  }
}
```

---

## 🔄 Data Flow Timeline

```
Time    Mobile App              Server                  Database
────────────────────────────────────────────────────────────────────
0.0s    Capture image          
        │                      
0.5s    Convert to base64      
        │                      
1.0s    Upload starts ────────→ Receive request
        │                       │
1.5s    Uploading...            Extract image buffer
        │                       │
2.0s    Upload complete         Preprocess image
        │                       │
2.5s    Waiting...              Detect document
        │                       │
3.0s    Waiting...              Detect bubbles
        │                       │
4.0s    Waiting...              Detect metadata
        │                       │
4.5s    Waiting...              Get answer key ────→ Query
        │                       │                    │
5.0s    Waiting...              Calculate scores     Return data
        │                       │                    │
5.5s    Waiting...              Store image ───────→ Save files
        │                       │                    │
6.0s    Waiting...              Save to DB ────────→ INSERT
        │                       │                    │
6.5s    Receive results ←────── Return JSON          Commit
        │                       
7.0s    Display results        
        │                      
7.5s    Show dialog            
```

---

## 📱 Mobile App State Machine

```
┌─────────────────────────────────────────────────────────────┐
│              Mobile App States                               │
└─────────────────────────────────────────────────────────────┘

    [START]
       │
       ↓
┌──────────────┐
│   READY      │  Status: "Camera ready — align sheet"
│              │  Button: Enabled
└──────────────┘
       │
       │ User clicks capture
       ↓
┌──────────────┐
│  CAPTURING   │  Status: "Capturing image..."
│              │  Button: Disabled
└──────────────┘
       │
       │ Image captured
       ↓
┌──────────────┐
│  UPLOADING   │  Status: "Uploading image to server..."
│              │  Button: Disabled
└──────────────┘
       │
       │ Upload complete
       ↓
┌──────────────┐
│  PROCESSING  │  Status: "Server processing image..."
│              │  Button: Disabled
└──────────────┘
       │
       ├─ Success ─→ ┌──────────────┐
       │             │   COMPLETE   │  Status: "Processing complete!"
       │             │              │  Button: Enabled
       │             └──────────────┘
       │                    │
       │                    │ Show results dialog
       │                    ↓
       │             ┌──────────────┐
       │             │   RESULTS    │  Dialog: Score, percentage, status
       │             │              │  Options: [Scan Again] [Done]
       │             └──────────────┘
       │                    │
       │                    ├─ Scan Again ─→ [READY]
       │                    └─ Done ────────→ [EXIT]
       │
       └─ Error ───→ ┌──────────────┐
                     │    ERROR     │  Status: "Error: [message]"
                     │              │  Button: Enabled
                     └──────────────┘
                            │
                            │ User retries
                            ↓
                         [READY]
```

---

## 🎯 Summary

This complete flow ensures:

1. ✅ **Mobile app captures image** → saves locally
2. ✅ **Image uploads to web system**
3. ✅ **Web system checks** (scans bubbles, extracts student info, calculates score)
4. ✅ **Web system records** (stores image, answers, student data, and scores in database)
5. ✅ **Results sent back to mobile app** for display

**All processing happens on the server!** 🎉

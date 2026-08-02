# How the Web Interface Checks Scanned Papers

## 📊 Complete Data Flow Explanation

---

## 🎯 **Important Clarification:**

The **web interface DOES NOT scan the paper directly**. Instead:

1. **Mobile App** = Does the scanning (camera + OpenCV)
2. **Server** = Receives and processes the data
3. **Web Interface** = Displays the results

---

## 🔄 **Complete Workflow:**

```
┌─────────────────────────────────────────────────────────┐
│                    COMPLETE PROCESS                      │
└─────────────────────────────────────────────────────────┘

📱 MOBILE APP (Scanning)
    ↓
    1. Student fills answer sheet with pen/pencil
    2. Teacher opens ScanCheck mobile app
    3. App uses camera to capture photo
    4. OpenCV processes image locally
    5. Detects filled bubbles (A, B, C, D)
    6. Extracts answers array: ["A", "B", "C", "D", ...]
    ↓
☁️ SERVER (Processing)
    ↓
    7. Mobile app sends data to server via HTTP POST
    8. Server receives: answers, student info, photo
    9. Server compares with correct answers
    10. Server calculates score and percentage
    11. Server saves to database
    12. Server sends results back to mobile app
    ↓
💻 WEB INTERFACE (Display)
    ↓
    13. Web polls server every 5 seconds
    14. Web fetches all scan results via API
    15. Web displays results in dashboard
    16. Teachers can view detailed reports
```

---

## 📱 **Step 1: Mobile App Scanning**

### **What Happens:**
```kotlin
// In Android App (ScanActivity.kt)

1. Capture Photo
   camera.takePicture() → Bitmap image

2. Process with OpenCV
   omrProcessor.processAnswerSheet(bitmap)
   ↓
   - Convert to grayscale
   - Apply threshold
   - Detect document boundaries
   - Straighten perspective
   - Find bubble regions
   - Count filled pixels
   - Extract answers: ["A", "B", "C", "D", ...]

3. Prepare Data
   {
     "studentName": "John Doe",
     "answers": ["A", "B", "C", "D", ...],
     "quizId": 1,
     "photo": "base64_encoded_image",
     "proctorStatus": "Passinhon",
     "entryType": "New Student",
     "specialEquityGroup": "None"
   }
```

---

## ☁️ **Step 2: Server Processing**

### **API Endpoint: POST /api/scans**

```javascript
// In server/api.js

router.post('/scans', async (req, res) => {
    // 1. Receive data from mobile app
    const { studentName, answers, quizId, photo } = req.body;
    
    // 2. Process image (save, create thumbnail)
    const imageData = await processAndStoreImage(photo);
    
    // 3. Get correct answers from database
    const correctAnswers = await getCorrectAnswers(quizId);
    
    // 4. Calculate scores
    const subjectResults = await calculateSubjectScores(answers);
    // Example:
    // {
    //   MATH: { score: 18, percentage: 90, status: "Passinhon" },
    //   ENG: { score: 16, percentage: 80, status: "Passinhon" },
    //   SCI: { score: 15, percentage: 75, status: "Passinhon" },
    //   SOC: { score: 17, percentage: 85, status: "Passinhon" },
    //   FIL: { score: 14, percentage: 70, status: "Passinhon" },
    //   totalScore: 80,
    //   totalQuestions: 100,
    //   overallPercentage: 80
    // }
    
    // 5. Save to database
    await database.run(`
        INSERT INTO scans (
            student_name, answers, quiz_id, 
            total_score, percentage, status,
            math_score, english_score, science_score,
            photo, image_path, thumbnail_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [studentName, JSON.stringify(answers), quizId, ...]);
    
    // 6. Send response back to mobile app
    res.json({
        score: 80,
        totalQuestions: 100,
        percentage: 80,
        status: "Passinhon",
        subjectScores: subjectResults
    });
});
```

### **What Gets Saved:**
```sql
-- In database (scans table)
INSERT INTO scans:
- student_name: "John Doe"
- answers: ["A", "B", "C", "D", ...] (JSON)
- quiz_id: 1
- total_score: 80
- total_questions: 100
- percentage: 80.0
- status: "Passinhon"
- math_score: 18
- english_score: 16
- science_score: 15
- social_score: 17
- filipino_score: 14
- photo: base64 image data
- image_path: "/uploads/images/scan_123.jpg"
- thumbnail_path: "/uploads/thumbnails/scan_123_thumb.jpg"
- timestamp: "2026-04-21 10:30:00"
```

---

## 💻 **Step 3: Web Interface Display**

### **How Web Gets the Data:**

#### **A. Auto-Refresh (Every 5 seconds)**
```javascript
// In web/js/app.js

// Auto-refresh scan results every 5 seconds
setInterval(async () => {
    if (this.isAuthenticated()) {
        await this.loadScanResults();
    }
}, 5000);
```

#### **B. Load Scan Results**
```javascript
async loadScanResults() {
    try {
        // 1. Call API to get all scans
        const response = await scanCheckConfig.apiCall('/api/scans');
        
        // 2. Store in memory
        this.scanResults = response.scans || [];
        
        // 3. Display on page
        this.renderScanResults();
        
        // 4. Update dashboard stats
        this.renderDashboard();
    } catch (error) {
        console.error('Error loading scan results:', error);
    }
}
```

#### **C. API Call to Server**
```javascript
// GET /api/scans
// Server returns:
{
  "scans": [
    {
      "id": 1,
      "student_name": "John Doe",
      "quiz_id": 1,
      "quiz_title": "Entrance Exam",
      "score": 80,
      "total_questions": 100,
      "percentage": 80.0,
      "status": "Passinhon",
      "answers": ["A", "B", "C", "D", ...],
      "math_score": 18,
      "english_score": 16,
      "science_score": 15,
      "social_score": 17,
      "filipino_score": 14,
      "photo": "base64...",
      "image_path": "/uploads/images/scan_1.jpg",
      "thumbnail_path": "/uploads/thumbnails/scan_1_thumb.jpg",
      "timestamp": "2026-04-21 10:30:00",
      "entry_type": "New Student",
      "special_equity_group": "None"
    },
    // ... more scans
  ]
}
```

#### **D. Display Results**
```javascript
renderScanResults() {
    const container = document.getElementById('scanResults');
    
    // For each scan result, create HTML card
    container.innerHTML = this.scanResults.map(scan => `
        <div class="scan-item">
            <div class="student-info">
                <strong>${scan.student_name}</strong>
                <span>${scan.quiz_title}</span>
            </div>
            <div class="score-info">
                <div class="percentage">${scan.percentage}%</div>
                <div class="score">${scan.score} / ${scan.total_questions}</div>
                <span class="status">${scan.status}</span>
            </div>
            <button onclick="showDetailedResults(${scan.id})">
                View Details
            </button>
        </div>
    `).join('');
}
```

---

## 📊 **What the Web Interface Shows:**

### **1. Scan Results Page**
```
┌─────────────────────────────────────────────────────┐
│ 📷 Scan Results                                     │
├─────────────────────────────────────────────────────┤
│                                                      │
│ 👤 John Doe                          90.0%          │
│    Entrance Exam                     45/50 correct  │
│    📅 Apr 21, 2026 10:30 AM         ✅ Passinhon   │
│    [View Details] [Export]                          │
│                                                      │
│ 👤 Jane Smith                        85.0%          │
│    Entrance Exam                     85/100 correct │
│    📅 Apr 21, 2026 10:35 AM         ✅ Passinhon   │
│    [View Details] [Export]                          │
│                                                      │
│ 👤 Bob Johnson                       65.0%          │
│    Entrance Exam                     65/100 correct │
│    📅 Apr 21, 2026 10:40 AM         ❌ Non-passinhon│
│    [View Details] [Export]                          │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### **2. Detailed Results Modal**
```
┌─────────────────────────────────────────────────────┐
│ Detailed Results: John Doe                    [X]   │
├─────────────────────────────────────────────────────┤
│ Score: 45/50 (90.0%)                                │
│ Status: ✅ Passinhon                                │
│                                                      │
│ ┌─────────────────────┐  ┌──────────────────────┐  │
│ │ Question-by-Question│  │ Scanned Image        │  │
│ ├─────────────────────┤  │                      │  │
│ │ Q#  Student Correct │  │  [Photo of answer    │  │
│ │ 1   A       A    ✅ │  │   sheet with marks]  │  │
│ │ 2   B       B    ✅ │  │                      │  │
│ │ 3   C       D    ❌ │  │                      │  │
│ │ 4   D       D    ✅ │  │                      │  │
│ │ ... (scrollable)    │  │                      │  │
│ └─────────────────────┘  └──────────────────────┘  │
│                                                      │
│ Subject Breakdown:                                  │
│ MATH:    18/20 (90%) ✅                             │
│ ENGLISH: 16/20 (80%) ✅                             │
│ SCIENCE: 15/20 (75%) ✅                             │
│ SOCIAL:  17/20 (85%) ✅                             │
│ FILIPINO:14/20 (70%) ✅                             │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### **3. Dashboard Statistics**
```
┌─────────────────────────────────────────────────────┐
│ 📊 Dashboard                                        │
├─────────────────────────────────────────────────────┤
│                                                      │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐│
│ │ 📝 Quizzes│ │ 📷 Scans │ │ 📊 Avg   │ │ ✅ Pass ││
│ │    5      │ │   150    │ │  82.5%   │ │  85%   ││
│ └──────────┘ └──────────┘ └──────────┘ └─────────┘│
│                                                      │
│ Recent Scans:                                       │
│ • John Doe - 90% - Passinhon                        │
│ • Jane Smith - 85% - Passinhon                      │
│ • Bob Johnson - 65% - Non-passinhon                 │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### **4. Reports Page**
```
┌─────────────────────────────────────────────────────┐
│ 📈 Comprehensive Score Report                       │
├─────────────────────────────────────────────────────┤
│                                                      │
│ Total Scans: 150                                    │
│ Passinhon: 128 (85%)                                │
│ Non-passinhon: 22 (15%)                             │
│ Average Score: 82.5%                                │
│                                                      │
│ [Export to CSV]                                     │
│                                                      │
│ ┌─────────────────────────────────────────────────┐│
│ │ Student    Quiz      Score  %     Status       ││
│ ├─────────────────────────────────────────────────┤│
│ │ John Doe   Entrance  45/50  90%   Passinhon    ││
│ │ Jane Smith Entrance  85/100 85%   Passinhon    ││
│ │ Bob Johnson Entrance 65/100 65%   Non-passinhon││
│ │ ... (all scans)                                 ││
│ └─────────────────────────────────────────────────┘│
│                                                      │
└─────────────────────────────────────────────────────┘
```

---

## 🔄 **Real-Time Updates:**

### **How Web Stays Updated:**

```javascript
// Automatic refresh every 5 seconds
setInterval(() => {
    // 1. Call server API
    fetch('/api/scans')
    
    // 2. Get latest scan results
    .then(response => response.json())
    
    // 3. Update display
    .then(data => {
        this.scanResults = data.scans;
        this.renderScanResults();
        this.renderDashboard();
    });
}, 5000);
```

### **What This Means:**
- ✅ When mobile app uploads a scan, it appears on web within 5 seconds
- ✅ Multiple teachers can view results simultaneously
- ✅ Dashboard updates automatically
- ✅ No page refresh needed

---

## 📸 **Image Display:**

### **How Web Shows Scanned Images:**

```javascript
// In detailed results modal
showDetailedResults(scanId) {
    const scan = this.scanResults.find(s => s.id === scanId);
    
    // Display scanned image
    if (scan.photo) {
        // Show base64 image
        modalHtml += `
            <img src="${scan.photo}" 
                 alt="Scanned answer sheet"
                 style="max-width: 100%;">
        `;
    } else if (scan.image_path) {
        // Show image from server
        modalHtml += `
            <img src="${serverUrl}${scan.image_path}" 
                 alt="Scanned answer sheet">
        `;
    }
}
```

---

## 🎯 **Summary: How Web "Checks" Papers**

### **The web DOESN'T scan papers directly. Instead:**

1. **Mobile App** → Scans paper with camera + OpenCV
2. **Mobile App** → Sends results to server
3. **Server** → Processes and saves to database
4. **Web** → Fetches results from server
5. **Web** → Displays results to teachers

### **Web Interface Role:**
- ✅ **Display** scan results
- ✅ **Show** detailed answers
- ✅ **Generate** reports
- ✅ **Export** data to CSV
- ✅ **View** scanned images
- ✅ **Monitor** statistics
- ✅ **Manage** quizzes and answer keys

### **Web Does NOT:**
- ❌ Scan papers directly
- ❌ Process images
- ❌ Use camera
- ❌ Run OpenCV

---

## 🔧 **Technical Architecture:**

```
┌─────────────────────────────────────────────────────┐
│                  SYSTEM ARCHITECTURE                 │
└─────────────────────────────────────────────────────┘

📱 MOBILE APP (Android)
├── Camera (CameraX)
├── Image Processing (OpenCV)
├── OMR Detection (Custom Algorithm)
└── HTTP Client (Upload to Server)
        ↓
        ↓ POST /api/scans
        ↓
☁️ SERVER (Node.js + Express)
├── API Endpoints (Express Router)
├── Database (SQLite)
├── Image Storage (File System)
├── Score Calculation (JavaScript)
└── Authentication (JWT)
        ↓
        ↓ GET /api/scans
        ↓
💻 WEB INTERFACE (HTML + JavaScript)
├── Dashboard (Statistics)
├── Scan Results (List View)
├── Detailed Results (Modal)
├── Reports (Analytics)
└── Auto-Refresh (5 second polling)
```

---

## 📊 **Data Flow Diagram:**

```
MOBILE APP                SERVER              WEB INTERFACE
    │                        │                      │
    │ 1. Scan Paper         │                      │
    │ (Camera + OpenCV)     │                      │
    │                        │                      │
    │ 2. POST /api/scans    │                      │
    ├──────────────────────>│                      │
    │   {answers, photo}    │                      │
    │                        │                      │
    │                        │ 3. Save to DB       │
    │                        │    Calculate Score  │
    │                        │                      │
    │ 4. Response           │                      │
    │<──────────────────────┤                      │
    │   {score, status}     │                      │
    │                        │                      │
    │                        │ 5. GET /api/scans   │
    │                        │<─────────────────────┤
    │                        │                      │
    │                        │ 6. Return Results   │
    │                        ├─────────────────────>│
    │                        │   {scans: [...]}    │
    │                        │                      │
    │                        │                      │ 7. Display
    │                        │                      │    Results
```

---

## 🎉 **Conclusion:**

The web interface **receives and displays** scan results, but the actual **scanning and processing** happens on the **mobile app** using the phone's camera and OpenCV library.

**Think of it like this:**
- 📱 **Mobile App** = Scanner + Processor
- ☁️ **Server** = Storage + Calculator
- 💻 **Web** = Dashboard + Reports

All three work together to create a complete OMR system! 🚀

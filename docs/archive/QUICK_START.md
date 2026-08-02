# 🚀 Quick Start Guide - ScanCheck System

## ✅ System Status: RUNNING

The ScanCheck system is now **fully operational** and ready to use!

---

## 📍 Access the System

### Option 1: Local Access (Same Computer)
Open your web browser and go to:
```
http://localhost:3000
```

### Option 2: Network Access (Mobile/Other Devices)
From any device on the same network:
```
http://192.168.137.1:3000
```

---

## 🎯 What You Can Do Now

### 1. **Web Dashboard** 
Access the full-featured web interface with:
- 📊 **Dashboard** - View statistics and recent scans
- ✏️ **Exam Mode** - Quick scanning interface
- 📝 **Exams Management** - Create and manage quizzes
- 🔑 **Answer Key** - Set correct answers for exams
- 👥 **Staff Management** - Manage user accounts
- 📈 **Reports** - View detailed student performance

### 2. **Mobile App** (Android)
Configure the mobile app to connect to the server:
1. Open the Android app
2. Go to Settings
3. Set Server URL: `http://192.168.137.1:3000`
4. Start scanning answer sheets!

---

## 🎓 Using the System

### Create Your First Exam

1. **Open Web Dashboard**
   - Go to http://localhost:3000
   - Login or register a new account

2. **Create an Exam**
   - Click "Exams" in the navigation
   - Click "Create New Exam"
   - Enter exam details:
     - Title (e.g., "Midterm Exam")
     - Number of questions
     - Number of options (A, B, C, D)

3. **Set Answer Key**
   - Click "Answer Key" in navigation
   - Select your exam
   - Enter correct answers for each question
   - Save the answer key

4. **Start Scanning**
   - Use the mobile app to capture answer sheets
   - Or use "Exam Mode" in web dashboard
   - System automatically grades and stores results

---

## 📱 Mobile App Setup

### Configure Server Connection

1. **Build the Android App** (if not already built)
   ```bash
   cd android
   ./gradlew assembleDebug
   ```

2. **Install APK**
   - APK location: `android/app/build/outputs/apk/debug/app-debug.apk`
   - Transfer to phone and install

3. **Configure in App**
   - Open ScanCheck app
   - Enter server URL: `http://192.168.137.1:3000`
   - Test connection

### Scan Answer Sheets

1. Open the app
2. Select exam/quiz
3. Capture answer sheet photo
4. App uploads to server
5. Server processes and returns results
6. View scores immediately

---

## 🎨 Features Overview

### Multi-Subject Exams (100 Questions)
Perfect for entrance exams with 5 subjects:
- **Mathematics** - Questions 1-20
- **English** - Questions 21-40
- **Science** - Questions 41-60
- **Social Studies** - Questions 61-80
- **Filipino** - Questions 81-100

Each subject scored separately with pass/fail status (70% passing)

### Single Exam Mode
Create custom exams with any number of questions for:
- Quizzes
- Chapter tests
- Practice exams
- Custom assessments

### Automatic Processing
- ✅ Bubble detection
- ✅ Student ID extraction
- ✅ Automatic grading
- ✅ Score calculation
- ✅ Pass/Fail determination
- ✅ Image storage
- ✅ Thumbnail generation

---

## 📊 View Results

### Dashboard
- Total scans today/week/month
- Pass/fail statistics
- Recent scans
- Subject performance charts

### Individual Results
- Student name and ID
- Score per subject
- Overall percentage
- Pass/fail status
- Scanned answer sheet image
- Detailed answer breakdown

### Reports
- Filter by department, course, date
- Export to CSV
- Subject-wise analysis
- Performance trends

---

## 🔧 Server Management

### Check Server Status
```bash
curl http://localhost:3000/api/health
```

Expected response:
```json
{"status":"OK","timestamp":"2026-04-26T04:20:25.611Z"}
```

### Restart Server
If you need to restart:
1. Press `Ctrl+C` in the server terminal
2. Run: `npm start` in the `server` directory

### View Logs
Server logs are displayed in the terminal where it's running.

---

## 📁 Important Directories

```
scancheck-system/
├── server/              # Backend server
│   ├── server.js       # Main server file
│   ├── database.js     # Database operations
│   ├── api.js          # API endpoints
│   ├── omr-processor.js # OMR processing logic
│   └── scancheck.db    # SQLite database
├── web/                # Web dashboard
│   ├── index.html      # Main page
│   ├── css/            # Stylesheets
│   └── js/             # JavaScript files
├── android/            # Mobile app
│   └── app/            # Android app source
└── uploads/            # Scanned images
    ├── images/         # Full-size images
    └── thumbnails/     # Thumbnail images
```

---

## 🆘 Common Issues

### Can't Access Web Dashboard
- ✅ Check server is running (look for "ScanCheck Server running" message)
- ✅ Try http://localhost:3000
- ✅ Check firewall settings

### Mobile App Can't Connect
- ✅ Ensure phone and server are on same WiFi network
- ✅ Use network IP (192.168.137.1:3000) not localhost
- ✅ Check server is running
- ✅ Verify firewall allows port 3000

### No Answer Key Found Error
- ✅ Create an exam first
- ✅ Set the answer key for that exam
- ✅ Select the correct exam when scanning

---

## 📞 Need Help?

Check the detailed documentation:
- **[SYSTEM_STATUS.md](SYSTEM_STATUS.md)** - Current system status
- **[README.md](README.md)** - Full documentation
- **[NEW_ARCHITECTURE.md](NEW_ARCHITECTURE.md)** - Technical details
- **[SETUP_NEW_SYSTEM.md](SETUP_NEW_SYSTEM.md)** - Setup guide

---

## 🎉 You're All Set!

The ScanCheck system is ready to use. Start by:
1. Opening http://localhost:3000 in your browser
2. Creating a user account
3. Setting up your first exam
4. Scanning answer sheets!

**Happy Scanning! 📝✨**

# Quick Setup Guide - New Architecture

## 🚀 Getting Started

Follow these steps to set up the new server-side OMR processing system.

---

## 📋 Prerequisites

- Node.js 16+ installed
- Python 3.8+ installed (with `pip`)
- Android Studio (for mobile app development)
- Network connection between mobile device and server

---

## 🔧 Step 0: Install Python Dependencies

The system now uses high-accuracy Python workers for OMR and OCR.

```bash
# From the project root
pip install -r requirements.txt
```

**Note:** The first time you run a scan, the system will automatically download the PaddleOCR models (~20MB). This may take a moment depending on your internet connection.

---

## 🔧 Step 1: Install Server Dependencies

```bash
cd scancheck-system/server
npm install
```

This will install the new `jimp` package along with existing dependencies.

**Expected output:**
```
added 1 package, and audited 150 packages in 5s
```

---

## 🚀 Step 2: Start the Server

```bash
npm start
```

**Expected output:**
```
✅ ScanCheck Server running on:
   Local:  http://localhost:3000
   Network: http://192.168.1.100:3000
🌐 Web interface available at both URLs
📱 Use this URL on phone: http://192.168.1.100:3000
```

**Note the Network URL** - you'll need this for the mobile app!

---

## 📱 Step 3: Build Mobile App

### Option A: Using Android Studio

1. Open `scancheck-system/android` in Android Studio
2. Wait for Gradle sync to complete
3. Click **Build > Build Bundle(s) / APK(s) > Build APK(s)**
4. Find APK in `android/app/build/outputs/apk/debug/`

### Option B: Using Command Line

```bash
cd scancheck-system/android
./gradlew assembleDebug
```

**APK Location:**
```
android/app/build/outputs/apk/debug/app-debug.apk
```

---

## 📲 Step 4: Install Mobile App

### Transfer APK to Android device:

**Option A: USB Cable**
```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

**Option B: File Transfer**
1. Copy APK to device via USB/Bluetooth/Email
2. Open APK on device
3. Allow installation from unknown sources
4. Install

---

## ⚙️ Step 5: Configure Mobile App

1. **Open ScanCheck app**
2. **Enter Server URL:**
   - Use the Network URL from Step 2
   - Example: `http://192.168.1.100:3000`
3. **Enter Quiz ID:** `1` (or your quiz ID)
4. **Enter Question Count:** `100` (or your question count)
5. **Click "Test Connection"**
   - Should show: "Connected to server"
6. **Click "Start Scanning"**

---

## 🎯 Step 6: Test the System

### Create a Test Quiz:

1. **Open web browser:** `http://localhost:3000`
2. **Sign in** (default: username/password from database)
3. **Go to "Exams" page**
4. **Create new exam:**
   - Title: "Test Exam"
   - Questions: 100
   - Options: 4 (A-D)
5. **Set answer key:**
   - Go to "Answer Key" page
   - Select "Test Exam"
   - Set some answers (e.g., all "A")
   - Save

### Generate Answer Sheet:

1. **Go to "Exam Mode" page**
2. **Select "Test Exam"**
3. **Choose format:** Multi-Subject or Normal
4. **Click "Generate Sheet"**
5. **Print the answer sheet**

### Scan Answer Sheet:

1. **Fill some bubbles on printed sheet**
2. **Open mobile app**
3. **Click "Start Scanning"**
4. **Align sheet in camera view**
5. **Click capture button**
6. **Wait for processing** (3-8 seconds)
7. **View results!**

---

## ✅ Verification

### Check if everything works:

**Mobile App:**
- [ ] Camera opens successfully
- [ ] Can capture image
- [ ] Shows "Uploading image to server..."
- [ ] Shows "Server processing image..."
- [ ] Shows "Processing complete!"
- [ ] Displays score and status

**Server:**
- [ ] Receives image upload
- [ ] Processes image successfully
- [ ] Logs show: "Processing scan for..."
- [ ] Logs show: "OMR Processing complete: X answers detected"
- [ ] Returns results to mobile app

**Web Dashboard:**
- [ ] New scan appears in "Scan Results"
- [ ] Shows correct score and percentage
- [ ] Displays student name
- [ ] Shows timestamp
- [ ] Can view detailed results

---

## 🐛 Troubleshooting

### Mobile App Can't Connect to Server

**Problem:** "Connection failed: Failed to connect to /192.168.1.100:3000"

**Solutions:**
1. Check server is running (`npm start`)
2. Verify server URL is correct
3. Ensure mobile device and server are on same network
4. Check firewall settings (allow port 3000)
5. Try using IP address instead of hostname

**Windows Firewall:**
```bash
# Run as Administrator
netsh advfirewall firewall add rule name="ScanCheck Server" dir=in action=allow protocol=TCP localport=3000
```

---

### Server Processing Fails

**Problem:** "OMR processing failed: Invalid image format"

**Solutions:**
1. Check image quality (good lighting, clear bubbles)
2. Ensure answer sheet is properly aligned
3. Verify image is not too large (< 10MB)
4. Check server logs for detailed error

**View Server Logs:**
```bash
# Server console shows detailed processing logs
Processing scan for Student 123, Quiz ID: 1, Questions: 100
OMR Processing complete: 85 answers detected
```

---

### No Bubbles Detected

**Problem:** "Detected 0 filled bubbles out of 100"

**Solutions:**
1. **Improve lighting** - Use bright, even lighting
2. **Fill bubbles completely** - Use dark pen/pencil
3. **Align sheet properly** - All corners visible
4. **Check answer sheet format** - Must match generated template
5. **Adjust threshold** - Edit `BUBBLE_FILL_THRESHOLD` in `omr-processor.js`

---

### Web Dashboard Not Updating

**Problem:** New scans don't appear on dashboard

**Solutions:**
1. Refresh browser (Ctrl+F5)
2. Check auto-refresh is enabled (every 5 seconds)
3. Verify scan was saved to database
4. Check browser console for errors
5. Clear browser cache

---

## 🔍 Testing Tips

### For Best Results:

**Printing:**
- Use high-quality printer
- Print on white paper
- Ensure alignment markers are clear
- Check all bubbles are visible

**Filling:**
- Use black pen or #2 pencil
- Fill bubbles completely
- Make clean erasures
- Avoid stray marks

**Scanning:**
- Use good lighting (natural or bright indoor)
- Hold camera steady
- Align sheet to fill camera view
- Ensure all corners are visible
- Avoid shadows on paper

---

## 📊 Performance Expectations

### Normal Operation:

**Mobile App:**
- Image capture: < 1 second
- Upload time: 1-3 seconds (depends on network)
- Total time: 3-8 seconds per scan

**Server:**
- Image processing: 2-5 seconds
- Bubble detection: 1-2 seconds
- Score calculation: < 1 second
- Database save: < 1 second

**Accuracy:**
- Good conditions: 95-99%
- Average conditions: 90-95%
- Poor conditions: 80-90%

---

## 🎓 Next Steps

### After successful setup:

1. **Create real quizzes** with actual questions
2. **Set answer keys** for all quizzes
3. **Generate answer sheets** for students
4. **Train staff** on mobile app usage
5. **Test with sample sheets** before actual exam
6. **Monitor server logs** during scanning
7. **Export results** to CSV for analysis

---

## 📞 Support

### If you encounter issues:

1. **Check server logs** - Most errors are logged
2. **Test with sample image** - Verify processing works
3. **Review documentation** - See NEW_ARCHITECTURE.md
4. **Check network connectivity** - Ping server from mobile device
5. **Verify dependencies** - Run `npm install` again

---

## 🎉 Success!

If you can:
- ✅ Capture image on mobile app
- ✅ Upload to server
- ✅ See "Processing complete!" message
- ✅ View results on mobile app
- ✅ See scan in web dashboard

**Your system is working correctly!** 🎊

You're now ready to use the ScanCheck system for real examinations.

---

## 📝 Quick Reference

**Server URL Format:**
```
http://[SERVER_IP]:[PORT]
Example: http://192.168.1.100:3000
```

**API Endpoint:**
```
POST /api/scans/process
```

**Required Fields:**
- `studentId` - Student identifier
- `studentName` - Student name
- `quizId` - Quiz/exam ID
- `photo` - Base64 encoded image
- `questionCount` - Number of questions

**Response:**
- `score` - Number of correct answers
- `totalQuestions` - Total questions
- `percentage` - Score percentage
- `status` - Passinhon/Non-passinhon
- `answers` - Detected answers array

---

## 🔄 Update Process

### To update the system:

**Server:**
```bash
cd scancheck-system/server
git pull  # or copy new files
npm install
npm start
```

**Mobile App:**
```bash
cd scancheck-system/android
./gradlew assembleDebug
# Install new APK on devices
```

**No database migration needed** - existing data remains intact!

---

**Happy Scanning! 📱✨**

# Answer Sheet Format Options - Implementation Guide

## Date: April 21, 2026

## Summary
Successfully implemented two optional answer sheet formats for the ScanCheck OMR system with a quick "Generate Sheet" button:
1. **Multi-Subject Format** (5 subjects: MATH, ENG, SCI, SOC, FIL)
2. **Normal Format** (Single quiz/exam)

## Changes Made

### 1. Web Interface Updates

#### `web/index.html`
- ✅ Added "Sheet Format" dropdown selector
- ✅ Added **"Generate Sheet" button** for quick generation
- ✅ Reorganized layout: Quiz → Format → Generate Button → Department Cards
- ✅ Loaded `answer-sheetnormal.js` script

### 2. JavaScript Files

#### `web/js/answer-sheet.js`
- ✅ Contains `AnswerSheetGenerator` class (base class with department colors)
- ✅ Contains `MultiSubjectAnswerSheetGenerator` class (extends base for 5 subjects)
- ✅ Initializes both generators on page load

#### `web/js/answer-sheetnormal.js` (NEW)
- ✅ Contains `NormalAnswerSheetGenerator` class
- ✅ Supports department color coding
- ✅ Supports course logos
- ✅ Single quiz format with flexible question count
- ✅ Auto-adjusts columns based on question count

#### `web/js/app.js`
- ✅ Updated `generateDepartmentSheet()` to check format selection
- ✅ Added **`generateGenericSheet()`** method for quick generation
- ✅ Routes to appropriate generator based on user choice
- ✅ Stores format preference in localStorage
- ✅ Shows format type in success toast message

## How It Works

### User Workflow (Two Options):

#### Option 1: Quick Generate (NEW)
1. **Choose Quiz** - Select from available quizzes
2. **Select Format** - Choose Multi-Subject or Normal
3. **Click "Generate Sheet"** - Creates generic answer sheet with default "Answer Sheet" label

#### Option 2: Department-Specific Generate
1. **Choose Quiz** - Select from available quizzes
2. **Select Format** - Choose Multi-Subject or Normal
3. **Click Department Card** - Creates answer sheet with department branding

### Format Differences:

#### Multi-Subject Format:
- **Questions**: Fixed 100 questions (20 per subject)
- **Subjects**: MATH, ENG, SCI, SOC, FIL
- **Layout**: Grid layout with subject headers
- **Use Case**: Comprehensive entrance exams covering multiple subjects
- **Student Info**: Includes Entry and Equity Group sections

#### Normal Format:
- **Questions**: Flexible (based on quiz configuration)
- **Subjects**: Single quiz/exam
- **Layout**: Continuous question grid
- **Use Case**: Single subject tests, departmental exams
- **Student Info**: Standard form with name, course, subject, date, room, signature

### Both Formats Include:
✅ Department color coding (Red, Green, Pink, Yellow, Maroon)
✅ Course logos
✅ PCC header with warning
✅ OMR alignment markers (corner squares and edge bars)
✅ Bubble answer format with A, B, C, D options
✅ Instructions section
✅ Professional layout optimized for 8.5" x 13" paper

## Department Colors:
- **Criminology**: Red (#ff0000)
- **Elementary Education**: Green (#008000)
- **Secondary Education**: Green (#008000)
- **Hospitality Management**: Pink (#ffc0cb)
- **Business Administration**: Yellow (#ffff00)
- **Information Technology**: Maroon (#800000)
- **Default/Answer Sheet**: Black (#000000)

## Technical Details

### Class Structure:
```
AnswerSheetGenerator (base)
├── MultiSubjectAnswerSheetGenerator (extends base)
└── NormalAnswerSheetGenerator (separate class)
```

### Methods:
- `generateDepartmentSheet(name, logo)` - Generates with department branding
- `generateGenericSheet()` - **NEW** - Generates generic answer sheet

### Storage:
- Current quiz config: `localStorage.scancheck_current_quiz`
- Selected format: `localStorage.scancheck_sheet_format`

### Generator Instances:
- `window.answerSheetGenerator` - Multi-subject generator
- `window.normalAnswerSheetGenerator` - Normal generator

## Testing Checklist

✅ Format selector displays correctly
✅ **"Generate Sheet" button works**
✅ Multi-subject format generates 5 subject sections
✅ Normal format generates single quiz layout
✅ Department-specific generation works
✅ Generic generation works with default branding
✅ Department colors apply correctly to both formats
✅ Course logos display in both formats
✅ Alignment markers present in both formats
✅ Print functionality works for both formats
✅ Format preference persists during session

## Benefits

1. **Quick Generation** - One-click generic sheet creation
2. **Flexibility** - Choose format based on exam type
3. **Two Workflows** - Generic or department-specific
4. **Consistency** - Both formats use same color coding
5. **Professional** - Both formats maintain PCC branding
6. **User-Friendly** - Simple dropdown + button interface
7. **Backward Compatible** - Existing multi-subject format still default

## UI Layout

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Choose Quiz    2. Sheet Format    [Generate Sheet]       │
│ [Dropdown]        [Dropdown]                                 │
│                                                               │
│ 3. Or Select Department                                      │
│ [Dept Cards...]                                              │
└─────────────────────────────────────────────────────────────┘
```

## Future Enhancements (Optional)

- Add format preview thumbnails
- Allow custom subject names in multi-subject format
- Add 3-subject and 4-subject format options
- Save format preference per quiz type
- Add format-specific print settings
- Bulk generate multiple sheets at once

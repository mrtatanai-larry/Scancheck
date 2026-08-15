// Answer Sheet Generator
class AnswerSheetGenerator {
    constructor() {
        this.PAPER_SIZES = {
            'a4': { width: '210mm', height: '297mm', label: 'A4 (210×297mm)' },
            'long-bond': { width: '8.5in', height: '13in', label: 'Long Bond (8.5×13)' },
            '11x14-bond': { width: '11in', height: '14in', label: '11×14 Bond' },
        };
        this.defaultConfig = {
            questions: 100, // College entrance exams usually have more questions
            options: 4, 
            columns: 3, // Default to 3 columns for 100 questions
            showStudentInfo: true,
            showInstructions: true,
            title: 'Entrance Examination',
            courseLogo: null,
            courseName: null,
            paperSize: 'a4'
        };
    }

    /** Mount point for the OMR markup (inside .print-container) */
    getOmrMount(targetElement = null) {
        if (targetElement) return targetElement;
        
        let el = document.getElementById('omr-sheet');
        if (!el) {
            const wrap = document.getElementById('answerSheetPreview');
            if (wrap) {
                wrap.classList.add('print-container');
                wrap.innerHTML = '<div id="omr-sheet"></div>';
                el = document.getElementById('omr-sheet');
            }
        }
        return el;
    }

    generate(config = this.defaultConfig, targetElement = null) {
        const sheet = this.getOmrMount(targetElement);
        if (!sheet) return;

        const finalConfig = { ...this.defaultConfig, ...config };
        
        // Use black for all department colors
        finalConfig.deptColor = '#000000';
        // Keep every generated format on the same A4 physical page standard.
        finalConfig.paperSize = 'a4';

        if (config.questionCount != null && !config.questions) {
            finalConfig.questions = config.questionCount;
        }
        finalConfig.questions = Math.max(1, parseInt(String(finalConfig.questions), 10) || this.defaultConfig.questions);
        finalConfig.options = Math.min(6, Math.max(1, parseInt(String(finalConfig.options), 10) || this.defaultConfig.options));
        if (config.title) {
            finalConfig.title = config.title;
        }

        // Auto-adjust columns for Long Bond Paper (maximize use of page)
        if (finalConfig.questions > 120) {
            finalConfig.columns = 4; // Use 4 columns for 120-150 to keep bubbles large
        } else if (finalConfig.questions > 90) {
            finalConfig.columns = 3;
        } else {
            finalConfig.columns = 2;
        }

        // Every newly generated sheet gets a fresh, unique exam id so that
        // regenerating a quiz never overwrites previously stored V1/V2 layouts.
        if (!finalConfig.examId && !finalConfig.studentData?.examId) {
            finalConfig.examId = this.createFreshExamId();
        }

        sheet.innerHTML = this.createSheetHTML(finalConfig);
        return finalConfig;
    }

    createFreshExamId() {
        const rand = Math.random().toString(36).toUpperCase().slice(2, 6);
        return `EX${Date.now().toString(36).toUpperCase().slice(-5)}${rand}`;
    }

    compactCourseForQr(course) {
        const text = String(course || '').trim();
        const key = text.toUpperCase().replace(/[^A-Z]/g, ' ');
        const compactMap = [
            [/BACHELOR\s+OF\s+SCIENCE\s+IN\s+INFORMATION\s+TECHNOLOGY|^BSIT$/, 'BSIT'],
            [/BACHELOR\s+OF\s+SCIENCE\s+IN\s+HOSPITALITY\s+MANAGEMENT|^BSHM$/, 'BSHM'],
            [/BACHELOR\s+OF\s+SCIENCE\s+IN\s+BUSINESS\s+ADMINISTRATION|^BSBA$/, 'BSBA'],
            [/BACHELOR\s+OF\s+SCIENCE\s+IN\s+CRIMINOLOGY|^BSCRIM$/, 'BSCRIM'],
            [/BACHELOR\s+OF\s+ELEMENTARY\s+EDUCATION|^BEED$/, 'BEED'],
            [/BACHELOR\s+OF\s+SECONDARY\s+EDUCATION|^BSED$/, 'BSED']
        ];
        const match = compactMap.find(([pattern]) => pattern.test(key));
        return match ? match[1] : text;
    }

    compactDateTimeForQr(dateTime) {
        const text = String(dateTime || '').trim();
        if (!text) return '';
        const parsed = new Date(text);
        if (Number.isNaN(parsed.getTime())) return text;
        const pad = value => String(value).padStart(2, '0');
        return [
            parsed.getFullYear(),
            pad(parsed.getMonth() + 1),
            pad(parsed.getDate()),
            pad(parsed.getHours()),
            pad(parsed.getMinutes())
        ].join('');
    }

    createCompactQrPayload(config, examId) {
        const studentData = config.studentData || {};
        const payload = {
            v: 2,
            e: String(examId || '').trim(),
            s: String(studentData.sheetId || '').trim(),
            n: String(studentData.studentName || '').trim(),
            c: this.compactCourseForQr(studentData.course),
            a: String(studentData.age || '').trim(),
            r: String(studentData.roomNo || '').trim(),
            t: this.compactDateTimeForQr(studentData.dateTime)
        };
        return Object.fromEntries(Object.entries(payload).filter(([key, value]) => key === 'v' || String(value || '').trim()));
    }

    getPaperSize(config) {
        const key = config.paperSize || 'a4';
        return this.PAPER_SIZES[key] || this.PAPER_SIZES['a4'];
    }

    createSheetHTML(config) {
        const paper = this.getPaperSize(config);
        return `
            <div class="answer-sheet" data-layout-sheet="1" data-paper-size="${config.paperSize || 'a4'}" style="width: ${paper.width}; min-width: ${paper.width}; max-width: ${paper.width}; height: ${paper.height}; min-height: ${paper.height}; max-height: ${paper.height}; background: #fff; padding: 0.35in 0.42in; box-sizing: border-box; display: flex; flex-direction: column; position: relative; overflow: hidden; border: 4px solid ${config.deptColor};">
                ${this.createRegistrationAnchors(config.deptColor)}
                <div class="sheet-inner-wrap" style="width: 100%; height: 100%; display: flex; flex-direction: column; box-sizing: border-box;">
                    ${this.createHeader(config)}
                    
                    <div class="answer-sheet-top" style="display: flex; gap: 0.2in; align-items: stretch; margin-bottom: 0.1in; flex-shrink: 0;">
                        ${config.showStudentInfo ? this.createStudentInfo(config) : ''}
                    </div>

                    <div class="answer-sheet-questions-wrap" style="flex: 1; display: flex; flex-direction: column; min-height: 0; margin-bottom: 0.1in; justify-content: space-between;">
                        ${this.createQuestionsGrid(config)}
                    </div>

                    <div class="answer-sheet-footer" style="flex-shrink: 0;">
                        ${config.showInstructions ? this.createInstructions(config) : ''}
                    </div>
                </div>
            </div>
        `;
    }

    createHeader(config) {
        const color = config.deptColor || '#000000';
        const title = 'ENTRANCE EXAMINATION FOR ANSWER SHEET';
        
        // Get examId for layout display
        const examId = String(config.studentData?.examId || config.examId || '').trim();
        
        // Right logo HTML - FORCE EXACT SAME DIMENSIONS
        const rightLogoSrc = config.courseLogo ? `images/${config.courseLogo}` : 'images/pcc.png';
        const rightLogoStyle = config.courseLogo ? 'filter: contrast(1.1);' : 'filter: grayscale(100%);';
        
        let qrImg = `
            <div style="font-size:0.06in; font-weight:800; letter-spacing:0.5px; line-height:1.3; color: #333;">[ QR ]</div>
        `;
        
        if (config.studentData) {
            const qrPayload = this.createCompactQrPayload(config, examId);
            const qrValue = encodeURIComponent(JSON.stringify(qrPayload));
            const qrEndpoint = `/api/qr?size=900&margin=2&ecc=H&data=${qrValue}`;
            const qrSrc = window.scanCheckConfig ? window.scanCheckConfig.resolveUrl(qrEndpoint) : qrEndpoint;
            qrImg = `
                <img 
                    alt="Student QR" 
                    src="${qrSrc}" 
                    style="
                        width: 100%;
                        height: 100%;
                        object-fit: contain;
                        display: block;
                        background: #fff;
                    ">
            `;
        }

        return `
            <div style="
                display: grid;
                grid-template-columns: 0.68in 1fr 2.78in;
                align-items: center;
                gap: 0.08in;
                padding: 0.06in;
                min-height: 1.62in;
                background: #fff;
                border: 3px double ${color};
                border-radius: 8px;
                box-sizing: border-box;
            ">
                <!-- Left Section: Logo -->
                <div style="display: flex; align-items: center; justify-content: center; width: 0.68in;">
                    <img src="images/pcc.png" 
                         style="
                            width: 0.58in;
                            height: 0.58in;
                            object-fit: contain;
                            display: block;
                            filter: contrast(1.1);
                         " 
                         alt="PCC Logo">
                </div>
                
                <!-- Center Section: Title and Info -->
                <div style="text-align: center; min-width: 0;">
                    <h1 style="
                        margin: 0;
                        font-size: 0.17in;
                        letter-spacing: 1.2px;
                        text-transform: uppercase;
                        font-weight: 900;
                        color: ${color};
                        line-height: 1.2;
                        word-break: keep-all;
                    ">PASSI CITY COLLEGE</h1>
                    <div style="font-size: 0.09in; margin-bottom: 2px; font-weight: 600; color: #444;">City of Passi, Iloilo</div>
                    
                    <div style="
                        border-top: 1.5px solid ${color};
                        margin: 0.025in auto;
                        width: 85%;
                    "></div>
                    
                    <h2 style="
                        margin: 2px auto;
                        font-size: 0.11in;
                        font-weight: 800;
                        color: #000;
                        text-transform: uppercase;
                        line-height: 1.25;
                        word-break: keep-all;
                    ">${title}</h2>
                    
                </div>
                
                <!-- Right Section: Logo + QR + Layout ID -->
                <div style="
                    display: flex;
                    flex-direction: row;
                    align-items: center;
                    justify-content: flex-end;
                    gap: 0.08in;
                    width: 2.78in;
                    min-width: 2.78in;
                    flex-shrink: 0;
                    white-space: nowrap;
                ">
                    <img src="${rightLogoSrc}" 
                        style="
                            width: 0.45in;
                            height: 0.45in;
                            object-fit: contain;
                            display: block;
                            flex: 0 0 auto;
                            ${rightLogoStyle}
                        " 
                        alt="Right Logo">
                    <div style="
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        gap: 0.02in;
                        flex: 0 0 auto;
                    ">
                        <div data-layout-region="qr" style="
                            width: 1.78in;
                            height: 1.78in;
                            padding: 0.045in;
                            background: #fff;
                            border: 1.8px solid ${color};
                            box-sizing: border-box;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                        ">
                            ${qrImg}
                        </div>
                        ${examId ? `
                            <div style="
                                font-size: 0.07in;
                                font-weight: bold;
                                color: #111;
                                font-family: monospace;
                                text-align: center;
                                line-height: 1;
                                white-space: nowrap;
                            ">
                                Layout ID: ${examId}
                            </div>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    createRegistrationAnchors(color = '#000000') {
        const anchorStyle = [
            'position:absolute',
            'width:0.18in',
            'height:0.18in',
            `background:${color} !important`,
            'display:block',
            'z-index:999',
            'pointer-events:none',
            '-webkit-print-color-adjust:exact',
            'print-color-adjust:exact'
        ].join(';');
        const inset = '0.12in';
        const half = '50%';
        const anchors = [
            ['top-left', `left:${inset};top:${inset};`],
            ['top-mid', `left:calc(${half} - 0.09in);top:${inset};`],
            ['top-right', `right:${inset};top:${inset};`],
            ['left-mid', `left:${inset};top:calc(${half} - 0.09in);`],
            ['right-mid', `right:${inset};top:calc(${half} - 0.09in);`],
            ['bottom-left', `left:${inset};bottom:${inset};`],
            ['bottom-mid', `left:calc(${half} - 0.09in);bottom:${inset};`],
            ['bottom-right', `right:${inset};bottom:${inset};`]
        ];
        return anchors
            .map(([label, position]) => `<div data-layout-anchor="${label}" aria-hidden="true" style="${anchorStyle};${position}"></div>`)
            .join('');
    }


    createStudentInfo(config) {
        const color = config.deptColor || '#000000';
        const s = config.studentData || {};
        const v = (key) => String(s[key] || '').trim();
        const fit = (value, maxLen = 36) => {
            const text = String(value || '').trim();
            return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
        };
        const formatSheetDateTime = (value) => {
            const text = String(value || '').trim();
            if (!text) return '';
            const date = new Date(text);
            if (Number.isNaN(date.getTime())) return fit(text.replace('T', ' '), 16);
            const month = date.toLocaleString('en-US', { month: 'short' });
            const day = String(date.getDate()).padStart(2, '0');
            const year = date.getFullYear();
            const hour = String(date.getHours()).padStart(2, '0');
            const minute = String(date.getMinutes()).padStart(2, '0');
            return `${month} ${day}, ${year} ${hour}:${minute}`;
        };
        const answerSheetId = v('sheetId') || v('studentId');
        const labelStyle = `font-size: 0.095in; text-transform: uppercase; letter-spacing: 0.25px; flex-shrink: 0; color: #000;`;
        const valueLineStyle = `border-bottom: 2px solid ${color}; flex-grow: 1; min-height: 0.15in; max-height: 0.15in; font-size: 0.098in; font-weight: 900; text-transform: uppercase; padding-left: 0.035in; line-height: 0.15in; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`;
        
        return `
            <div style="display: grid; grid-template-columns: 1fr 1.0in 1.0in; gap: 0.07in; margin: 0; width: 100%; align-items: stretch; height: 1.42in;">
                <!-- Student Info Form (Main Column) -->
                <div style="padding: 0.045in 0.08in; border: 2px solid ${color}; border-radius: 4px; background: #fff; overflow: hidden; box-sizing: border-box;">
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.02in 0.10in; height: 100%; align-content: space-between;">
                        <div style="display: flex; align-items: flex-end; gap: 0.03in; grid-column: span 2;">
                            <strong style="width: 0.7in; ${labelStyle}">Full Name:</strong>
                            <div data-layout-region="studentName" style="${valueLineStyle}">${fit(v('studentName'), 40)}</div>
                        </div>

                        <div style="display: flex; align-items: flex-end; gap: 0.05in; grid-column: span 2; min-width: 0;">
                            <div style="display: flex; align-items: flex-end; gap: 0.02in; flex: 0 0 1.05in;">
                                <strong style="width: 0.76in; ${labelStyle}">Exam No.:</strong>
                                <div data-layout-region="examineeNumber" style="${valueLineStyle} flex: 0 0 0.45in; text-align: center; padding-left: 0;">${fit(answerSheetId, 12)}</div>
                            </div>
                            <div style="display: flex; align-items: flex-end; gap: 0.02in; flex: 0 0 0.5in;">
                                <strong style="width: 0.26in; ${labelStyle}">Age:</strong>
                                <div data-layout-region="age" style="${valueLineStyle} flex: 0 0 0.22in; text-align: center; padding-left: 0;">${fit(v('age'), 3)}</div>
                            </div>
                            <div style="display: flex; align-items: flex-end; gap: 0.02in; flex: 0 0 0.62in;">
                                <strong style="width: 0.36in; ${labelStyle}">Room:</strong>
                                <div data-layout-region="roomNumber" style="${valueLineStyle} flex: 0 0 0.26in; text-align: center; padding-left: 0;">${fit(v('roomNo'), 3)}</div>
                            </div>
                            <div style="display: flex; align-items: flex-end; gap: 0.03in; flex: 0 0 0.72in;">
                                <strong style="width: 0.24in; ${labelStyle}">Sex:</strong>
                                <span style="display: inline-flex; align-items: center; gap: 0.02in;">
                                    <span data-layout-group="sex" data-layout-label="M" style="width: 0.14in; height: 0.14in; border: 1.6px solid ${color}; border-radius: 50%; display: inline-block; box-sizing: border-box;"></span>
                                    <span style="font-size: 0.088in; font-weight: 900; margin-right: 0.03in;">M</span>
                                    <span data-layout-group="sex" data-layout-label="F" style="width: 0.14in; height: 0.14in; border: 1.6px solid ${color}; border-radius: 50%; display: inline-block; box-sizing: border-box;"></span>
                                    <span style="font-size: 0.088in; font-weight: 900;">F</span>
                                </span>
                            </div>
                        </div>

                        <div style="display: flex; align-items: flex-end; gap: 0.03in; grid-column: span 2;">
                            <strong style="width: 0.5in; ${labelStyle}">Course:</strong>
                            <div data-layout-region="course" style="${valueLineStyle} padding-left: 0.04in; font-weight: 900;">${fit(config.courseName || '', 40)}</div>
                        </div>

                        <div style="display: flex; align-items: flex-end; gap: 0.03in; grid-column: span 2; min-width: 0;">
                            <strong style="width: 0.72in; ${labelStyle}">Date &amp; Time:</strong>
                            <div style="${valueLineStyle} flex: 0 0 1.6in;">${formatSheetDateTime(v('dateTime'))}</div>
                        </div>
                    </div>
                </div>

                ${this.groupBlockHTML('Entry Type', 'entry', ['New Student', 'Transferee', 'Passinhon', 'Non-Passinhon'])}
                ${this.groupBlockHTML('Equity Group', 'equity', ['PWDs', 'IPs', 'Solo Parent', 'Magna Carta'])}
            </div>
        `;
    }

    groupBlockHTML(title, key, items) {
        return `
            <div style="padding: 0.04in 0.04in; border: 2px solid #000; border-radius: 4px; background: #fff; display: flex; flex-direction: column; justify-content: flex-start; box-sizing: border-box;">
                <div style="font-size: 0.085in; font-weight: 900; text-transform: uppercase; border-bottom: 2px solid #000; padding-bottom: 1px; text-align: center; margin-bottom: 0.03in;">${title}</div>
                <div style="display: flex; flex-direction: column; gap: 0.02in; padding-left: 0.05in; justify-content: space-around; flex: 1;">
                    ${items.map(label => `
                        <div style="display: flex; align-items: center; gap: 0.05in;">
                            <div data-layout-group="${key}" data-layout-label="${label}" style="width: 0.19in; height: 0.19in; border: 2px solid #000; border-radius: 50%; flex-shrink: 0; print-color-adjust: exact; -webkit-print-color-adjust: exact;"></div>
                            <span style="font-size: 0.074in; font-weight: 800; text-transform: uppercase;">${label}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    createQuestionsGrid(config) {
        const questionsPerColumn = Math.ceil(config.questions / config.columns);
        const color = config.deptColor;
        
        let html = `<div class="answer-sheet-q-grid omr-grid" style="display: grid; grid-template-columns: repeat(${config.columns}, 1fr); margin: 0; border: 2.5px solid ${color}; border-radius: 6px; flex: 1; min-height: 0; background: #fff; overflow: hidden;">`;
        
        for (let col = 0; col < config.columns; col++) {
            const isLast = col === config.columns - 1;
            const borderStyle = isLast ? '' : `border-right: 2.5px solid ${color};`;
            
            html += `<div class="answer-sheet-q-col" style="display: flex; flex-direction: column; height: 100%; ${borderStyle} padding: 0.05in 0.12in; justify-content: space-between; box-sizing: border-box;">`;
            const start = col * questionsPerColumn + 1;
            const end = Math.min((col + 1) * questionsPerColumn, config.questions);
            
            for (let i = start; i <= end; i++) {
                html += this.createQuestionRow(i, config.options, config.questions, color);
            }
            
            // Fill empty rows to keep column heights consistent
            const emptyRows = questionsPerColumn - (end - start + 1);
            for (let i = 0; i < emptyRows; i++) {
                html += `<div class="answer-sheet-q-spacer" style="flex: 1;"></div>`;
            }
            
            html += '</div>';
        }
        
        html += '</div>';
        return html;
    }

    createQuestionRow(questionNumber, optionsCount, questionsTotal, color) {
        let options = '';
        const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F'];

        for (let i = 0; i < optionsCount; i++) {
            options += `
                <span style="display: inline-flex; align-items: center; margin: 0; flex: 0 0 auto;">
                    <span class="bubble" data-layout-choice="${optionLetters[i]}" style="width: 0.2in; height: 0.2in; border: 2px solid ${color}; border-radius: 50%; display: inline-block; box-sizing: border-box;"></span>
                    <span class="bubble-label" style="font-size: 0.10in; font-weight: 900; font-family: Arial, sans-serif; margin-left: 0.03in; color: #000;">${optionLetters[i]}</span>
                </span>
            `;
        }

        return `
            <div class="question-row" data-layout-question="${questionNumber}" style="display: flex; align-items: center; border-bottom: 0.7px solid #bbb; padding: 0.002in 0; flex: 1; width: 100%; min-height: 0.2in; box-sizing: border-box;">
                <strong style="font-size: 0.11in; width: 0.34in; text-align: right; margin-right: 0.06in; color: #000; font-family: Arial, sans-serif;">${questionNumber}.</strong>
                <div style="display: flex; justify-content: space-between; align-items: center; flex: 1; padding: 0 0.10in 0 0.04in; max-width: 100%; box-sizing: border-box; overflow: hidden;">
                    ${options}
                </div>
            </div>
        `;
    }

    createInstructions(config) {
        const color = config.deptColor;
        return `
            <div class="instruction-box" style="font-size: 0.1in; padding: 0.08in 0.12in; border: 1.5px solid ${color}; border-radius: 4px; background: #fff; line-height: 1.3;">
                <div style="display: flex; gap: 0.2in; align-items: center;">
                    <div style="flex: 1;">
                        <strong style="font-size: 0.11in; text-transform: uppercase; display: block; margin-bottom: 2px;">General Instructions:</strong>
                        1. Use a No. 2 pencil or black pen only. Fill bubbles completely.<br>
                        2. Do not make any stray marks. Clean erasures are required.<br>
                        3. Avoid folding or crumpling this answer sheet.
                    </div>
                    <div style="display: flex; gap: 0.15in; border-left: 1px solid ${color}; padding-left: 0.2in; align-items: center;">
                        <div style="text-align: center;">
                            <div style="width: 0.18in; height: 0.18in; background: ${color} !important; border-radius: 50%; margin: 0 auto; -webkit-print-color-adjust: exact; print-color-adjust: exact;"></div>
                            <div style="font-size: 0.08in; margin-top: 2px; font-weight: bold;">CORRECT</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="position: relative; width: 0.18in; height: 0.18in; border: 2px solid ${color}; border-radius: 50%; margin: 0 auto; display: flex; justify-content: center; align-items: center;">
                                <div style="font-size: 0.12in; line-height: 1; color: ${color};">×</div>
                            </div>
                            <div style="font-size: 0.08in; margin-top: 2px; font-weight: bold;">WRONG</div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
}

class MultiSubjectAnswerSheetGenerator extends AnswerSheetGenerator {
    generate(config = this.defaultConfig, targetElement = null) {
        const finalConfig = super.generate(config, targetElement);
        if (!finalConfig) return finalConfig;
        const mount = this.getOmrMount(targetElement);
        this.saveRenderedLayout(mount, finalConfig);
        return finalConfig;
    }

    getDefaultSubjects() {
        return [
            { code: 'MATH', name: 'MATHEMATICS', questions: 20 },
            { code: 'SCI', name: 'SCIENCE', questions: 20 },
            { code: 'ENG', name: 'ENGLISH', questions: 20 },
            { code: 'GEN', name: 'GENERAL KNOWLEDGE', questions: 20 },
            { code: 'ABS', name: 'ABSTRACT REASONING', questions: 20 }
        ];
    }

    normalizeSubjects(subjects) {
        const defaults = this.getDefaultSubjects();
        const source = Array.isArray(subjects) && subjects.length > 0 ? subjects : defaults;
        const normalized = source
            .map((item, index) => {
                const fallback = defaults[index] || {};
                const code = String(item?.code || fallback.code || `SUB${index + 1}`).trim().toUpperCase();
                const name = String(item?.name || fallback.name || code).trim().toUpperCase();
                const questionsRaw = Number.parseInt(String(item?.questions ?? fallback.questions ?? 20), 10);
                // Keep subject geometry scanner-safe: each subject slot supports 1..20.
                const questions = Number.isFinite(questionsRaw) ? Math.min(20, Math.max(1, questionsRaw)) : 20;
                return { code, name, questions };
            })
            .filter((item) => item.code && item.name);

        return normalized.length > 0 ? normalized : defaults;
    }

    buildAnswerKeyMetadata(config = {}, subjects = []) {
        const quizId = config.quizId || config.id || config.examId || config.exam_id || null;
        const correctAnswers = Array.isArray(config.correctAnswers)
            ? config.correctAnswers
            : (Array.isArray(config.answerKey) ? config.answerKey : []);
        const totalQuestions = subjects.reduce((sum, subject) => sum + (Number(subject.questions) || 0), 0)
            || Number(config.questionCount)
            || Number(config.questions)
            || 0;
        return {
            answerKeyAvailable: correctAnswers.filter((answer) => String(answer || '').trim()).length > 0,
            source: correctAnswers.filter((answer) => String(answer || '').trim()).length > 0 ? 'database' : null,
            quizId: quizId != null ? String(quizId) : '',
            subjectCount: subjects.length || 0,
            totalQuestions
        };
    }

    collectBubbleGeometry(layout = {}) {
        const rows = [];
        const pushBubble = (scope, label, bubble) => {
            if (!bubble || typeof bubble !== 'object') return;
            rows.push({
                scope,
                label,
                x: Number(bubble.x),
                y: Number(bubble.y),
                radius: Number(bubble.radius)
            });
        };

        Object.entries(layout.sexGroup || {}).forEach(([label, bubble]) => pushBubble('sex', label, bubble));
        Object.entries(layout.entryGroup || {}).forEach(([label, bubble]) => pushBubble('entry', label, bubble));
        Object.entries(layout.equityGroup || {}).forEach(([label, bubble]) => pushBubble('equity', label, bubble));
        Object.entries(layout.registrationAnchors || {}).forEach(([label, anchor]) => pushBubble('anchor', label, anchor));
        (layout.subjects || []).forEach((subject) => {
            (subject.questions || []).forEach((question) => {
                Object.entries(question.choices || {}).forEach(([label, bubble]) => {
                    pushBubble(`${subject.code}:Q${question.number}`, label, bubble);
                });
            });
        });
        return rows;
    }

    collectComparableGeometry(layout = {}) {
        const rows = [];
        const pushPoint = (scope, label, rect) => {
            if (!rect || typeof rect !== 'object') return;
            rows.push({
                scope,
                label,
                x: Number(rect.x),
                y: Number(rect.y),
                width: Number(rect.width || 0),
                height: Number(rect.height || 0)
            });
        };
        Object.entries(layout.registrationAnchors || {}).forEach(([label, anchor]) => pushPoint('anchor', label, anchor));
        (layout.subjects || []).forEach((subject) => {
            pushPoint('subject', subject.code || subject.name || '', subject.block);
            (subject.questions || []).forEach((question) => {
                pushPoint(`${subject.code}:Q${question.number}`, 'row', question.row);
                Object.entries(question.choices || {}).forEach(([label, bubble]) => {
                    pushPoint(`${subject.code}:Q${question.number}`, label, bubble);
                });
            });
        });
        return rows;
    }

    summarizeDistances(values = []) {
        const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
        if (!sorted.length) return { count: 0, mean: 0, median: 0, rms: 0, p95: 0, max: 0 };
        const sum = sorted.reduce((acc, value) => acc + value, 0);
        const sumSquares = sorted.reduce((acc, value) => acc + value * value, 0);
        const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
        return {
            count: sorted.length,
            mean: sum / sorted.length,
            median: sorted[Math.floor(sorted.length / 2)],
            rms: Math.sqrt(sumSquares / sorted.length),
            p95: at(0.95),
            max: sorted[sorted.length - 1]
        };
    }

    compareLayoutGeometry(savedLayout, currentLayout) {
        const savedRows = this.collectComparableGeometry(savedLayout);
        const currentRows = this.collectComparableGeometry(currentLayout);
        const currentByKey = new Map(currentRows.map((row) => [`${row.scope}|${row.label}`, row]));
        const distances = [];
        const dxValues = [];
        const dyValues = [];
        let missing = 0;
        savedRows.forEach((saved) => {
            const current = currentByKey.get(`${saved.scope}|${saved.label}`);
            if (!current) {
                missing += 1;
                return;
            }
            const dx = current.x - saved.x;
            const dy = current.y - saved.y;
            dxValues.push(Math.abs(dx));
            dyValues.push(Math.abs(dy));
            distances.push(Math.hypot(dx, dy));
        });
        return {
            compared: distances.length,
            missing,
            distance: this.summarizeDistances(distances),
            dxAbs: this.summarizeDistances(dxValues),
            dyAbs: this.summarizeDistances(dyValues)
        };
    }

    validateLayoutAgainstDom(sheetContainer, config = {}, savedLayout = null, context = 'print') {
        const expected = savedLayout || window.latestOmrGeneratedLayout || null;
        if (!expected) return null;
        const current = this.extractGeneratedLayout(sheetContainer, config);
        if (!current) return null;
        const report = this.compareLayoutGeometry(expected, current);
        const maxDistance = Number(report.distance?.max || 0);
        const p95Distance = Number(report.distance?.p95 || 0);
        if (maxDistance > 1 || p95Distance > 0.75 || report.missing > 0) {
            console.warn(`[AnswerSheet] ${context} geometry differs from saved layout`, report);
        } else {
            console.debug(`[AnswerSheet] ${context} geometry matches saved layout`, report);
        }
        return report;
    }

    layoutsMatchGeometry(a, b, tolerance = 2) {
        if (!a || !b) return true;
        const aSize = a.sheetSize || {};
        const bSize = b.sheetSize || {};
        if (Math.abs(Number(aSize.width || 0) - Number(bSize.width || 0)) > tolerance) return false;
        if (Math.abs(Number(aSize.height || 0) - Number(bSize.height || 0)) > tolerance) return false;

        const aRows = this.collectBubbleGeometry(a);
        const bRows = this.collectBubbleGeometry(b);
        if (aRows.length !== bRows.length) return false;
        for (let i = 0; i < aRows.length; i++) {
            const left = aRows[i];
            const right = bRows[i];
            if (left.scope !== right.scope || left.label !== right.label) return false;
            if (Math.abs(left.x - right.x) > tolerance) return false;
            if (Math.abs(left.y - right.y) > tolerance) return false;
            if (Math.abs(left.radius - right.radius) > tolerance) return false;
        }
        return true;
    }

    cssLengthToPx(value) {
        const raw = String(value || '').trim().toLowerCase();
        const match = raw.match(/^(-?\d+(?:\.\d+)?)(px|in|mm|cm)?$/);
        if (!match) return null;
        const amount = Number.parseFloat(match[1]);
        const unit = match[2] || 'px';
        if (!Number.isFinite(amount)) return null;
        if (unit === 'px') return amount;
        if (unit === 'in') return amount * 96;
        if (unit === 'mm') return amount * 96 / 25.4;
        if (unit === 'cm') return amount * 96 / 2.54;
        return null;
    }

    getCanonicalSheetSize(config = {}, sheetRect = null) {
        const paperSize = this.getPaperSize(config);
        const width = this.cssLengthToPx(paperSize.width);
        const height = this.cssLengthToPx(paperSize.height);
        return {
            width: width || Number(sheetRect?.width || 0),
            height: height || Number(sheetRect?.height || 0)
        };
    }

    normalizeRect(rect, sheetRect, canonicalSize) {
        const scaleX = canonicalSize?.width && sheetRect?.width ? canonicalSize.width / sheetRect.width : 1;
        const scaleY = canonicalSize?.height && sheetRect?.height ? canonicalSize.height / sheetRect.height : 1;
        return {
            x: rect.x * scaleX,
            y: rect.y * scaleY,
            left: rect.left * scaleX,
            top: rect.top * scaleY,
            width: rect.width * scaleX,
            height: rect.height * scaleY,
            right: rect.right * scaleX,
            bottom: rect.bottom * scaleY
        };
    }

    relativeRect(element, sheetRect, canonicalSize = null) {
        if (!element) return null;
        const elementRect = element.getBoundingClientRect();
        const rect = {
            x: elementRect.left - sheetRect.left + elementRect.width / 2,
            y: elementRect.top - sheetRect.top + elementRect.height / 2,
            left: elementRect.left - sheetRect.left,
            top: elementRect.top - sheetRect.top,
            width: elementRect.width,
            height: elementRect.height,
            right: elementRect.right - sheetRect.left,
            bottom: elementRect.bottom - sheetRect.top
        };
        return canonicalSize ? this.normalizeRect(rect, sheetRect, canonicalSize) : rect;
    }

    bubbleFromElement(element, sheetRect, canonicalSize = null) {
        const rect = this.relativeRect(element, sheetRect, canonicalSize);
        if (!rect) return null;
        return {
            x: rect.x,
            y: rect.y,
            radius: Math.min(rect.width, rect.height) / 2,
            box: rect
        };
    }

    extractGeneratedLayout(sheetContainer, config = {}) {
        const sheet = sheetContainer?.querySelector?.('.answer-sheet') || sheetContainer;
        if (!sheet) return null;
        const sheetRect = sheet.getBoundingClientRect();
        if (!sheetRect.width || !sheetRect.height) return null;
        const paperSize = this.getPaperSize(config);
        const canonicalSize = this.getCanonicalSheetSize(config, sheetRect);

        const studentData = config.studentData || {};
        const examId = String(studentData.examId || config.examId || config.exam_id || config.id || config.quizId || '').trim();
        if (!examId) return null;
        const normalizedSubjects = this.normalizeSubjects(config.subjects || config.subjectConfig);

        const region = (name) => this.relativeRect(sheet.querySelector(`[data-layout-region="${name}"]`), sheetRect, canonicalSize);
        const anchors = () => {
            const out = {};
            sheet.querySelectorAll('[data-layout-anchor]').forEach((element) => {
                const label = element.getAttribute('data-layout-anchor') || '';
                const anchor = this.bubbleFromElement(element, sheetRect, canonicalSize);
                if (label && anchor) out[label] = anchor;
            });
            return out;
        };
        const group = (name) => {
            const out = {};
            sheet.querySelectorAll(`[data-layout-group="${name}"]`).forEach((element) => {
                const label = element.getAttribute('data-layout-label') || '';
                const bubble = this.bubbleFromElement(element, sheetRect, canonicalSize);
                if (label && bubble) out[label] = bubble;
            });
            return out;
        };
        const subjects = [];
        sheet.querySelectorAll('[data-layout-subject]').forEach((subjectElement) => {
            const code = subjectElement.getAttribute('data-layout-subject') || '';
            const name = subjectElement.getAttribute('data-layout-subject-name') || code;
            const questions = [];
            subjectElement.querySelectorAll('[data-layout-question]').forEach((row) => {
                const number = Number.parseInt(row.getAttribute('data-layout-question') || '0', 10);
                const choices = {};
                row.querySelectorAll('[data-layout-choice]').forEach((choice) => {
                    const label = choice.getAttribute('data-layout-choice') || '';
                    const bubble = this.bubbleFromElement(choice, sheetRect, canonicalSize);
                    if (label && bubble) choices[label] = bubble;
                });
                if (number > 0 && Object.keys(choices).length > 0) {
                    questions.push({
                        number,
                        row: this.relativeRect(row, sheetRect, canonicalSize),
                        choices
                    });
                }
            });
            subjects.push({
                code,
                name,
                block: this.relativeRect(subjectElement, sheetRect, canonicalSize),
                questions
            });
        });
        const registrationAnchors = anchors();

        const layout = {
            layoutVersion: 'generated-layout-v3-ai-print-canonical',
            examId,
            exam_id: examId,
            sheetId: String(studentData.sheetId || studentData.studentId || '').trim(),
            quizId: config.id || config.quizId || null,
            title: config.title || '',
            generatedAt: new Date().toISOString(),
            sheetSize: {
                width: canonicalSize.width,
                height: canonicalSize.height
            },
            scaleReference: {
                paper: config.paperSize || 'a4',
                cssWidth: paperSize.width,
                cssHeight: paperSize.height,
                sheetWidth: canonicalSize.width,
                sheetHeight: canonicalSize.height,
                measuredSheetWidth: sheetRect.width,
                measuredSheetHeight: sheetRect.height,
                devicePixelRatio: window.devicePixelRatio || 1,
                exportScale: 2,
                coordinateOrigin: 'answer-sheet-container',
                coordinateSystem: 'canonical-print-css-px'
            },
            qrArea: region('qr'),
            studentNameArea: region('studentName'),
            courseArea: region('course'),
            examineeNumberArea: region('examineeNumber'),
            ageArea: region('age'),
            roomNumberArea: region('roomNumber'),
            seatNumberArea: region('seatNumber'),
            sexGroup: group('sex'),
            sex_group: group('sex'),
            entryGroup: group('entry'),
            entry_group: group('entry'),
            equityGroup: group('equity'),
            equity_group: group('equity'),
            registrationAnchors,
            registration_anchors: registrationAnchors,
            subjects,
            answerKey: config.answerKey || config.correctAnswers || null,
            answerKeyMetadata: this.buildAnswerKeyMetadata(config, normalizedSubjects),
            subjectConfig: config.subjectConfig || config.subjects || null
        };
        return layout;
    }

    saveRenderedLayout(sheetContainer, config = {}) {
        const layout = this.extractGeneratedLayout(sheetContainer, config);
        if (!layout) return;
        
        console.log(`[AnswerSheet] layout payload examId=${layout.examId}`);
        
        window.savedOmrLayoutByExamId = window.savedOmrLayoutByExamId || {};
        const existing = window.savedOmrLayoutByExamId[layout.examId];
        if (existing && !this.layoutsMatchGeometry(existing, layout, 2)) {
            const warning = `Answer sheet geometry changed (${Math.round(Number(existing.sheetSize?.width || 0))}x${Math.round(Number(existing.sheetSize?.height || 0))} -> ${Math.round(Number(layout.sheetSize?.width || 0))}x${Math.round(Number(layout.sheetSize?.height || 0))}). Overwriting saved layout with the new geometry.`;
            layout.geometryWarning = warning;
            window.omrLayoutGeometryWarnings = window.omrLayoutGeometryWarnings || [];
            window.omrLayoutGeometryWarnings.push({ examId: layout.examId, warning, generatedAt: new Date().toISOString() });
            console.warn(warning, layout.examId);
            if (window.app?.showToast) window.app.showToast(warning, 'warning');
        }
        window.savedOmrLayoutByExamId[layout.examId] = layout;
        window.latestOmrGeneratedLayout = layout;
        if (!window.scanCheckConfig?.apiCall) return;
        window.scanCheckConfig.apiCall('/api/omr/layouts', {
            method: 'POST',
            body: JSON.stringify({ layout })
        }).then(response => {
            console.log(`[AnswerSheet] saved layout filename=${layout.examId}.json`);
        }).catch((error) => {
            console.warn('Generated OMR layout was not saved:', error.message || error);
        });
    }
    
    createSheetHTML(config) {
        // Use subjects from config, or localStorage, or default
        let subjects = config.subjects;
        
        if (!subjects) {
            const savedSubjects = localStorage.getItem('scancheck_multi_subjects');
            if (savedSubjects) {
                try {
                    subjects = JSON.parse(savedSubjects);
                } catch (e) {
                    console.error('Error parsing saved subjects:', e);
                }
            }
        }

        subjects = this.normalizeSubjects(subjects);

        const color = config.deptColor || '#000000';
        const paper = this.getPaperSize(config);
        
        // Calculate total questions if not explicitly set
        const totalQuestions = subjects.reduce((sum, s) => sum + (parseInt(s.questions) || 0), 0);
        config.questions = totalQuestions;

        return `
            <div class="answer-sheet" data-layout-sheet="1" data-paper-size="a4" style="width: ${paper.width}; min-width: ${paper.width}; max-width: ${paper.width}; height: ${paper.height}; min-height: ${paper.height}; max-height: ${paper.height}; background: #fff; padding: 0.35in 0.42in; box-sizing: border-box; display: flex; flex-direction: column; position: relative; overflow: hidden; border: 4px solid ${color};">
                ${this.createRegistrationAnchors(color)}
                <div class="sheet-inner-wrap" style="width: 100%; height: 100%; display: flex; flex-direction: column; box-sizing: border-box;">
                    ${this.createHeader(config)}
                    
                    <div class="answer-sheet-top" style="display: flex; gap: 0.2in; align-items: stretch; margin-bottom: 0.15in; flex-shrink: 0;">
                        ${this.createStudentInfo(config)}
                    </div>

                    <!-- Subject Content Areas (All Combined in One Form) -->
                    <div class="subject-content" style="flex: 1; display: flex; flex-direction: column; gap: 0.07in; min-height: 0; box-sizing: border-box;">
                        ${subjects.map((subject) => `
                            <div id="subject-${subject.code}" class="subject-panel" data-layout-subject="${subject.code}" data-layout-subject-name="${subject.name}"
                                 style="flex: 1; display: flex; flex-direction: column; min-height: 0; box-sizing: border-box;">
                                <div style="border: 2px solid ${color}; border-radius: 4px; overflow: hidden; background: #fff; flex: 1; display: flex; flex-direction: column; min-height: 0; box-sizing: border-box;">
                                    ${this.createSubjectHeader(subject, color)}
                                    <div style="border-top: 1.5px solid ${color}; flex: 1; display: flex; flex-direction: column; min-height: 0; box-sizing: border-box;">
                                        ${this.createQuestionsGridForSubject(subject.questions, 4, color, subject)}
                                    </div>
                                </div>
                            </div>
                        `).join('')}
                    </div>

                    <div class="answer-sheet-footer" style="flex-shrink: 0; margin-top: 0.03in;">
                        ${this.createInstructions(config)}
                    </div>
                </div>
            </div>
        `;
    }

    createSubjectHeader(subject, color) {
        return `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.012in 0.06in; box-sizing: border-box;">
                <span style="font-size: 0.09in; font-weight: 900; text-transform: uppercase; color: ${color}; letter-spacing: 0.5px;">${subject.name}</span>
                <span style="font-size: 0.07in; font-weight: 700; color: #333; text-transform: uppercase;">1-${subject.questions}</span>
            </div>
        `;
    }

    createQuestionsGridForSubject(questionCount, optionsCount, color, subject = {}) {
        const columns = 4;
        const rows = 5;
        const maxQuestions = columns * rows;
        const activeQuestions = Math.max(0, Math.min(maxQuestions, Number.parseInt(String(questionCount || 0), 10) || 0));

        const gridRows = [];
        for (let row = 0; row < rows; row++) {
            const cells = [];
            for (let col = 0; col < columns; col++) {
                const qNo = row * columns + col + 1;
                const inactive = qNo > activeQuestions;
                cells.push(`
                    <div style="flex: 1; display: flex; min-height: 0; box-sizing: border-box; ${col < columns - 1 ? 'border-right: 1px solid #ddd;' : ''}">
                        ${this.createQuestionRow(qNo, optionsCount, maxQuestions, color, { inactive, subjectCode: subject.code || '', subjectName: subject.name || '' })}
                    </div>
                `);
            }
            gridRows.push(`
                <div style="flex: 1; display: flex; min-height: 0; box-sizing: border-box; ${row < rows - 1 ? 'border-bottom: 0.7px solid #bbb;' : ''}">
                    ${cells.join('')}
                </div>
            `);
        }

        return `
            <div class="answer-sheet-q-grid" style="flex: 1; display: flex; flex-direction: column; min-height: 0; box-sizing: border-box;">
                ${gridRows.join('')}
            </div>
        `;
    }

    createQuestionRow(questionNumber, optionsCount, questionsTotal, color, opts = {}) {
        const inactive = Boolean(opts?.inactive);
        let options = '';
        const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F'];

        if (!inactive) {
            for (let i = 0; i < optionsCount; i++) {
                options += `
                    <span style="display: inline-flex; align-items: center; margin: 0; flex: 0 0 auto;">
                        <span class="bubble" data-layout-choice="${optionLetters[i]}" style="width: 0.2in; height: 0.2in; border: 2px solid ${color}; border-radius: 50%; display: inline-block; box-sizing: border-box;"></span>
                        <span class="bubble-label" style="font-size: 0.10in; font-weight: 900; font-family: Arial, sans-serif; margin-left: 0.03in; color: #000;">${optionLetters[i]}</span>
                    </span>
                `;
            }
        }

        return `
            <div class="question-row" data-layout-question="${inactive ? '' : questionNumber}" data-layout-subject-code="${opts?.subjectCode || ''}" style="display: flex; align-items: center; flex: 1 1 0; width: 100%; min-height: 0; box-sizing: border-box; padding: 0.0015in 0.02in;">
                <strong style="font-size: 0.095in; width: 0.22in; text-align: right; margin-right: 0.045in; color: #000; font-family: Arial, sans-serif;">${inactive ? '' : `${questionNumber}.`}</strong>
                <div style="display: flex; justify-content: space-between; align-items: center; flex: 1; padding: 0 0.02in; max-width: 100%; box-sizing: border-box; overflow: hidden;">
                    ${options}
                </div>
            </div>
        `;
    }
}

// Initialize generator
document.addEventListener('DOMContentLoaded', () => {
    if (!window.answerSheetGenerator) {
        // Use the multi-subject version for the main OMR workflow
        window.answerSheetGenerator = new MultiSubjectAnswerSheetGenerator();
    }
    
    if (!window.normalAnswerSheetGenerator) {
        // Use the base class for single-subject/normal sheets
        window.normalAnswerSheetGenerator = new AnswerSheetGenerator();
    }

    // Only auto-generate if we're on a page that needs a default preview (like index.html)
    // but not on print.html which handles its own generation
    if (document.getElementById('answerSheetPreview') && !window.location.pathname.includes('print.html')) {
        window.answerSheetGenerator.generate();
    }
});

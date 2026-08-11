const { cropToJpeg, imageToJpeg } = require('./imagePreparation');

function getSheetSize(layout = {}, image) {
    const width = Number(layout.sheetSize?.width) || Number(layout.sheet_size?.width) || image.bitmap.width;
    const height = Number(layout.sheetSize?.height) || Number(layout.sheet_size?.height) || image.bitmap.height;
    return { width, height };
}

function subjectQuestions(layout = {}) {
    const subjects = Array.isArray(layout.subjects) ? layout.subjects : [];
    const rows = [];
    let offset = 0;
    for (const subject of subjects) {
        const questions = Array.isArray(subject.questions) ? subject.questions : [];
        for (const question of questions) {
            const localNumber = Number(question.number);
            if (!Number.isFinite(localNumber)) continue;
            rows.push({
                question: offset + localNumber,
                localQuestion: localNumber,
                subjectCode: subject.code || subject.subjectCode || subject.name || null,
                subjectName: subject.name || subject.code || null,
                row: question.row || null,
                choices: question.choices || {},
                block: subject.block || null
            });
        }
        offset += questions.length;
    }
    return rows.sort((a, b) => a.question - b.question);
}

function activeQuestionNumbers(layout = {}) {
    const fromSubjects = subjectQuestions(layout).map((row) => row.question);
    if (fromSubjects.length > 0) return fromSubjects;
    const total = Number(layout.questionCount || layout.question_count || 100);
    return Array.from({ length: Math.max(1, total) }, (_, index) => index + 1);
}

function groupQuestionRanges(questions, size) {
    const ranges = [];
    for (let index = 0; index < questions.length; index += size) {
        ranges.push(questions.slice(index, index + size));
    }
    return ranges;
}

function layoutBoundsForQuestions(layout, questions) {
    const wanted = new Set(questions.map(Number));
    const rows = subjectQuestions(layout).filter((row) => wanted.has(row.question));
    if (rows.length === 0) return null;

    const xs = [];
    const ys = [];
    const subjects = new Set();

    for (const row of rows) {
        if (row.subjectCode) subjects.add(row.subjectCode);
        if (row.row) {
            xs.push(Number(row.row.left), Number(row.row.right));
            ys.push(Number(row.row.top), Number(row.row.bottom));
        }
        for (const choice of Object.values(row.choices || {})) {
            const box = choice?.box || choice;
            xs.push(Number(box.left), Number(box.right), Number(choice.x));
            ys.push(Number(box.top), Number(box.bottom), Number(choice.y));
        }
        if (row.block) {
            xs.push(Number(row.block.left), Number(row.block.right));
        }
    }

    const finiteX = xs.filter(Number.isFinite);
    const finiteY = ys.filter(Number.isFinite);
    if (finiteX.length === 0 || finiteY.length === 0) return null;

    return {
        left: Math.min(...finiteX),
        top: Math.min(...finiteY),
        right: Math.max(...finiteX),
        bottom: Math.max(...finiteY),
        subjects: Array.from(subjects),
        questionMappings: rows.map((row) => ({
            question: row.question,
            localQuestion: row.localQuestion,
            subjectCode: row.subjectCode,
            subjectName: row.subjectName
        }))
    };
}

function groupFromLayout(layout = {}, camelName, snakeName) {
    const group = layout[camelName] || layout[snakeName] || {};
    return group && typeof group === 'object' ? group : {};
}

function bubbleExtent(bubble) {
    const box = bubble?.box || bubble;
    const x = Number(bubble?.x ?? box?.x);
    const y = Number(bubble?.y ?? box?.y);
    const radius = Number(bubble?.radius || bubble?.r || 8);
    const left = Number(box?.left);
    const top = Number(box?.top);
    const right = Number(box?.right);
    const bottom = Number(box?.bottom);
    return {
        left: Number.isFinite(left) ? left : x - radius,
        top: Number.isFinite(top) ? top : y - radius,
        right: Number.isFinite(right) ? right : x + radius,
        bottom: Number.isFinite(bottom) ? bottom : y + radius,
        x,
        y
    };
}

function topFieldGroups(layout = {}) {
    const sexGroup = groupFromLayout(layout, 'sexGroup', 'sex_group');
    const entryGroup = groupFromLayout(layout, 'entryGroup', 'entry_group');
    const equityGroup = groupFromLayout(layout, 'equityGroup', 'equity_group');
    const build = (field, source, labels) => {
        const options = labels.filter((label) => source[label]);
        if (options.length === 0) return null;
        return {
            field,
            options,
            bubbles: options.map((label) => ({
                label,
                ...bubbleExtent(source[label])
            }))
        };
    };
    const fallbackSex = (() => {
        if (Object.keys(sexGroup).length > 0) return null;
        const room = layout.roomNumberArea || layout.room_number_area || null;
        if (!room || !Number.isFinite(Number(room.right)) || !Number.isFinite(Number(room.y))) return null;
        const y = Number(room.y);
        const mX = Number(room.right) + 58;
        const fX = mX + 30;
        const radius = 9;
        return {
            M: { x: mX, y, radius, box: { left: mX - radius, top: y - radius, right: mX + radius, bottom: y + radius } },
            F: { x: fX, y, radius, box: { left: fX - radius, top: y - radius, right: fX + radius, bottom: y + radius } }
        };
    })();
    return [
        build('sex', Object.keys(sexGroup).length > 0 ? sexGroup : (fallbackSex || {}), ['M', 'F']),
        build('studentType', entryGroup, ['New Student', 'Transferee']),
        build('residencyType', entryGroup, ['Passinhon', 'Non-Passinhon']),
        build('equityGroup', equityGroup, ['PWDs', 'IPs', 'Solo Parent', 'Magna Carta'])
    ].filter(Boolean);
}

function layoutBoundsForTopFields(layout = {}) {
    const groups = topFieldGroups(layout);
    if (groups.length === 0) return null;
    const xs = [];
    const ys = [];
    for (const group of groups) {
        for (const bubble of group.bubbles || []) {
            xs.push(bubble.left, bubble.right, bubble.x);
            ys.push(bubble.top, bubble.bottom, bubble.y);
        }
    }
    const finiteX = xs.filter(Number.isFinite);
    const finiteY = ys.filter(Number.isFinite);
    if (finiteX.length === 0 || finiteY.length === 0) return null;
    return {
        left: Math.min(...finiteX),
        top: Math.min(...finiteY),
        right: Math.max(...finiteX),
        bottom: Math.max(...finiteY),
        groups
    };
}

function scaleLayoutRectToImage(bounds, sheetSize, image) {
    const imageWidth = image.bitmap.width;
    const imageHeight = image.bitmap.height;
    const sx = imageWidth / sheetSize.width;
    const sy = imageHeight / sheetSize.height;
    return {
        x: bounds.left * sx,
        y: bounds.top * sy,
        width: Math.max(1, (bounds.right - bounds.left) * sx),
        height: Math.max(1, (bounds.bottom - bounds.top) * sy)
    };
}

function expandLayoutBounds(bounds, sheetSize, margin = {}) {
    const xMargin = Number(margin.x) || 24;
    const yMargin = Number(margin.y) || 18;
    return {
        left: Math.max(0, bounds.left - xMargin),
        top: Math.max(0, bounds.top - yMargin),
        right: Math.min(sheetSize.width, bounds.right + xMargin),
        bottom: Math.min(sheetSize.height, bounds.bottom + yMargin),
        subjects: bounds.subjects || []
    };
}

async function cropQuestionRange(image, layout, questions, options = {}) {
    const sheetSize = getSheetSize(layout, image);
    const bounds = layoutBoundsForQuestions(layout, questions);
    if (!bounds) {
        return {
            ...(await imageToJpeg(image, options)),
            cropKind: 'whole_sheet_fallback',
            questions,
            subjects: []
        };
    }
    const expanded = expandLayoutBounds(bounds, sheetSize, options.margin);
    const pixelRect = scaleLayoutRectToImage(expanded, sheetSize, image);
    const crop = await cropToJpeg(image, pixelRect, options);
    return {
        ...crop,
        cropKind: 'answer_region',
        questions,
        subjects: expanded.subjects,
        questionMappings: bounds.questionMappings || [],
        layoutBounds: expanded
    };
}

async function buildTopFieldCrop(image, layout, options = {}) {
    const sheetSize = getSheetSize(layout, image);
    const bounds = layoutBoundsForTopFields(layout);
    if (!bounds) return null;
    const expanded = expandLayoutBounds(bounds, sheetSize, options.margin || { x: 80, y: 44 });
    const pixelRect = scaleLayoutRectToImage(expanded, sheetSize, image);
    const crop = await cropToJpeg(image, pixelRect, options);
    return {
        ...crop,
        cropKind: 'top_fields',
        label: 'Top Fields',
        questions: [],
        subjects: [],
        fields: bounds.groups,
        layoutBounds: expanded
    };
}

async function buildCropsForStrategy(image, layout, strategy, options = {}) {
    const questions = activeQuestionNumbers(layout);
    if (strategy === 'whole_sheet') {
        return [{
            ...(await imageToJpeg(image, options)),
            cropKind: 'whole_sheet',
            questions,
            subjects: []
        }];
    }

    const sectionSize = strategy === 'section_10' ? 10 : Number(options.sectionSize) || 20;
    const ranges = groupQuestionRanges(questions, Math.max(1, sectionSize));
    const crops = [];
    for (const range of ranges) {
        crops.push(await cropQuestionRange(image, layout, range, options));
    }
    return crops;
}

async function cropSingleQuestion(image, layout, question, options = {}) {
    return cropQuestionRange(image, layout, [question], {
        ...options,
        margin: options.margin || { x: 28, y: 14 },
        maxWidth: options.maxWidth || 900
    });
}

module.exports = {
    activeQuestionNumbers,
    subjectQuestions,
    topFieldGroups,
    buildTopFieldCrop,
    buildCropsForStrategy,
    cropQuestionRange,
    cropSingleQuestion
};

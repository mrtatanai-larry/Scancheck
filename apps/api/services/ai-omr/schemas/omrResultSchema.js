const ALLOWED_OPTIONS = ['A', 'B', 'C', 'D'];
const ALLOWED_STATES = ['selected', 'blank', 'multiple', 'uncertain'];
const TOP_FIELD_NAMES = ['sex', 'studentType', 'residencyType', 'equityGroup'];
const TOP_FIELD_OPTIONS = [
    'M',
    'F',
    'New Student',
    'Transferee',
    'Passinhon',
    'Non-Passinhon',
    'PWDs',
    'IPs',
    'Solo Parent',
    'Magna Carta',
    'None'
];

const omrQuestionSchema = {
    type: 'object',
    properties: {
        question: { type: 'integer' },
        state: { type: 'string', enum: ALLOWED_STATES },
        answer: {
            type: ['string', 'null'],
            enum: [...ALLOWED_OPTIONS, null]
        },
        markedOptions: {
            type: 'array',
            items: { type: 'string', enum: ALLOWED_OPTIONS },
            minItems: 0,
            maxItems: 4
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 }
    },
    required: ['question', 'state', 'answer', 'markedOptions', 'confidence'],
    additionalProperties: false
};

const omrResultSchema = {
    type: 'object',
    properties: {
        questions: {
            type: 'array',
            items: omrQuestionSchema
        }
    },
    required: ['questions'],
    additionalProperties: false
};

const topFieldSchema = {
    type: 'object',
    properties: {
        field: { type: 'string', enum: TOP_FIELD_NAMES },
        state: { type: 'string', enum: ALLOWED_STATES },
        value: {
            type: ['string', 'null'],
            enum: [...TOP_FIELD_OPTIONS, null]
        },
        markedOptions: {
            type: 'array',
            items: { type: 'string', enum: TOP_FIELD_OPTIONS },
            minItems: 0,
            maxItems: 4
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 }
    },
    required: ['field', 'state', 'value', 'markedOptions', 'confidence'],
    additionalProperties: false
};

const topFieldsResultSchema = {
    type: 'object',
    properties: {
        fields: {
            type: 'array',
            items: topFieldSchema
        }
    },
    required: ['fields'],
    additionalProperties: false
};

module.exports = {
    ALLOWED_OPTIONS,
    ALLOWED_STATES,
    TOP_FIELD_NAMES,
    TOP_FIELD_OPTIONS,
    omrQuestionSchema,
    omrResultSchema,
    topFieldSchema,
    topFieldsResultSchema
};

/**
 * Input Validator Component
 * Validate all user inputs before submission to prevent invalid data and provide immediate feedback
 */

class InputValidator {
  constructor() {
    // Valid enum values
    this.validEntryTypes = ['New Student', 'Transferee', 'Passinhon', 'Non-Passinhon'];
    this.validEquityGroups = ['PWDs', 'IPs', 'Solo Parent', 'Magna Carta', 'None'];
    this.validFormats = ['multi-subject', 'normal'];
    this.validOptionLetters = ['A', 'B', 'C', 'D', 'E', 'F'];
    
    // File validation constants
    this.maxFileSize = 10 * 1024 * 1024; // 10MB
    this.validImageTypes = ['image/jpeg', 'image/jpg', 'image/png'];
  }

  /**
   * Validate quiz form data
   * @param {Object} data - Quiz form data
   * @returns {Object} Validation result
   */
  validateQuizForm(data) {
    const errors = [];
    const warnings = [];

    // Validate title
    if (!data.title || data.title.trim().length === 0) {
      errors.push({
        field: 'title',
        message: 'Exam title is required',
        code: 'REQUIRED'
      });
    } else if (data.title.trim().length < 3) {
      errors.push({
        field: 'title',
        message: 'Exam title must be at least 3 characters',
        code: 'TOO_SHORT'
      });
    } else if (data.title.trim().length > 200) {
      errors.push({
        field: 'title',
        message: 'Exam title must be at most 200 characters',
        code: 'TOO_LONG'
      });
    }

    // Validate question count
    if (!data.questionCount) {
      errors.push({
        field: 'questionCount',
        message: 'Question count is required',
        code: 'REQUIRED'
      });
    } else {
      const count = parseInt(data.questionCount, 10);
      if (isNaN(count)) {
        errors.push({
          field: 'questionCount',
          message: 'Question count must be a number',
          code: 'INVALID_TYPE'
        });
      } else if (count < 50) {
        errors.push({
          field: 'questionCount',
          message: 'Question count must be at least 50',
          code: 'TOO_SMALL'
        });
      } else if (count > 150) {
        errors.push({
          field: 'questionCount',
          message: 'Question count must be at most 150',
          code: 'TOO_LARGE'
        });
      }
    }

    // Validate options count
    if (!data.options) {
      errors.push({
        field: 'options',
        message: 'Options count is required',
        code: 'REQUIRED'
      });
    } else {
      const options = parseInt(data.options, 10);
      if (isNaN(options)) {
        errors.push({
          field: 'options',
          message: 'Options count must be a number',
          code: 'INVALID_TYPE'
        });
      } else if (options < 2) {
        errors.push({
          field: 'options',
          message: 'Options count must be at least 2',
          code: 'TOO_SMALL'
        });
      } else if (options > 6) {
        errors.push({
          field: 'options',
          message: 'Options count must be at most 6',
          code: 'TOO_LARGE'
        });
      }
    }

    // Validate format
    if (!data.format) {
      errors.push({
        field: 'format',
        message: 'Format is required',
        code: 'REQUIRED'
      });
    } else if (!this.validFormats.includes(data.format)) {
      errors.push({
        field: 'format',
        message: 'Format must be either "multi-subject" or "normal"',
        code: 'INVALID_VALUE'
      });
    }

    // Validate subjects for multi-subject format
    if (data.format === 'multi-subject') {
      if (!data.subjects || !Array.isArray(data.subjects)) {
        errors.push({
          field: 'subjects',
          message: 'Subjects are required for multi-subject format',
          code: 'REQUIRED'
        });
      } else if (data.subjects.length !== 5) {
        errors.push({
          field: 'subjects',
          message: 'Multi-subject format requires exactly 5 subjects',
          code: 'INVALID_COUNT'
        });
      } else {
        // Validate each subject
        data.subjects.forEach((subject, index) => {
          if (!subject.code || subject.code.trim().length === 0) {
            errors.push({
              field: `subjects[${index}].code`,
              message: `Subject ${index + 1} code is required`,
              code: 'REQUIRED'
            });
          }
          if (!subject.name || subject.name.trim().length === 0) {
            errors.push({
              field: `subjects[${index}].name`,
              message: `Subject ${index + 1} name is required`,
              code: 'REQUIRED'
            });
          }
          if (!subject.questions || parseInt(subject.questions, 10) <= 0) {
            errors.push({
              field: `subjects[${index}].questions`,
              message: `Subject ${index + 1} must have at least 1 question`,
              code: 'INVALID_VALUE'
            });
          }
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate answer key data
   * @param {Array} answers - Array of answer objects
   * @param {number} questionCount - Expected number of questions
   * @param {number} optionsCount - Number of options per question
   * @returns {Object} Validation result
   */
  validateAnswerKey(answers, questionCount, optionsCount = 6) {
    const errors = [];
    const warnings = [];

    if (!answers || !Array.isArray(answers)) {
      errors.push({
        field: 'answers',
        message: 'Answer key must be an array',
        code: 'INVALID_TYPE'
      });
      return { valid: false, errors, warnings };
    }

    // Validate length matches question count
    if (answers.length !== questionCount) {
      errors.push({
        field: 'answers',
        message: `Answer key must have exactly ${questionCount} answers`,
        code: 'INVALID_LENGTH'
      });
    }

    // Get valid letters based on options count
    const validLetters = this.validOptionLetters.slice(0, optionsCount);

    // Validate each answer
    answers.forEach((answer, index) => {
      if (!answer || typeof answer !== 'object') {
        errors.push({
          field: `answers[${index}]`,
          message: `Answer ${index + 1} is invalid`,
          code: 'INVALID_TYPE'
        });
        return;
      }

      // Validate question number
      if (answer.questionNumber !== index + 1) {
        errors.push({
          field: `answers[${index}].questionNumber`,
          message: `Answer ${index + 1} has incorrect question number`,
          code: 'INVALID_VALUE'
        });
      }

      // Validate correct answer
      if (!answer.correctAnswer) {
        errors.push({
          field: `answers[${index}].correctAnswer`,
          message: `Answer ${index + 1} is missing correct answer`,
          code: 'REQUIRED'
        });
      } else if (!validLetters.includes(answer.correctAnswer.toUpperCase())) {
        errors.push({
          field: `answers[${index}].correctAnswer`,
          message: `Answer ${index + 1} must be one of: ${validLetters.join(', ')}`,
          code: 'INVALID_VALUE'
        });
      }
    });

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate scan form data
   * @param {Object} data - Scan form data
   * @returns {Object} Validation result
   */
  validateScanForm(data) {
    const errors = [];
    const warnings = [];

    // Validate student name
    if (!data.studentName || data.studentName.trim().length === 0) {
      errors.push({
        field: 'studentName',
        message: 'Student name is required',
        code: 'REQUIRED'
      });
    } else if (data.studentName.trim().length < 2) {
      errors.push({
        field: 'studentName',
        message: 'Student name must be at least 2 characters',
        code: 'TOO_SHORT'
      });
    } else if (data.studentName.trim().length > 100) {
      errors.push({
        field: 'studentName',
        message: 'Student name must be at most 100 characters',
        code: 'TOO_LONG'
      });
    }

    // Validate course (optional)
    if (data.course && data.course.trim().length > 100) {
      errors.push({
        field: 'course',
        message: 'Course must be at most 100 characters',
        code: 'TOO_LONG'
      });
    }

    // Validate age (optional)
    if (data.age) {
      const age = parseInt(data.age, 10);
      if (isNaN(age)) {
        errors.push({
          field: 'age',
          message: 'Age must be a number',
          code: 'INVALID_TYPE'
        });
      } else if (age < 10 || age > 100) {
        errors.push({
          field: 'age',
          message: 'Age must be between 10 and 100',
          code: 'OUT_OF_RANGE'
        });
      }
    }

    // Validate student ID (optional)
    if (data.studentId && data.studentId.trim().length > 50) {
      errors.push({
        field: 'studentId',
        message: 'Student ID must be at most 50 characters',
        code: 'TOO_LONG'
      });
    }

    // Validate entry type
    if (!data.entryType) {
      errors.push({
        field: 'entryType',
        message: 'Entry type is required',
        code: 'REQUIRED'
      });
    } else if (!this.validEntryTypes.includes(data.entryType)) {
      errors.push({
        field: 'entryType',
        message: `Entry type must be one of: ${this.validEntryTypes.join(', ')}`,
        code: 'INVALID_VALUE'
      });
    }

    // Validate special equity group
    if (!data.equityGroup && data.equityGroup !== 'None') {
      errors.push({
        field: 'equityGroup',
        message: 'Special equity group is required',
        code: 'REQUIRED'
      });
    } else if (data.equityGroup && !this.validEquityGroups.includes(data.equityGroup)) {
      errors.push({
        field: 'equityGroup',
        message: `Special equity group must be one of: ${this.validEquityGroups.join(', ')}`,
        code: 'INVALID_VALUE'
      });
    }

    // Validate exam ID
    if (!data.examId) {
      errors.push({
        field: 'examId',
        message: 'Please select an exam',
        code: 'REQUIRED'
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate image file
   * @param {File} file - The file object
   * @returns {Object} Validation result
   */
  validateImageFile(file) {
    const errors = [];
    const warnings = [];

    if (!file) {
      errors.push({
        field: 'file',
        message: 'Please select an image file',
        code: 'REQUIRED'
      });
      return { valid: false, errors, warnings };
    }

    // Validate file type
    if (!this.validImageTypes.includes(file.type.toLowerCase())) {
      errors.push({
        field: 'file',
        message: 'Invalid file type. Please select a JPG or PNG image',
        code: 'INVALID_TYPE'
      });
    }

    // Validate file size
    if (file.size > this.maxFileSize) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
      errors.push({
        field: 'file',
        message: `Image file is too large (${sizeMB}MB). Maximum size is 10MB`,
        code: 'TOO_LARGE'
      });
    }

    // Warning for large files
    if (file.size > 5 * 1024 * 1024 && file.size <= this.maxFileSize) {
      warnings.push({
        field: 'file',
        message: 'Large file size may result in slower upload',
        code: 'LARGE_FILE'
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate server URL
   * @param {string} url - The URL to validate
   * @returns {Object} Validation result
   */
  validateServerUrl(url) {
    const errors = [];
    const warnings = [];

    if (!url || url.trim().length === 0) {
      errors.push({
        field: 'url',
        message: 'Server URL is required',
        code: 'REQUIRED'
      });
      return { valid: false, errors, warnings };
    }

    // Basic URL format validation
    try {
      const urlObj = new URL(url);
      
      // Check protocol
      if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
        errors.push({
          field: 'url',
          message: 'URL must use HTTP or HTTPS protocol',
          code: 'INVALID_PROTOCOL'
        });
      }

      // Warning for HTTP (not HTTPS)
      if (urlObj.protocol === 'http:') {
        warnings.push({
          field: 'url',
          message: 'Using HTTP instead of HTTPS is less secure',
          code: 'INSECURE_PROTOCOL'
        });
      }
    } catch (e) {
      errors.push({
        field: 'url',
        message: 'Please enter a valid URL (e.g., http://localhost:3000)',
        code: 'INVALID_FORMAT'
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Validate student information
   * @param {Object} data - Student information data
   * @returns {Object} Validation result
   */
  validateStudentInfo(data) {
    // Reuse scan form validation as they have similar requirements
    return this.validateScanForm(data);
  }
}

// Export as singleton instance
const inputValidator = new InputValidator();

// For ES6 modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = inputValidator;
}

// For browser global
if (typeof window !== 'undefined') {
  window.inputValidator = inputValidator;
}

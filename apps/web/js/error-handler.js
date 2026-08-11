/**
 * Error Handler Component
 * Centralized error handling and formatting for consistent error messages across the application
 */

class ErrorHandler {
  constructor() {
    this.errorTypes = {
      NETWORK: 'network',
      AUTH: 'auth',
      VALIDATION: 'validation',
      SERVER: 'server',
      UNKNOWN: 'unknown'
    };
  }

  /**
   * Handle error with context information
   * @param {Error|Object} error - The error object
   * @param {string} context - Context where the error occurred
   * @returns {Object} Formatted error object
   */
  handleError(error, context) {
    this.logError(error, context);

    const errorType = this._determineErrorType(error);
    const message = this._formatErrorMessage(error, errorType);
    const details = this._extractErrorDetails(error);
    const recoverable = this._isRecoverable(errorType);
    const suggestedAction = this._getSuggestedAction(errorType, error);

    return {
      message,
      type: errorType,
      details,
      recoverable,
      suggestedAction
    };
  }

  /**
   * Format API error response into user-friendly message
   * @param {Response|Object} response - The API response object
   * @returns {string} Formatted error message
   */
  formatApiError(response) {
    if (!response) {
      return 'An unknown error occurred';
    }

    // Handle Response object
    if (response.status) {
      switch (response.status) {
        case 400:
          return 'Invalid request. Please check your input and try again.';
        case 401:
          return 'Your session has expired. Please sign in again.';
        case 403:
          return 'You don\'t have permission to perform this action.';
        case 404:
          return 'The requested resource was not found.';
        case 409:
          return 'This operation conflicts with existing data.';
        case 422:
          return 'The data provided is invalid. Please check and try again.';
        case 429:
          return 'Too many requests. Please wait a moment and try again.';
        case 500:
          return 'An error occurred while processing your request. Please try again.';
        case 502:
        case 503:
          return 'The server is temporarily unavailable. Please try again later.';
        case 504:
          return 'The request timed out. Please try again.';
        default:
          return `An error occurred (${response.status}). Please try again.`;
      }
    }

    // Handle error object with message
    if (response.message) {
      return response.message;
    }

    // Handle error object with error property
    if (response.error) {
      return typeof response.error === 'string' ? response.error : 'An error occurred';
    }

    return 'An unknown error occurred';
  }

  /**
   * Format validation errors into field-specific messages
   * @param {Array} errors - Array of validation error objects
   * @returns {string} Formatted validation error message
   */
  formatValidationError(errors) {
    if (!errors || !Array.isArray(errors) || errors.length === 0) {
      return 'Please correct the errors in the form';
    }

    if (errors.length === 1) {
      const error = errors[0];
      return error.message || `${error.field} is invalid`;
    }

    // Multiple errors
    const errorMessages = errors.map(error => {
      if (error.message) {
        return error.message;
      }
      return `${error.field}: ${error.code || 'invalid'}`;
    });

    return `Please correct the following errors:\n${errorMessages.join('\n')}`;
  }

  /**
   * Log error to console with context
   * @param {Error|Object} error - The error object
   * @param {string} context - Context where the error occurred
   */
  logError(error, context) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] Error in ${context}:`, error);
    
    // Log stack trace if available
    if (error && error.stack) {
      console.error('Stack trace:', error.stack);
    }
  }

  /**
   * Check if error is a network error
   * @param {Error|Object} error - The error object
   * @returns {boolean} True if network error
   */
  isNetworkError(error) {
    if (!error) return false;

    // Check error message
    const message = (error.message || '').toLowerCase();
    if (message.includes('network') || 
        message.includes('fetch') || 
        message.includes('connection') ||
        message.includes('timeout') ||
        message.includes('econnrefused') ||
        message.includes('enotfound')) {
      return true;
    }

    // Check error type
    if (error.name === 'NetworkError' || error.name === 'TypeError') {
      return true;
    }

    // Check if it's a failed fetch
    if (error instanceof TypeError && message.includes('failed to fetch')) {
      return true;
    }

    return false;
  }

  /**
   * Check if error is an authentication error
   * @param {Error|Object} error - The error object
   * @returns {boolean} True if auth error
   */
  isAuthError(error) {
    if (!error) return false;

    // Check status code
    if (error.status === 401 || error.statusCode === 401) {
      return true;
    }

    // Check response status
    if (error.response && (error.response.status === 401 || error.response.statusCode === 401)) {
      return true;
    }

    // Only explicit HTTP/auth statuses should force logout. Provider errors such
    // as "AI scanner authentication failed" are configuration errors, not user
    // session failures.
    if (error.status || error.statusCode || error.response?.status || error.response?.statusCode) {
      return false;
    }

    // Check error message
    const message = (error.message || '').toLowerCase();
    if (message.includes('unauthorized') || 
        message.includes('token') ||
        message.includes('session expired')) {
      return true;
    }

    return false;
  }

  /**
   * Determine the type of error
   * @private
   */
  _determineErrorType(error) {
    if (this.isNetworkError(error)) {
      return this.errorTypes.NETWORK;
    }

    if (this.isAuthError(error)) {
      return this.errorTypes.AUTH;
    }

    // Check for validation errors
    if (error && (error.validation || error.validationErrors || error.type === 'validation')) {
      return this.errorTypes.VALIDATION;
    }

    // Check for server errors
    if (error && error.status >= 500) {
      return this.errorTypes.SERVER;
    }

    return this.errorTypes.UNKNOWN;
  }

  /**
   * Format error message based on type
   * @private
   */
  _formatErrorMessage(error, errorType) {
    if (error && error.code === 'DUPLICATE_RECORD') {
      return error.payload?.error || 'This paper has already been saved to records.';
    }

    switch (errorType) {
      case this.errorTypes.NETWORK:
        return 'Cannot connect to server. Please check if the server is running.';
      
      case this.errorTypes.AUTH:
        return 'Your session has expired. Please sign in again.';
      
      case this.errorTypes.VALIDATION:
        if (error.validationErrors) {
          return this.formatValidationError(error.validationErrors);
        }
        return 'Please correct the errors in the form.';
      
      case this.errorTypes.SERVER:
        return 'An error occurred while processing your request. Please try again.';
      
      default:
        // Try to extract message from error object
        if (error && error.message) {
          return error.message;
        }
        return 'An unexpected error occurred. Please try again.';
    }
  }

  /**
   * Extract error details
   * @private
   */
  _extractErrorDetails(error) {
    if (!error) return '';

    // Extract details from various error formats
    if (error.details) return error.details;
    if (error.error && typeof error.error === 'string') return error.error;
    if (error.statusText) return error.statusText;
    if (error.message) return error.message;

    return '';
  }

  /**
   * Check if error is recoverable
   * @private
   */
  _isRecoverable(errorType) {
    switch (errorType) {
      case this.errorTypes.NETWORK:
      case this.errorTypes.AUTH:
      case this.errorTypes.VALIDATION:
        return true;
      
      case this.errorTypes.SERVER:
        return false; // Server errors may or may not be recoverable
      
      default:
        return false;
    }
  }

  /**
   * Get suggested action for error type
   * @private
   */
  _getSuggestedAction(errorType, error) {
    switch (errorType) {
      case this.errorTypes.NETWORK:
        return 'Check your network connection and verify the server is running. You can configure the server URL in settings.';
      
      case this.errorTypes.AUTH:
        return 'Please sign in again to continue.';
      
      case this.errorTypes.VALIDATION:
        return 'Please correct the highlighted fields and try again.';
      
      case this.errorTypes.SERVER:
        return 'Please try again later. If the problem persists, contact support.';
      
      default:
        return 'Please try again. If the problem persists, contact support.';
    }
  }
}

// Export as singleton instance
const errorHandler = new ErrorHandler();

// For ES6 modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = errorHandler;
}

// For browser global
if (typeof window !== 'undefined') {
  window.errorHandler = errorHandler;
}

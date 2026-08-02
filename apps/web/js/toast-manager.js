/**
 * Toast Notification Component
 * Display temporary feedback messages to users
 */

class ToastManager {
  constructor() {
    this.toasts = new Map();
    this.toastIdCounter = 0;
    this.defaultDurations = {
      success: 3000,
      error: 5000,
      warning: 4000,
      info: 3000
    };
    
    // Initialize toast container
    this._initializeContainer();
  }

  /**
   * Show toast with message, type, and optional options
   * @param {string} message - Toast message
   * @param {string} type - Toast type (success, error, warning, info)
   * @param {Object} options - Toast options (duration, action)
   * @returns {string} Toast ID
   */
  showToast(message, type = 'info', options = {}) {
    // Handle both old and new signatures
    const duration = typeof options === 'number' ? options : options.duration;
    const action = typeof options === 'object' ? options.action : null;

    // Check for duplicate messages
    if (this._isDuplicate(message)) {
      return null;
    }

    // Generate unique ID
    const toastId = `toast-${++this.toastIdCounter}`;
    
    // Get duration
    const toastDuration = duration || this.defaultDurations[type] || 3000;

    // Create toast object
    const toast = {
      id: toastId,
      message,
      type,
      duration: toastDuration,
      action: action,
      timestamp: Date.now()
    };

    // Store toast
    this.toasts.set(toastId, toast);

    // Create and show toast element
    this._createToastElement(toast);

    // Auto-dismiss after duration
    setTimeout(() => {
      this.dismissToast(toastId);
    }, toastDuration);

    return toastId;
  }

  /**
   * Show success toast
   * @param {string} message - Success message
   */
  showSuccess(message) {
    return this.showToast(message, 'success');
  }

  /**
   * Show error toast
   * @param {string} message - Error message
   */
  showError(message) {
    return this.showToast(message, 'error');
  }

  /**
   * Show warning toast
   * @param {string} message - Warning message
   */
  showWarning(message) {
    return this.showToast(message, 'warning');
  }

  /**
   * Show info toast
   * @param {string} message - Info message
   */
  showInfo(message) {
    return this.showToast(message, 'info');
  }

  /**
   * Dismiss a specific toast
   * @param {string} toastId - Toast ID to dismiss
   */
  dismissToast(toastId) {
    if (!this.toasts.has(toastId)) {
      return;
    }

    // Remove from map
    this.toasts.delete(toastId);

    // Remove from DOM
    const toastElement = document.getElementById(toastId);
    if (toastElement) {
      toastElement.classList.add('hiding');
      setTimeout(() => {
        toastElement.remove();
      }, 300); // Match CSS transition duration
    }
  }

  /**
   * Dismiss all active toasts
   */
  dismissAll() {
    const toastIds = Array.from(this.toasts.keys());
    toastIds.forEach(id => this.dismissToast(id));
  }

  /**
   * Initialize toast container
   * @private
   */
  _initializeContainer() {
    if (typeof document === 'undefined') return;

    // Check if container already exists
    let container = document.getElementById('toast-container');
    if (container) return;

    // Create container
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container position-fixed top-0 end-0 p-3';
    container.style.zIndex = '9999';

    // Add to body
    document.body.appendChild(container);
  }

  /**
   * Create toast element
   * @private
   */
  _createToastElement(toast) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    // Get icon and color for toast type
    const { icon, bgClass, textClass } = this._getToastStyle(toast.type);

    // Create toast HTML
    let actionBtn = '';
    if (toast.action) {
      const btnClass = toast.type === 'warning' ? 'btn-dark' : 'btn-light';
      actionBtn = `<button type="button" class="btn btn-sm ${btnClass} ms-3 btn-toast-action" data-toast-id="${toast.id}">${toast.action.label}</button>`;
    }

    const toastHTML = `
      <div id="${toast.id}" class="toast show ${bgClass} ${textClass} border-0 shadow-lg mb-2" role="alert" aria-live="assertive" aria-atomic="true">
        <div class="d-flex align-items-center p-3">
          <i class="${icon} fs-5 me-3"></i>
          <div class="toast-body p-0 flex-grow-1">
            ${this._escapeHtml(toast.message)}
          </div>
          ${actionBtn}
          <button type="button" class="btn-close ${toast.type === 'warning' ? '' : 'btn-close-white'} ms-3" data-toast-id="${toast.id}" aria-label="Close"></button>
        </div>
      </div>
    `;

    // Create element
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = toastHTML;
    const toastElement = tempDiv.firstElementChild;

    // Add close button event listener
    const closeButton = toastElement.querySelector('.btn-close');
    if (closeButton) {
      closeButton.addEventListener('click', () => {
        this.dismissToast(toast.id);
      });
    }

    // Add action button event listener
    const actionButton = toastElement.querySelector('.btn-toast-action');
    if (actionButton && toast.action && typeof toast.action.callback === 'function') {
      actionButton.addEventListener('click', () => {
        toast.action.callback();
        this.dismissToast(toast.id);
      });
    }

    // Add to container
    container.appendChild(toastElement);
  }

  /**
   * Get toast style based on type
   * @private
   */
  _getToastStyle(type) {
    const styles = {
      success: {
        icon: 'fas fa-check-circle',
        bgClass: 'bg-success',
        textClass: 'text-white'
      },
      error: {
        icon: 'fas fa-exclamation-circle',
        bgClass: 'bg-danger',
        textClass: 'text-white'
      },
      warning: {
        icon: 'fas fa-exclamation-triangle',
        bgClass: 'bg-warning',
        textClass: 'text-dark'
      },
      info: {
        icon: 'fas fa-info-circle',
        bgClass: 'bg-info',
        textClass: 'text-white'
      }
    };

    return styles[type] || styles.info;
  }

  /**
   * Get toast title based on type
   * @private
   */
  _getToastTitle(type) {
    const titles = {
      success: 'Success',
      error: 'Error',
      warning: 'Warning',
      info: 'Information'
    };

    return titles[type] || 'Notification';
  }

  /**
   * Check if message is duplicate
   * @private
   */
  _isDuplicate(message) {
    for (const toast of this.toasts.values()) {
      if (toast.message === message) {
        return true;
      }
    }
    return false;
  }

  /**
   * Escape HTML to prevent XSS
   * @private
   */
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Export as singleton instance
const toastManager = new ToastManager();

// For ES6 modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = toastManager;
}

// For browser global
if (typeof window !== 'undefined') {
  window.toastManager = toastManager;
}

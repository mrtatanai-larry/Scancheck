/**
 * Loading State Manager Component
 * Manage loading states consistently across all async operations
 */

class LoadingStateManager {
  constructor() {
    // Track multiple concurrent loading states
    this.loadingStates = new Map();
    
    // Track original button states
    this.buttonStates = new Map();
  }

  /**
   * Show loading state with context identifier
   * @param {string} context - Context identifier for this loading state
   * @param {string} message - Optional loading message
   */
  showLoading(context, message = 'Loading...') {
    this.loadingStates.set(context, {
      active: true,
      message,
      startTime: Date.now()
    });

    // Emit custom event for UI updates
    this._emitLoadingEvent(context, true, message);
  }

  /**
   * Hide loading state by context identifier
   * @param {string} context - Context identifier for this loading state
   */
  hideLoading(context) {
    if (this.loadingStates.has(context)) {
      this.loadingStates.delete(context);
      this._emitLoadingEvent(context, false);
    }
  }

  /**
   * Check if a specific context is loading
   * @param {string} context - Context identifier
   * @returns {boolean} True if loading
   */
  isLoading(context) {
    return this.loadingStates.has(context) && this.loadingStates.get(context).active;
  }

  /**
   * Show button loading state
   * @param {string} buttonId - Button element ID or selector
   */
  showButtonLoading(buttonId) {
    const button = this._getElement(buttonId);
    if (!button) {
      console.warn(`Button not found: ${buttonId}`);
      return;
    }

    // Save original state
    if (!this.buttonStates.has(buttonId)) {
      this.buttonStates.set(buttonId, {
        text: button.innerHTML,
        disabled: button.disabled,
        classList: Array.from(button.classList)
      });
    }

    // Disable button
    button.disabled = true;

    // Add loading spinner
    const spinner = '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>';
    const loadingText = button.getAttribute('data-loading-text') || 'Loading...';
    button.innerHTML = spinner + loadingText;

    // Add loading class
    button.classList.add('btn-loading');
  }

  /**
   * Hide button loading state
   * @param {string} buttonId - Button element ID or selector
   * @param {string} originalText - Optional original text to restore
   */
  hideButtonLoading(buttonId, originalText = null) {
    const button = this._getElement(buttonId);
    if (!button) {
      console.warn(`Button not found: ${buttonId}`);
      return;
    }

    // Restore original state
    const savedState = this.buttonStates.get(buttonId);
    if (savedState) {
      button.innerHTML = originalText || savedState.text;
      button.disabled = savedState.disabled;
      button.classList.remove('btn-loading');
      this.buttonStates.delete(buttonId);
    } else if (originalText) {
      button.innerHTML = originalText;
      button.disabled = false;
      button.classList.remove('btn-loading');
    }
  }

  /**
   * Show skeleton loader in a container
   * @param {string} containerId - Container element ID or selector
   */
  showSkeletonLoader(containerId) {
    const container = this._getElement(containerId);
    if (!container) {
      console.warn(`Container not found: ${containerId}`);
      return;
    }

    // Save original content
    if (!container.hasAttribute('data-original-content')) {
      container.setAttribute('data-original-content', container.innerHTML);
    }

    // Create skeleton loader HTML
    const skeletonHTML = `
      <div class="skeleton-loader">
        <div class="skeleton-line" style="width: 80%;"></div>
        <div class="skeleton-line" style="width: 60%;"></div>
        <div class="skeleton-line" style="width: 90%;"></div>
        <div class="skeleton-line" style="width: 70%;"></div>
      </div>
    `;

    container.innerHTML = skeletonHTML;
    container.classList.add('skeleton-loading');
  }

  /**
   * Hide skeleton loader from a container
   * @param {string} containerId - Container element ID or selector
   */
  hideSkeletonLoader(containerId) {
    const container = this._getElement(containerId);
    if (!container) {
      console.warn(`Container not found: ${containerId}`);
      return;
    }

    // Restore original content
    const originalContent = container.getAttribute('data-original-content');
    if (originalContent) {
      container.innerHTML = originalContent;
      container.removeAttribute('data-original-content');
    }

    container.classList.remove('skeleton-loading');
  }

  /**
   * Get all active loading states
   * @returns {Array} Array of active loading contexts
   */
  getActiveLoadingStates() {
    return Array.from(this.loadingStates.keys());
  }

  /**
   * Clear all loading states (use with caution)
   */
  clearAllLoadingStates() {
    this.loadingStates.clear();
    this.buttonStates.clear();
  }

  /**
   * Get element by ID or selector
   * @private
   */
  _getElement(idOrSelector) {
    // Try as ID first
    let element = document.getElementById(idOrSelector);
    
    // If not found, try as selector
    if (!element) {
      element = document.querySelector(idOrSelector);
    }

    return element;
  }

  /**
   * Emit custom loading event
   * @private
   */
  _emitLoadingEvent(context, isLoading, message = '') {
    const event = new CustomEvent('loadingStateChange', {
      detail: {
        context,
        isLoading,
        message,
        timestamp: Date.now()
      }
    });

    if (typeof window !== 'undefined') {
      window.dispatchEvent(event);
    }
  }
}

// Export as singleton instance
const loadingStateManager = new LoadingStateManager();

// For ES6 modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = loadingStateManager;
}

// For browser global
if (typeof window !== 'undefined') {
  window.loadingStateManager = loadingStateManager;
}

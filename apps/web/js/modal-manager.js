/**
 * Modal Manager Component
 * Manage modal dialogs for confirmations, forms, and detailed views
 */

class ModalManager {
  constructor() {
    this.openModals = new Set();
    this.confirmModalId = 'confirm-modal';
    this.detailModalId = 'detail-modal';
    
    // Initialize default modals
    this._initializeDefaultModals();
  }

  /**
   * Show a modal by identifier
   * @param {string} modalId - Modal element ID
   * @param {Object} data - Optional data to bind to modal
   */
  showModal(modalId, data = null) {
    const modalElement = document.getElementById(modalId);
    if (!modalElement) {
      console.warn(`Modal not found: ${modalId}`);
      return;
    }

    // Track open modal
    this.openModals.add(modalId);

    // Bind data if provided
    if (data && typeof data === 'object') {
      this._bindModalData(modalElement, data);
    }

    // Show modal using Bootstrap
    const modal = new bootstrap.Modal(modalElement);
    modal.show();

    // Listen for modal hidden event
    modalElement.addEventListener('hidden.bs.modal', () => {
      this.openModals.delete(modalId);
    }, { once: true });
  }

  /**
   * Hide a modal by identifier
   * @param {string} modalId - Modal element ID
   */
  hideModal(modalId) {
    const modalElement = document.getElementById(modalId);
    if (!modalElement) {
      console.warn(`Modal not found: ${modalId}`);
      return;
    }

    // Hide modal using Bootstrap
    const modal = bootstrap.Modal.getInstance(modalElement);
    if (modal) {
      modal.hide();
    }

    // Remove from tracking
    this.openModals.delete(modalId);
  }

  /**
   * Show confirmation dialog with message and callback
   * @param {string} message - Confirmation message
   * @param {Function} onConfirm - Callback function when confirmed
   * @param {Object} options - Optional configuration
   */
  showConfirmDialog(message, onConfirm, options = {}) {
    const {
      title = 'Confirm Action',
      confirmText = 'Confirm',
      cancelText = 'Cancel',
      confirmClass = 'btn-primary',
      onCancel = null
    } = options;

    // Update modal content
    const modal = document.getElementById(this.confirmModalId);
    if (!modal) {
      console.error('Confirm modal not found');
      return;
    }

    const titleElement = modal.querySelector('.modal-title');
    const bodyElement = modal.querySelector('.modal-body');
    const confirmButton = modal.querySelector('.btn-confirm');
    const cancelButton = modal.querySelector('.btn-cancel');

    if (titleElement) titleElement.textContent = title;
    if (bodyElement) bodyElement.textContent = message;
    if (confirmButton) {
      confirmButton.textContent = confirmText;
      confirmButton.className = `btn ${confirmClass} btn-confirm`;
    }
    if (cancelButton) cancelButton.textContent = cancelText;

    // Set up event listeners
    const handleConfirm = () => {
      this.hideModal(this.confirmModalId);
      if (typeof onConfirm === 'function') {
        onConfirm();
      }
      cleanup();
    };

    const handleCancel = () => {
      this.hideModal(this.confirmModalId);
      if (typeof onCancel === 'function') {
        onCancel();
      }
      cleanup();
    };

    const cleanup = () => {
      if (confirmButton) confirmButton.removeEventListener('click', handleConfirm);
      if (cancelButton) cancelButton.removeEventListener('click', handleCancel);
    };

    if (confirmButton) confirmButton.addEventListener('click', handleConfirm);
    if (cancelButton) cancelButton.addEventListener('click', handleCancel);

    // Show modal
    this.showModal(this.confirmModalId);
  }

  /**
   * Show detail modal with title and content
   * @param {string} title - Modal title
   * @param {string} content - Modal content (HTML)
   */
  showDetailModal(title, content) {
    const modal = document.getElementById(this.detailModalId);
    if (!modal) {
      console.error('Detail modal not found');
      return;
    }

    const titleElement = modal.querySelector('.modal-title');
    const bodyElement = modal.querySelector('.modal-body');

    if (titleElement) titleElement.textContent = title;
    if (bodyElement) bodyElement.innerHTML = content;

    this.showModal(this.detailModalId);
  }

  /**
   * Check if a specific modal is open
   * @param {string} modalId - Modal element ID
   * @returns {boolean} True if modal is open
   */
  isModalOpen(modalId) {
    return this.openModals.has(modalId);
  }

  /**
   * Get all open modals
   * @returns {Array} Array of open modal IDs
   */
  getOpenModals() {
    return Array.from(this.openModals);
  }

  /**
   * Initialize default modals
   * @private
   */
  _initializeDefaultModals() {
    if (typeof document === 'undefined') return;

    // Create confirm modal if it doesn't exist
    if (!document.getElementById(this.confirmModalId)) {
      this._createConfirmModal();
    }

    // Create detail modal if it doesn't exist
    if (!document.getElementById(this.detailModalId)) {
      this._createDetailModal();
    }
  }

  /**
   * Create confirm modal
   * @private
   */
  _createConfirmModal() {
    const modalHTML = `
      <div class="modal fade" id="${this.confirmModalId}" tabindex="-1" aria-labelledby="confirmModalLabel" aria-hidden="true">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="confirmModalLabel">Confirm Action</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body">
              Are you sure you want to proceed?
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary btn-cancel" data-bs-dismiss="modal">Cancel</button>
              <button type="button" class="btn btn-primary btn-confirm">Confirm</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);
  }

  /**
   * Create detail modal
   * @private
   */
  _createDetailModal() {
    const modalHTML = `
      <div class="modal fade" id="${this.detailModalId}" tabindex="-1" aria-labelledby="detailModalLabel" aria-hidden="true">
        <div class="modal-dialog modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="detailModalLabel">Details</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body">
              <!-- Content will be inserted here -->
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);
  }

  /**
   * Bind data to modal elements
   * @private
   */
  _bindModalData(modalElement, data) {
    // Find all elements with data-bind attribute
    const bindElements = modalElement.querySelectorAll('[data-bind]');
    
    bindElements.forEach(element => {
      const bindKey = element.getAttribute('data-bind');
      if (bindKey && data.hasOwnProperty(bindKey)) {
        const value = data[bindKey];
        
        // Set value based on element type
        if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
          element.value = value;
        } else if (element.tagName === 'SELECT') {
          element.value = value;
        } else if (element.tagName === 'IMG') {
          element.src = value;
        } else {
          element.textContent = value;
        }
      }
    });
  }
}

// Export as singleton instance
const modalManager = new ModalManager();

// For ES6 modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = modalManager;
}

// For browser global
if (typeof window !== 'undefined') {
  window.modalManager = modalManager;
}

// UI Utilities for OSHA AI Dashboard

export const showToast = (message, type = 'success') => {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast-msg ${type}`;

    const iconName = type === 'success' ? 'check-circle' : 'alert-circle';

    toast.innerHTML = `
        <div class="toast-ico-box">
            <i data-lucide="${iconName}"></i>
        </div>
        <span class="toast-text">${message}</span>
        <button class="toast-close-btn" aria-label="Close toast">
            <i data-lucide="x"></i>
        </button>
    `;

    container.appendChild(toast);
    if (typeof lucide !== 'undefined') lucide.createIcons();

    // Close action
    const closeBtn = toast.querySelector('.toast-close-btn');
    closeBtn.addEventListener('click', () => {
        toast.style.animation = 'slideOutRight 0.3s forwards';
        setTimeout(() => toast.remove(), 300);
    });

    // Auto remove
    setTimeout(() => {
        if (document.body.contains(toast)) {
            toast.style.animation = 'slideOutRight 0.3s forwards';
            setTimeout(() => toast.remove(), 300);
        }
    }, 5000);
};

export const showModal = (modalId) => {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'flex';
        modal.classList.add('fade-in');
        
        // Setup close buttons for this specific modal if not already done
        const closeBtns = modal.querySelectorAll('.modal-close, .btn-secondary');
        closeBtns.forEach(btn => {
            // Remove old listeners to prevent duplicates if called multiple times
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            newBtn.addEventListener('click', () => closeModal(modalId));
        });
    }
};

export const closeModal = (modalId) => {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('fade-in');
        
        // Optionally clear forms inside
        const form = modal.querySelector('form');
        if (form) form.reset();
    }
};

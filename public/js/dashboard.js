// Initialize Socket.IO
const socket = io();

// Global State
let accounts = [];
let webhooks = [];

// Chatbot configuration cache
const chatbotConfigCache = {};

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    console.log('Dashboard initializing...');
    
    // Check authentication
    checkAuth();
    
    // Setup Socket.IO listeners first
    setupSocketListeners();
    
    // Setup event listeners
    try {
        setupEventListeners();
    } catch (error) {
        console.error('Error setting up event listeners:', error);
    }
    
    // Load initial data with slight delay for session validation
    setTimeout(() => {
        loadStats();
        loadAccounts();
    }, 300);
    
    // Set active nav
    setActiveNav();
    
    console.log('Dashboard initialized successfully');
});

// Authentication Check
function checkAuth() {
    // Session-based authentication - the server will redirect if not authenticated
    // Just check if we have localStorage flag for better UX
    const authenticated = localStorage.getItem('authenticated');
    if (!authenticated) {
        window.location.href = '/login';
        return;
    }
}

// Debounce utility
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Debounced stats loader
const debouncedLoadStats = debounce(() => {
    console.log('Debounced loadStats triggered');
    loadStats();
}, 2000);

// Setup Socket.IO Listeners
function setupSocketListeners() {
    socket.on('connect', () => {
        console.log('Connected to server');
        showAlert('Connected to server', 'success');
    });

    socket.on('disconnect', () => {
        console.log('Disconnected from server');
        showAlert('Disconnected from server', 'warning');
    });

    socket.on('qr', (data) => {
        console.log('QR Code received for account:', data.accountId);
        displayQRCode(data.accountId, data.qr);
    });

    socket.on('authenticated', (data) => {
        console.log('Account authenticated:', data.accountId);
        showAlert(`Account ${data.accountId} authenticated successfully!`, 'success');
        loadAccounts();
        debouncedLoadStats();
    });

    socket.on('ready', (data) => {
        console.log('Account ready:', data.accountId);
        showAlert(`Account ${data.accountId} is ready!`, 'success');
        loadAccounts();
        debouncedLoadStats();
    });

    socket.on('disconnected', (data) => {
        console.log('Account disconnected:', data.accountId);
        showAlert(`Account ${data.accountId} disconnected`, 'warning');
        loadAccounts();
        debouncedLoadStats();
    });

    socket.on('message', (data) => {
        console.log('Message received:', data);
        debouncedLoadStats();
    });
}

// Setup Event Listeners
function setupEventListeners() {
    // Navigation
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const view = link.getAttribute('data-view');
            
            // Update active state
            document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
            link.classList.add('active');
            
            // Update page title
            const pageTitle = document.querySelector('.page-title');
            const viewTitles = {
                'dashboard': 'Dashboard',
                'accounts': 'Accounts',
                'webhooks': 'Webhooks',
                'messages': 'Messages',
                'analytics': 'Analytics'
            };
            if (pageTitle) {
                pageTitle.textContent = viewTitles[view] || 'Dashboard';
            }
            
            console.log('Navigating to:', view);
            
            // Get main content container
            const mainContent = document.getElementById('mainContent');
            
            // For webhooks and messages, we replace the entire content
            // For others, we show/hide existing elements
            if (view === 'webhooks') {
                showWebhooksView();
                return;
            }
            
            if (view === 'messages') {
                showMessagesView();
                return;
            }
            
            // For dashboard, accounts, and analytics - restore original view if needed
            const statsGrid = document.getElementById('statsGrid');
            const analyticsView = document.getElementById('analyticsView');
            const systemView = document.getElementById('systemView');
            
            if (!statsGrid) {
                // Content was replaced, need to reload page or restore
                location.reload();
                return;
            }
            
            // Show/hide content based on view
            const accountsSection = document.querySelector('.table-card');
            
            // Hide all by default
            if (statsGrid) statsGrid.style.display = 'none';
            if (accountsSection) accountsSection.style.display = 'none';
            if (analyticsView) analyticsView.style.display = 'none';
            if (systemView) systemView.style.display = 'none';
            
            switch(view) {
                case 'dashboard':
                    // Show everything
                    if (statsGrid) statsGrid.style.display = 'grid';
                    if (accountsSection) accountsSection.style.display = 'block';
                    
                    // Optimized loading: Load accounts first, then pass to stats
                    loadAccounts().then(accounts => {
                        loadStats(accounts).then(() => {
                            setTimeout(createAnalyticsCharts, 500);
                        });
                    });
                    break;
                    
                case 'accounts':
                    // Show only accounts
                    if (accountsSection) accountsSection.style.display = 'block';
                    loadAccounts();
                    break;
                    
                case 'analytics':
                    // Show detailed analytics view
                    if (analyticsView) {
                        analyticsView.style.display = 'block';
                        // Pass current accounts if we have them
                        loadStats(accounts.length > 0 ? accounts : null).then((stats) => {
                            // Create detailed charts
                            setTimeout(() => loadDetailedAnalytics(stats), 500);
                        });
                    }
                    break;

                case 'system':
                    // Show system view
                    if (systemView) {
                        systemView.style.display = 'block';
                        loadSystemHealth();
                        loadSystemLogs();
                    }
                    break;
            }
        });
    });

    // Create Account Button
    const createAccountBtn = document.getElementById('createAccountBtn');
    if (createAccountBtn) {
        createAccountBtn.addEventListener('click', () => {
            console.log('Create Account button clicked');
            openModal('createAccountModal');
        });
    } else {
        console.error('createAccountBtn not found');
    }

    // Create Account Form
    const createAccountForm = document.getElementById('createAccountForm');
    if (createAccountForm) {
        createAccountForm.addEventListener('submit', handleCreateAccount);
    }

    // Send Message Button
    const sendMessageBtn = document.getElementById('sendMessageBtn');
    if (sendMessageBtn) {
        sendMessageBtn.addEventListener('click', () => {
            console.log('Send Message button clicked');
            openModal('sendMessageModal');
        });
    } else {
        console.error('sendMessageBtn not found');
    }

    // Send Message Form
    const sendMessageForm = document.getElementById('sendMessageForm');
    if (sendMessageForm) {
        console.log('Send message form found, attaching handler');
        sendMessageForm.addEventListener('submit', handleSendMessage);
    } else {
        console.error('sendMessageForm not found!');
    }

    // Account Search
    const accountSearch = document.getElementById('accountSearch');
    const clearSearch = document.getElementById('clearSearch');
    
    if (accountSearch) {
        accountSearch.addEventListener('input', (e) => {
            const searchTerm = e.target.value.toLowerCase().trim();
            
            // Show/hide clear button
            if (clearSearch) {
                clearSearch.style.display = searchTerm ? 'block' : 'none';
            }
            
            filterAccounts(searchTerm);
        });
    }
    
    if (clearSearch) {
        clearSearch.addEventListener('click', () => {
            if (accountSearch) {
                accountSearch.value = '';
                clearSearch.style.display = 'none';
                filterAccounts('');
            }
        });
    }

    // Close Modal Buttons - using delegation for dynamically added modals
    document.addEventListener('click', (e) => {
        if (e.target.classList.contains('btn-close') || 
            e.target.classList.contains('modal-close') ||
            e.target.closest('.btn-close') ||
            e.target.closest('.modal-close')) {
            const modal = e.target.closest('.modal');
            if (modal) closeModal(modal.id);
        }
        
        // Modal backdrop click
        if (e.target.classList.contains('modal-backdrop')) {
            const modal = e.target.closest('.modal');
            if (modal) closeModal(modal.id);
        }
    });

    // Create Webhook Form
    const createWebhookForm = document.getElementById('createWebhookForm');
    if (createWebhookForm) {
        createWebhookForm.addEventListener('submit', handleCreateWebhook);
    }

    // Add Webhook Button
    document.addEventListener('click', (e) => {
        if (e.target.closest('#addWebhookBtn')) {
            const accountId = document.getElementById('webhookAccountId').value;
            if (accountId) {
                document.getElementById('newWebhookAccountId').value = accountId;
                closeModal('webhooksModal');
                openModal('createWebhookModal');
            }
        }
    });

    // Message Type Toggle
    const messageTypeInputs = document.querySelectorAll('input[name="messageType"]');
    messageTypeInputs.forEach(input => {
        input.addEventListener('change', (e) => {
            const type = e.target.value;
            const mediaGroup = document.getElementById('mediaInputGroup');
            const buttonGroup = document.getElementById('buttonInputs');
            const messageLabel = document.getElementById('messageBodyLabel');
            const messageInput = document.getElementById('messageText');
            
            // Reset visibility
            if (mediaGroup) mediaGroup.style.display = 'none';
            if (buttonGroup) buttonGroup.style.display = 'none';
            
            if (type === 'text') {
                messageLabel.textContent = 'Message';
                messageInput.placeholder = 'Type your message...';
            } else if (type === 'media') {
                if (mediaGroup) mediaGroup.style.display = 'block';
                messageLabel.textContent = 'Caption (Optional)';
                messageInput.placeholder = 'Type a caption...';
            } else if (type === 'buttons') {
                if (buttonGroup) buttonGroup.style.display = 'block';
                // Allow media for buttons too
                if (mediaGroup) mediaGroup.style.display = 'block'; 
                messageLabel.textContent = 'Body Text';
                messageInput.placeholder = 'Main message text...';
            }
        });
    });

    // Add Button Option
    const addBtnOption = document.getElementById('addBtnOption');
    if (addBtnOption) {
        addBtnOption.addEventListener('click', () => {
            const list = document.getElementById('buttonsList');
            const count = list.children.length;
            
            if (count >= 3) {
                showAlert('Maximum 3 buttons allowed', 'warning');
                return;
            }
            
            const div = document.createElement('div');
            div.className = 'button-option-item';
            div.innerHTML = `
                <input type="text" class="cyber-input button-option-input" placeholder="Button Text" required>
                <button type="button" class="btn-remove-option"><i class="fas fa-times"></i></button>
            `;
            list.appendChild(div);
        });
    }

    // Remove Button Option (Delegation)
    document.addEventListener('click', (e) => {
        if (e.target.closest('.btn-remove-option')) {
            e.target.closest('.button-option-item').remove();
        }
    });

    // Search
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', handleSearch);
    }

    // Logout
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', handleLogout);
    } else {
        console.error('logoutBtn not found');
    }

    // Event delegation for table action buttons
    document.addEventListener('click', (e) => {
        const actionBtn = e.target.closest('[data-action]');
        if (actionBtn) {
            const action = actionBtn.getAttribute('data-action');
            const accountId = actionBtn.getAttribute('data-account-id');
            const webhookId = actionBtn.getAttribute('data-webhook-id');
            
            console.log('Action button clicked:', action, accountId);
            
            switch(action) {
                case 'show-qr':
                    showQRCode(accountId);
                    break;
                case 'reconnect':
                    reconnectAccount(accountId);
                    break;
                case 'webhooks':
                    openWebhookModal(accountId);
                    break;
                case 'chatbot':
                    openChatbotModal(accountId);
                    break;
                case 'delete':
                    deleteAccount(accountId);
                    break;
                case 'delete-webhook':
                    deleteWebhook(webhookId, accountId);
                    break;
            }
        }
    });

    // Menu Toggle
    const menuToggle = document.getElementById('menuToggle');
    const sidebar = document.querySelector('.sidebar');
    const mainContent = document.querySelector('.main-content');
    
    if (menuToggle && sidebar) {
        menuToggle.addEventListener('click', () => {
            // Check if we are on mobile or desktop
            if (window.innerWidth <= 768) {
                sidebar.classList.toggle('active');
            } else {
                sidebar.classList.toggle('collapsed');
                if (mainContent) mainContent.classList.toggle('expanded');
            }
        });
        
        // Close sidebar when clicking outside on mobile
        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768 && 
                !sidebar.contains(e.target) && 
                !menuToggle.contains(e.target) && 
                sidebar.classList.contains('active')) {
                sidebar.classList.remove('active');
            }
            
            // Close notification dropdown when clicking outside
            const notificationDropdown = document.getElementById('notificationDropdown');
            const notificationBtn = document.getElementById('notificationBtn');
            if (notificationDropdown && 
                notificationBtn && 
                !notificationDropdown.contains(e.target) && 
                !notificationBtn.contains(e.target) && 
                notificationDropdown.classList.contains('active')) {
                notificationDropdown.classList.remove('active');
            }
        });
    }

    // Notification Button
    const notificationBtn = document.getElementById('notificationBtn');
    const notificationDropdown = document.getElementById('notificationDropdown');
    const notificationBadge = document.getElementById('notificationBadge');
    
    if (notificationBtn && notificationDropdown) {
        notificationBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            notificationDropdown.classList.toggle('active');
            
            // Clear badge when opened
            if (notificationDropdown.classList.contains('active') && notificationBadge) {
                notificationBadge.style.display = 'none';
            }
        });
    }
    
    // Mark all read button
    const markAllReadBtn = document.getElementById('markAllRead');
    if (markAllReadBtn) {
        markAllReadBtn.addEventListener('click', () => {
            const items = document.querySelectorAll('.notification-item.unread');
            items.forEach(item => item.classList.remove('unread'));
            if (notificationBadge) notificationBadge.style.display = 'none';
        });
    }
}

// Load Statistics (cards + charts) using /api/stats
async function loadStats(preloadedAccounts = null) {
    try {
        // Use preloaded accounts if available to avoid double fetch
        if (preloadedAccounts) {
            accounts = preloadedAccounts;
        } else {
            const accountsRes = await fetch('/api/accounts', { credentials: 'include' });
            if (!accountsRes.ok) {
                console.warn('Stats load failed, user may not be authenticated yet');
                return null;
            }
            accounts = await accountsRes.json();
        }

        const statsRes = await fetch('/api/stats', { credentials: 'include' });
        if (!statsRes.ok) {
            console.warn('Stats endpoint failed');
            return null;
        }
        const stats = await statsRes.json();

        const totalAccountsEl = document.querySelector('[data-stat="totalAccounts"]');
        const activeAccountsEl = document.querySelector('[data-stat="activeAccounts"]');
        const totalMessagesEl = document.querySelector('[data-stat="totalMessages"]');
        const successRateEl = document.querySelector('[data-stat="successRate"]');

        if (totalAccountsEl) totalAccountsEl.textContent = stats.totalAccounts ?? accounts.length;
        if (activeAccountsEl) activeAccountsEl.textContent = stats.activeAccounts ?? accounts.filter(a => a.status === 'ready').length;
        if (totalMessagesEl) totalMessagesEl.textContent = stats.totalMessages ?? 0;

        const safeSuccessRate = typeof stats.successRate === 'number' ? Math.max(0, Math.min(100, stats.successRate)) : 0;
        if (successRateEl) successRateEl.textContent = `${safeSuccessRate}%`;

        // Rebuild mini charts with fresh data
        createAnalyticsCharts(stats);
        
        // If we are on the analytics view, update detailed charts too
        const analyticsView = document.getElementById('analyticsView');
        if (analyticsView && analyticsView.style.display !== 'none') {
            loadDetailedAnalytics(stats);
        }

        return stats;
    } catch (error) {
        console.error('Error loading stats:', error);
        console.warn('Statistics will load after authentication');
        return null;
    }
}

// Load Accounts
async function loadAccounts() {
    try {
        const response = await fetch('/api/accounts', {
            credentials: 'include'
        });

        if (!response.ok) throw new Error('Failed to fetch accounts');

        const data = await response.json();
        accounts = data;
        
        console.log('Loaded accounts:', accounts);

        renderAccountsTable();
        
        return accounts; // Return accounts for chaining

    } catch (error) {
        console.error('Error loading accounts:', error);
        showAlert('Failed to load accounts', 'error');
        return [];
    }
}

// Render Accounts Table
function renderAccountsTable() {
    const tbody = document.getElementById('accountsTableBody');
    
    if (accounts.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5" class="text-center">
                    <div class="empty-state">
                        <i class="fas fa-inbox"></i>
                        <p>No accounts yet. Create your first account!</p>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    // Log first account to debug description
    if (accounts.length > 0) {
        console.log('First account details:', {
            name: accounts[0].name,
            description: accounts[0].description,
            hasDescription: !!accounts[0].description
        });
    }

    tbody.innerHTML = accounts.map(account => {
        // Escape HTML in description to prevent issues
        const description = account.description || '';
        const escapedDescription = description.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        
        return `
        <tr>
            <td>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, var(--primary), var(--secondary)); display: flex; align-items: center; justify-content: center; font-weight: bold;">
                        ${account.name ? account.name.charAt(0).toUpperCase() : 'W'}
                    </div>
                    <div style="flex: 1;">
                        <div style="font-weight: 600;">${account.name || 'Unnamed'}</div>
                        ${escapedDescription ? `<div style="font-size: 11px; color: var(--text-secondary); margin-top: 3px; line-height: 1.4;">${escapedDescription}</div>` : ''}
                        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 3px;">${account.phone_number || 'Not connected'}</div>
                    </div>
                </div>
            </td>
            <td><span style="font-family: monospace; font-size: 10px; word-break: break-all;">${account.id || account.account_id}</span></td>
            <td>
                <span class="status-badge ${account.status}">
                    <span class="status-indicator"></span>
                    ${account.status}
                </span>
            </td>
            <td>${formatDate(account.created_at)}</td>
            <td>
                <div class="action-buttons">
                    <button class="btn-action" data-action="show-qr" data-account-id="${account.id || account.account_id}" title="Show QR Code">
                        <i class="fas fa-qrcode"></i>
                    </button>
                    ${account.status !== 'ready' ? `
                        <button class="btn-action" data-action="reconnect" data-account-id="${account.id || account.account_id}" title="Reconnect">
                            <i class="fas fa-sync-alt"></i>
                        </button>
                    ` : ''}
                    <button class="btn-action" data-action="webhooks" data-account-id="${account.id || account.account_id}" title="Manage Webhooks">
                        <i class="fas fa-plug"></i>
                    </button>
                    <button class="btn-action" data-action="chatbot" data-account-id="${account.id || account.account_id}" title="Configure Chatbot">
                        <i class="fas fa-robot"></i>
                    </button>
                    <button class="btn-action danger" data-action="delete" data-account-id="${account.id || account.account_id}" title="Delete Account">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>
    `;
    }).join('');
}

// Filter Accounts
function filterAccounts(searchTerm) {
    const tbody = document.getElementById('accountsTableBody');
    
    if (!searchTerm) {
        // If search is empty, show all accounts
        renderAccountsTable();
        return;
    }
    
    // Filter accounts by name, description, phone number, or account ID
    const filteredAccounts = accounts.filter(account => {
        const name = (account.name || '').toLowerCase();
        const description = (account.description || '').toLowerCase();
        const phoneNumber = (account.phone_number || '').toLowerCase();
        const accountId = (account.id || account.account_id || '').toLowerCase();
        
        return name.includes(searchTerm) || 
               description.includes(searchTerm) || 
               phoneNumber.includes(searchTerm) ||
               accountId.includes(searchTerm);
    });
    
    console.log('Filtered accounts:', filteredAccounts.length, 'out of', accounts.length);
    
    if (filteredAccounts.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5" class="text-center">
                    <div class="empty-state">
                        <i class="fas fa-search"></i>
                        <p>No accounts found matching "${searchTerm}"</p>
                        <p style="font-size: 12px; color: var(--text-secondary); margin-top: 10px;">Try searching by name, description, phone number, or account ID</p>
                    </div>
                </td>
            </tr>
        `;
        return;
    }
    
    // Render filtered accounts with highlighting
    tbody.innerHTML = filteredAccounts.map(account => {
        const escapedDescription = (account.description || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        
        // Highlight matching text
        const highlightText = (text) => {
            if (!text) return '';
            const regex = new RegExp(`(${searchTerm})`, 'gi');
            return text.replace(regex, '<mark style="background: rgba(76, 175, 80, 0.2); color: var(--primary); padding: 2px 4px; border-radius: 3px;">$1</mark>');
        };
        
        const highlightedName = highlightText(account.name || 'Unnamed');
        const highlightedDescription = highlightText(escapedDescription);
        const highlightedPhone = highlightText(account.phone_number || 'Not connected');
        
        return `
        <tr>
            <td>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, var(--primary), var(--secondary)); display: flex; align-items: center; justify-content: center; font-weight: bold;">
                        ${account.name ? account.name.charAt(0).toUpperCase() : 'W'}
                    </div>
                    <div style="flex: 1;">
                        <div style="font-weight: 600;">${highlightedName}</div>
                        ${escapedDescription ? `<div style="font-size: 11px; color: var(--text-secondary); margin-top: 3px; line-height: 1.4;">${highlightedDescription}</div>` : ''}
                        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 3px;">${highlightedPhone}</div>
                    </div>
                </div>
            </td>
            <td><span style="font-family: monospace; font-size: 10px; word-break: break-all;">${account.id || account.account_id}</span></td>
            <td>
                <span class="status-badge ${account.status}">
                    <span class="status-indicator"></span>
                    ${account.status}
                </span>
            </td>
            <td>${formatDate(account.created_at)}</td>
            <td>
                <div class="action-buttons">
                    <button class="btn-action" data-action="show-qr" data-account-id="${account.id || account.account_id}" title="Show QR Code">
                        <i class="fas fa-qrcode"></i>
                    </button>
                    ${account.status !== 'ready' ? `
                        <button class="btn-action" data-action="reconnect" data-account-id="${account.id || account.account_id}" title="Reconnect">
                            <i class="fas fa-sync-alt"></i>
                        </button>
                    ` : ''}
                    <button class="btn-action" data-action="webhooks" data-account-id="${account.id || account.account_id}" title="Manage Webhooks">
                        <i class="fas fa-plug"></i>
                    </button>
                    <button class="btn-action" data-action="chatbot" data-account-id="${account.id || account.account_id}" title="Configure Chatbot">
                        <i class="fas fa-robot"></i>
                    </button>
                    <button class="btn-action danger" data-action="delete" data-account-id="${account.id || account.account_id}" title="Delete Account">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>
    `;
    }).join('');
}

// Handle Create Account
async function handleCreateAccount(e) {
    e.preventDefault();

    const accountName = document.getElementById('accountName').value.trim();
    const accountDescription = document.getElementById('accountDescription').value.trim();

    if (!accountName) {
        showAlert('Please enter an account name', 'error');
        return;
    }

    // Show loading state
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalBtnContent = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="btn-content"><i class="fas fa-spinner fa-spin"></i> Creating...</span>';

    try {
        const response = await fetch('/api/accounts', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({
                name: accountName,
                description: accountDescription || null
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to create account');
        }

        showAlert('Account created successfully! Waiting for QR code...', 'success');
        closeModal('createAccountModal');
        document.getElementById('createAccountForm').reset();

        // Show QR modal
        openModal('qrModal');
        document.getElementById('qrAccountId').textContent = data.id || accountName;
        document.getElementById('qrCode').innerHTML = '<div style="text-align: center; padding: 40px;"><i class="fas fa-spinner fa-spin" style="font-size: 48px;"></i><p style="margin-top: 20px;">Generating QR code...</p></div>';

        // Reload accounts
        loadAccounts();
        loadStats();

    } catch (error) {
        console.error('Error creating account:', error);
        showAlert(error.message, 'error');
    } finally {
        // Re-enable button
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnContent;
        }
    }
}

// Display QR Code
function displayQRCode(accountId, qrData) {
    const currentQRAccountId = document.getElementById('qrAccountId').textContent;
    
    if (currentQRAccountId === accountId) {
        document.getElementById('qrCode').innerHTML = `
            <div class="qr-container">
                <img src="${qrData}" alt="QR Code">
                <div class="scanning-effect"></div>
            </div>
            <p style="text-align: center; margin-top: 20px; color: var(--text-secondary);">
                Scan this QR code with WhatsApp
            </p>
        `;
    }
}

// Show QR Code for existing account
async function showQRCode(accountId) {
    const btn = document.querySelector(`button[data-action="show-qr"][data-account-id="${accountId}"]`);
    const originalContent = btn ? btn.innerHTML : '';
    
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }

    try {
        const response = await fetch(`/api/accounts/${accountId}/qr`, {
            method: 'GET',
            credentials: 'include'
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to get QR code');
        }

        const data = await response.json();
        
        openModal('qrModal');
        document.getElementById('qrAccountId').textContent = accountId;
        
        if (data.qr_code) {
            document.getElementById('qrCode').innerHTML = `
                <div class="qr-container">
                    <img src="${data.qr_code}" alt="QR Code" style="width: 100%; height: 100%;">
                    <div class="scanning-effect"></div>
                </div>
            `;
        } else if (data.status === 'ready') {
            document.getElementById('qrCode').innerHTML = `
                <div style="text-align: center; padding: 40px;">
                    <i class="fas fa-check-circle" style="font-size: 48px; color: var(--success);"></i>
                    <p style="margin-top: 20px; color: var(--success);">Account is already connected!</p>
                </div>
            `;
        } else {
            document.getElementById('qrCode').innerHTML = `
                <div style="text-align: center; padding: 40px;">
                    <i class="fas fa-spinner fa-spin" style="font-size: 48px;"></i>
                    <p style="margin-top: 20px;">Generating QR code...</p>
                </div>
            `;
        }

    } catch (error) {
        console.error('Error getting QR code:', error);
        showAlert(error.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalContent;
        }
    }
}

// Reconnect Account
async function reconnectAccount(accountId) {
    const btn = document.querySelector(`button[data-action="reconnect"][data-account-id="${accountId}"]`);
    const originalContent = btn ? btn.innerHTML : '';
    
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }

    try {
        const response = await fetch(`/api/accounts/${accountId}/reconnect`, {
            method: 'POST',
            credentials: 'include'
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to reconnect');
        }

        showAlert('Reconnecting account...', 'info');
        
        // Show QR modal
        openModal('qrModal');
        document.getElementById('qrAccountId').textContent = accountId;
        document.getElementById('qrCode').innerHTML = '<div style="text-align: center; padding: 40px;"><i class="fas fa-spinner fa-spin" style="font-size: 48px;"></i><p style="margin-top: 20px;">Generating QR code...</p></div>';

    } catch (error) {
        console.error('Error reconnecting account:', error);
        showAlert(error.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalContent;
        }
    }
}

// Delete Account
async function deleteAccount(accountId) {
    if (!confirm('Are you sure you want to delete this account?')) {
        return;
    }

    const btn = document.querySelector(`button[data-action="delete"][data-account-id="${accountId}"]`);
    const originalContent = btn ? btn.innerHTML : '';
    
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }

    try {
        const response = await fetch(`/api/accounts/${accountId}`, {
            method: 'DELETE',
            credentials: 'include'
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to delete account');
        }

        showAlert('Account deleted successfully', 'success');
        loadAccounts();
        loadStats();

    } catch (error) {
        console.error('Error deleting account:', error);
        showAlert(error.message, 'error');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalContent;
        }
    }
}

// Handle Send Message
async function handleSendMessage(e) {
    e.preventDefault();
    
    console.log('Send message form submitted');

    const accountId = document.getElementById('messageAccountId').value;
    const recipient = document.getElementById('messageRecipient').value.trim();
    const message = document.getElementById('messageText').value.trim();
    const messageType = document.querySelector('input[name="messageType"]:checked').value;
    
    const mediaFileInput = document.getElementById('messageMedia');
    const mediaFile = mediaFileInput && mediaFileInput.files && mediaFileInput.files.length > 0 ? mediaFileInput.files[0] : null;

    console.log('Form values:', { accountId, recipient, message, messageType, hasMediaFile: !!mediaFile });

    if (!accountId) {
        showAlert('Please select an account', 'error');
        return;
    }

    if (!recipient) {
        showAlert('Please enter recipient number', 'error');
        return;
    }

    // Show loading state
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalBtnContent = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="btn-content"><i class="fas fa-spinner fa-spin"></i> Sending...</span>';

    try {
        let response;

        if (messageType === 'text') {
            if (!message) {
                throw new Error('Message text is required');
            }
            
            // Send text message
            response = await fetch('/api/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    account_id: accountId,
                    number: recipient,
                    message: message
                })
            });
        } else if (messageType === 'media') {
            if (!mediaFile) {
                throw new Error('Media file is required');
            }
            
            // Send media message
            const formData = new FormData();
            formData.append('account_id', accountId);
            formData.append('number', recipient);
            if (message) formData.append('caption', message);
            formData.append('media', mediaFile);

            response = await fetch('/api/send-media', {
                method: 'POST',
                credentials: 'include',
                body: formData
            });
        } else if (messageType === 'buttons') {
            // Collect buttons
            const buttonInputs = document.querySelectorAll('.button-option-input');
            const buttons = Array.from(buttonInputs).map(input => input.value.trim()).filter(val => val);
            
            if (buttons.length === 0) {
                throw new Error('At least one button is required');
            }
            
            if (!message && !mediaFile) {
                throw new Error('Message body or media is required for buttons');
            }
            
            const title = document.getElementById('buttonTitle').value.trim();
            const footer = document.getElementById('buttonFooter').value.trim();
            
            // Prepare payload
            // If media is present, we must use FormData
            if (mediaFile) {
                const formData = new FormData();
                formData.append('account_id', accountId);
                formData.append('number', recipient);
                formData.append('body', message); // Used as content if no media, or ignored/caption if media
                formData.append('buttons', JSON.stringify(buttons.map(b => ({ body: b }))));
                if (title) formData.append('title', title);
                if (footer) formData.append('footer', footer);
                formData.append('media', mediaFile);
                
                response = await fetch('/api/send-buttons', {
                    method: 'POST',
                    credentials: 'include',
                    body: formData
                });
            } else {
                // JSON payload
                response = await fetch('/api/send-buttons', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({
                        account_id: accountId,
                        number: recipient,
                        body: message,
                        buttons: buttons.map(b => ({ body: b })),
                        title: title || undefined,
                        footer: footer || undefined
                    })
                });
            }
        }

        const data = await response.json();

        if (!response.ok) {
            if (data.details && Array.isArray(data.details)) {
                const errorMessages = data.details.map(d => `${d.field}: ${d.message}`).join('\n');
                throw new Error(`Validation Failed:\n${errorMessages}`);
            }
            throw new Error(data.error || data.message || 'Failed to send message');
        }

        showAlert('Message sent successfully!', 'success');
        closeModal('sendMessageModal');
        document.getElementById('sendMessageForm').reset();
        
        // Reset UI state
        document.querySelector('input[name="messageType"][value="text"]').click();
        document.getElementById('buttonsList').innerHTML = '';
        
        // Re-enable button
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnContent;

        loadStats();

    } catch (error) {
        console.error('Error sending message:', error);
        showAlert(error.message, 'error');
        
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnContent;
        }
    }
}

// Load Account Options
async function loadAccountOptions() {
    const select = document.getElementById('messageAccountId');
    
    select.innerHTML = '<option value="">Select Account</option>';
    
    const readyAccounts = accounts.filter(acc => acc.status === 'ready');
    
    console.log('Ready accounts for dropdown:', readyAccounts);
    
    if (readyAccounts.length === 0) {
        select.innerHTML = '<option value="">No accounts available</option>';
        return;
    }

    readyAccounts.forEach(account => {
        const option = document.createElement('option');
        const accountId = account.id || account.account_id;
        option.value = accountId;
        option.textContent = `${account.name || account.account_id} (${account.phone_number || 'Not connected'})`;
        console.log(`Adding account option: ${accountId} - ${option.textContent}`);
        select.appendChild(option);
    });
}

// Open Webhook Modal
async function openWebhookModal(accountId) {
    openModal('webhooksModal');
    document.getElementById('webhookAccountId').value = accountId;
    
    await loadWebhooks(accountId);
}

// Load Webhooks
async function loadWebhooks(accountId) {
    try {
        const response = await fetch(`/api/accounts/${accountId}/webhooks`, {
            credentials: 'include'
        });

        if (!response.ok) throw new Error('Failed to fetch webhooks');

        const data = await response.json();
        webhooks = data;

        renderWebhooksList(accountId);

    } catch (error) {
        console.error('Error loading webhooks:', error);
        showAlert('Failed to load webhooks', 'error');
    }
}

// Render Webhooks List
function renderWebhooksList(accountId) {
    const list = document.getElementById('webhooksList');
    
    if (webhooks.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-webhook empty-icon"></i>
                <p>No webhooks configured</p>
            </div>
        `;
        return;
    }

    list.innerHTML = webhooks.map(webhook => `
        <div style="padding: 15px; background: rgba(255, 255, 255, 0.03); border-radius: 8px; margin-bottom: 10px; border: 1px solid var(--border-color);">
            <div style="display: flex; justify-content: space-between; align-items: start; gap: 15px;">
                <div style="flex: 1;">
                    <div style="font-weight: 600; margin-bottom: 5px; word-break: break-all;">${webhook.url}</div>
                    ${webhook.secret ? `
                        <div style="font-size: 12px; color: var(--primary); margin-bottom: 3px;">
                            <i class="fas fa-key"></i> Secret: ${webhook.secret.substring(0, 10)}${'*'.repeat(Math.max(0, (webhook.secret.length || 10) - 10))}
                        </div>
                    ` : ''}
                    <div style="font-size: 12px; color: var(--text-secondary);">
                        ${webhook.is_active ? '<span style="color: var(--success);"><i class="fas fa-check-circle"></i> Active</span>' : '<span style="color: var(--warning);"><i class="fas fa-pause-circle"></i> Inactive</span>'}
                        · Created: ${formatDate(webhook.created_at)}
                    </div>
                </div>
                <button class="btn-action danger" data-action="delete-webhook" data-webhook-id="${webhook.id}" data-account-id="${accountId}" title="Delete">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
    `).join('');
}

// Handle Create Webhook
async function handleCreateWebhook(e) {
    e.preventDefault();

    const accountId = document.getElementById('newWebhookAccountId').value;
    const url = document.getElementById('webhookUrl').value.trim();
    const secret = document.getElementById('webhookSecret').value.trim();
    const isActive = document.getElementById('webhookActive').checked;

    if (!accountId || !url) {
        showAlert('Please fill in all required fields', 'error');
        return;
    }

    // Show loading state
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalBtnContent = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="btn-content"><i class="fas fa-spinner fa-spin"></i> Creating...</span>';

    try {
        const webhookData = {
            url: url,
            is_active: isActive
        };
        
        if (secret) {
            webhookData.secret = secret;
        }

        const response = await fetch(`/api/accounts/${accountId}/webhooks`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify(webhookData)
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to create webhook');
        }

        showAlert('Webhook created successfully!', 'success');
        closeModal('createWebhookModal');
        document.getElementById('createWebhookForm').reset();
        
        // Reload webhooks if the modal is still showing the list
        const webhookAccountId = document.getElementById('webhookAccountId').value;
        if (webhookAccountId === accountId) {
            await loadWebhooks(accountId);
            openModal('webhooksModal');
        }

    } catch (error) {
        console.error('Error creating webhook:', error);
        showAlert(error.message, 'error');
    } finally {
        // Re-enable button
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnContent;
        }
    }
}

// Delete Webhook
async function deleteWebhook(webhookId, accountId) {
    if (!confirm('Are you sure you want to delete this webhook?')) {
        return;
    }

    const btn = document.querySelector(`button[data-action="delete-webhook"][data-webhook-id="${webhookId}"]`);
    const originalContent = btn ? btn.innerHTML : '';
    
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }

    try {
        const response = await fetch(`/api/accounts/${accountId}/webhooks/${webhookId}`, {
            method: 'DELETE',
            credentials: 'include'
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to delete webhook');
        }

        showAlert('Webhook deleted successfully', 'success');
        await loadWebhooks(accountId);

    } catch (error) {
        console.error('Error deleting webhook:', error);
        showAlert(error.message, 'error');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalContent;
        }
    }
}

// Get Message Stats
async function getMessageStats() {
    try {
        const response = await fetch('/api/messages?limit=1000', {
            credentials: 'include'
        });

        if (!response.ok) return { total: 0, successRate: '100%' };

        const data = await response.json();
        const total = data.length;
        const success = data.filter(m => m.status === 'sent' || m.status === 'delivered').length;
        const successRate = total > 0 ? Math.round((success / total) * 100) : 100;

        return { total, successRate: `${successRate}%` };

    } catch (error) {
        return { total: 0, successRate: '100%' };
    }
}

// Modal Functions
function openModal(modalId) {
    console.log('Opening modal:', modalId);
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('active');
        
        // Load account options if it's send message modal
        if (modalId === 'sendMessageModal') {
            loadAccountOptions();
        }
        
        // Load account options for webhook creation
        if (modalId === 'createWebhookModal') {
            loadWebhookAccountOptions();
        }
        
        console.log('Modal opened successfully:', modalId);
    } else {
        console.error('Modal not found:', modalId);
    }
}

function closeModal(modalId) {
    console.log('Closing modal:', modalId);
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('active');
    } else {
        console.error('Modal not found for closing:', modalId);
    }
}

// Load Webhook Account Options
function loadWebhookAccountOptions() {
    const select = document.getElementById('newWebhookAccountId');
    
    select.innerHTML = '<option value="">Select Account</option>';
    
    accounts.forEach(account => {
        const option = document.createElement('option');
        option.value = account.account_id;
        option.textContent = `${account.name || account.account_id}`;
        select.appendChild(option);
    });
}

// Navigation
function navigateToSection(section) {
    // Update active nav
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.remove('active');
    });
    document.querySelector(`[data-section="${section}"]`).classList.add('active');

    // Handle section visibility
    // For now, all sections are visible on one page
    // Add section switching logic here if needed
}

function setActiveNav() {
    const currentPath = window.location.pathname;
    document.querySelectorAll('.nav-link').forEach(link => {
        if (link.getAttribute('data-section') === 'dashboard') {
            link.classList.add('active');
        }
    });
}

// Logout
async function handleLogout() {
    if (confirm('Are you sure you want to logout?')) {
        try {
            await fetch('/api/auth/logout', {
                method: 'POST',
                credentials: 'include'
            });
        } catch (error) {
            console.error('Logout error:', error);
        } finally {
            localStorage.removeItem('authenticated');
            localStorage.removeItem('username');
            window.location.href = '/login';
        }
    }
}

// Search
function handleSearch(e) {
    const query = e.target.value.toLowerCase();
    
    if (!query) {
        renderAccountsTable();
        return;
    }

    const filtered = accounts.filter(account => {
        return (account.name && account.name.toLowerCase().includes(query)) ||
               (account.account_id && account.account_id.toLowerCase().includes(query)) ||
               (account.phone_number && account.phone_number.toLowerCase().includes(query));
    });

    const tbody = document.getElementById('accountsTableBody');
    
    if (filtered.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5" class="text-center">
                    <div class="empty-state">
                        <i class="fas fa-search"></i>
                        <p>No accounts found matching "${query}"</p>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    const currentAccounts = accounts;
    accounts = filtered;
    renderAccountsTable();
    accounts = currentAccounts;
}

// Alert System
function showAlert(message, type = 'info') {
    const container = document.getElementById('alertContainer');
    const alert = document.createElement('div');
    alert.className = `alert alert-${type}`;
    alert.innerHTML = `
        <i class="fas fa-${getAlertIcon(type)}"></i>
        <span>${message}</span>
    `;
    
    container.appendChild(alert);

    setTimeout(() => {
        alert.style.animation = 'slideOutRight 0.3s ease forwards';
        setTimeout(() => {
            alert.remove();
        }, 300);
    }, 5000);
}

function getAlertIcon(type) {
    const icons = {
        success: 'check-circle',
        error: 'exclamation-circle',
        warning: 'exclamation-triangle',
        info: 'info-circle'
    };
    return icons[type] || 'info-circle';
}

// Utility Functions
function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;
    
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    
    return date.toLocaleDateString();
}



// Custom View Functions
function showWebhooksView() {
    const mainContent = document.getElementById('mainContent');
    mainContent.innerHTML = '<div class="cyber-card"><div class="card-header"><h2 class="card-title">Webhooks Management</h2><p class="card-subtitle">Manage webhooks for all accounts</p></div><div style="padding: 20px;"><div id="allWebhooksContainer"><div style="text-align: center; padding: 40px; color: var(--text-secondary);"><i class="fas fa-spinner fa-spin" style="font-size: 32px;"></i><p style="margin-top: 15px;">Loading webhooks...</p></div></div></div></div>';
    loadAllWebhooks();
}

async function loadAllWebhooks() {
    const container = document.getElementById('allWebhooksContainer');
    if (!container) return;
    
    try {
        const accountsResponse = await fetch('/api/accounts', { credentials: 'include' });
        const accounts = await accountsResponse.json();
        
        if (accounts.length === 0) {
            container.innerHTML = '<div style="text-align: center; padding: 40px;"><i class="fas fa-inbox" style="font-size: 48px; opacity: 0.3;"></i><p style="margin-top: 15px;">No accounts found</p></div>';
            return;
        }
        
        let html = '';
        for (const account of accounts) {
            const webhooksResponse = await fetch('/api/accounts/' + account.id + '/webhooks', { credentials: 'include' });
            const webhooks = await webhooksResponse.json();
            
            html += '<div class="cyber-card" style="margin-bottom: 20px;"><div class="card-header"><div><h3 style="margin: 0; font-size: 16px;">' + (account.name || 'Unnamed') + '</h3><p style="font-size: 12px; color: var(--text-secondary); margin: 5px 0 0 0;">' + (account.phone_number || 'Not connected') + '</p></div></div><div style="padding: 15px;">';
            
            if (webhooks.length === 0) {
                html += '<p style="color: var(--text-secondary); text-align: center; padding: 20px;">No webhooks configured</p>';
            } else {
                webhooks.forEach(wh => {
                    html += '<div style="background: rgba(0,243,255,0.05); border: 1px solid rgba(0,243,255,0.2); border-radius: 8px; padding: 15px; margin-bottom: 10px;"><div style="display: flex; justify-content: space-between;"><div style="flex: 1;"><div style="font-family: monospace; font-size: 12px;">' + wh.url + '</div><div style="font-size: 11px; color: var(--text-secondary);">Secret: ' + (wh.secret ? '••••••••' : 'None') + '</div></div></div></div>';
                });
            }
            
            html += '</div></div>';
        }
        
        container.innerHTML = html;
    } catch (error) {
        console.error('Error loading webhooks:', error);
        container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--error);"><i class="fas fa-exclamation-circle" style="font-size: 48px;"></i><p style="margin-top: 15px;">Failed to load webhooks</p></div>';
    }
}

function showMessagesView() {
    const mainContent = document.getElementById('mainContent');
    mainContent.innerHTML = '<div class="cyber-card"><div class="card-header"><div><h2 class="card-title">Messages</h2><p class="card-subtitle">View all messages</p></div><button class="btn-cyber" onclick="openModal(\'sendMessageModal\');"><span class="btn-content"><i class="fas fa-paper-plane"></i> Send Message</span></button></div><div id="messagesContainer" style="padding: 20px;"><div style="text-align: center; padding: 40px;"><i class="fas fa-spinner fa-spin" style="font-size: 32px;"></i><p style="margin-top: 15px;">Loading messages...</p></div></div></div>';
    loadAllMessages();
}

async function loadAllMessages() {
    const container = document.getElementById('messagesContainer');
    if (!container) return;
    
    try {
        const response = await fetch('/api/messages?limit=50', { credentials: 'include' });
        const messages = await response.json();
        
        if (messages.length === 0) {
            container.innerHTML = '<div style="text-align: center; padding: 40px;"><i class="fas fa-inbox" style="font-size: 48px; opacity: 0.3;"></i><p style="margin-top: 15px;">No messages found</p></div>';
            return;
        }
        
        let html = '';
        messages.forEach(msg => {
            const direction = msg.direction || 'unknown';
            const from = msg.sender || msg.from_number || msg.to_number || 'Unknown';
            const text = msg.body || msg.message || msg.caption || 'No text';
            const date = formatDate(msg.created_at);
            
            // Find account name
            const account = accounts.find(a => a.id === msg.account_id || a.account_id === msg.account_id);
            const accountName = account ? (account.name || account.account_id) : (msg.account_id || 'Unknown Account');
            
            html += `
            <div style="background: rgba(0,243,255,0.05); border: 1px solid rgba(0,243,255,0.2); border-radius: 8px; padding: 15px; margin-bottom: 10px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 8px;">
                    <div style="font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 5px;">
                        <i class="fas fa-robot" style="color: var(--secondary);"></i> 
                        <span>Account: <strong>${accountName}</strong></span>
                    </div>
                    <span style="font-size: 11px; color: var(--text-secondary);">${date}</span>
                </div>
                <div style="margin-bottom: 8px;">
                    <span style="color: var(--primary); font-size: 13px; font-weight: 600;">${direction === 'outgoing' ? 'To' : 'From'}: </span>
                    <span style="font-size: 13px;">${from}</span>
                </div>
                <div style="color: var(--text-primary); font-size: 14px; line-height: 1.4;">${text}</div>
            </div>`;
        });
        
        container.innerHTML = html;
    } catch (error) {
        console.error('Error loading messages:', error);
        container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--error);"><i class="fas fa-exclamation-circle" style="font-size: 48px;"></i><p style="margin-top: 15px;">Failed to load messages</p></div>';
    }
}

// Analytics Charts
let dashboardChartInstances = {};
let detailedChartInstances = {};

function getChartTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
        textColor: isDark ? '#e2e8f0' : '#64748b',
        gridColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
        borderColor: isDark ? '#1e293b' : '#ffffff', // Matches card background
        tooltipBg: isDark ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.8)',
        tooltipText: isDark ? '#fff' : '#000'
    };
}

function createAnalyticsCharts(latestStats, retryCount = 0) {
    console.log('Creating analytics charts...', latestStats);
    
    // Check if Chart.js is loaded
    if (typeof Chart === 'undefined') {
        console.error('Chart.js is not loaded!');
        if (retryCount < 10) {
            setTimeout(() => createAnalyticsCharts(latestStats, retryCount + 1), 1000); // Retry after 1 second
        } else {
            console.error('Giving up on creating analytics charts after 10 attempts.');
        }
        return;
    }
    
    const theme = getChartTheme();
    
    // Get current stats
    const totalAccounts = latestStats?.totalAccounts ?? accounts.length;
    const activeAccounts = latestStats?.activeAccounts ?? accounts.filter(acc => acc.status === 'ready').length;
    const inactiveAccounts = Math.max(0, totalAccounts - activeAccounts);
    
    // Chart 1: Accounts Overview (Doughnut)
    const ctx1 = document.getElementById('chart1');
    if (ctx1) {
        if (dashboardChartInstances.chart1) {
            dashboardChartInstances.chart1.data.datasets[0].data = [activeAccounts, inactiveAccounts];
            dashboardChartInstances.chart1.data.datasets[0].borderColor = theme.borderColor;
            dashboardChartInstances.chart1.options.plugins.tooltip.backgroundColor = theme.tooltipBg;
            dashboardChartInstances.chart1.options.plugins.tooltip.titleColor = theme.tooltipText;
            dashboardChartInstances.chart1.options.plugins.tooltip.bodyColor = theme.tooltipText;
            dashboardChartInstances.chart1.update();
        } else {
            dashboardChartInstances.chart1 = new Chart(ctx1, {
                type: 'doughnut',
                data: {
                    labels: ['Active', 'Inactive'],
                    datasets: [{
                        data: [activeAccounts, inactiveAccounts],
                        backgroundColor: ['#4CAF50', '#FF9800'],
                        borderColor: theme.borderColor,
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: { duration: 0 },
                    plugins: {
                        legend: { display: false },
                        tooltip: { 
                            backgroundColor: theme.tooltipBg,
                            titleColor: theme.tooltipText,
                            bodyColor: theme.tooltipText,
                            callbacks: {
                                label: function(context) {
                                    return ` ${context.label}: ${context.raw}`;
                                }
                            }
                        }
                    },
                    cutout: '70%'
                }
            });
        }
    }
    
    // Chart 2: Message Traffic (Line) - Using Daily Stats
    const ctx2 = document.getElementById('chart2');
    if (ctx2) {
        const dailyStats = latestStats?.dailyStats || [];
        const labels = dailyStats.length > 0 
            ? dailyStats.map(d => new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))
            : Array.from({length: 7}, (_, i) => {
                const d = new Date();
                d.setDate(d.getDate() - (6-i));
                return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            });
            
        const data = dailyStats.length > 0
            ? dailyStats.map(d => d.total)
            : Array(7).fill(0);

        if (dashboardChartInstances.chart2) {
            dashboardChartInstances.chart2.data.labels = labels;
            dashboardChartInstances.chart2.data.datasets[0].data = data;
            dashboardChartInstances.chart2.options.plugins.tooltip.backgroundColor = theme.tooltipBg;
            dashboardChartInstances.chart2.options.plugins.tooltip.titleColor = theme.tooltipText;
            dashboardChartInstances.chart2.options.plugins.tooltip.bodyColor = theme.tooltipText;
            dashboardChartInstances.chart2.update();
        } else {
            dashboardChartInstances.chart2 = new Chart(ctx2, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Messages',
                        data: data,
                        borderColor: '#2196F3',
                        backgroundColor: 'rgba(33, 150, 243, 0.1)',
                        fill: true,
                        tension: 0.4,
                        borderWidth: 2,
                        pointRadius: 3,
                        pointHoverRadius: 5
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: { duration: 0 },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            mode: 'index',
                            intersect: false,
                            backgroundColor: theme.tooltipBg,
                            titleColor: theme.tooltipText,
                            bodyColor: theme.tooltipText
                        }
                    },
                    scales: {
                        x: { display: false },
                        y: { display: false, min: 0 }
                    },
                    interaction: {
                        mode: 'nearest',
                        axis: 'x',
                        intersect: false
                    }
                }
            });
        }
    }
    
    // Chart 3: Incoming vs Outgoing (Doughnut)
    const ctx3 = document.getElementById('chart3');
    if (ctx3) {
        const incoming = latestStats?.incomingMessages ?? 0;
        const outgoing = latestStats?.outgoingMessages ?? 0;
        // If no data, show empty ring
        const data = (incoming + outgoing === 0) ? [0, 0] : [incoming, outgoing];
        const bgColors = ['#4CAF50', '#2196F3']; // Green (In), Blue (Out)

        if (dashboardChartInstances.chart3) {
            dashboardChartInstances.chart3.data.datasets[0].data = data;
            dashboardChartInstances.chart3.data.datasets[0].borderColor = theme.borderColor;
            dashboardChartInstances.chart3.options.plugins.tooltip.backgroundColor = theme.tooltipBg;
            dashboardChartInstances.chart3.options.plugins.tooltip.titleColor = theme.tooltipText;
            dashboardChartInstances.chart3.options.plugins.tooltip.bodyColor = theme.tooltipText;
            dashboardChartInstances.chart3.update();
        } else {
            dashboardChartInstances.chart3 = new Chart(ctx3, {
                type: 'doughnut',
                data: {
                    labels: ['Incoming', 'Outgoing'],
                    datasets: [{
                        data: data,
                        backgroundColor: bgColors,
                        borderColor: theme.borderColor,
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: { duration: 0 },
                    plugins: {
                        legend: { display: false },
                        tooltip: { 
                            backgroundColor: theme.tooltipBg,
                            titleColor: theme.tooltipText,
                            bodyColor: theme.tooltipText,
                            callbacks: {
                                label: function(context) {
                                    return ` ${context.label}: ${context.raw}`;
                                }
                            }
                        }
                    },
                    cutout: '70%'
                }
            });
        }
    }
    
    // Chart 4: Success Rate (Doughnut)
    const ctx4 = document.getElementById('chart4');
    if (ctx4) {
        const success = latestStats?.successMessages ?? 0;
        const failed = latestStats?.failedMessages ?? 0;
        
        const data = (success + failed === 0) ? [0, 0] : [success, failed];
        
        if (dashboardChartInstances.chart4) {
            dashboardChartInstances.chart4.data.datasets[0].data = data;
            dashboardChartInstances.chart4.data.datasets[0].borderColor = theme.borderColor;
            dashboardChartInstances.chart4.options.plugins.tooltip.backgroundColor = theme.tooltipBg;
            dashboardChartInstances.chart4.options.plugins.tooltip.titleColor = theme.tooltipText;
            dashboardChartInstances.chart4.options.plugins.tooltip.bodyColor = theme.tooltipText;
            dashboardChartInstances.chart4.update();
        } else {
            dashboardChartInstances.chart4 = new Chart(ctx4, {
                type: 'doughnut',
                data: {
                    labels: ['Success', 'Failed'],
                    datasets: [{
                        data: data,
                        backgroundColor: ['#66BB6A', '#F44336'], // Green, Red
                        borderColor: theme.borderColor,
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: { duration: 0 },
                    cutout: '70%',
                    plugins: {
                        legend: { display: false },
                        tooltip: { 
                            backgroundColor: theme.tooltipBg,
                            titleColor: theme.tooltipText,
                            bodyColor: theme.tooltipText,
                            callbacks: {
                                label: function(context) {
                                    return ` ${context.label}: ${context.raw}`;
                                }
                            }
                        }
                    }
                }
            });
        }
    }
    
    console.log('Analytics charts updated successfully!');
}

// Auto-refresh data
setInterval(() => {
    loadStats();
    loadAccounts();
}, 60000); // Refresh every 60 seconds

// Chatbot Form
const chatbotForm = document.getElementById('chatbotForm');
if (chatbotForm) {
    chatbotForm.addEventListener('submit', handleChatbotSave);
}

// Chatbot Provider Change
const chatbotProvider = document.getElementById('chatbotProvider');
if (chatbotProvider) {
    chatbotProvider.addEventListener('change', updateChatbotModels);
}

// Temperature Slider
const chatbotTemperature = document.getElementById('chatbotTemperature');
const temperatureValue = document.getElementById('temperatureValue');
if (chatbotTemperature && temperatureValue) {
    chatbotTemperature.addEventListener('input', (e) => {
        temperatureValue.textContent = e.target.value;
    });
}

// Test Chatbot Button
const testChatbotBtn = document.getElementById('testChatbotBtn');
if (testChatbotBtn) {
    testChatbotBtn.addEventListener('click', handleTestChatbot);
}

// Theme Toggle
const themeToggle = document.getElementById('themeToggle');
if (themeToggle) {
    // Check saved theme
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);

    themeToggle.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        updateThemeIcon(newTheme);
        
        // Reload charts to apply new theme colors
        loadStats();
    });
}

// Refresh Logs Button
const refreshLogsBtn = document.getElementById('refreshLogsBtn');
if (refreshLogsBtn) {
    refreshLogsBtn.addEventListener('click', loadSystemLogs);
}

// Chatbot Functions
async function openChatbotModal(accountId) {
    openModal('chatbotModal');
    document.getElementById('chatbotAccountId').value = accountId;
    
    // Reset form first
    document.getElementById('chatbotForm').reset();
    document.getElementById('chatbotActive').checked = false;
    updateChatbotStatusLabel(false);
    document.getElementById('chatbotTemperature').value = 0.7;
    document.getElementById('temperatureValue').textContent = '0.7';
    document.getElementById('testResultContainer').style.display = 'none';
    document.getElementById('testMessageInput').value = '';
    
    updateChatbotModels(); // Set default models

    // Helper to populate form
    const populateForm = (config) => {
        if (config && config.provider) {
            document.getElementById('chatbotProvider').value = config.provider;
            updateChatbotModels(); // Update models based on provider
            
            // Small delay to ensure options are rendered
            setTimeout(() => {
                if (config.model) document.getElementById('chatbotModel').value = config.model;
            }, 0);

            document.getElementById('chatbotApiKey').value = config.api_key || '';
            document.getElementById('chatbotSystemPrompt').value = config.system_prompt || '';
            document.getElementById('chatbotActive').checked = config.is_active;
            updateChatbotStatusLabel(config.is_active);
            
            if (config.temperature !== undefined) {
                document.getElementById('chatbotTemperature').value = config.temperature;
                document.getElementById('temperatureValue').textContent = config.temperature;
            }
        }
    };

    // 1. Try to load from cache first for instant UI
    if (chatbotConfigCache[accountId]) {
        console.log('Loading chatbot config from cache');
        populateForm(chatbotConfigCache[accountId]);
    }

    // 2. Fetch fresh config from server
    try {
        const response = await fetch(`/api/accounts/${accountId}/chatbot`, {
            credentials: 'include'
        });
        
        const config = await response.json();
        
        // Update cache and UI
        if (config && config.provider) {
            chatbotConfigCache[accountId] = config;
            populateForm(config);
        }
    } catch (error) {
        console.error('Error loading chatbot config:', error);
        // Only show error if we didn't have cached data
        if (!chatbotConfigCache[accountId]) {
            showAlert('Failed to load chatbot configuration', 'error');
        }
    }
}

function updateChatbotStatusLabel(isActive) {
    const label = document.getElementById('chatbotStatusLabel');
    if (label) {
        label.textContent = isActive ? 'Active' : 'Disabled';
        label.className = `toggle-label ${isActive ? 'active' : ''}`;
        label.style.color = isActive ? 'var(--success)' : 'var(--text-secondary)';
    }
}

// Toggle API Key Visibility
const toggleApiKeyBtn = document.getElementById('toggleApiKey');
if (toggleApiKeyBtn) {
    toggleApiKeyBtn.addEventListener('click', () => {
        const input = document.getElementById('chatbotApiKey');
        const icon = toggleApiKeyBtn.querySelector('i');
        if (input.type === 'password') {
            input.type = 'text';
            icon.className = 'fas fa-eye-slash';
        } else {
            input.type = 'password';
            icon.className = 'fas fa-eye';
        }
    });
}

// Chatbot Active Toggle Listener
const chatbotActiveToggle = document.getElementById('chatbotActive');
if (chatbotActiveToggle) {
    chatbotActiveToggle.addEventListener('change', (e) => {
        updateChatbotStatusLabel(e.target.checked);
    });
}

function updateChatbotModels() {
    const provider = document.getElementById('chatbotProvider').value;
    const modelSelect = document.getElementById('chatbotModel');
    
    modelSelect.innerHTML = '';
    
    let models = [];
    if (provider === 'openai') {
        models = [
            // Flagship & Efficient
            { value: 'gpt-4o', label: 'GPT-4o (Omni) - Best Overall' },
            { value: 'gpt-4o-mini', label: 'GPT-4o Mini - Fast & Cheap' },
            
            // Reasoning (o1 Series)
            { value: 'o1-preview', label: 'o1 Preview (Reasoning)' },
            { value: 'o1-mini', label: 'o1 Mini (Fast Reasoning)' },

            // Legacy / Stable
            { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
            { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' }
        ];
    } else if (provider === 'gemini') {
        models = [
            // Gemini 2.5 Series
            { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Free: 2 RPM, 50 RPD)' },
            { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Free: 10 RPM, 250 RPD)' },
            { value: 'gemini-2.5-flash-preview', label: 'Gemini 2.5 Flash Preview (Free: 10 RPM, 250 RPD)' },
            { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (Free: 15 RPM, 1000 RPD)' },
            { value: 'gemini-2.5-flash-lite-preview', label: 'Gemini 2.5 Flash-Lite Preview (Free: 15 RPM, 1000 RPD)' },

            // Gemini 2.0 Series
            { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (Free: 15 RPM, 200 RPD)' },
            { value: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash-Lite' },

            // Gemini 1.5 Series
            { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro (Best Quality)' }
        ];
    } else if (provider === 'anthropic') {
        models = [
            // Claude 3.5 Series
            { value: 'claude-3-5-sonnet-20240620', label: 'Claude 3.5 Sonnet (Latest)' },
            { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku (Fastest)' },
            
            // Claude 3 Series
            { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus (Powerful)' },
            { value: 'claude-3-sonnet-20240229', label: 'Claude 3 Sonnet' },
            { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' }
        ];
    } else if (provider === 'openrouter') {
        models = [
            // Free Models (Community)
            { value: 'meta-llama/llama-3.1-8b-instruct:free', label: 'Llama 3.1 8B (Free)' },
            { value: 'mistralai/mistral-7b-instruct:free', label: 'Mistral 7B (Free)' },
            { value: 'google/gemini-pro-1.5-exp:free', label: 'Gemini Pro 1.5 Exp (Free)' },
            { value: 'google/gemini-flash-1.5-exp:free', label: 'Gemini Flash 1.5 Exp (Free)' },
            
            // Paid / High Performance
            { value: 'openai/gpt-4o', label: 'GPT-4o (via OpenRouter)' },
            { value: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet (via OpenRouter)' },
            { value: 'meta-llama/llama-3.1-70b-instruct', label: 'Llama 3.1 70B' },
            { value: 'meta-llama/llama-3.1-405b-instruct', label: 'Llama 3.1 405B' },
            { value: 'mistralai/mistral-large-2407', label: 'Mistral Large 2' }
        ];
    } else if (provider === 'openrouter-free') {
        models = [
            { value: 'meta-llama/llama-3.2-3b-instruct:free', label: 'Meta: Llama 3.2 3B Instruct (Free)' },
            { value: 'qwen/qwen-2.5-72b-instruct:free', label: 'Qwen2.5 72B Instruct (Free)' },
            { value: 'nousresearch/hermes-3-llama-3.1-405b:free', label: 'Nous: Hermes 3 405B Instruct (Free)' },
            { value: 'mistralai/mistral-nemo:free', label: 'Mistral: Mistral Nemo (Free)' },
            { value: 'mistralai/mistral-7b-instruct:free', label: 'Mistral: Mistral 7B Instruct (Free)' }
        ];
    }
    
    models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.value;
        option.textContent = model.label;
        modelSelect.appendChild(option);
    });
}

async function handleChatbotSave(e) {
    e.preventDefault();
    
    const accountId = document.getElementById('chatbotAccountId').value;
    const provider = document.getElementById('chatbotProvider').value;
    const model = document.getElementById('chatbotModel').value;
    const apiKey = document.getElementById('chatbotApiKey').value;
    const systemPrompt = document.getElementById('chatbotSystemPrompt').value;
    const temperature = parseFloat(document.getElementById('chatbotTemperature').value);
    const isActive = document.getElementById('chatbotActive').checked;

    if (isActive && !apiKey) {
        showAlert('API Key is required to enable chatbot', 'error');
        return;
    }

    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalBtnContent = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="btn-content"><i class="fas fa-spinner fa-spin"></i> Saving...</span>';

    try {
        const response = await fetch(`/api/accounts/${accountId}/chatbot`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({
                provider,
                model,
                api_key: apiKey,
                system_prompt: systemPrompt,
                temperature,
                is_active: isActive
            })
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to save configuration');
        }

        // Update cache with new values
        chatbotConfigCache[accountId] = {
            provider,
            model,
            api_key: apiKey,
            system_prompt: systemPrompt,
            temperature,
            is_active: isActive
        };

        showAlert('Chatbot configuration saved successfully!', 'success');
        closeModal('chatbotModal');

    } catch (error) {
        console.error('Error saving chatbot config:', error);
        showAlert(error.message, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnContent;
    }
}

async function handleTestChatbot() {
    const accountId = document.getElementById('chatbotAccountId').value;
    const provider = document.getElementById('chatbotProvider').value;
    const model = document.getElementById('chatbotModel').value;
    const apiKey = document.getElementById('chatbotApiKey').value;
    const systemPrompt = document.getElementById('chatbotSystemPrompt').value;
    const temperature = parseFloat(document.getElementById('chatbotTemperature').value);
    const testMessage = document.getElementById('testMessageInput').value.trim() || "Hello, this is a test message.";

    if (!apiKey) {
        showAlert('Please enter an API Key to test', 'warning');
        return;
    }

    const btn = document.getElementById('testChatbotBtn');
    const originalContent = btn.innerHTML;
    const resultContainer = document.getElementById('testResultContainer');
    const resultText = document.getElementById('testResultText');
    const latencyBadge = document.getElementById('testLatency');

    btn.disabled = true;
    btn.innerHTML = '<span class="btn-content"><i class="fas fa-spinner fa-spin"></i> Testing...</span>';
    
    // Reset result
    resultContainer.style.display = 'none';
    resultText.textContent = '';
    resultText.className = 'test-result-content';

    const startTime = Date.now();

    try {
        const response = await fetch(`/api/accounts/${accountId}/chatbot/test`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({
                provider,
                model,
                api_key: apiKey,
                system_prompt: systemPrompt,
                temperature,
                message: testMessage
            })
        });

        const endTime = Date.now();
        const latency = endTime - startTime;
        latencyBadge.textContent = `${latency}ms`;

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || data.details || 'Test failed');
        }

        resultContainer.style.display = 'block';
        resultText.textContent = data.response;
        resultText.style.color = 'var(--text-primary)';
        showAlert('Chatbot test successful!', 'success');

    } catch (error) {
        console.error('Error testing chatbot:', error);
        resultContainer.style.display = 'block';
        resultText.textContent = `Error: ${error.message}`;
        resultText.style.color = 'var(--error)';
        showAlert('Chatbot test failed', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalContent;
    }
}

// Detailed Analytics
function loadDetailedAnalytics(stats) {
    if (!stats) return;
    
    console.log('Loading detailed analytics...', stats);

    // Check if Chart.js is loaded
    if (typeof Chart === 'undefined') {
        console.error('Chart.js is not loaded for detailed analytics!');
        return;
    }
    
    const theme = getChartTheme();
    
    // 1. Detailed Traffic Chart (Line: Incoming vs Outgoing)
    const ctxTraffic = document.getElementById('detailedTrafficChart');
    if (ctxTraffic) {
        const dailyStats = stats.dailyStats || [];
        const labels = dailyStats.map(d => new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
        const incomingData = dailyStats.map(d => d.incoming);
        const outgoingData = dailyStats.map(d => d.outgoing);
        
        if (detailedChartInstances.detailedTraffic) {
            detailedChartInstances.detailedTraffic.data.labels = labels;
            detailedChartInstances.detailedTraffic.data.datasets[0].data = incomingData;
            detailedChartInstances.detailedTraffic.data.datasets[1].data = outgoingData;
            detailedChartInstances.detailedTraffic.options.plugins.legend.labels.color = theme.textColor;
            detailedChartInstances.detailedTraffic.options.plugins.tooltip.backgroundColor = theme.tooltipBg;
            detailedChartInstances.detailedTraffic.options.plugins.tooltip.titleColor = theme.tooltipText;
            detailedChartInstances.detailedTraffic.options.plugins.tooltip.bodyColor = theme.tooltipText;
            detailedChartInstances.detailedTraffic.options.scales.y.grid.color = theme.gridColor;
            detailedChartInstances.detailedTraffic.options.scales.y.ticks.color = theme.textColor;
            detailedChartInstances.detailedTraffic.options.scales.x.grid.color = theme.gridColor;
            detailedChartInstances.detailedTraffic.options.scales.x.ticks.color = theme.textColor;
            detailedChartInstances.detailedTraffic.update();
        } else {
            detailedChartInstances.detailedTraffic = new Chart(ctxTraffic, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: 'Incoming',
                            data: incomingData,
                            borderColor: '#4CAF50',
                            backgroundColor: 'rgba(76, 175, 80, 0.1)',
                            fill: true,
                            tension: 0.4
                        },
                        {
                            label: 'Outgoing',
                            data: outgoingData,
                            borderColor: '#2196F3',
                            backgroundColor: 'rgba(33, 150, 243, 0.1)',
                            fill: true,
                            tension: 0.4
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { 
                            position: 'top',
                            labels: { color: theme.textColor }
                        },
                        tooltip: { 
                            mode: 'index', 
                            intersect: false,
                            backgroundColor: theme.tooltipBg,
                            titleColor: theme.tooltipText,
                            bodyColor: theme.tooltipText
                        }
                    },
                    scales: {
                        y: { 
                            beginAtZero: true,
                            grid: { color: theme.gridColor },
                            ticks: { color: theme.textColor }
                        },
                        x: {
                            grid: { color: theme.gridColor },
                            ticks: { color: theme.textColor }
                        }
                    }
                }
            });
        }
    }
    
    // 2. Account Performance Chart (Bar)
    const ctxAccounts = document.getElementById('accountPerformanceChart');
    if (ctxAccounts) {
        const accountStats = stats.accountStats || [];
        // Sort by total messages desc
        const sortedAccounts = [...accountStats].sort((a, b) => b.total - a.total).slice(0, 10);
        
        const labels = sortedAccounts.map(a => a.name);
        const data = sortedAccounts.map(a => a.total);
        
        if (detailedChartInstances.accountPerformance) {
            detailedChartInstances.accountPerformance.data.labels = labels;
            detailedChartInstances.accountPerformance.data.datasets[0].data = data;
            detailedChartInstances.accountPerformance.options.plugins.tooltip.backgroundColor = theme.tooltipBg;
            detailedChartInstances.accountPerformance.options.plugins.tooltip.titleColor = theme.tooltipText;
            detailedChartInstances.accountPerformance.options.plugins.tooltip.bodyColor = theme.tooltipText;
            detailedChartInstances.accountPerformance.options.scales.y.grid.color = theme.gridColor;
            detailedChartInstances.accountPerformance.options.scales.y.ticks.color = theme.textColor;
            detailedChartInstances.accountPerformance.options.scales.x.ticks.color = theme.textColor;
            detailedChartInstances.accountPerformance.update();
        } else {
            detailedChartInstances.accountPerformance = new Chart(ctxAccounts, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Total Messages',
                        data: data,
                        backgroundColor: 'rgba(33, 150, 243, 0.7)',
                        borderColor: '#2196F3',
                        borderWidth: 1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: theme.tooltipBg,
                            titleColor: theme.tooltipText,
                            bodyColor: theme.tooltipText
                        }
                    },
                    scales: {
                        y: { 
                            beginAtZero: true,
                            grid: { color: theme.gridColor },
                            ticks: { color: theme.textColor }
                        },
                        x: {
                            grid: { display: false },
                            ticks: { color: theme.textColor }
                        }
                    }
                }
            });
        }
    }
    
    // 3. Status Distribution Chart (Doughnut)
    const ctxStatus = document.getElementById('statusDistributionChart');
    if (ctxStatus) {
        const success = stats.successMessages || 0;
        const failed = stats.failedMessages || 0;
        
        if (detailedChartInstances.statusDistribution) {
            detailedChartInstances.statusDistribution.data.datasets[0].data = [success, failed];
            detailedChartInstances.statusDistribution.data.datasets[0].borderColor = theme.borderColor;
            detailedChartInstances.statusDistribution.options.plugins.legend.labels.color = theme.textColor;
            detailedChartInstances.statusDistribution.options.plugins.tooltip.backgroundColor = theme.tooltipBg;
            detailedChartInstances.statusDistribution.options.plugins.tooltip.titleColor = theme.tooltipText;
            detailedChartInstances.statusDistribution.options.plugins.tooltip.bodyColor = theme.tooltipText;
            detailedChartInstances.statusDistribution.update();
        } else {
            detailedChartInstances.statusDistribution = new Chart(ctxStatus, {
                type: 'doughnut',
                data: {
                    labels: ['Success', 'Failed'],
                    datasets: [{
                        data: [success, failed],
                        backgroundColor: ['#66BB6A', '#F44336'],
                        borderColor: theme.borderColor,
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { 
                            position: 'bottom',
                            labels: { color: theme.textColor }
                        },
                        tooltip: {
                            backgroundColor: theme.tooltipBg,
                            titleColor: theme.tooltipText,
                            bodyColor: theme.tooltipText
                        }
                    }
                }
            });
        }
    }
    
    // 4. Top Accounts Table
    const tbody = document.getElementById('topAccountsTableBody');
    if (tbody && stats.accountStats) {
        const sortedAccounts = [...stats.accountStats].sort((a, b) => b.total - a.total);
        
        if (sortedAccounts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center">No data available</td></tr>';
        } else {
            tbody.innerHTML = sortedAccounts.map(acc => {
                const successRate = acc.total > 0 ? Math.round((acc.success / acc.total) * 100) : 0;
                return `
                    <tr>
                        <td>
                            <div style="font-weight: 600;">${acc.name}</div>
                            <div style="font-size: 11px; color: var(--text-secondary);">${acc.id}</div>
                        </td>
                        <td>${acc.total}</td>
                        <td>
                            <div style="display: flex; align-items: center; gap: 5px;">
                                <div style="flex: 1; height: 6px; background: rgba(0,0,0,0.1); border-radius: 3px; overflow: hidden;">
                                    <div style="width: ${successRate}%; height: 100%; background: ${successRate > 90 ? 'var(--success)' : (successRate > 70 ? 'var(--warning)' : 'var(--error)')};"></div>
                                </div>
                                <span style="font-size: 12px;">${successRate}%</span>
                            </div>
                        </td>
                        <td>${acc.incoming}</td>
                        <td>${acc.outgoing}</td>
                    </tr>
                `;
            }).join('');
        }
    }
}

// Theme Icon Update
function updateThemeIcon(theme) {
    const btn = document.getElementById('themeToggle');
    if (btn) {
        const icon = btn.querySelector('i');
        if (theme === 'dark') {
            icon.className = 'fas fa-sun';
        } else {
            icon.className = 'fas fa-moon';
        }
    }
}

// Load System Logs
async function loadSystemLogs() {
    const terminal = document.getElementById('logTerminal');
    if (!terminal) return;

    terminal.innerHTML = '<div style="color: var(--text-secondary);">Loading logs...</div>';

    try {
        const response = await fetch('/api/logs', { credentials: 'include' });
        const data = await response.json();

        if (data.logs && data.logs.length > 0) {
            terminal.innerHTML = data.logs.map(log => {
                const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '';
                const level = log.level || 'INFO';
                const msg = log.message || JSON.stringify(log);
                
                let color = '#f1f5f9'; // Default white
                if (level === 'error') color = '#ef4444';
                if (level === 'warn') color = '#f59e0b';
                if (level === 'info') color = '#3b82f6';

                return `<div style="margin-bottom: 5px; font-family: 'Consolas', monospace; font-size: 12px;">
                    <span style="color: #64748b;">[${time}]</span>
                    <span style="color: ${color}; font-weight: bold;">${level.toUpperCase()}</span>: 
                    <span style="color: var(--text-primary);">${msg}</span>
                </div>`;
            }).join('');
        } else {
            terminal.innerHTML = '<div style="color: var(--text-secondary);">No logs found.</div>';
        }
    } catch (error) {
        console.error('Error loading logs:', error);
        terminal.innerHTML = '<div style="color: var(--error);">Failed to load logs.</div>';
    }
}

// Load System Health
async function loadSystemHealth() {
    try {
        const response = await fetch('/api/health');
        const data = await response.json();

        const uptimeEl = document.getElementById('sysUptime');
        const memoryEl = document.getElementById('sysMemory');
        const dbStatusEl = document.getElementById('sysDbStatus');

        if (uptimeEl) {
            const uptime = data.uptime || 0;
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            uptimeEl.textContent = `${hours}h ${minutes}m`;
        }

        if (memoryEl) {
            if (data.systemMemory && data.memory) {
                // Show App Usage (MB) / System Total (GB)
                const appUsedMB = Math.round(data.memory.rss / 1024 / 1024);
                const totalGB = (data.systemMemory.total / (1024 * 1024 * 1024)).toFixed(1);
                memoryEl.textContent = `${appUsedMB} MB / ${totalGB} GB`;
                
                // Add a small label to clarify
                let label = document.getElementById('memLabel');
                if (!label) {
                    label = document.createElement('div');
                    label.id = 'memLabel';
                    label.style.fontSize = '10px';
                    label.style.opacity = '0.7';
                    label.style.marginTop = '5px';
                    memoryEl.parentNode.appendChild(label);
                }
                label.textContent = 'App Usage / System Total';
            } else if (data.memory) {
                // Fallback to Process Memory (MB)
                const used = Math.round(data.memory.heapUsed / 1024 / 1024);
                const total = Math.round(data.memory.heapTotal / 1024 / 1024);
                memoryEl.textContent = `${used} MB / ${total} MB`;
            }
        }

        if (dbStatusEl) {
            // If we got a response, DB is likely connected (since health check queries DB)
            dbStatusEl.textContent = 'Connected';
            dbStatusEl.style.color = 'var(--success)';
        }

    } catch (error) {
        console.error('Error loading system health:', error);
    }
}

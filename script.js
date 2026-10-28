// Global variables
let currentPage = 'home';
let sosTimer = null;
let sosCountdown = 3;

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
});

function initializeApp() {
    // Set up navigation
    setupNavigation();
    
    // Show home page by default
    showPage('home');
}

// Navigation Functions
function setupNavigation() {
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const page = this.getAttribute('href').substring(1);
            showPage(page);
            updateActiveNavLink(this);
        });
    });
}

function showPage(pageId) {
    // Hide all pages
    const pages = document.querySelectorAll('.page');
    pages.forEach(page => {
        page.classList.remove('active');
    });
    
    // Show selected page
    const targetPage = document.getElementById(pageId);
    if (targetPage) {
        targetPage.classList.add('active');
        currentPage = pageId;
    }
    
    // Update navigation
    updateActiveNavLink();
    
    // Close mobile menu if open
    closeMobileMenu();
}

function updateActiveNavLink(activeLink = null) {
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        link.classList.remove('active');
    });
    
    if (activeLink) {
        activeLink.classList.add('active');
    } else {
        // Find and activate the current page's nav link
        const currentNavLink = document.querySelector(`a[href="#${currentPage}"]`);
        if (currentNavLink) {
            currentNavLink.classList.add('active');
        }
    }
}

function toggleMobileMenu() {
    const navMenu = document.querySelector('.nav-menu');
    const toggleIcon = document.querySelector('.mobile-menu-toggle i');
    
    navMenu.classList.toggle('active');
    
    if (navMenu.classList.contains('active')) {
        toggleIcon.className = 'fas fa-times';
    } else {
        toggleIcon.className = 'fas fa-bars';
    }
}

function closeMobileMenu() {
    const navMenu = document.querySelector('.nav-menu');
    const toggleIcon = document.querySelector('.mobile-menu-toggle i');
    
    navMenu.classList.remove('active');
    toggleIcon.className = 'fas fa-bars';
}

// Location is optional and entered manually until a real geocoder is available.
function focusLocationEntry(inputId) {
    const locationInput = document.getElementById(inputId);
    if (locationInput) locationInput.focus();
}

// Form Submission Functions
async function submitSymptoms(event) {
    event.preventDefault();
    
    const form = event.target;
    const formData = new FormData(form);
    const symptoms = formData.getAll('symptoms');
    const description = String(formData.get('description') || '').trim();
    const severity = formData.get('severity');
    const location = document.getElementById('location').value.trim();
    
    if (symptoms.length === 0) {
        showErrorMessage('Please select at least one symptom.');
        return;
    }

    if (description.length > 2000) {
        showErrorMessage('The description must be 2000 characters or fewer.');
        return;
    }

    const report = {
        reportType: 'symptom',
        symptoms,
        severity
    };
    if (description) report.description = description;
    if (location) report.location = { region: location };

    await submitReport(form, report, 'Submitting your report...', 'Your symptom report was saved.');
}

async function submitDisaster(event) {
    event.preventDefault();
    
    const form = event.target;
    const formData = new FormData(form);
    const disasterType = formData.get('disaster-type');
    const severity = formData.get('severity');
    const description = String(formData.get('description') || '').trim();
    const location = document.getElementById('disaster-location').value.trim();
    
    if (!disasterType || !severity) {
        showErrorMessage('Please select a disaster type and severity.');
        return;
    }

    const reportDescription = [disasterType, description].filter(Boolean).join(': ');
    if (reportDescription.length > 2000) {
        showErrorMessage('The description and disaster type must total 2000 characters or fewer.');
        return;
    }

    const report = {
        reportType: 'disaster',
        description: reportDescription,
        severity
    };
    if (location) report.location = { region: location };

    const photoSelected = Boolean(document.getElementById('photo').files.length);
    const successMessage = photoSelected
        ? 'Your disaster report was saved. The selected photo was only previewed and was not uploaded.'
        : 'Your disaster report was saved.';

    await submitReport(form, report, 'Submitting your report...', successMessage, function() {
        const photoPreview = document.getElementById('photo-preview');
        if (photoPreview) {
            photoPreview.innerHTML = '';
            photoPreview.classList.add('hidden');
        }
    });
}

async function submitReport(form, report, loadingMessage, successMessage, onSuccess) {
    const submitButton = form.querySelector('button[type="submit"]');
    if (!submitButton || submitButton.disabled) return;

    submitButton.disabled = true;
    showLoadingMessage(loadingMessage);

    try {
        let response;
        try {
            response = await fetch('/api/reports', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(report)
            });
        } catch (error) {
            showErrorMessage('Could not reach the report service. Check your connection and try again.');
            return;
        }

        if (response.status !== 201) {
            const result = await response.json().catch(function() { return {}; });
            let message = 'The report could not be saved. Please try again.';
            if (response.status === 400) {
                message = result.error || 'Please review the report details and try again.';
            } else if (response.status === 503) {
                message = 'The report service is temporarily unavailable. Your entries have been kept; please try again.';
            }
            showErrorMessage(message);
            return;
        }

        form.reset();
        if (onSuccess) onSuccess();
        showSuccessMessage(successMessage);
    } finally {
        hideLoadingMessage();
        submitButton.disabled = false;
    }
}

// Photo Upload Function
function handlePhotoUpload(event) {
    const file = event.target.files[0];
    const photoPreview = document.getElementById('photo-preview');
    
    if (file && photoPreview) {
        const reader = new FileReader();
        reader.onload = function(e) {
            photoPreview.innerHTML = `<img src="${e.target.result}" alt="Disaster photo">`;
            photoPreview.classList.remove('hidden');
        };
        reader.readAsDataURL(file);
    }
}

// SOS Functions
function startSOS() {
    const sosButton = document.getElementById('sos-button');
    const countdown = document.getElementById('countdown');
    const countdownNumber = countdown.querySelector('.countdown-number');
    
    sosCountdown = 3;
    countdown.classList.remove('hidden');
    
    sosTimer = setInterval(() => {
        countdownNumber.textContent = sosCountdown;
        sosCountdown--;
        
        if (sosCountdown < 0) {
            clearInterval(sosTimer);
            triggerEmergency();
        }
    }, 1000);
}

function cancelSOS() {
    if (sosTimer) {
        clearInterval(sosTimer);
        sosTimer = null;
    }
    
    const countdown = document.getElementById('countdown');
    countdown.classList.add('hidden');
    sosCountdown = 3;
}

function triggerEmergency() {
    const countdown = document.getElementById('countdown');
    countdown.classList.add('hidden');
    
    // Simulate emergency alert
    showLoadingMessage('Sending emergency alert...');
    
    setTimeout(() => {
        hideLoadingMessage();
        showSuccessMessage('Emergency alert sent! Your location has been shared with emergency services. Help is on the way!');
    }, 2000);
}

// Map Functions
// function filterMap() {
//     const filterValue = document.getElementById('map-filter').value;
//     const markers = document.querySelectorAll('.map-marker');
    
//     markers.forEach(marker => {
//         if (filterValue === 'all') {
//             marker.style.display = 'flex';
//         } else {
//             if (marker.classList.contains(filterValue)) {
//                 marker.style.display = 'flex';
//             } else {
//                 marker.style.display = 'none';
//             }
//         }
//     });
// }


  // Initialize the map
        var map = L.map('map').setView([19.0760, 72.8777], 7); // Maharashtra focus


    // Add OSM base tiles
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19
}).addTo(map);





    // Example heatmap points
    var heatData = [
        [19.0760, 72.8777, 1], // Mumbai
        [18.4575, 73.8500, 1], // Katraj, Pune
        [19.9975, 73.7898, 1], // Nashik
        [19.8762, 75.3433, 1]  // Aurangabad
    ];

    // Add heatmap
    L.heatLayer(heatData, {
      radius: 40,   // increase point radius
      blur: 25,     // smoothness
      maxZoom: 10
    }).addTo(map);


// Utility Functions
function showLoadingMessage(message) {
    // Create and show loading overlay
    const overlay = document.createElement('div');
    overlay.id = 'loading-overlay';
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.8);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999;
        color: white;
        font-size: 1.2rem;
        font-weight: 600;
    `;
    overlay.innerHTML = `
        <div style="text-align: center;">
            <div style="width: 40px; height: 40px; border: 4px solid #A8E6CF; border-top: 4px solid transparent; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 1rem;"></div>
            ${message}
        </div>
    `;
    
    // Add spinner animation
    const style = document.createElement('style');
    style.textContent = `
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    `;
    document.head.appendChild(style);
    
    document.body.appendChild(overlay);
}

function hideLoadingMessage() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.remove();
    }
}

function showSuccessMessage(message) {
    // Create and show success message
    const successDiv = document.createElement('div');
    successDiv.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: #2ECC71;
        color: white;
        padding: 1rem 2rem;
        border-radius: 0.5rem;
        box-shadow: 0 4px 20px rgba(46, 204, 113, 0.3);
        z-index: 10000;
        font-weight: 600;
        text-align: center;
        max-width: 90%;
        animation: slideDown 0.3s ease-out;
    `;
    successDiv.innerHTML = `
        <i class="fas fa-check-circle" style="margin-right: 0.5rem;"></i>
        ${message}
    `;
    
    // Add slide animation
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideDown {
            from {
                opacity: 0;
                transform: translateX(-50%) translateY(-20px);
            }
            to {
                opacity: 1;
                transform: translateX(-50%) translateY(0);
            }
        }
    `;
    document.head.appendChild(style);
    
    document.body.appendChild(successDiv);
    
    // Remove after 5 seconds
    setTimeout(() => {
        successDiv.style.animation = 'slideDown 0.3s ease-out reverse';
        setTimeout(() => {
            if (successDiv.parentNode) {
                successDiv.remove();
            }
        }, 300);
    }, 5000);
}

function showErrorMessage(message) {
    const errorDiv = document.createElement('div');
    errorDiv.setAttribute('role', 'alert');
    errorDiv.textContent = message;
    errorDiv.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: #C0392B;
        color: white;
        padding: 1rem 2rem;
        border-radius: 0.5rem;
        box-shadow: 0 4px 20px rgba(192, 57, 43, 0.3);
        z-index: 10000;
        font-weight: 600;
        text-align: center;
        max-width: 90%;
    `;
    document.body.appendChild(errorDiv);

    setTimeout(() => {
        if (errorDiv.parentNode) errorDiv.remove();
    }, 6000);
}

// Add event listeners for touch events (mobile support)
document.addEventListener('touchstart', function() {}, {passive: true});
document.addEventListener('touchend', function() {}, {passive: true});

// Prevent default behavior for SOS button on mobile
document.addEventListener('DOMContentLoaded', function() {
    const sosButton = document.getElementById('sos-button');
    if (sosButton) {
        sosButton.addEventListener('touchstart', function(e) {
            e.preventDefault();
            startSOS();
        });
        
        sosButton.addEventListener('touchend', function(e) {
            e.preventDefault();
            cancelSOS();
        });
        
        // Prevent context menu on long press
        sosButton.addEventListener('contextmenu', function(e) {
            e.preventDefault();
        });
    }
});

function initMap() {
    const map = L.map('map').setView([20.5937, 78.9629], 5);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    L.marker([28.6139, 77.2090])
        .addTo(map)
        .bindPopup('Example: New Delhi')
        .openPopup();
}

document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('map')) {
        initMap();
    }
});

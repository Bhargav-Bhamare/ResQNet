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
     // NULL SIGNAL: connect the evaluation form and history button.
    const nullSignalForm = document.getElementById('null-signal-form');
    const nullSignalRefreshButton = document.getElementById('ns-refresh-history');
    const nullSignalNavLink = document.querySelector('.nav-link[href="#null-signal"]');

    if (nullSignalForm) {
        nullSignalForm.addEventListener('submit', submitNullSignalEvaluation);
    }

    if (nullSignalRefreshButton) {
        nullSignalRefreshButton.addEventListener('click', loadNullSignalHistory);
    }

    if (nullSignalNavLink) {
        nullSignalNavLink.addEventListener('click', loadNullSignalHistory);
    }
    // Initialize location detection
    detectLocation();
    detectDisasterLocation();
    
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

// Location Functions
function detectLocation() {
    const locationInput = document.getElementById('location');
    if (!locationInput) return;
    
    locationInput.value = 'Detecting location...';
    
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            function(position) {
                // Simulate reverse geocoding with dummy data
                const locations = [
                    'Katraj,Pune,Maharashtra',
                    'Dadar,Mumbai,Maharashtra',
                    'Navi Mumbai,Maharashtra',
                    'Kothrud,Pune,Maharashtra',
                    'Hinjewadi,Pune,Maharashtra'
                ];
                
                const randomLocation = locations[Math.floor(Math.random() * locations.length)];
                locationInput.value = randomLocation;
            },
            function(error) {
                locationInput.value = 'Location detection failed. Please enter manually.';
                locationInput.removeAttribute('readonly');
            }
        );
    } else {
        locationInput.value = 'Geolocation not supported. Please enter manually.';
        locationInput.removeAttribute('readonly');
    }
}

function detectDisasterLocation() {
    const locationInput = document.getElementById('disaster-location');
    if (!locationInput) return;
    
    locationInput.value = 'Detecting location...';
    
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            function(position) {
                // Simulate reverse geocoding with dummy data
                const locations = [
                    'Himachal Pradesh',
                    'Kokan East',
                    'Andhra Pradesh',
                    'Jammu West',
                    'Kali Ghati'
                ];
                
                const randomLocation = locations[Math.floor(Math.random() * locations.length)];
                locationInput.value = randomLocation;
            },
            function(error) {
                locationInput.value = 'Location detection failed. Please enter manually.';
                locationInput.removeAttribute('readonly');
            }
        );
    } else {
        locationInput.value = 'Geolocation not supported. Please enter manually.';
        locationInput.removeAttribute('readonly');
    }
}

// Form Submission Functions

async function submitSymptoms(event) {
    event.preventDefault();

    const form = event.target;
    const formData = new FormData(form);
    const symptoms = formData.getAll('symptoms');
    const severity = formData.get('severity');
    const location = document.getElementById('location').value.trim();
    const description = formData.get('description') || '';

    if (symptoms.length === 0) {
        alert('Please select at least one symptom.');
        return;
    }

    if (!location || location.toLowerCase().includes('detecting')) {
        alert('Please confirm your location before submitting.');
        return;
    }

    showLoadingMessage('Submitting your report...');

    try {
        const response = await fetch('/api/reports', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                reportType: 'symptom',
                symptoms,
                severity,
                description,
                location
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Could not submit report.');
        }

        hideLoadingMessage();
        showSuccessMessage('Your symptom report has been saved successfully.');
        form.reset();
        detectLocation();
    } catch (error) {
        hideLoadingMessage();
        alert('Report submission failed: ' + error.message);
    }
}


async function submitDisaster(event) {
    event.preventDefault();

    const form = event.target;
    const formData = new FormData(form);

    const disasterType = formData.get('disaster-type');
    const severity = formData.get('severity');
    const description = (formData.get('description') || '').trim();
    const location = document.getElementById('disaster-location').value.trim();

    if (!disasterType || !severity) {
        alert('Please fill in all required fields.');
        return;
    }

    if (!location || location.toLowerCase().includes('detecting')) {
        alert('Please confirm your location before submitting.');
        return;
    }

    showLoadingMessage('Submitting disaster report...');

    try {
        const response = await fetch('/api/reports', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                reportType: 'disaster',
                disasterType,
                severity,
                description,
                location,
                source: 'resqnet-web'
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Could not submit disaster report.');
        }

        hideLoadingMessage();
        showSuccessMessage(
            'Disaster report saved successfully. This prototype has not automatically notified emergency services.'
        );

        form.reset();
        detectDisasterLocation();

        const photoPreview = document.getElementById('photo-preview');
        if (photoPreview) {
            photoPreview.innerHTML = '';
            photoPreview.classList.add('hidden');
        }

    } catch (error) {
        hideLoadingMessage();
        alert('Disaster report submission failed: ' + error.message);
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







async function submitNullSignalEvaluation(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const message = document.getElementById('ns-form-message');
    const resultContainer = document.getElementById('ns-latest-result');
    const formData = new FormData(form);

    const payload = {
        area: String(formData.get('area') || '').trim(),
        expectedReports: Number(formData.get('expectedReports')),
        windowHours: Number(formData.get('windowHours')),
        channelStatus: String(formData.get('channelStatus') || 'unknown')
    };

    if (
        !payload.area ||
        !Number.isInteger(payload.expectedReports) ||
        payload.expectedReports < 0 ||
        !Number.isFinite(payload.windowHours) ||
        payload.windowHours <= 0 ||
        payload.windowHours > 720
    ) {
        message.textContent = 'Please enter valid evaluation details.';
        return;
    }

    message.textContent = 'Evaluating evidence...';

    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton) submitButton.disabled = true;

    try {
        const response = await fetch('/api/evidence/evaluate-from-reports', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Evaluation failed.');
        }

        message.textContent = data.message || 'Evaluation saved successfully.';
        renderNullSignalInvestigation(resultContainer, data.investigation);

        await loadNullSignalHistory();
    } catch (error) {
        message.textContent = 'Evaluation failed: ' + error.message;
    } finally {
        if (submitButton) submitButton.disabled = false;
    }
}


function renderNullSignalInvestigation(container, investigation) {
    if (!container) return;

    container.replaceChildren();

    if (!investigation) {
        container.textContent = 'No investigation data was returned.';
        return;
    }

    const heading = document.createElement('h3');
    heading.textContent = investigation.area || 'Investigation';
    container.appendChild(heading);

    const details = [
        ['Status', investigation.status],
        ['Severity', investigation.severity],
        ['Expected reports', investigation.expectedReports],
        ['Received reports', investigation.receivedReports],
        ['Missing reports', investigation.missingReports],
        ['Reporting channel', investigation.channelStatus]
    ];

    const list = document.createElement('dl');

    details.forEach(([label, value]) => {
        const term = document.createElement('dt');
        term.textContent = label;

        const description = document.createElement('dd');
        description.textContent =
            value === undefined || value === null ? 'Not provided' : String(value);

        list.append(term, description);
    });

    container.appendChild(list);

    appendNullSignalTextList(
        container,
        'Findings',
        investigation.findings
    );

    appendNullSignalTextList(
        container,
        'Recommended actions',
        investigation.recommendedActions
    );
}

function appendNullSignalTextList(container, headingText, items) {
    const heading = document.createElement('h4');
    heading.textContent = headingText;
    container.appendChild(heading);

    if (!Array.isArray(items) || items.length === 0) {
        const emptyMessage = document.createElement('p');
        emptyMessage.textContent = 'No items recorded.';
        container.appendChild(emptyMessage);
        return;
    }

    const list = document.createElement('ul');

    items.forEach(item => {
        const entry = document.createElement('li');

        entry.textContent = typeof item === 'string'
            ? item
            : JSON.stringify(item);

        list.appendChild(entry);
    });

    container.appendChild(list);
}


async function loadNullSignalHistory() {
    const container = document.getElementById('ns-investigation-history');
    const message = document.getElementById('ns-history-message');

    if (!container) return;

    container.textContent = 'Loading investigation history...';

    if (message) message.textContent = '';

    try {
        const response = await fetch('/api/evidence/investigations');
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Could not load investigation history.');
        }

        const investigations = Array.isArray(data.investigations)
            ? data.investigations
            : [];

        container.replaceChildren();

        if (investigations.length === 0) {
            container.textContent = 'No investigations have been saved yet.';
        }

        investigations.forEach(investigation => {
            const card = document.createElement('article');

            const heading = document.createElement('h3');
            heading.textContent = investigation.area || 'Unknown area';
            card.appendChild(heading);

            const summary = document.createElement('p');
            summary.textContent =
                'Status: ' + (investigation.status || 'Unknown') +
                ' | Severity: ' + (investigation.severity || 'Unknown');
            card.appendChild(summary);

            const counts = document.createElement('p');
            counts.textContent =
                'Expected: ' + displayNullSignalValue(investigation.expectedReports) +
                ' | Received: ' + displayNullSignalValue(investigation.receivedReports) +
                ' | Missing: ' + displayNullSignalValue(investigation.missingReports);
            card.appendChild(counts);

            const date = document.createElement('p');
            date.textContent = 'Created: ' + formatNullSignalDate(investigation.createdAt);
            card.appendChild(date);

            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = 'View details';

            button.addEventListener('click', () => {
                renderNullSignalInvestigation(
                    document.getElementById('ns-latest-result'),
                    investigation
                );
            });

            card.appendChild(button);
            container.appendChild(card);
        });

        if (message) {
            message.textContent = 'Loaded ' + investigations.length + ' investigation(s).';
        }
    } catch (error) {
        container.textContent = 'Could not load investigation history.';
        if (message) message.textContent = error.message;
    }
}

function displayNullSignalValue(value) {
    return value === undefined || value === null ? 'N/A' : String(value);
}

function formatNullSignalDate(value) {
    if (!value) return 'Not available';

    const date = new Date(value);

    return Number.isNaN(date.getTime())
        ? 'Not available'
        : date.toLocaleString();
}

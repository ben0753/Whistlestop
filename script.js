/**
 * Whistle Stop v1.1.2 — Pressure Cooker Whistle Counter
 * Teachable Machine Audio Classification Engine
 */

// ===== CONFIG & STATE =====
const MODEL_URL = "./model/"; // Default to local for speed/offline
const MODEL_URL_FALLBACK = "https://teachablemachine.withgoogle.com/models/0VMcHzFHY/";
const WHISTLE_CLASS = "Pressure cooker whistle";
const NOISE_CLASS = "Background Noise";
const DETECTION_COOLDOWN = 5000;
const PROBABILITY_THRESHOLD = 0.88; 
const CONSECUTIVE_FRAMES_REQUIRED = 2;
let classifier = null;
let isModelLoaded = false;
let count = 0;
let targetWhistles = 3;
let isListening = false;
let lastDetectionTime = 0;
let consecutiveFrames = 0;
let whistleVisualActive = false;
activeMode = 'local';

// Alert state
let dangerVignette = null;
let emberInterval = null;
let alarmCtx = null;
let alarmOsc = null;
let alarmGain = null;
let alarmSweep = null;

// ===== DOM ELEMENTS =====
const $ = id => document.getElementById(id);
const counterValue = $('counter-value');
const statusBadge = $('status-badge');
const statusText = $('status-text');
const startBtn = $('start-btn');
const resetBtn = $('reset-btn');
const targetInput = $('target-input');
const targetBar = $('target-bar');
const targetMinusBtn = $('target-minus');
const targetPlusBtn = $('target-plus');
const alertSound = $('alert-sound');
const progressCircle = $('progress-ring-circle');
const terminalBody = $('terminal-body');
const counterRing = $('counter-ring');

// Prob meters
const whistleFill = $('prob-whistle-fill');
const whistlePct = $('prob-whistle-pct');
const noiseFill = $('prob-noise-fill');
const noisePct = $('prob-noise-pct');

const CIRCUMFERENCE = 2 * Math.PI * 95;

// ===== INIT =====
function init() {
    const saved = localStorage.getItem('whistlestop_target');
    if (saved) {
        targetWhistles = parseInt(saved) || 3;
        targetInput.value = targetWhistles;
    }

    updateTargetProgress();
    initVisualizer();
    resetVisualizerBars(); // Set idle state without starting RAF loop
    
    // Mobile Policy Handling: Show unlock overlay on mobile devices
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (isMobile) {
        const unlockOverlay = $('mobile-unlock');
        const unlockBtn = $('unlock-btn');
        unlockOverlay.style.display = 'flex';
        
        unlockBtn.addEventListener('click', async () => {
            log("Unlocking audio engine...");
            // One-touch unlocking of AudioContext and HTML5 Audio
            const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
            await tempCtx.resume();
            
            alertSound.volume = 0;
            await alertSound.play().catch(() => {});
            alertSound.pause();
            
            unlockOverlay.style.animation = 'fadeOut 0.3s ease forwards';
            setTimeout(() => unlockOverlay.remove(), 300);
            log("Engine unlocked.");
        });
    }

    // Preload model to fix mobile gesture timeout issues
    preloadModel();

    // Danger vignette
    dangerVignette = document.createElement('div');
    dangerVignette.className = 'danger-vignette';
    document.body.appendChild(dangerVignette);

    // Notification permission
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }

    log("System initialized.");
    log("Audio engine ready.");

    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js')
                .then(reg => log("App offline-ready."))
                .catch(err => console.warn("SW register failed", err));
        });
    }
}

function log(msg) {
    const line = document.createElement('div');
    line.className = 'log-line';
    line.textContent = msg;
    terminalBody.appendChild(line);
    terminalBody.scrollTop = terminalBody.scrollHeight;
}

// ===== AUDIO MODEL =====
async function preloadModel() {
    const tmLib = window.speechCommands || window.tmAudio;
    if (!tmLib) return;

    try {
        statusText.textContent = "Loading Model...";
        log("Loading TM model...");
        
        // Try local first, then fallback
        let loadUrl = MODEL_URL;
        
        const tryWithTimeout = (url, timeoutMs = 8000) => {
            return Promise.race([
                tmLib.create("BROWSER_FFT", undefined, url + "model.json", url + "metadata.json"),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), timeoutMs))
            ]);
        };

        try {
            log("Core: Checking local engine...");
            classifier = await tryWithTimeout(MODEL_URL);
            await classifier.ensureModelLoaded();
            log("Core: Local engine active.");
        } catch (e) {
            log("Core: Using cloud engine...");
            classifier = await tryWithTimeout(MODEL_URL_FALLBACK, 15000);
            await classifier.ensureModelLoaded();
            log("Core: Cloud engine active.");
        }

        isModelLoaded = true;
        
        if (!isListening) {
            statusText.textContent = "Ready";
        }
        log("Model loaded successfully.");
    } catch (err) {
        console.error("Model error:", err);
        statusText.textContent = "Load Failed";
        log("Model load failed: " + err.message);
    }
}

async function startListening() {
    const tmLib = window.speechCommands || window.tmAudio;
    if (!tmLib) {
        statusText.textContent = "Library Missing";
        return;
    }

    if (!isModelLoaded || !classifier) {
        statusText.textContent = "Refreshing Engine...";
        await preloadModel();
        if (!isModelLoaded) return;
    }

    if (isListening) return;

    // Wake Lock
    if ('wakeLock' in navigator) {
        try { window.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
    }

    isListening = true;
    statusBadge.classList.add('listening');
    startBtn.innerHTML = '<i data-lucide="square" class="btn-icon"></i> Stop Counting';
    if (typeof lucide !== 'undefined') lucide.createIcons();
    document.body.classList.add('theme-active');
    counterRing.classList.add('active');
    startVisualizerLoop(); 

    try {
        if (classifier.audioContext) {
            log(`Audio: ${classifier.audioContext.state} @ ${classifier.audioContext.sampleRate}Hz`);
            await classifier.audioContext.resume();
        }

        await classifier.listen(result => {
            const scores = result.scores;
            const labels = classifier.wordLabels();
            const wIdx = labels.indexOf(WHISTLE_CLASS);
            const nIdx = labels.indexOf(NOISE_CLASS);

            const wScore = wIdx !== -1 ? scores[wIdx] : 0;
            const nScore = nIdx !== -1 ? scores[nIdx] : 0;
            
            // Update UI Meters (very frequently)
            whistleFill.style.width = (wScore * 100) + "%";
            whistlePct.textContent = Math.round(wScore * 100) + "%";
            noiseFill.style.width = (nScore * 100) + "%";
            noisePct.textContent = Math.round(nScore * 100) + "%";

            if (wScore > PROBABILITY_THRESHOLD) {
                consecutiveFrames++;
                if (consecutiveFrames >= CONSECUTIVE_FRAMES_REQUIRED) {
                    const now = Date.now();
                    if (now - lastDetectionTime > DETECTION_COOLDOWN) {
                        lastDetectionTime = now;
                        log(`Whistle! (${(wScore * 100).toFixed(0)}%)`);
                        onWhistle();
                    }
                    consecutiveFrames = 0;
                }
            } else {
                consecutiveFrames = 0;
            }
        }, {
            includeSpectrogram: false,
            probabilityThreshold: 0.50, // High-frequency updates for smooth UI
            overlapFactor: 0.5,
            invokeCallbackOnNoiseAndUnknown: true 
        });

        statusText.textContent = "Listening...";
        log("Engine active.");
    } catch (err) {
        statusText.textContent = "Mic Error";
        log("Error: " + err.message);
        stopListening();
    }
}

// ===== WHISTLE HANDLER =====
function onWhistle() {
    count++;
    counterValue.textContent = count;
    updateTargetProgress();
    updateDangerLevel();

    // Pop animation
    counterValue.classList.add('pulse');
    setTimeout(() => counterValue.classList.remove('pulse'), 600);

    // Steam effect
    spawnSteam();

    // Visualizer spike
    whistleVisualActive = true;
    setTimeout(() => { whistleVisualActive = false; }, 1000);

    // Target check
    if (count >= targetWhistles) {
        log("⚠ TARGET REACHED. ALERT TRIGGERED.");
        triggerAlert();
    } else {
        const remaining = targetWhistles - count;
        if (remaining === 1) {
            counterValue.classList.add('high-pressure');
            counterRing.classList.add('warning');
            log("! 1 whistle remaining!");
            if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
        } else if (remaining <= 2) {
            log(`${remaining} whistles remaining.`);
            if (navigator.vibrate) navigator.vibrate(100);
        }
        statusText.textContent = "Whistle Detected!";
        setTimeout(() => { if (isListening) statusText.textContent = "Listening..."; }, 2000);
    }
}

// ===== ALERT SYSTEM =====
function triggerAlert() {
    showOverlay();
    statusText.textContent = "TURN OFF THE STOVE!";

    if (dangerVignette) dangerVignette.className = 'danger-vignette level-3';

    // Audio file alarm
    alertSound.loop = true;
    alertSound.volume = 1.0;
    alertSound.play().catch(e => console.warn("Audio play blocked:", e));

    // Web Audio siren
    startSiren();

    // Vibration
    if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500, 200, 500]);

    // Browser notification
    if ('Notification' in window && Notification.permission === 'granted') {
        try {
            const n = new Notification('🔥 Whistle Stop Alert!', {
                body: `${count}/${targetWhistles} whistles done. Turn off the stove NOW!`,
                tag: 'whistlestop-alert',
                requireInteraction: true
            });
            n.onclick = () => { window.focus(); n.close(); };
        } catch (e) {}
    }

    // Card shake
    document.querySelector('.card').animate([
        { transform: 'translateX(0)', boxShadow: '0 0 20px var(--accent-glow)' },
        { transform: 'translateX(-12px)', boxShadow: '0 0 50px #f43f5e' },
        { transform: 'translateX(12px)', boxShadow: '0 0 50px #f43f5e' },
        { transform: 'translateX(-12px)', boxShadow: '0 0 50px #f43f5e' },
        { transform: 'translateX(0)', boxShadow: '0 0 20px var(--accent-glow)' }
    ], { duration: 350, iterations: 3 });
}

function startSiren() {
    try {
        alarmCtx = new (window.AudioContext || window.webkitAudioContext)();
        alarmOsc = alarmCtx.createOscillator();
        alarmGain = alarmCtx.createGain();

        alarmOsc.type = 'sine'; // Smooth, calm tone instead of harsh square wave
        alarmOsc.frequency.value = 600; // Lower, softer pitch
        alarmGain.gain.value = 0.3; // Much lower volume

        alarmOsc.connect(alarmGain);
        alarmGain.connect(alarmCtx.destination);
        alarmOsc.start();

        // Create a gentle pulsing effect (beep ... beep ...)
        let isOn = true;
        alarmSweep = setInterval(() => {
            if (alarmGain && alarmCtx) {
                // Set target gradually for a smooth pulse instead of hard cuts
                alarmGain.gain.setTargetAtTime(isOn ? 0.0 : 0.3, alarmCtx.currentTime, 0.1);
                isOn = !isOn;
            }
        }, 500);

        log("Calm alarm pulsing.");
    } catch (e) {
        console.error("Siren error:", e);
    }
}

function stopSiren() {
    try { alarmOsc?.stop(); } catch (e) {}
    alarmOsc = null;
    alarmGain = null;
    try { alarmCtx?.close(); } catch (e) {}
    alarmCtx = null;
    if (alarmSweep) { clearInterval(alarmSweep); alarmSweep = null; }
}

function showOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'success-overlay';
    overlay.id = 'success-overlay';
    overlay.innerHTML = `
        <div class="success-content">
            <i data-lucide="flame" class="alert-icon" style="color:#fff"></i>
            <h2>🔥 DONE!</h2>
            <p class="alert-subtitle">All ${targetWhistles} whistles detected</p>
            <p class="alert-message">TURN OFF THE STOVE!</p>
            <p class="whistle-count-display">${count} / ${targetWhistles} WHISTLES</p>
            <button class="btn btn-reset-full" onclick="dismissAlert()">
                <i data-lucide="x-circle" style="width:20px;height:20px"></i> Dismiss & Reset
            </button>
        </div>
    `;
    document.body.appendChild(overlay);
    if (typeof lucide !== 'undefined') lucide.createIcons();

    // Embers
    spawnEmbers(overlay);
    emberInterval = setInterval(() => spawnEmbers(overlay), 700);
}

function spawnEmbers(container) {
    for (let i = 0; i < 10; i++) {
        const e = document.createElement('div');
        e.className = 'ember';
        const s = 3 + Math.random() * 7;
        e.style.cssText = `width:${s}px;height:${s}px;left:${Math.random()*100}%;bottom:-10px;animation-duration:${2+Math.random()*3}s;animation-delay:${Math.random()*0.6}s`;
        container.appendChild(e);
        setTimeout(() => e.remove(), 5000);
    }
}

window.dismissAlert = function() {
    const overlay = $('success-overlay');
    if (overlay) {
        overlay.style.animation = 'fadeOut 0.3s ease forwards';
        setTimeout(() => overlay.remove(), 300);
    }
    if (emberInterval) { clearInterval(emberInterval); emberInterval = null; }
    if (dangerVignette) dangerVignette.className = 'danger-vignette';
    counterRing.classList.remove('warning');
    if (navigator.vibrate) navigator.vibrate(0);
    stopSiren();
    resetBtn.click();
    stopListening();
};

// ===== DANGER LEVEL =====
function updateDangerLevel() {
    if (!dangerVignette || targetWhistles <= 1) return;
    const p = count / targetWhistles;
    if (p >= 1) {
        dangerVignette.className = 'danger-vignette level-3';
    } else if (p >= 0.8) {
        dangerVignette.className = 'danger-vignette level-2';
        counterRing.classList.add('warning');
    } else if (p >= 0.5) {
        dangerVignette.className = 'danger-vignette level-1';
    } else {
        dangerVignette.className = 'danger-vignette';
        counterRing.classList.remove('warning');
    }
}

// ===== PROGRESS =====
function updateTargetProgress() {
    const pct = Math.min((count / targetWhistles) * 100, 100);
    targetBar.style.width = pct + "%";
    progressCircle.style.strokeDashoffset = CIRCUMFERENCE - (pct / 100 * CIRCUMFERENCE);

    if (pct >= 100) {
        targetBar.style.background = "var(--success-color)";
        progressCircle.style.stroke = "var(--success-color)";
        progressCircle.setAttribute('stroke-width', '10');
        progressCircle.classList.add('pulse');
    } else {
        targetBar.style.background = "var(--primary-gradient)";
        progressCircle.style.stroke = "";
        progressCircle.setAttribute('stroke-width', '6');
        progressCircle.classList.remove('pulse');
    }
}

// ===== STOP / RESET =====
function stopListening() {
    if (classifier) {
        try { classifier.stopListening(); } catch (e) {}
    }

    alertSound.pause();
    alertSound.currentTime = 0;
    alertSound.loop = false;
    stopSiren();

    isListening = false;
    whistleVisualActive = false;
    consecutiveFrames = 0;

    // Release Wake Lock
    if (window.wakeLock) {
        window.wakeLock.release().then(() => {
            window.wakeLock = null;
            log("Screen lock released.");
        });
    }

    // Stop the RAF loop and reset bars
    if (vizRafId) { cancelAnimationFrame(vizRafId); vizRafId = null; }
    resetVisualizerBars();

    if (dangerVignette) dangerVignette.className = 'danger-vignette';
    counterRing.classList.remove('warning', 'active');
    if (navigator.vibrate) navigator.vibrate(0);

    document.body.classList.remove('theme-active');
    log("Session ended.");
    statusText.textContent = "Ready";
    statusBadge.classList.remove('listening');
    startBtn.innerHTML = '<i data-lucide="play" class="btn-icon"></i> Start Counting';
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ===== EFFECTS =====
function spawnSteam() {
    const card = document.querySelector('.card');
    for (let i = 0; i < 8; i++) { // Reduced from 12
        const p = document.createElement('div');
        p.className = 'steam-particle';
        const size = 8 + Math.random() * 12; // Smaller size
        p.style.cssText = `width:${size}px;height:${size}px;left:${40+Math.random()*20}%;top:30%`;
        card.appendChild(p);

        const angle = (Math.random() - 0.5) * 40;
        const dist = 30 + Math.random() * 60;
        p.animate([
            { transform: 'translate(0,0) scale(1)', opacity: 0.7 },
            { transform: `translate(${angle}px,-${dist}px) scale(1.6)`, opacity: 0 }
        ], { duration: 600 + Math.random() * 600, easing: 'ease-out' }).onfinish = () => p.remove();
    }
}

// ===== VISUALIZER =====
const visualizer = $('visualizer');
const BAR_COUNT = 28;
let visualizerBars = [];
let vizRafId = null;
let vizLastFrame = 0;
const VIZ_THROTTLE_IDLE = 200;  // ms between frames when idle
const VIZ_THROTTLE_ACTIVE = 60; // ms between frames when listening (~16fps)

function initVisualizer() {
    for (let i = 0; i < BAR_COUNT; i++) {
        const bar = document.createElement('div');
        bar.className = 'bar';
        visualizer.appendChild(bar);
        visualizerBars.push(bar);
    }
}

function resetVisualizerBars() {
    for (let i = 0; i < visualizerBars.length; i++) {
        visualizerBars[i].style.transform = 'scaleY(0.15)';
        visualizerBars[i].classList.remove('active');
    }
}

function updateVisualizerLoop(ts) {
    if (!isListening && !whistleVisualActive) {
        resetVisualizerBars();
        vizRafId = null; // Stop loop — will restart when listening begins
        return;
    }

    const throttle = whistleVisualActive ? VIZ_THROTTLE_ACTIVE : VIZ_THROTTLE_ACTIVE;
    if (ts - vizLastFrame < throttle) {
        vizRafId = requestAnimationFrame(updateVisualizerLoop);
        return;
    }
    vizLastFrame = ts;

    const t = Date.now() / 200;
    for (let i = 0; i < visualizerBars.length; i++) {
        const base = whistleVisualActive ? 0.7 : 0.25;
        const mult = whistleVisualActive ? 0.3 : 0.4;
        const scale = base + Math.sin(t + i * 0.5) * mult + Math.random() * 0.1;
        visualizerBars[i].style.transform = `scaleY(${Math.max(0.1, scale)})`;
        visualizerBars[i].classList.toggle('active', scale > 0.6);
    }
    vizRafId = requestAnimationFrame(updateVisualizerLoop);
}

function startVisualizerLoop() {
    if (!vizRafId) {
        vizRafId = requestAnimationFrame(updateVisualizerLoop);
    }
}

// ===== EVENT LISTENERS =====
targetMinusBtn.addEventListener('click', () => {
    let v = parseInt(targetInput.value) || 1;
    if (v > 1) { targetInput.value = --v; targetInput.dispatchEvent(new Event('change')); }
});

targetPlusBtn.addEventListener('click', () => {
    let v = parseInt(targetInput.value) || 1;
    targetInput.value = ++v;
    targetInput.dispatchEvent(new Event('change'));
});

startBtn.addEventListener('click', async () => {
    targetWhistles = parseInt(targetInput.value) || 1;
    localStorage.setItem('whistlestop_target', targetWhistles);

    if (!isListening) {
        startBtn.disabled = true;
        startBtn.innerHTML = '<i data-lucide="loader" class="btn-icon"></i> Starting...';
        if (typeof lucide !== 'undefined') lucide.createIcons();

        // 1. Unlock HTML5 Audio (same-turn gesture)
        try {
            alertSound.volume = 0.01;
            await alertSound.play();
            alertSound.pause();
            alertSound.currentTime = 0;
            alertSound.volume = 1.0;
        } catch (e) {
            console.warn("Audio unlock failed", e);
        }

        // 2. Unlock Web Audio Context if already initialized
        if (classifier && classifier.audioContext) {
            try {
                await classifier.audioContext.resume();
                log("AudioContext resumed by gesture.");
            } catch (e) {
                console.warn("Context resume failed", e);
            }
        }

        // 3. Start engine
        await startListening();

        if (isListening) {
            startBtn.disabled = false;
        } else {
            // Revert button on failure
            startBtn.disabled = false;
            startBtn.innerHTML = '<i data-lucide="play" class="btn-icon"></i> Start Counting';
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }
    } else {
        stopListening();
    }
});

resetBtn.addEventListener('click', () => {
    alertSound.pause();
    alertSound.currentTime = 0;
    alertSound.loop = false;
    stopSiren();

    count = 0;
    lastDetectionTime = 0;
    counterValue.textContent = "0";
    counterValue.classList.remove('high-pressure');
    progressCircle.setAttribute('stroke-width', '6');
    progressCircle.classList.remove('pulse');
    updateTargetProgress();

    if (dangerVignette) dangerVignette.className = 'danger-vignette';
    counterRing.classList.remove('warning');
    if (emberInterval) { clearInterval(emberInterval); emberInterval = null; }
    if (navigator.vibrate) navigator.vibrate(0);
});

targetInput.addEventListener('change', e => {
    targetWhistles = parseInt(e.target.value) || 1;
    localStorage.setItem('whistlestop_target', targetWhistles);
    updateTargetProgress();
});

targetInput.addEventListener('input', e => {
    targetWhistles = parseInt(e.target.value) || 1;
    updateTargetProgress();
});

// Boot
init();

// ===== RESPONSIVE LAYOUT MANAGER =====
function handleResponsiveLayout() {
    const isDesktop = window.innerWidth >= 1024;
    const terminal = $('terminal-body')?.parentElement;
    const footer = document.querySelector('.footer');
    const card = $('main-card');
    const container = document.querySelector('.container');

    if (isDesktop) {
        // Move to body for fixed positioning on desktop
        if (terminal && terminal.parentElement === card) {
            document.body.appendChild(terminal);
            terminal.classList.add('desktop-hover', 'terminal-hover');
        }
        if (footer && footer.parentElement === container) {
            document.body.appendChild(footer);
            footer.classList.add('desktop-hover', 'footer-hover');
        }
    } else {
        // Return to original layout for mobile
        if (terminal && terminal.parentElement === document.body) {
            card.appendChild(terminal);
            terminal.classList.remove('desktop-hover', 'terminal-hover');
        }
        if (footer && footer.parentElement === document.body) {
            container.appendChild(footer);
            footer.classList.remove('desktop-hover', 'footer-hover');
        }
    }
}

window.addEventListener('resize', handleResponsiveLayout);
handleResponsiveLayout(); // Initial check

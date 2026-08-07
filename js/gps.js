// ==========================================
// CycloWind - gps.js (CORRIGÉ & SYNCHRONISÉ)
// ==========================================

// État partagé avec route.js
window.currentStepIndex = Number.isInteger(window.currentStepIndex) ? window.currentStepIndex : 0;
window.lastSpokenStepIndex = Number.isInteger(window.lastSpokenStepIndex) ? window.lastSpokenStepIndex : -1;

let lastHeading = 0;
let hasInitialCentering = false;
let wakeLock = null;
let hasAnnouncedArrival = false;

// Anti-spam GPS (ms min entre 2 calculs)
let lastUpdateTime = 0;

// État hors itinéraire
let lastOffRouteSpokenTime = 0;
let wasOffRoute = false;

// TTS queue (to serialize speech and return Promises)
let ttsQueue = [];
let ttsRunning = false;

// Compteurs anti faux-positifs hors trajet
let offRouteHighCount = 0;
let offRouteLowCount = 0;

// Indique si on a déjà averti pour la sortie courante (reset au retour)
let offRouteHasWarned = false;

// Cooldown de réessai du recalcul automatique (indépendant de l'avertissement vocal)
let lastRerouteAttemptTime = 0;

// ==============================
// ETAT INTERNE DU GUIDAGE VOCAL
// ==============================
function resetVoiceNavigationState() {
    checkVoiceNavigation.trackedStepIndex = -1;
    checkVoiceNavigation.hasAnnounced = false;
    checkVoiceNavigation.minDistance = Infinity;
    checkVoiceNavigation.hasReachedTurnZone = false;
    checkVoiceNavigation.lastDistance = Infinity;
}

resetVoiceNavigationState();

// Réinitialise TOUT le state de session (hors-trajet + arrivée), à appeler
// depuis startNavigation() à chaque (re)démarrage d'une navigation, en plus
// de resetVoiceNavigationState(). Sans ça, wasOffRoute/hasAnnouncedArrival
// peuvent rester bloqués d'une session à l'autre.
function resetOffRouteAndArrivalState() {
    wasOffRoute = false;
    offRouteHasWarned = false;
    offRouteHighCount = 0;
    offRouteLowCount = 0;
    lastOffRouteSpokenTime = 0;
    lastRerouteAttemptTime = 0;
    hasAnnouncedArrival = false;
    hasWarnedGpsStale = false;
}
window.resetOffRouteAndArrivalState = resetOffRouteAndArrivalState;

// ==============================
// GPS SETTINGS (appliquées depuis l'UI)
// ==============================
const gpsDefaults = {
    leadTimeMultiplier: 12,              // secondes d'avance (mètres = speedMs * leadTimeMultiplier)
    offRouteEnterMultiplier: 2.5,        // multiplicateur gpsAccuracy pour seuil sortie
    offRouteExitMultiplier: 1.2,         // multiplicateur gpsAccuracy pour seuil retour
    offRouteConsecutive: 2,              // relevés consécutifs pour déclarer sortie
    offRouteCooldownMs: 30000,           // cooldown alerte hors-trajet (ms)
    updateIntervalMs: 200,               // intervalle minimum entre calculs (ms)
    rerouteRetryCooldownMs: 15000        // intervalle minimum entre 2 tentatives de recalcul auto (ms)
};

let gpsRuntime = Object.assign({}, gpsDefaults);

function applyGpsSettingsFromWindow() {
    try {
        const s = window.gpsSettings || {};
        gpsRuntime.leadTimeMultiplier = Number(s.leadTimeMultiplier) || gpsDefaults.leadTimeMultiplier;
        gpsRuntime.offRouteEnterMultiplier = Number(s.offRouteEnterMultiplier) || gpsDefaults.offRouteEnterMultiplier;
        gpsRuntime.offRouteExitMultiplier = Number(s.offRouteExitMultiplier) || gpsDefaults.offRouteExitMultiplier;
        gpsRuntime.offRouteConsecutive = Math.max(1, parseInt(s.offRouteConsecutive) || gpsDefaults.offRouteConsecutive);
        gpsRuntime.offRouteCooldownMs = Math.max(1000, Number(s.offRouteCooldownMs) || gpsDefaults.offRouteCooldownMs);
        gpsRuntime.updateIntervalMs = Math.max(50, parseInt(s.updateIntervalMs) || gpsDefaults.updateIntervalMs);
        gpsRuntime.rerouteRetryCooldownMs = Math.max(3000, Number(s.rerouteRetryCooldownMs) || gpsDefaults.rerouteRetryCooldownMs);
    } catch (e) {
        gpsRuntime = Object.assign({}, gpsDefaults);
    }
}

// liaison UI -> runtime : appelé par l'UI quand l'utilisateur sauvegarde
window.onGpsSettingsChanged = (settings) => { applyGpsSettingsFromWindow(); };
applyGpsSettingsFromWindow();

// ==============================
// WAKE LOCK
// ==============================
async function requestWakeLock() {
    if ("wakeLock" in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request("screen");
        } catch (err) {
            console.warn("Wake Lock indisponible ou refusé :", err);
        }
    }
}

function releaseWakeLock() {
    if (wakeLock !== null) {
        wakeLock.release();
        wakeLock = null;
    }
}

document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && window.isNavigating) {
        await requestWakeLock();
    }
});

function shouldUpdate() {
    const now = Date.now();
    if (now - lastUpdateTime < (gpsRuntime.updateIntervalMs || 200)) return false;
    lastUpdateTime = now;
    return true;
}

// ==============================
// VOIX HORS-LIGNE (LOCAL SERVICE)
// ==============================
function getBestFrenchVoice() {
    if (!("speechSynthesis" in window)) return null;
    const voices = speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;

    return voices.find(v => v.lang.startsWith("nl") && v.localService === true) ||
           voices.find(v => v.lang.startsWith("nl")) ||
           null;
}

/**
 * Traduction des instructions
 */
function translateInstruction(text) {
    if (!text) return "";
    return text
        .replace(/turn left/gi, "sla linksaf")
        .replace(/turn right/gi, "sla rechtsaf")
        .replace(/sharp right/gi, "scherpe bocht naar rechts")
        .replace(/sharp left/gi, "scherpe bocht naar links")
        .replace(/make a slight left/gi, "draai iets naar links")
        .replace(/make a slight right/gi, "draai iets naar rechts")
        .replace(/keep left/gi, "houd links aan")
        .replace(/keep right/gi, "houd rechts aan")
        .replace(/head/gi, "neem de richting")
        .replace(/onto/gi, "op")
        .replace(/continue/gi, "ga verder");
}

// TTS queue processor: ensures sequential playback and returns a Promise
function processTtsQueue() {
    if (ttsRunning) return;
    if (ttsQueue.length === 0) return;

    ttsRunning = true;

    const item = ttsQueue.shift();

    // Garde-fou anti-blocage : si le moteur de synthèse vocale ne répond
    // plus (écran verrouillé, page en arrière-plan...), onend/onerror
    // peuvent ne jamais se déclencher. Sans ce filet, ttsRunning resterait
    // bloqué à true pour toujours et plus AUCUNE annonce suivante ne
    // pourrait jamais être lue pour le reste de la navigation.
    let settled = false;
    const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdogId);
        item.resolve();
        ttsRunning = false;
        setTimeout(processTtsQueue, 0);
    };
    const watchdogId = setTimeout(() => {
        console.warn("[TTS] Timeout de synthèse vocale (probablement écran verrouillé/app en arrière-plan) : file débloquée.");
        finish();
    }, 15000);

    try {
        let translated = translateInstruction(item.text);
        let cleanedText = translated
            .replace(/\bRte\b/gi, "Route")
            .replace(/\bAv\.\b|\bAv\b/gi, "Avenue")
            .replace(/\bBd\.\b|\bBd\b/gi, "Boulevard")
            .replace(/\bD(\d+)/gi, "Départementale $1")
            .replace(/['"’`_]/g, " ")
            .replace(/[^a-zA-Z0-9àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ\s,.!?]/g, "")
            .replace(/\s+/g, " ")
            .trim();

        if (!cleanedText) {
            finish();
            return;
        }

        const utterance = new SpeechSynthesisUtterance(cleanedText);
        const voice = getBestFrenchVoice();
        if (voice) utterance.voice = voice;
       // utterance.lang = "fr-FR";
        utterance.rate = 1;

        utterance.onend = finish;
        utterance.onerror = finish;

        speechSynthesis.speak(utterance);
    } catch (e) {
        finish();
    }
}

function speakInstruction(text) {
    if (!("speechSynthesis" in window) || !text) return Promise.resolve();

    return new Promise(resolve => {
        ttsQueue.push({ text, resolve });
        setTimeout(processTtsQueue, 0);
    });
}

// Allow other modules to clear the TTS queue and cancel current speech
window.clearTtsQueue = function() {
    ttsQueue = [];
    if (window.speechSynthesis) {
        try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    }
};

// ==============================
// GÉOMÉTRIE
// ==============================
function getDistanceInMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;

    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function calculateHeading(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
    const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
              Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);

    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// Lissage de la rotation de la flèche sans saut à 360°
function smoothRotation(target) {
    const diff = ((target - lastHeading + 540) % 360) - 180;
    lastHeading = (lastHeading + diff * 0.25 + 360) % 360;
    return lastHeading;
}

// ==============================
// SNAP TO ROUTE
// ==============================
function snapToRoute(lat, lon, route, maxDist = 15) {
    if (!route || route.length < 2) {
        return {
            point: [lat, lon],
            routeAngle: null,
            distance: Infinity,
            isSnapped: false,
            segmentIndex: -1,
            t: 0
        };
    }

    let closest = [lat, lon];
    let minDist = Infinity;
    let bestSegmentAngle = null;
    let bestSegmentIndex = -1;
    let bestT = 0;

    const latThreshold = maxDist / 111000;
    const lonThreshold = latThreshold / Math.cos(lat * Math.PI / 180);

    for (let i = 0; i < route.length - 1; i++) {
        const p1 = route[i];
        const p2 = route[i + 1];

        const minLat = Math.min(p1[0], p2[0]) - latThreshold;
        const maxLat = Math.max(p1[0], p2[0]) + latThreshold;
        const minLon = Math.min(p1[1], p2[1]) - lonThreshold;
        const maxLon = Math.max(p1[1], p2[1]) + lonThreshold;

        if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) {
            continue;
        }

        const dx = p2[0] - p1[0];
        const dy = p2[1] - p1[1];

        const t = Math.max(0, Math.min(1,
            ((lat - p1[0]) * dx + (lon - p1[1]) * dy) / (dx * dx + dy * dy || 1)
        ));

        const proj = [p1[0] + t * dx, p1[1] + t * dy];
        const dist = getDistanceInMeters(lat, lon, proj[0], proj[1]);

        if (dist < minDist) {
            minDist = dist;
            closest = proj;
            bestSegmentAngle = calculateHeading(p1[0], p1[1], p2[0], p2[1]);
            bestSegmentIndex = i;
            bestT = t;
        }
    }

    return {
        point: closest,
        routeAngle: bestSegmentAngle,
        distance: minDist,
        isSnapped: minDist <= maxDist,
        segmentIndex: bestSegmentIndex,
        t: bestT
    };
}

function findNextStepIndexFromProgress(progress, steps) {
    if (!steps || steps.length === 0) return 0;

    const lookBehindTolerance = 0.25;

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step || !step.way_points || typeof step.way_points[0] !== "number") continue;

        const stepProgress = step.way_points[0];
        if (stepProgress >= progress - lookBehindTolerance) {
            return i;
        }
    }

    return steps.length - 1;
}

// ==============================
// FLÈCHE SANS CSS TRANSITION LENTE
// ==============================
function createFluidArrowIcon() {
    const svgHtml = `
        <div id="user-arrow-container" style="width: 32px; height: 32px; transform-origin: center;">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32">
                <circle cx="12" cy="12" r="10" fill="#2980b9" opacity="0.25"/>
                <path d="M12 2 L18 20 L12 16 L6 20 Z" fill="#27ae60" stroke="#ffffff" stroke-width="2"/>
            </svg>
        </div>
    `;
    return L.divIcon({
        html: svgHtml,
        className: "fluid-arrow-icon",
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });
}

function updateArrowRotation(angle) {
    const el = document.getElementById("user-arrow-container");
    if (el) el.style.transform = `rotate(${angle}deg)`;
}

// ==============================
// DÉTECTION ÉLOIGNEMENT PARCOURS
// ==============================
function checkOffRoute(lat, lon, gpsAccuracy = 10) {
    if (!window.isNavigating || !window.routeSteps || window.routeSteps.length === 0) return;

    const activeGeometry = (window.routeSteps === window.altSteps &&
        window.latlngsAlternativePersist &&
        window.latlngsAlternativePersist.length > 1)
        ? window.latlngsAlternativePersist
        : window.latlngsNormalPersist;

    if (!activeGeometry || activeGeometry.length < 2) return;

    const snap = snapToRoute(lat, lon, activeGeometry, 5000);
    if (!snap) return;

    const distFromTrack = snap.distance;
    const now = Date.now();

    const offRouteEnterThreshold = Math.max(15, Math.min(200, gpsAccuracy * (gpsRuntime.offRouteEnterMultiplier || 2.5)));
    const offRouteExitThreshold = Math.max(8, Math.min(120, gpsAccuracy * (gpsRuntime.offRouteExitMultiplier || 1.2)));
    const offRouteCooldown = Math.max(1000, gpsRuntime.offRouteCooldownMs || 30000);
    const requiredHighCount = Math.max(1, gpsRuntime.offRouteConsecutive || 2);
    const rerouteRetryCooldown = Math.max(3000, gpsRuntime.rerouteRetryCooldownMs || 15000);

    if (distFromTrack >= offRouteEnterThreshold) {
        offRouteHighCount++;
        offRouteLowCount = 0;
    } else if (distFromTrack <= offRouteExitThreshold) {
        offRouteLowCount++;
        offRouteHighCount = 0;
    } else {
        offRouteHighCount = 0;
        offRouteLowCount = 0;
    }

    if (!wasOffRoute && offRouteHighCount >= requiredHighCount) {
        wasOffRoute = true;
        offRouteHighCount = 0;

        if (!offRouteHasWarned && (now - lastOffRouteSpokenTime > offRouteCooldown)) {
            speakInstruction("U wijkt af van de route. Vergeet niet om te keren of weer op de route terug te keren.");
            lastOffRouteSpokenTime = now;
            offRouteHasWarned = true;
        }
    }

    if (wasOffRoute && offRouteLowCount >= 2 && snap.segmentIndex >= 0) {
        wasOffRoute = false;
        offRouteLowCount = 0;
        offRouteHighCount = 0;
        offRouteHasWarned = false;
        lastOffRouteSpokenTime = 0;
        lastRerouteAttemptTime = 0;

        const routeProgress = snap.segmentIndex + snap.t;
        const nextStepIndex = findNextStepIndexFromProgress(routeProgress, window.routeSteps);

        window.currentStepIndex = nextStepIndex;
        window.lastSpokenStepIndex = nextStepIndex - 1;
        resetVoiceNavigationState();

        console.log(`[GPS] Retour sur l'itinéraire. Recalage à l'étape ${window.currentStepIndex}`);

        // Hook optionnel : informe route.js qu'un retour naturel sur le
        // trajet actif vient d'avoir lieu, pour qu'il puisse annuler un
        // recalcul automatique encore en vol (voir onRouteDeviationConfirmed).
        // Ne fait rien si le hook n'est pas implémenté.
        if (typeof window.onRouteRecoveryConfirmed === "function") {
            try {
                window.onRouteRecoveryConfirmed({ lat, lon });
            } catch (e) {
                console.warn("[GPS] onRouteRecoveryConfirmed a échoué :", e);
            }
        }
        return;
    }

    // Tentative de recalcul périodique tant qu'on reste hors trajet.
    // Volontairement indépendant de offRouteHasWarned (qui ne gère que
    // l'avertissement vocal) : si un précédent recalcul a échoué (coupure
    // réseau...), on réessaie automatiquement toutes les rerouteRetryCooldown
    // ms, sans exiger un retour complet sur l'ancien trajet.
    if (wasOffRoute && (now - lastRerouteAttemptTime > rerouteRetryCooldown)) {
        lastRerouteAttemptTime = now;
        if (typeof window.onRouteDeviationConfirmed === "function") {
            try {
                window.onRouteDeviationConfirmed({ lat, lon, gpsAccuracy });
            } catch (e) {
                console.warn("[GPS] onRouteDeviationConfirmed a échoué :", e);
            }
        }
    }
}

// ==============================
// GUIDAGE VOCAL
// ==============================
function checkVoiceNavigation(lat, lon, gpsAccuracy = 10) {
    // Ne rien faire tant qu'on est officiellement hors trajet : le state
    // (currentStepIndex/lastSpokenStepIndex) est piloté par checkOffRoute
    // pendant cette phase, et ne redevient fiable qu'au moment du recalage.
    if (wasOffRoute) return;

    if (!window.routeSteps || window.currentStepIndex >= window.routeSteps.length) return;

    const activeGeometry = (window.routeSteps === window.altSteps &&
        window.latlngsAlternativePersist &&
        window.latlngsAlternativePersist.length > 1)
        ? window.latlngsAlternativePersist
        : window.latlngsNormalPersist;

    if (activeGeometry && activeGeometry.length > 1) {
        const syncSnap = snapToRoute(lat, lon, activeGeometry, Math.max(25, gpsAccuracy * 3));
        if (syncSnap.segmentIndex >= 0) {
            const routeProgress = syncSnap.segmentIndex + syncSnap.t;
            const expectedStepIndex = findNextStepIndexFromProgress(routeProgress, window.routeSteps);

            if (expectedStepIndex > window.currentStepIndex) {
                window.currentStepIndex = expectedStepIndex;
                if (window.lastSpokenStepIndex >= window.currentStepIndex) {
                    window.lastSpokenStepIndex = window.currentStepIndex - 1;
                }
                resetVoiceNavigationState();
            }
        }
    }

    if (window.currentStepIndex >= window.routeSteps.length) return;

    const step = window.routeSteps[window.currentStepIndex];
    if (!step || !step.location) return;

    if (checkVoiceNavigation.trackedStepIndex !== window.currentStepIndex) {
        checkVoiceNavigation.trackedStepIndex = window.currentStepIndex;
        checkVoiceNavigation.hasAnnounced = false;
        checkVoiceNavigation.minDistance = Infinity;
        checkVoiceNavigation.hasReachedTurnZone = false;
        checkVoiceNavigation.lastDistance = Infinity;
    }

    const dist = getDistanceInMeters(lat, lon, step.location[1], step.location[0]);
    checkVoiceNavigation.minDistance = Math.min(checkVoiceNavigation.minDistance, dist);

    const speedKmhRaw = (typeof window.currentSpeedKmh === "number" && isFinite(window.currentSpeedKmh))
        ? window.currentSpeedKmh
        : 0;

    const speedKmh = speedKmhRaw > 2 ? speedKmhRaw : 12;
    const speedMs = speedKmh / 3.6;

    let triggerRadius = speedMs * (gpsRuntime.leadTimeMultiplier || 12);
    triggerRadius = Math.max(25, Math.min(120, triggerRadius));

    if (window.currentStepIndex > 0) {
        const prevStep = window.routeSteps[window.currentStepIndex - 1];
        if (prevStep && prevStep.location) {
            const segmentLength = getDistanceInMeters(
                prevStep.location[1], prevStep.location[0],
                step.location[1], step.location[0]
            );

            const shortSegmentCap = Math.max(12, segmentLength * 0.45);
            triggerRadius = Math.min(triggerRadius, shortSegmentCap);
        }
    }

    const accuracyBuffer = Math.min(10, Math.max(0, gpsAccuracy) * 0.5);
    triggerRadius = Math.min(120, triggerRadius + accuracyBuffer);

    if (!checkVoiceNavigation.hasAnnounced &&
        dist <= triggerRadius &&
        window.currentStepIndex !== window.lastSpokenStepIndex) {

        let msg = "";

        if (step.instruction) {
            msg = step.instruction;

            if (step.windInfo) {
                if (step.windInfo.type === "tegenwind") {
                    msg += `. Tegenwind uit à ${step.windInfo.speed} kilometer per uur.`;
                } else if (step.windInfo.type === "rug") {
                    msg += ". Rugwind.";
                } else if (step.windInfo.type === "cote") {
                    msg += ". Let op, zijwind.";
                }
            }
        } else if (step.isWindOnly && step.windInfo && step.windInfo.type === "face") {
            // Pseudo-étape insérée par route.js : pas de changement de
            // direction ici, uniquement un signalement de vent de face
            // détecté en cours de route (virage progressif, ligne droite...).
            msg = `Let op, tegenwind uit ${step.windInfo.speed} kilometer per uur.`;
        }

        if (msg) {
            speakInstruction(msg);
        }

        checkVoiceNavigation.hasAnnounced = true;
        window.lastSpokenStepIndex = window.currentStepIndex;
    }

    const turnPassRadius = Math.max(10, Math.min(25, gpsAccuracy + 5));

    if (dist <= turnPassRadius) {
        checkVoiceNavigation.hasReachedTurnZone = true;
    }

    const movingAwayAfterTurn =
        checkVoiceNavigation.hasReachedTurnZone &&
        dist > Math.max(turnPassRadius, checkVoiceNavigation.minDistance + 12);

    if (movingAwayAfterTurn) {
        window.currentStepIndex++;
        resetVoiceNavigationState();
    }

    checkVoiceNavigation.lastDistance = dist;
}

// =====================================
// AVERTISSEMENT DESTINATION ATTEINTE
// =====================================
function checkArrivalSimple(lat, lon, gpsAccuracy = 10) {
    if (!window.isNavigating) {
        hasAnnouncedArrival = false;
        return;
    }

    if (hasAnnouncedArrival || !window.destination) return;

    const destLat = window.destination.lat;
    const destLon = window.destination.lon;

    if (typeof destLat !== "number" || typeof destLon !== "number") return;

    const distToDestination = getDistanceInMeters(lat, lon, destLat, destLon);
    const arrivalRadius = Math.max(15, Math.min(30, gpsAccuracy + 8));

    if (distToDestination <= arrivalRadius) {
        hasAnnouncedArrival = true;
        speakInstruction("Bestemming bereikt.");
    }
}

// ==============================
// GESTION GPS PRINCIPALE
// ==============================
function onLocationUpdate(rawLat, rawLon, headingGps = null, speed = null, gpsAccuracy = 10) {
    if (!shouldUpdate()) return;

    if (speed !== null && speed >= 0) {
        window.currentSpeedKmh = speed * 3.6;
    } else {
        window.currentSpeedKmh = 0;
    }

    const prevLat = window.userPosition ? window.userPosition[0] : rawLat;
    const prevLon = window.userPosition ? window.userPosition[1] : rawLon;
    const movedDistance = getDistanceInMeters(prevLat, prevLon, rawLat, rawLon);

    window.userPosition = [rawLat, rawLon];

    const activeRoute = (window.routeSteps === window.altSteps)
        ? window.latlngsAlternativePersist
        : window.latlngsNormalPersist;

    let displayLat = rawLat;
    let displayLon = rawLon;
    let routeAngle = null;

    if (activeRoute && activeRoute.length > 0) {
        const dynamiqueSeuil = Math.max(12, Math.min(30, gpsAccuracy + 3));
        const snap = snapToRoute(rawLat, rawLon, activeRoute, dynamiqueSeuil);
        if (snap.isSnapped) {
            displayLat = snap.point[0];
            displayLon = snap.point[1];
            routeAngle = snap.routeAngle;
        }
    }

    let targetHeading = lastHeading;
    if (movedDistance > 1.2) {
        if (headingGps !== null && !isNaN(headingGps) && headingGps !== 0) {
            targetHeading = headingGps;
        } else if (routeAngle !== null) {
            targetHeading = routeAngle;
        } else {
            targetHeading = calculateHeading(prevLat, prevLon, displayLat, displayLon);
        }
    }

    const smoothedCap = smoothRotation(targetHeading);

    if (!window.userMarker && window.map) {
        window.userMarker = L.marker([displayLat, displayLon], { icon: createFluidArrowIcon() }).addTo(window.map);
    } else if (window.userMarker) {
        window.userMarker.setLatLng([displayLat, displayLon]);
    }

    updateArrowRotation(smoothedCap);

    if (!hasInitialCentering && window.map) {
        window.map.setView([displayLat, displayLon], 16);
        hasInitialCentering = true;
    }

    if (window.isNavigating && window.map && movedDistance > 0.8) {
        window.map.panTo([displayLat, displayLon], { animate: false });

        checkArrivalSimple(rawLat, rawLon, gpsAccuracy);

        // IMPORTANT : checkOffRoute doit tourner AVANT checkVoiceNavigation.
        // C'est checkOffRoute qui détecte la sortie/le retour sur trajet et qui
        // recale currentStepIndex / lastSpokenStepIndex en conséquence. Si
        // checkVoiceNavigation tournait en premier, il traiterait un state
        // encore périmé (ancienne étape, potentiellement très loin) au moment
        // précis du recalage, retardant la reprise du guidage d'un cycle GPS.
        checkOffRoute(rawLat, rawLon, gpsAccuracy);
        checkVoiceNavigation(displayLat, displayLon, gpsAccuracy);
    }
}

// ==============================
// INITIALISATION GPS
// ==============================
let lastGpsFixTime = 0;
let hasWarnedGpsStale = false;

function initGeolocation() {
    if (!navigator.geolocation) return;

    navigator.geolocation.watchPosition(
        pos => {
            lastGpsFixTime = Date.now();
            hasWarnedGpsStale = false;
            onLocationUpdate(
                pos.coords.latitude,
                pos.coords.longitude,
                pos.coords.heading,
                pos.coords.speed,
                pos.coords.accuracy
            );
        },
        err => {
            console.warn("[GPS] Erreur de géolocalisation :", err);
            if (window.isNavigating && err.code === err.PERMISSION_DENIED) {
                speakInstruction("Attention, la géolocalisation a été refusée. La navigation ne peut plus continuer.");
            }
        },
        {
            enableHighAccuracy: true,
            maximumAge: 1000,
            timeout: 10000
        }
    );

    // Surveillance périodique : avertit à la voix si aucun point GPS n'a été
    // reçu depuis trop longtemps pendant la navigation (signal perdu, onglet
    // suspendu par l'OS, etc.). Sans ça, une perte de signal est totalement
    // silencieuse pour un cycliste qui ne regarde pas l'écran en continu.
    setInterval(() => {
        if (!window.isNavigating) return;
        if (lastGpsFixTime === 0) return; // aucun premier point encore reçu
        const staleFor = Date.now() - lastGpsFixTime;
        if (staleFor > 25000 && !hasWarnedGpsStale) {
            hasWarnedGpsStale = true;
            speakInstruction("Signal GPS perdu depuis un moment. Vérifiez votre position.");
        }
    }, 10000);
}

document.addEventListener("DOMContentLoaded", initGeolocation);

// Exports
window.requestWakeLock = requestWakeLock;
window.releaseWakeLock = releaseWakeLock;
window.onLocationUpdate = onLocationUpdate;
window.resetVoiceNavigationState = resetVoiceNavigationState;
window.speakInstruction = speakInstruction;
window.getDistanceInMeters = getDistanceInMeters; // réutilisé par route.js pour la détection vent en cours d'étape


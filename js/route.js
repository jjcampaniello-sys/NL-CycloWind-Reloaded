

// ==========================================
// CycloWind - route.js (COMPLET & AUTONOME)
// ==========================================

// Direction segment route
function getSegmentDirection(p1, p2) {
    if (!p1 || !p2) return 0;
    
    // Inversion dy/dx corrigée pour l'orientation boussole par rapport au Nord
    const dy = p2[0] - p1[0];
    const dx = p2[1] - p1[1];
    
    let angle = Math.atan2(dx, dy) * (180 / Math.PI);

    if (angle < 0) {
        angle += 360;
    }

    return angle;
}

async function getAlternativeRoute(start, endLat, endLon, silent = false) {
    const url = "/api/route";

    const body = {
        coordinates: [
            [parseFloat(start.lng), parseFloat(start.lat)],
            [parseFloat(endLon), parseFloat(endLat)]
        ],
        extra_info: ["waytype"], 
        alternative_routes: {
            target_count: 2,    
            share_factor: 0.8,  
            weight_factor: 2.5  
        }
    };

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errDetails = await response.text();
            if (silent) {
                console.warn(`[Route] Erreur API (${response.status}) :`, errDetails);
            } else {
                alert(`❌ Erreur API (${response.status}) :\n${errDetails}`);
            }
            return { features: [] };
        }

        const data = await response.json();
        return data;

    } catch (error) {
        if (silent) {
            console.warn("[Route] Erreur réseau / Fetch :", error.message);
        } else {
            alert("❌ Erreur réseau / Fetch :\n" + error.message);
        }
        return { features: [] };
    }
}

function extractSegments(feature) {
    const forestSegments = new Set();
    const residentialSegments = new Set();

    if (!feature.properties || !feature.properties.extra_info) {
        return { forestSegments, residentialSegments };
    }

    const extras = feature.properties.extra_info;
 
    if (extras.waytype && extras.waytype.values) {
        extras.waytype.values.forEach(v => {
            const from = v[0];
            const to = v[1];
            const type = v[2];

            // 🌳 Chemins nature / forêt / pistes cyclables
            if (type === 4 || type === 5 || type === 6 || type === 7) {
                for (let i = from; i <= to; i++) {
                    forestSegments.add(i);
                }
            }

            // 🏠 Zones résidentielles
            if (type === 3) {
                for (let i = from; i <= to; i++) {
                    residentialSegments.add(i);
                }
            }
        });
    }

    const debugDiv = document.getElementById("debug");
    if (debugDiv) {
        debugDiv.innerHTML = `
            🌲 Segments forêt/piste: ${forestSegments.size}<br>
            🏠 Segments résidentiel: ${residentialSegments.size}
        `;
    }

    return { forestSegments, residentialSegments };
}

function calculateWindScore(latlngs, feature) {
    const { forestSegments, residentialSegments } = extractSegments(feature);

    let totalCost = 0;
    let count = 0;

    // Lecture cohérente : window.currentWindDirection / window.currentWindSpeed sont
    // désormais TOUJOURS les propriétés définies explicitement par wind.js (getWind()).
    // Avant, ce fichier lisait la variable globale SANS préfixe "window." pendant que
    // route.js (voix) la lisait AVEC "window.". Les deux finissaient par pointer sur des
    // choses différentes selon le mode strict/module, ce qui masquait le bug ailleurs.
    const windDir = typeof window.currentWindDirection === "number" ? window.currentWindDirection : 0;
    const windSpd = typeof window.currentWindSpeed === "number" ? window.currentWindSpeed : 0;

    for (let i = 0; i < latlngs.length - 1; i++) {
        const direction = getSegmentDirection(
            latlngs[i],
            latlngs[i+1]
        );

        let cost = windCost(direction, windDir, windSpd);

        // 🌳 BONUS ABRI
        if (forestSegments.has(i)) {
            cost = cost * 0.5;
        } else if (residentialSegments.has(i)) {
            cost = cost * 0.7;
        }

        totalCost += cost;
        count++;
    }

    return count > 0 ? totalCost / count : 0;
}

function chooseBestRoute(normalRoute, alternativeRoute, normalScore, alternativeScore) {
    const normalTime = normalRoute.duration;
    const alternativeTime = alternativeRoute.duration;
    const windGain = normalScore - alternativeScore;

    if (windGain > 3 && alternativeTime < normalTime * 1.2) {
        return "alternative";
    }

    return "normal";
}

function calculateWindGain(scoreNormal, scoreAlternative) {
    if (scoreNormal <= 0) return 0;
    const gain = ((scoreNormal - scoreAlternative) / scoreNormal) * 100;
    return Math.max(0, gain);
}

function drawWindRoute(latlngs) {
    const windDir = typeof window.currentWindDirection === "number" ? window.currentWindDirection : 0;
    const windSpd = typeof window.currentWindSpeed === "number" ? window.currentWindSpeed : 0;

    for (let i = 0; i < latlngs.length - 1; i++) {
        const direction = getSegmentDirection(latlngs[i], latlngs[i+1]);
        const cost = windCost(direction, windDir, windSpd);

        let color = "green";
        if (cost > 20) color = "red";
        else if (cost > 8) color = "orange";

        const line = L.polyline(
            [latlngs[i], latlngs[i+1]],
            {
                color: color,
                weight: 4,
                opacity: 0.8,
                pane: 'overlayPane'
            }
        ).addTo(window.routeGroup);

        if (typeof routeLayers !== 'undefined') {
            routeLayers.push(line);
        }
    }
}

function drawGrayRoute(latlngs) {
    const line = L.polyline(
        latlngs,
        {
            color: "gray",
            weight: 3,
            opacity: 0.5,
            pane: 'overlayPane'
        }
    ).addTo(window.routeGroup);

    if (typeof routeLayers !== 'undefined') {
        routeLayers.push(line);
    }
}

function evaluateStepWind(step, latlngs) {
    if (!step.way_points || step.way_points.length < 2) return null;

    const p1 = latlngs[step.way_points[0]];
    const p2 = latlngs[step.way_points[1]];

    if (!p1 || !p2) return null;

    // Si aucune donnée vent valide n'a jamais été récupérée avec succès
    // (getWind() jamais résolu, ex: échec réseau dès le premier appel),
    // on ne génère aucune info vent plutôt que d'annoncer une fausse
    // valeur (ex: "vent de face à 0 km/h" alors que ce n'est pas le cas).
    if (typeof window.currentWindDirection !== "number" || typeof window.currentWindSpeed !== "number") {
        return null;
    }

    const routeHeading = getSegmentDirection(p1, p2);

    // window.currentWindDirection est déjà la direction D'OÙ VIENT le vent
    // (convention météo standard, cf. windCost()/windEffect() dans wind.js
    // qui l'utilisent sans correction). Pas de +180 ici : angle proche de 0°
    // entre le cap de la route et l'origine du vent = vent de face.
    const windDir = window.currentWindDirection;

    const speed = Math.round(window.currentWindSpeed);

    let diff = Math.abs(routeHeading - windDir) % 360;
    if (diff > 180) diff = 360 - diff;

    // Seuils élargis par rapport à windEffect()/windCost() (45°/135°) :
    // un vent à 45-60° du cap a encore une composante de face ressentie
    // comme significative (cos(50°) ≈ 0,64). Uniquement pour l'annonce
    // vocale — le widget météo et le calcul de coût du trajet (wind.js)
    // restent sur 45°/135°, volontairement non touchés.
    let type = "cote";
    if (diff < 60) {
        type = "face";
    } else if (diff > 120) {
        type = "dos";
    }

    return { type, speed };
}


// FORMATAGE DES ÉTAPES POUR LA NAVIGATION VOCALE
function prepareStepsForVoice(steps, latlngs) {
    if (!steps) return [];
    return steps.map(step => {
        // Copie de l'étape enrichie du point GPS [lon, lat] pour checkVoiceNavigation
        const enrichedStep = { ...step };
        if (step.way_points && latlngs[step.way_points[0]]) {
            const pt = latlngs[step.way_points[0]];
            enrichedStep.location = [pt[1], pt[0]]; // Exporation au format [lon, lat]
        }
        enrichedStep.windInfo = evaluateStepWind(step, latlngs);
        return enrichedStep;
    });
}

// Longueur minimum (mètres) d'une portion "vent de face" à l'intérieur d'une
// même étape (donc sans changement de direction) pour déclencher une annonce
// dédiée. En dessous, on considère que c'est un micro-virage/du bruit.
const WIND_FACE_MIN_RUN_METERS = 40;

// DÉTECTION DE VENT DE FACE EN COURS D'ÉTAPE (route qui tourne progressivement
// sans instruction de manœuvre). Classification basée UNIQUEMENT sur l'angle
// entre le cap de la route et l'origine du vent (diff < 60°, seuil élargi —
// voir evaluateStepWind). On n'utilise PAS windCost() ici : ce dernier mélange
// angle et vitesse (pénalité = vitesse × 2 pour un vent de face, × 0.5 pour un
// vent latéral), donc un "cost élevé" peut aussi bien être un vent latéral
// fort qu'un vent de face modéré — inadapté pour répondre à la question
// "est-ce un vent de face ?".
function insertMidStepFaceWindWarnings(steps, latlngs) {
    if (!steps || steps.length === 0 || !latlngs || latlngs.length < 2) return steps || [];

    const getDist = typeof window.getDistanceInMeters === "function" ? window.getDistanceInMeters : null;
    if (!getDist) return steps; // gps.js pas encore chargé : on ne bloque pas, pas d'annonce ajoutée

    // Même garde-fou que evaluateStepWind : pas de données vent valides,
    // pas d'annonce fantôme.
    if (typeof window.currentWindDirection !== "number" || typeof window.currentWindSpeed !== "number") {
        return steps;
    }

    // Convention FROM, cohérente avec windCost()/windEffect() (pas de +180)
    const windDir = window.currentWindDirection;
    const roundedSpeed = Math.round(window.currentWindSpeed);

    const result = [];

    for (let s = 0; s < steps.length; s++) {
        const step = steps[s];
        result.push(step);

        if (!step.way_points || step.way_points.length < 2) continue;

        const from = step.way_points[0];
        const to = step.way_points[1];
        if (to - from < 2) continue; // segment trop court pour subdiviser

        let runStart = null;
        let runLength = 0;
        let alreadyInsertedForThisStep = false;

        // Démarre à from + 1 : le tout début de l'étape est déjà couvert
        // par l'annonce normale de l'étape (step.windInfo), pas la peine
        // de dupliquer l'annonce pile au même endroit.
        for (let i = from + 1; i < to; i++) {
            const p1 = latlngs[i];
            const p2 = latlngs[i + 1];
            if (!p1 || !p2) continue;

            const segLen = getDist(p1[0], p1[1], p2[0], p2[1]);
            const direction = getSegmentDirection(p1, p2);

            let diff = Math.abs(direction - windDir) % 360;
            if (diff > 180) diff = 360 - diff;
            const isFace = diff < 60; // seuil élargi, voir evaluateStepWind pour la justification

            if (isFace) {
                if (runStart === null) runStart = i;
                runLength += segLen;
            } else {
                if (runStart !== null && runLength >= WIND_FACE_MIN_RUN_METERS && !alreadyInsertedForThisStep) {
                    const pt = latlngs[runStart];
                    result.push({
                        instruction: "",
                        location: [pt[1], pt[0]],
                        windInfo: { type: "face", speed: roundedSpeed },
                        way_points: [runStart, runStart],
                        isWindOnly: true
                    });
                    alreadyInsertedForThisStep = true;
                }
                runStart = null;
                runLength = 0;
            }
        }

        // La portion "vent de face" se termine pile à la fin de l'étape
        if (runStart !== null && runLength >= WIND_FACE_MIN_RUN_METERS && !alreadyInsertedForThisStep) {
            const pt = latlngs[runStart];
            result.push({
                instruction: "",
                location: [pt[1], pt[0]],
                windInfo: { type: "face", speed: roundedSpeed },
                way_points: [runStart, runStart],
                isWindOnly: true
            });
        }
    }

    return result;
}

// AFFICHAGE DYNAMIQUE DU TEXTE VENT ET DISTANCE
function updateWindText(currentView, activeScore) {
    const allData = window.currentAllRoutesData || { features: [] };
    const nFeature = window.currentNormalFeature || null;
    const aFeature = window.currentAltFeature || null;

    const isAlternativeView = currentView === "alternative";
    const featureActive = isAlternativeView ? aFeature : nFeature;

    const distMeters = featureActive?.properties?.summary?.distance || 0;
    const distanceKm = (distMeters / 1000).toFixed(1);

    const nScore = parseFloat(window.currentNormalScore) || 0;
    const aScore = parseFloat(window.currentAltScore) || 0;

    let line1 = isAlternativeView ? "Route alternative" : "Route normale";
    let line2 = `Distance : ${distanceKm} km`;
    let line3 = "";

    if (!allData.features || allData.features.length <= 1) {
        line3 = "Aucune alternative disponible";
    } else {
        const diffPercent = nScore > 0 ? Math.round(((aScore - nScore) / nScore) * 100) : 0;
        const absDiff = Math.min(Math.abs(diffPercent), 90);

        if (Math.abs(diffPercent) < 5) {
            line3 = "Vent similaire sur les 2 trajets";
        } else if (diffPercent < 0) {
            line3 = isAlternativeView
                ? `Environ ${absDiff}% d'effort en moins`
                : `L'alternative économise ${absDiff}%`;
        } else {
            line3 = isAlternativeView
                ? `Environ ${absDiff}% d'effort en plus`
                : `La route normale est plus abritée`;
        }
    }

    const windInfoElem = document.getElementById("windInfo");
    if (windInfoElem) {
        windInfoElem.innerHTML = `
            <strong>${line1}</strong><br>
            ${line2}<br>
            ${line3}
        `;
    }
}


// Calcul trajet principal
async function getRoute() {
    if (!window.userPosition) {
        alert("Définissez votre position d'abord");
        return;
    }
    
    if (!window.destination) {
        alert("Choisissez une destination dans la liste");
        return;
    }
    
    const start = {
        lat: window.userPosition[0],
        lng: window.userPosition[1]
    };
    
    const endLat = window.destination.lat;
    const endLon = window.destination.lon;
    
    const allRoutesData = await getAlternativeRoute(start, endLat, endLon);
    
    if (!allRoutesData.features || allRoutesData.features.length === 0) {
        alert("Aucun itinéraire trouvé");
        return;
    }

    const normalFeature = allRoutesData.features[0];
    const coordsNormal = normalFeature.geometry.coordinates;
    const latlngsNormal = coordsNormal.map(point => [point[1], point[0]]);

    let latlngsAlternative = latlngsNormal;
    let alternativeFeature = normalFeature;

    if (allRoutesData.features.length > 1) {
        alternativeFeature = allRoutesData.features[1];
        const coordsAlt = alternativeFeature.geometry.coordinates;
        latlngsAlternative = coordsAlt.map(point => [point[1], point[0]]);
        drawGrayRoute(latlngsAlternative);
    }

    window.latlngsNormalPersist = latlngsNormal;
    window.latlngsAlternativePersist = latlngsAlternative;
    window.currentRoute = latlngsNormal.map(p => ({ lat: p[0], lng: p[1] }));

    const firstDir = getSegmentDirection(latlngsNormal[0], latlngsNormal[1]);
    
    await getWind(start.lat, start.lng, firstDir);
    window.windDataTimestamp = Date.now();
    
    drawWindRoute(latlngsNormal);

    const normalScore = calculateWindScore(latlngsNormal, normalFeature);
    const alternativeScore = calculateWindScore(latlngsAlternative, alternativeFeature);
    
    window.currentNormalScore = normalScore;
    window.currentAltScore = alternativeScore;
    window.currentAllRoutesData = allRoutesData;
    window.currentNormalFeature = normalFeature;
    window.currentAltFeature = alternativeFeature;

    // Préparation des étapes vocales
    if (normalFeature.properties && normalFeature.properties.segments) {
        const rawSteps = normalFeature.properties.segments[0].steps;
        window.normSteps = insertMidStepFaceWindWarnings(prepareStepsForVoice(rawSteps, latlngsNormal), latlngsNormal);
        window.routeSteps = window.normSteps;
    }

    if (alternativeFeature.properties && alternativeFeature.properties.segments) {
        const rawAltSteps = alternativeFeature.properties.segments[0].steps;
        window.altSteps = insertMidStepFaceWindWarnings(prepareStepsForVoice(rawAltSteps, latlngsAlternative), latlngsAlternative);
    }

    // Reset propre de l'état de navigation à chaque nouveau calcul d'itinéraire
    window.currentStepIndex = 0;
    window.lastSpokenStepIndex = -1;
    if (typeof window.resetVoiceNavigationState === "function") {
        window.resetVoiceNavigationState();
    }

    updateWindText("normale", normalScore);

    if (latlngsNormal && latlngsNormal.length > 0) {
        const bounds = L.latLngBounds(latlngsNormal);
        window.map.fitBounds(bounds, { padding: [50, 50] });
    }

    const toggleBtn = document.getElementById("toggleRouteBtn");
    
    if (toggleBtn) {
        if (allRoutesData.features.length > 1) {
            toggleBtn.style.display = "block";
            let showingAlternative = false;
            toggleBtn.innerText = "Voir la route alternative";

            toggleBtn.onclick = function() {
                window.routeGroup.clearLayers();
                if (typeof routeLayers !== "undefined") {
                    routeLayers = [];
                }

                if (!showingAlternative) {
                    drawWindRoute(window.latlngsAlternativePersist);
                    toggleBtn.innerText = "Voir la route normale";
                    updateWindText("alternative", alternativeScore);
                    window.routeSteps = window.altSteps;

                    window.currentStepIndex = 0;
                    window.lastSpokenStepIndex = -1;
                    if (typeof window.resetVoiceNavigationState === "function") {
                        window.resetVoiceNavigationState();
                    }

                    showingAlternative = true;
                } else {
                    drawWindRoute(window.latlngsNormalPersist);
                    toggleBtn.innerText = "Voir la route alternative";
                    updateWindText("normale", normalScore);
                    window.routeSteps = window.normSteps;

                    window.currentStepIndex = 0;
                    window.lastSpokenStepIndex = -1;
                    if (typeof window.resetVoiceNavigationState === "function") {
                        window.resetVoiceNavigationState();
                    }

                    showingAlternative = false;
                }
            };
        } else {
            toggleBtn.style.display = "none";
        }
    }
}


// Fonction commandée par le bouton Démarrer
function startNavigation() {
    const btn = document.getElementById("startNavBtn");
    if (!btn) return;

    let windInfoPanel = document.querySelector(".wind-container-right");
    if (!windInfoPanel) {
        windInfoPanel = document.getElementById("windInfo");
    }

    if (!window.userPosition) {
        alert("Position GPS non détectée. Impossible de démarrer.");
        return;
    }

    if (!window.routeSteps || window.routeSteps.length === 0) {
        alert("Aucun itinéraire prêt pour la navigation.");
        return;
    }

    if (!window.isNavigating) {
        window.isNavigating = true;
        btn.innerText = "Arrêter";
        btn.style.backgroundColor = "#e74c3c";

        Promise.resolve(requestWakeLock()).catch(err => {
            console.warn("Wake Lock refusé ou indisponible :", err);
        });

        window.currentStepIndex = 0;
        window.lastSpokenStepIndex = -1;

        if (typeof window.resetVoiceNavigationState === "function") {
            window.resetVoiceNavigationState();
        }

        if (typeof window.resetOffRouteAndArrivalState === "function") {
            window.resetOffRouteAndArrivalState();
        }
        // Salutation immédiate, puis annonce enchaînée : première instruction -> info vent
        if (typeof speakInstruction === "function") {
            speakInstruction("Navigation démarrée. Bonne route !").then(() => {
                const firstStep = (window.routeSteps && window.routeSteps[0]) ? window.routeSteps[0] : null;
                if (firstStep && firstStep.instruction) {
                    //Empêche checkVoiceNavigation (gps.js)au premier point GPS reçu après le démarrage
                    window.lastSpokenStepIndex = 0;
                    // annonce de la première instruction
                    speakInstruction(firstStep.instruction).then(() => {
                        if (firstStep.windInfo) {
                            const wi = firstStep.windInfo;
                            const windMsg = wi.type === "face"
                                ? `Vent de face à ${wi.speed} kilomètres heure.`
                                : wi.type === "dos"
                                    ? "Vent dans le dos."
                                    : "Attention, vent de côté.";
                            speakInstruction(windMsg);
                        }
                    });
                } else {
                    // si pas d'étape, on peut annoncer le vent global si disponible
                    const globalWindSpd = window.currentWindSpeed || 0;
                    if (globalWindSpd) {
                        speakInstruction(`Vent ${globalWindSpd} kilomètres heure.`);
                    }
                }
            });
        }

        if (windInfoPanel) {
            windInfoPanel.classList.add("nav-hidden");
        }
        
        window.currentNavZoom = 17;
        window.map.setView(window.userPosition, window.currentNavZoom);

        setTimeout(() => {
            window.map.panBy([0, -5], { animate: true });
        }, 250);
    } else {
        // STOP navigation
        window.isNavigating = false;
        btn.innerText = "Démarrer";
        btn.style.backgroundColor = "#2ecc71";

        releaseWakeLock();

        // Vider la file TTS puis annuler la lecture en cours
        if (typeof window.clearTtsQueue === "function") {
            window.clearTtsQueue();
        } else if (window.speechSynthesis) {
            // fallback
            try { window.speechSynthesis.cancel(); } catch (e) {}
        }

        window.currentStepIndex = 0;
        window.lastSpokenStepIndex = -1;

        if (typeof window.resetVoiceNavigationState === "function") {
            window.resetVoiceNavigationState();
        }

        if (typeof window.resetOffRouteAndArrivalState === "function") {
            window.resetOffRouteAndArrivalState();
        }
        if (windInfoPanel) {
            windInfoPanel.classList.remove("nav-hidden");
        }

        if (window.latlngsNormalPersist) {
            window.map.fitBounds(L.latLngBounds(window.latlngsNormalPersist), {
                padding: [50, 50]
            });
        }
    }
}

// ==========================================
// RECALCUL AUTOMATIQUE D'ITINÉRAIRE (DÉVIATION)
// ==========================================
// Appelée par gps.js (window.onRouteDeviationConfirmed) quand une sortie de
// trajet est confirmée pendant la navigation. Réutilise le même pipeline que
// getRoute() (appel API, score vent, préparation des étapes vocales), mais :
//   - part de la position actuelle du cycliste (pas de window.userPosition initial)
//   - choisit automatiquement le trajet le moins exposé au vent via chooseBestRoute
//   - ne touche pas à window.isNavigating (la navigation continue sans coupure)
let isRecalculatingRoute = false;
let deviationToken = 0; // incrémenté à chaque recalcul lancé ET à chaque retour naturel confirmé

async function recalculateRouteFromDeviation(lat, lon) {
    if (isRecalculatingRoute) return; // évite les appels concurrents
    if (!window.destination) return;

    isRecalculatingRoute = true;
    const myToken = ++deviationToken;

    try {
        console.log("[Route] Déviation confirmée : recalcul automatique en cours...");

        const start = { lat, lng: lon };
        const endLat = window.destination.lat;
        const endLon = window.destination.lon;

        const allRoutesData = await getAlternativeRoute(start, endLat, endLon, true);

        // Si le cycliste est revenu naturellement sur le trajet actif pendant
        // l'appel réseau (checkOffRoute l'a déjà recalé), ce recalcul est
        // obsolète : on l'ignore plutôt que d'écraser un trajet déjà valide.
        if (myToken !== deviationToken) {
            console.log("[Route] Recalcul ignoré : retour naturel sur le trajet entre-temps.");
            return;
        }

        if (!allRoutesData.features || allRoutesData.features.length === 0) {
            console.warn("[Route] Recalcul automatique : aucun itinéraire trouvé.");
            return;
        }

        const normalFeature = allRoutesData.features[0];
        const coordsNormal = normalFeature.geometry.coordinates;
        const latlngsNormal = coordsNormal.map(point => [point[1], point[0]]);

        let latlngsAlternative = latlngsNormal;
        let alternativeFeature = normalFeature;

        if (allRoutesData.features.length > 1) {
            alternativeFeature = allRoutesData.features[1];
            const coordsAlt = alternativeFeature.geometry.coordinates;
            latlngsAlternative = coordsAlt.map(point => [point[1], point[0]]);
        }

        // Pas de getWind() bloquant ici : le recalcul doit rester rapide (voir
        // la période de grâce et la boucle "vous vous éloignez..." corrigées
        // plus tôt). On réutilise les valeurs déjà connues
        // (window.currentWindDirection / window.currentWindSpeed) pour ne pas
        // ajouter de latence au moment critique.
        //
        // Mais on rafraîchit quand même en ARRIÈRE-PLAN (sans attendre la
        // réponse) si la dernière donnée date de plus de 15 minutes, pour
        // éviter d'utiliser une donnée trop périmée sur un trajet long ou
        // après une grosse déviation géographique.
        const WIND_DATA_MAX_AGE_MS = 15 * 60 * 1000;
        const windIsStale = !window.windDataTimestamp || (Date.now() - window.windDataTimestamp) > WIND_DATA_MAX_AGE_MS;
        if (windIsStale && typeof getWind === "function") {
            const bgWindDir = getSegmentDirection(latlngsNormal[0], latlngsNormal[1]);
            getWind(start.lat, start.lng, bgWindDir)
                .then(() => { window.windDataTimestamp = Date.now(); })
                .catch(() => { /* échec silencieux : on retentera au prochain recalcul */ });
        }

        const normalScore = calculateWindScore(latlngsNormal, normalFeature);
        const alternativeScore = calculateWindScore(latlngsAlternative, alternativeFeature);

        // Durées extraites depuis la feature (chooseBestRoute attend .duration)
        const normalDuration = normalFeature.properties?.summary?.duration ?? Infinity;
        const altDuration = alternativeFeature.properties?.summary?.duration ?? Infinity;

        const bestChoice = (allRoutesData.features.length > 1)
            ? chooseBestRoute(
                { duration: normalDuration },
                { duration: altDuration },
                normalScore,
                alternativeScore
            )
            : "normal";

        const chosenLatlngs = bestChoice === "alternative" ? latlngsAlternative : latlngsNormal;
        const chosenFeature = bestChoice === "alternative" ? alternativeFeature : normalFeature;
        const chosenScore = bestChoice === "alternative" ? alternativeScore : normalScore;

        // Persistance identique à getRoute()
        window.latlngsNormalPersist = latlngsNormal;
        window.latlngsAlternativePersist = latlngsAlternative;
        window.currentRoute = chosenLatlngs.map(p => ({ lat: p[0], lng: p[1] }));

        window.currentNormalScore = normalScore;
        window.currentAltScore = alternativeScore;
        window.currentAllRoutesData = allRoutesData;
        window.currentNormalFeature = normalFeature;
        window.currentAltFeature = alternativeFeature;

        if (normalFeature.properties && normalFeature.properties.segments) {
            window.normSteps = insertMidStepFaceWindWarnings(
                prepareStepsForVoice(normalFeature.properties.segments[0].steps, latlngsNormal),
                latlngsNormal
            );
        }
        if (alternativeFeature.properties && alternativeFeature.properties.segments) {
            window.altSteps = insertMidStepFaceWindWarnings(
                prepareStepsForVoice(alternativeFeature.properties.segments[0].steps, latlngsAlternative),
                latlngsAlternative
            );
        }
        window.routeSteps = bestChoice === "alternative" ? window.altSteps : window.normSteps;

        // Redessine uniquement le tracé retenu (+ l'autre en gris si dispo)
        window.routeGroup.clearLayers();
        if (typeof routeLayers !== "undefined") {
            routeLayers = [];
        }
        if (allRoutesData.features.length > 1) {
            const otherLatlngs = bestChoice === "alternative" ? latlngsNormal : latlngsAlternative;
            drawGrayRoute(otherLatlngs);
        }
        drawWindRoute(chosenLatlngs);
        updateWindText(bestChoice === "alternative" ? "alternative" : "normale", chosenScore);

        // Redémarre le guidage vocal sur le nouveau tracé sans couper la navigation
        window.currentStepIndex = 0;
        window.lastSpokenStepIndex = -1;
        if (typeof window.resetVoiceNavigationState === "function") {
            window.resetVoiceNavigationState();
        }
        if (typeof window.resetOffRouteAndArrivalState === "function") {
            window.resetOffRouteAndArrivalState(); // remet __routeJustRecalculatedUntil à 0
        }
        // Période de grâce : laisse 8s au GPS pour se stabiliser sur le
        // nouveau tracé avant de recommencer à évaluer l'écart au trajet.
        // Doit être défini APRÈS resetOffRouteAndArrivalState (qui le remet à 0).
        window.__routeJustRecalculatedUntil = Date.now() + 8000;

        if (typeof speakInstruction === "function") {
            speakInstruction("Nouvel itinéraire calculé.");
        }

    } catch (err) {
        console.warn("[Route] Erreur pendant le recalcul automatique :", err);
    } finally {
        isRecalculatingRoute = false;
    }
}

// Branchement sur les hooks exposés par gps.js
window.onRouteDeviationConfirmed = function({ lat, lon }) {
    recalculateRouteFromDeviation(lat, lon);
};

window.onRouteRecoveryConfirmed = function() {
    // Le cycliste est revenu tout seul sur le trajet actif : on invalide
    // tout recalcul en vol (voir la vérification myToken !== deviationToken
    // dans recalculateRouteFromDeviation).
    deviationToken++;
};




// Analyse du vent
function windDirectionText(deg) {
    const directions = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
    const index = Math.round(deg / 45) % 8;
    return directions[index];
}

// Effet du vent sur le cycliste
function windEffect(rideDirection, windDirection) {
    let angle = Math.abs(rideDirection - windDirection);

    if (angle > 180) {
        angle = 360 - angle;
    }

    // Si la route et l'origine du vent ont la MÊME direction (angle ~ 0°),
    // le vent vient de DEVANT toi -> Vent de face.
    if (angle < 45) {
        return "💨 Vent de face";
    }

    // Si la route et l'origine du vent sont OPPOSÉES (angle ~ 180°),
    // le vent vient de DERRIÈRE toi -> Vent favorable (dos).
    if (angle > 135) {
        return "🚴 Vent favorable";
    }

    return "↔️ Vent latéral";
}

// Coût du vent pour le calcul de route
function windCost(roadDirection, windDirection, windSpeed) {
    let angle = Math.abs(roadDirection - windDirection);

    if (angle > 180) {
        angle = 360 - angle;
    }

    // Vent de face (angle proche de 0°) = pénalité maximale
    if (angle < 45) {
        return windSpeed * 2;
    }

    // Vent latéral = pénalité modérée
    if (angle < 135) {
        return windSpeed * 0.5;
    }

    // Vent favorable (angle proche de 180°) = aucune pénalité (0)
    return 0;
}

// Récupération météo et affichage du Widget
async function getWind(lat, lon, rideDirection) {
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=wind_speed_10m%2Cwind_direction_10m`;

        const response = await fetch(url);
        const data = await response.json();

        // IMPORTANT : affectation EXPLICITE sur window.
        // L'ancienne version faisait "currentWindSpeed = ..." sans var/let/const
        // ni préfixe window. Ce type d'affectation globale implicite lève une
        // ReferenceError en mode strict (ex: <script type="module">), silencieusement
        // avalée par le catch ci-dessous -> window.currentWindDirection /
        // window.currentWindSpeed n'étaient alors JAMAIS définis, et route.js
        // (qui teste explicitement window.currentWindDirection / window.currentWindSpeed)
        // ne générait donc jamais d'annonce vocale de vent.
        window.currentWindSpeed = data.current.wind_speed_10m;
        window.currentWindDirection = data.current.wind_direction_10m;

        if (windControl) {
            map.removeControl(windControl);
        }

        windControl = L.control({
            position: "topright"
        });

        windControl.onAdd = function() {
            const div = L.DomUtil.create("div", "wind-box");

            // +180deg permet d'orienter la flèche vers OÙ SOUFFLE le vent (direction de déplacement)
            div.innerHTML = `
            <div class="wind-arrow" style="transform:rotate(${window.currentWindDirection + 90}deg)">
                ➤
            </div>
            <div>
                ${Math.round(window.currentWindSpeed)} km/h<br>
                Vent ${windDirectionText(window.currentWindDirection)}<br>
                ${windEffect(rideDirection, window.currentWindDirection)}
            </div>
            `;

            return div;
        };

        windControl.addTo(map);

    } catch(error) {
        console.log("Erreur vent:", error);
    }
}


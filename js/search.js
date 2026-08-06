window.destination = null;

function searchDestination(){

    const rawQuery = document.getElementById("destination").value.trim();

    if(rawQuery.length < 3) return;

    // 🔥 ÉTAPE 1 : Détecter si la saisie commence par un numéro
    const matchNumero = rawQuery.match(/^(\d+)\s+(.+)$/);
    
    let queryPourApi = rawQuery;
    let numeroSauvegarde = "";

    if (matchNumero) {
        numeroSauvegarde = matchNumero[1]; // On mémorise le numéro (ex: "12")
        queryPourApi = matchNumero[2];     // On n'envoie que la rue à l'API (ex: "rue de la paix")
    }

    const domaineApi = "pho" + "ton" + ".komoot.io";
    let urlComplete = `https://${domaineApi}/api/?q=${encodeURIComponent(queryPourApi)}&limit=5&lang=fr`;

    if (window.userPosition && window.userPosition[0]) {
        urlComplete += `&lat=${window.userPosition[0]}&lon=${window.userPosition[1]}`;
    }

    fetch(urlComplete)
        .then(res => res.json())
        .then(data => {

            const container = document.getElementById("suggestions");
            container.innerHTML = "";

            const uniqueAddresses = new Set();

            if (!data.features || data.features.length === 0) return;

            data.features.forEach(place => {

                const name = place.properties.name || "";
                const city = place.properties.city || "";

                // 🔥 ÉTAPE 2 : Si l'utilisateur avait tapé un numéro au début, on l'affiche de force dans la suggestion
                const housenumber = numeroSauvegarde || place.properties.housenumber || ""; 

                let full = "";
                if (housenumber && !name.includes(housenumber)) {
                    full = housenumber + " " + name + " " + city;
                } else {
                    full = name + " " + city;
                }

                full = full.replace(/\s+/g, ' ').trim();

                if (!full) full = "Lieu inconnu";

                if (uniqueAddresses.has(full)) {
                    return; 
                }
                uniqueAddresses.add(full);

                const div = document.createElement("div");
                div.innerHTML = full;
                div.style.padding = "10px";
                div.style.cursor = "pointer";

                div.onclick = function(){
                    // 🔥 ÉTAPE 3 : On transmet les coordonnées GPS à votre carte
                    window.destination = {
                        lat: place.geometry.coordinates[1], 
                        lon: place.geometry.coordinates[0]  
                    };

                    document.getElementById("destination").value = full;
                    container.innerHTML = "";
                    
                    console.log("Destination enregistrée avec le numéro :", window.destination);
                };

                container.appendChild(div);
            });
        })
        .catch(err => console.error("Erreur réseau API :", err));
}

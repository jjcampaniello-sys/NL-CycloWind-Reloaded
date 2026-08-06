window.userPosition = null;
let marker;
let bikeArrow = null;
let windControl;
let windLegend;
window.map = null;

let currentWindDirection = 0;
let currentWindSpeed = 0;
let routeLine = null;
let routeLayers = [];


// Initialize map immediately when script loads
// app.js

window.addEventListener("load", function(){

   // console.log("App démarrée");

    // 🌍 Création carte
   // Centre la carte sur l'Europe (coordonnées centrales approximatives) avec un zoom large de 4
window.map = L.map('map').setView([54.5260, 15.2551], 4);

   // window.map = L.map('map').setView([52.3676, 4.9041], 12);

    L.tileLayer(
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        { // 🔥 AJOUTEZ OU MODIFIEZ CETTE LIGNE : Autorise la carte à plonger très près
    maxZoom: 20, 
           attribution: 'OpenStreetMap' }
    ).addTo(window.map);

    window.routeGroup = L.layerGroup().addTo(window.map);

  //  console.log("Carte prête");

    // ✅ MAINTENANT SEULEMENT on lance GPS
    if(typeof startGPS === "function"){
        startGPS();
    }

    if(typeof startCompass === "function"){
        startCompass();
    }

});

function clearRoute(){
    localStorage.removeItem("cyclowind_route");

    if(window.routeGroup){
        window.routeGroup.clearLayers();
    }

    window.destination = null;

    document.getElementById("destination").value = "";

    document.getElementById("windInfo").innerHTML =
    "🚴 Aucun trajet calculé";
}

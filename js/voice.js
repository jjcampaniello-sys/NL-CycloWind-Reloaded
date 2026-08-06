
function speak(text) {
    // Vérifie si le navigateur supporte la synthèse vocale
    if ('speechSynthesis' in window) {
        // Arrête les éventuelles paroles en cours pour éviter la file d'attente
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'fr-FR'; // Langue française
        utterance.rate = 0.95;   // Vitesse de lecture (1 = normal)
        utterance.pitch = 1.0;  // Ton de la voix

        window.speechSynthesis.speak(utterance);
    } else {
        console.log("La synthèse vocale n'est pas supportée par ce navigateur.");
    }
}

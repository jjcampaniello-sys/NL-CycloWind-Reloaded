export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Méthode non autorisée' });
    }

    // 🔑 Mettre uniquement la clé ey... entre les guillemets
    const apiKey = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjliNTU2YzljMDI0YTA1MTlkMjU5YzdkZDM3MzY0YzQzNGIyN2VjYzZhZWQ3YzVkMzk5NmNjNTM4IiwiaCI6Im11cm11cjY0In0="; 
    
    const url = "https://api.openrouteservice.org/v2/directions/cycling-regular/geojson";

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + apiKey,
                "Content-Type": "application/json"
            },
            body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
        });

        const rawText = await response.text();

        if (!response.ok) {
            return res.status(response.status).send(rawText);
        }

        const data = JSON.parse(rawText);
        return res.status(200).json(data);

    } catch (error) {
        return res.status(500).json({ error: "Erreur serveur : " + error.message });
    }
}

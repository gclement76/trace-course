/* =========================================================
   Trace Course — logique de l'application
   ========================================================= */

/* ---------------------------------------------------------
   1. Configuration générale
   --------------------------------------------------------- */

// Vue par défaut : la France entière (si la géolocalisation est refusée)
const VUE_FRANCE = { centre: [46.6, 2.4], zoom: 6 };

// Zoom utilisé quand on centre la carte sur la position de l'utilisateur
const ZOOM_POSITION = 14;

/* ---------------------------------------------------------
   2. Création de la carte
   --------------------------------------------------------- */

// On crée la carte dans la div #carte, centrée sur la France pour commencer
const carte = L.map("carte").setView(VUE_FRANCE.centre, VUE_FRANCE.zoom);

// Fonds de carte (l'attribution des sources est obligatoire).
// Remarque : une page ouverte en local (adresse file://) n'envoie pas d'en-tête
// « Referer ». Les serveurs officiels d'OpenStreetMap et ceux de CARTO refusent
// alors les tuiles. Les fournisseurs ci-dessous, gratuits et sans clé, ont été
// testés et fonctionnent dans ce cas.

// Adresse générique du service de tuiles de l'IGN (Géoplateforme, France)
function coucheIGN(nomCouche, format, attribution) {
  return L.tileLayer(
    "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0" +
      `&LAYER=${nomCouche}&STYLE=normal&TILEMATRIXSET=PM&FORMAT=${format}` +
      "&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}",
    { maxZoom: 19, attribution }
  );
}

const ATTRIBUTION_IGN = '&copy; <a href="https://www.ign.fr">IGN</a> – Géoplateforme';

const fondsDeCarte = {
  // Plan IGN : clair et détaillé (France uniquement) — fond par défaut
  "Plan IGN": coucheIGN("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", "image/png", ATTRIBUTION_IGN),
  // Carte topographique avec courbes de niveau (monde entier) : idéale pour le trail
  "Topographique": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17,
    subdomains: "abc",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>' +
      ' &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  }),
  // Photo aérienne : pratique pour repérer les chemins
  "Photo aérienne": coucheIGN("ORTHOIMAGERY.ORTHOPHOTOS", "image/jpeg", ATTRIBUTION_IGN),
};

// Fond affiché au démarrage : le dernier choisi (mémorisé dans le navigateur),
// sinon le Plan IGN. try/catch : le stockage peut être bloqué (navigation privée…)
const CLE_FOND = "trace-course-fond";
let fondInitial = "Plan IGN";
try {
  const fondMemorise = localStorage.getItem(CLE_FOND);
  if (fondMemorise && fondsDeCarte[fondMemorise]) fondInitial = fondMemorise;
} catch (e) {
  /* stockage indisponible : on garde le fond par défaut */
}
fondsDeCarte[fondInitial].addTo(carte);

// Quand l'utilisateur change de fond, on le mémorise
carte.on("baselayerchange", (e) => {
  try {
    localStorage.setItem(CLE_FOND, e.name);
  } catch (err) {
    /* pas grave */
  }
});

// Petit sélecteur en haut à droite pour changer de fond
L.control.layers(fondsDeCarte, null, { position: "topright" }).addTo(carte);

/* ---------------------------------------------------------
   3. Géolocalisation : centrer sur l'utilisateur s'il accepte
   --------------------------------------------------------- */

function centrerSurPosition() {
  // Certains navigateurs ne proposent pas la géolocalisation
  if (!("geolocation" in navigator)) return;

  navigator.geolocation.getCurrentPosition(
    // Succès : on recentre la carte sur la position
    (position) => {
      const { latitude, longitude } = position.coords;
      carte.setView([latitude, longitude], ZOOM_POSITION);
    },
    // Refus ou erreur : on garde simplement la vue France, sans bloquer l'appli
    (erreur) => {
      console.info("Géolocalisation indisponible :", erreur.message);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
  );
}
// (L'appel à centrerSurPosition() se fait à la fin du fichier : on ne recentre
//  pas sur l'utilisateur si un parcours sauvegardé a été rechargé.)

/* ---------------------------------------------------------
   4. État du parcours
   ---------------------------------------------------------
   - points   : les points cliqués, dans l'ordre. Chaque point = { latlng, marqueur }.
   - segments : segments[i] relie le point i au point i+1.
                Si la boucle est fermée, le dernier segment relie
                le dernier point au point de départ.
                Chaque segment = { geometrie: [LatLng...], distance: mètres, mode, jeton }.
                mode = "route"      → suit les chemins (réponse du service de routage)
                       "provisoire" → ligne droite en attendant la réponse
                       "droit"      → ligne droite voulue (option « Suivre les chemins » décochée)
                       "secours"    → ligne droite car le routage a échoué
                       "importe"    → morceau d'un fichier GPX importé (gardé tel quel)
   - boucle   : true si le parcours revient au point de départ.
   - routage  : true si l'on veut suivre les chemins.
   - requetesEnCours : nombre de demandes d'itinéraire en attente.
   - marqueurEnGlissement : le marqueur que l'utilisateur fait glisser (ou null).
   --------------------------------------------------------- */

const etat = {
  points: [],
  segments: [],
  boucle: false,
  routage: true,
  requetesEnCours: 0,
  marqueurEnGlissement: null,
  // Altitude : statut = "vide" (pas de parcours), "chargement", "ok" ou "erreur".
  // profil = { distances, altitudes, latlngs, dPlus, dMoins, min, max } quand statut = "ok"
  altitude: { statut: "vide", profil: null },
};

// Couleur et style du tracé sur la carte, selon le mode du segment
const STYLE_TRACE = { color: "#e4572e", weight: 5, opacity: 0.85 };
const STYLES_PAR_MODE = {
  route: STYLE_TRACE,
  droit: STYLE_TRACE,
  importe: STYLE_TRACE,
  provisoire: { ...STYLE_TRACE, opacity: 0.45, dashArray: "2 8" },
  secours: { ...STYLE_TRACE, dashArray: "8 8" },
};

// Groupe qui contient les lignes du tracé (une ligne par segment)
const coucheTrace = L.layerGroup().addTo(carte);

/* ---------------------------------------------------------
   5. Calculs de géométrie
   --------------------------------------------------------- */

// Longueur (en mètres) d'une suite de points.
// distanceTo() de Leaflet utilise la formule de Haversine (distance sur la sphère terrestre).
function longueurGeometrie(geometrie) {
  let total = 0;
  for (let i = 1; i < geometrie.length; i++) {
    total += geometrie[i - 1].distanceTo(geometrie[i]);
  }
  return total;
}

// Indices des deux points reliés par le segment n° s
function extremitesSegment(s) {
  const n = etat.points.length;
  return [s, (s + 1) % n]; // le « % n » ramène au point 0 pour le segment de retour
}

// Vrai si le segment suit un vrai tracé (chemin calculé ou morceau de GPX importé),
// par opposition aux lignes droites
function suitUnTrace(segment) {
  return segment.mode === "route" || segment.mode === "importe";
}

// Numéros des segments qui touchent le point n° k (utile quand on le déplace)
function segmentsVoisins(k) {
  const voisins = [];
  const nbSegments = etat.segments.length;
  if (k > 0) voisins.push(k - 1);                      // segment qui arrive au point
  if (k < nbSegments) voisins.push(k);                 // segment qui part du point
  if (k === 0 && etat.boucle) voisins.push(nbSegments - 1); // retour vers le départ
  return voisins;
}

/* ---------------------------------------------------------
   5 bis. Routage : suivre les chemins entre deux points
   ---------------------------------------------------------
   Service OSRM « piéton » de l'association FOSSGIS (gratuit, sans clé).
   Il renvoie la liste des coordonnées du chemin le plus court à pied.
   --------------------------------------------------------- */

const URL_ROUTAGE = "https://routing.openstreetmap.de/routed-foot/route/v1/foot";
const DELAI_MAX_ROUTAGE = 10000; // au-delà de 10 s sans réponse, on abandonne

// Règle d'usage du service : 1 requête par seconde maximum.
// On garde une petite marge : au moins 1,1 s entre deux envois.
const INTERVALLE_MIN_ROUTAGE = 1100;

// Attribution demandée par le service (données OSM + lien pour corriger la carte)
carte.attributionControl.addAttribution(
  'Itinéraires : <a href="https://routing.openstreetmap.de/about.html">OSRM / FOSSGIS</a>, ' +
    'données &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
    '(<a href="https://www.openstreetmap.org/fixthemap">corriger la carte</a>)'
);

// Chaque demande reçoit un numéro unique (« jeton »). Si le segment a été modifié
// entre-temps, son jeton a changé : la réponse arrivée en retard est ignorée.
let dernierJeton = 0;

/* File d'attente des demandes de routage.
   « fileRoutage » est une promesse qui représente la fin de la dernière demande
   mise en file : chaque nouvelle demande s'enchaîne derrière avec .then(),
   ce qui garantit qu'elles passent une par une, dans l'ordre. */
let fileRoutage = Promise.resolve();
let dernierEnvoiRoutage = 0; // heure (en ms) du dernier envoi au service

// Petite fonction utilitaire : attendre un certain nombre de millisecondes
function pause(ms) {
  return new Promise((resoudre) => setTimeout(resoudre, ms));
}

// Attend son tour dans la file, en respectant l'intervalle minimal.
// Renvoie true si la demande doit partir, false si elle est devenue inutile
// (dans ce cas elle ne consomme pas de « créneau » et la suivante passe aussitôt).
function attendreTourRoutage(estToujoursUtile) {
  const tour = fileRoutage.then(async () => {
    if (!estToujoursUtile()) return false;
    const attente = dernierEnvoiRoutage + INTERVALLE_MIN_ROUTAGE - Date.now();
    if (attente > 0) await pause(attente);
    if (!estToujoursUtile()) return false; // a pu changer pendant l'attente
    dernierEnvoiRoutage = Date.now();
    return true;
  });
  // La file continue même si une étape échoue
  fileRoutage = tour.catch(() => {});
  return tour;
}

// Demande l'itinéraire à pied entre deux points ; renvoie une liste de LatLng.
// Lève une erreur en cas de problème (réseau, délai dépassé, pas de chemin trouvé).
async function demanderItineraire(depart, arrivee) {
  // OSRM attend « longitude,latitude » (dans cet ordre !)
  const coordonnees =
    `${depart.lng.toFixed(6)},${depart.lat.toFixed(6)};` +
    `${arrivee.lng.toFixed(6)},${arrivee.lat.toFixed(6)}`;
  const url = `${URL_ROUTAGE}/${coordonnees}?overview=full&geometries=geojson`;

  const reponse = await fetch(url, { signal: AbortSignal.timeout(DELAI_MAX_ROUTAGE) });
  if (!reponse.ok) throw new Error(`Erreur HTTP ${reponse.status}`);

  const donnees = await reponse.json();
  if (donnees.code !== "Ok" || !donnees.routes || donnees.routes.length === 0) {
    throw new Error(`Pas d'itinéraire (${donnees.code})`);
  }
  // GeoJSON donne [longitude, latitude] ; Leaflet veut (latitude, longitude)
  return donnees.routes[0].geometry.coordinates.map(([lng, lat]) => L.latLng(lat, lng));
}

// Déplace un point vers la position « aimantée » sur le chemin
function ajusterPoint(k, latlng) {
  const point = etat.points[k];
  // On ne déplace pas un point que l'utilisateur est en train de faire glisser
  if (point.marqueur === etat.marqueurEnGlissement) return;
  if (point.latlng.distanceTo(latlng) < 0.5) return; // déjà en place

  point.latlng = latlng;
  point.marqueur.setLatLng(latlng);

  // Les segments voisins en ligne droite doivent suivre le point
  for (const v of segmentsVoisins(k)) {
    const segment = etat.segments[v];
    if (suitUnTrace(segment)) continue;
    const [a, b] = extremitesSegment(v);
    segment.geometrie = [etat.points[a].latlng, etat.points[b].latlng];
    segment.distance = longueurGeometrie(segment.geometrie);
  }
}

// Lance le calcul d'itinéraire du segment n° s, puis met à jour l'affichage
async function routerSegment(s, jeton, depart, arrivee) {
  // Le segment n° s porte-t-il toujours ce jeton ? (sinon il a changé ou a disparu)
  const estAJour = () => Boolean(etat.segments[s]) && etat.segments[s].jeton === jeton;

  etat.requetesEnCours++;
  majMessage();
  try {
    // On attend notre tour dans la file (1 envoi par seconde au maximum)
    const doitPartir = await attendreTourRoutage(estAJour);
    if (!doitPartir) return;

    const geometrie = await demanderItineraire(depart, arrivee);
    // Réponse obsolète (le segment a changé ou a été supprimé) : on l'ignore
    if (!estAJour()) return;

    etat.segments[s] = { geometrie, distance: longueurGeometrie(geometrie), mode: "route", jeton };
    // Les extrémités du chemin sont les points « aimantés » : on y recale les marqueurs
    const [a, b] = extremitesSegment(s);
    ajusterPoint(a, geometrie[0]);
    ajusterPoint(b, geometrie[geometrie.length - 1]);
  } catch (erreur) {
    console.warn(`Routage du segment ${s} impossible :`, erreur.message);
    if (!estAJour()) return;
    // On garde la ligne droite, affichée en pointillés : la distance reste disponible
    etat.segments[s].mode = "secours";
  } finally {
    // « finally » s'exécute dans tous les cas, même après un « return »
    etat.requetesEnCours--;
    mettreAJour();
  }
}

// (Re)calcule les segments dont on donne les numéros.
// On pose d'abord une ligne droite (affichage immédiat de la distance), puis,
// si le routage est actif et que « avecRoutage » est vrai, on demande le vrai chemin.
function recalculerSegments(indices, avecRoutage = true) {
  for (const s of indices) {
    const [a, b] = extremitesSegment(s);
    const depart = etat.points[a].latlng;
    const arrivee = etat.points[b].latlng;
    const geometrie = [depart, arrivee];
    const jeton = ++dernierJeton;

    etat.segments[s] = {
      geometrie,
      distance: longueurGeometrie(geometrie),
      mode: etat.routage ? "provisoire" : "droit",
      jeton,
    };
    if (etat.routage && avecRoutage) routerSegment(s, jeton, depart, arrivee);
  }
}

// Tous les numéros de segments : [0, 1, 2, ...]
function tousLesSegments() {
  return etat.segments.map((_, s) => s);
}

/* ---------------------------------------------------------
   5 ter. Altitude, D+ et D-
   ---------------------------------------------------------
   Service : API Elevation d'Open-Meteo (gratuit, sans clé, usage non commercial).
   Modèle de terrain Copernicus GLO-90 (une valeur tous les ~90 m).
   Étapes :
     1. on place des points tous les 30 m le long du tracé (échantillonnage) ;
     2. on demande leur altitude par paquets de 100 (limite du service),
        en ne demandant que ceux qu'on ne connaît pas déjà (cache) ;
     3. on lisse la courbe, puis on calcule D+, D-, min et max.
   --------------------------------------------------------- */

const URL_ALTITUDE = "https://api.open-meteo.com/v1/elevation";
const PAS_ECHANTILLON = 30;      // mètres entre deux points d'altitude
const TAILLE_PAQUET = 100;       // nombre max de points par requête (limite du service)
const FENETRE_LISSAGE = 5;       // moyenne glissante sur 5 points (~150 m)
const SEUIL_DENIVELE = 3;        // une variation n'est comptée qu'au-delà de 3 m
const DELAI_ANTI_RAFALE = 400;   // on attend 0,4 s de calme avant de lancer le calcul
const DELAI_MAX_ALTITUDE = 10000;

// Attribution demandée par Open-Meteo (programme Copernicus)
carte.attributionControl.addAttribution(
  'Altitudes : <a href="https://open-meteo.com/">Open-Meteo</a>, Copernicus DEM GLO-90'
);

// Altitudes déjà connues. Clé = coordonnées arrondies à 4 décimales (~10 m),
// largement assez précis pour un modèle de terrain à 90 m.
const cacheAltitudes = new Map();

function cleAltitude(latlng) {
  return `${latlng.lat.toFixed(4)},${latlng.lng.toFixed(4)}`;
}

// Place un point tous les « pas » mètres le long d'une géométrie.
// Renvoie [{ latlng, d }] où d = distance depuis le début de la géométrie.
function echantillonnerGeometrie(geometrie, pas) {
  const resultat = [{ latlng: geometrie[0], d: 0 }];
  let parcouru = 0;      // distance cumulée jusqu'au début du morceau courant
  let prochain = pas;    // distance du prochain point à placer

  for (let i = 1; i < geometrie.length; i++) {
    const a = geometrie[i - 1];
    const b = geometrie[i];
    const longueur = a.distanceTo(b);
    // Tant que le prochain point tombe dans ce morceau, on l'interpole entre a et b
    while (prochain <= parcouru + longueur) {
      const t = (prochain - parcouru) / longueur; // 0 = en a, 1 = en b
      resultat.push({
        latlng: L.latLng(a.lat + t * (b.lat - a.lat), a.lng + t * (b.lng - a.lng)),
        d: prochain,
      });
      prochain += pas;
    }
    parcouru += longueur;
  }
  // On ajoute toujours le point d'arrivée (s'il n'est pas déjà quasiment là)
  if (parcouru - resultat[resultat.length - 1].d > 1) {
    resultat.push({ latlng: geometrie[geometrie.length - 1], d: parcouru });
  }
  return resultat;
}

// Échantillonne tout le parcours, segment par segment.
// Faire segment par segment garantit que, si on déplace un point, les échantillons
// des segments non modifiés restent identiques → ils sont retrouvés dans le cache.
function echantillonnerParcours() {
  const echantillons = [];
  let decalage = 0; // distance cumulée des segments précédents
  etat.segments.forEach((segment, s) => {
    const points = echantillonnerGeometrie(segment.geometrie, PAS_ECHANTILLON);
    // Le 1er point d'un segment = dernier point du précédent : on ne le duplique pas
    const debut = s === 0 ? 0 : 1;
    for (let i = debut; i < points.length; i++) {
      echantillons.push({ latlng: points[i].latlng, d: decalage + points[i].d });
    }
    decalage += segment.distance;
  });
  return echantillons;
}

// Demande l'altitude d'au plus 100 points ; renvoie un tableau de nombres
async function demanderAltitudes(latlngs) {
  const latitudes = latlngs.map((p) => p.lat.toFixed(4)).join(",");
  const longitudes = latlngs.map((p) => p.lng.toFixed(4)).join(",");
  const url = `${URL_ALTITUDE}?latitude=${latitudes}&longitude=${longitudes}`;

  const reponse = await fetch(url, { signal: AbortSignal.timeout(DELAI_MAX_ALTITUDE) });
  if (!reponse.ok) throw new Error(`Erreur HTTP ${reponse.status}`);

  const donnees = await reponse.json();
  const altitudes = donnees.elevation;
  if (!Array.isArray(altitudes) || altitudes.length !== latlngs.length) {
    throw new Error("Réponse d'altitude inattendue");
  }
  return altitudes;
}

// Moyenne glissante centrée : chaque valeur est remplacée par la moyenne
// de ses voisines (fenêtre réduite aux extrémités de la courbe)
function lisser(valeurs, fenetre) {
  const demi = Math.floor(fenetre / 2);
  return valeurs.map((_, i) => {
    const debut = Math.max(0, i - demi);
    const fin = Math.min(valeurs.length - 1, i + demi);
    let somme = 0;
    for (let j = debut; j <= fin; j++) somme += valeurs[j];
    return somme / (fin - debut + 1);
  });
}

// Calcul du D+ et du D- avec un seuil (« hystérésis ») :
// on mémorise une altitude de référence, et on ne compte une montée ou une descente
// que lorsqu'on s'en est éloigné d'au moins « seuil » mètres. Les petites
// oscillations dues au bruit du modèle de terrain ne sont donc pas comptées.
function calculerDenivele(altitudes, seuil) {
  let reference = altitudes[0];
  let dPlus = 0;
  let dMoins = 0;
  for (const alt of altitudes) {
    if (alt - reference >= seuil) {
      dPlus += alt - reference;
      reference = alt;
    } else if (reference - alt >= seuil) {
      dMoins += reference - alt;
      reference = alt;
    }
  }
  return { dPlus, dMoins };
}

// Numéro du calcul en cours : un calcul dépassé par un plus récent s'arrête
let versionProfil = 0;
let minuterieAltitude = null;

// Lance le calcul d'altitude après un court délai de calme (anti-rafale)
function planifierAltitude() {
  clearTimeout(minuterieAltitude);
  minuterieAltitude = setTimeout(calculerProfil, DELAI_ANTI_RAFALE);
}

async function calculerProfil() {
  const version = ++versionProfil;

  if (etat.segments.length === 0) {
    etat.altitude = { statut: "vide", profil: null };
    afficherAltitude();
    return;
  }
  // Tracé encore en mouvement ou en cours de routage : on attendra.
  // (Un nouveau calcul sera planifié à la fin du glissement / du routage.)
  if (etat.marqueurEnGlissement || etat.requetesEnCours > 0) return;

  const echantillons = echantillonnerParcours();

  // Points dont l'altitude n'est pas encore connue (sans doublons)
  const aDemander = new Map();
  for (const e of echantillons) {
    const cle = cleAltitude(e.latlng);
    if (!cacheAltitudes.has(cle)) aDemander.set(cle, e.latlng);
  }
  const manquants = [...aDemander.values()];

  if (manquants.length > 0) {
    etat.altitude.statut = "chargement";
    afficherAltitude();
    try {
      // Requêtes par paquets de 100, l'une après l'autre
      for (let i = 0; i < manquants.length; i += TAILLE_PAQUET) {
        const paquet = manquants.slice(i, i + TAILLE_PAQUET);
        const altitudes = await demanderAltitudes(paquet);
        paquet.forEach((p, j) => cacheAltitudes.set(cleAltitude(p), altitudes[j]));
        if (version !== versionProfil) return; // un calcul plus récent a pris le relais
      }
    } catch (erreur) {
      console.warn("Altitude indisponible :", erreur.message);
      if (version !== versionProfil) return;
      // La distance reste affichée : seules les données d'altitude manquent
      etat.altitude = { statut: "erreur", profil: null };
      afficherAltitude();
      return;
    }
  }

  // Toutes les altitudes sont connues : on construit le profil
  const brutes = echantillons.map((e) => cacheAltitudes.get(cleAltitude(e.latlng)));
  if (brutes.some((a) => !Number.isFinite(a))) {
    etat.altitude = { statut: "erreur", profil: null };
    afficherAltitude();
    return;
  }
  const altitudes = lisser(brutes, FENETRE_LISSAGE);
  const { dPlus, dMoins } = calculerDenivele(altitudes, SEUIL_DENIVELE);

  etat.altitude = {
    statut: "ok",
    profil: {
      distances: echantillons.map((e) => e.d),
      latlngs: echantillons.map((e) => e.latlng),
      altitudes,
      dPlus,
      dMoins,
      min: Math.min(...altitudes),
      max: Math.max(...altitudes),
    },
  };
  afficherAltitude();
}

// Bouton « Réessayer » pour l'altitude
function reessayerAltitude() {
  calculerProfil();
}

/* ---------------------------------------------------------
   6. Marqueurs (points déplaçables)
   --------------------------------------------------------- */

// Icône ronde avec un numéro ; le point de départ est vert et marqué « D »
function iconePoint(index) {
  const estDepart = index === 0;
  return L.divIcon({
    className: "marqueur-point" + (estDepart ? " marqueur-depart" : ""),
    html: estDepart ? "D" : String(index + 1),
    iconSize: [24, 24],
    iconAnchor: [12, 12], // le centre du rond est exactement sur le point
  });
}

function creerMarqueur(latlng, index) {
  const marqueur = L.marker(latlng, {
    icon: iconePoint(index),
    draggable: true,     // permet de faire glisser le point
    autoPan: true,       // la carte défile si on approche du bord en glissant
  }).addTo(carte);

  marqueur.on("dragstart", () => {
    etat.marqueurEnGlissement = marqueur;
  });
  // Pendant le glissement : lignes droites provisoires, mises à jour en direct
  // (on n'interroge pas le service de routage à chaque petit mouvement)
  marqueur.on("drag", () => deplacerPoint(marqueur, false));
  // Au lâcher : on calcule le vrai chemin
  marqueur.on("dragend", () => {
    etat.marqueurEnGlissement = null;
    deplacerPoint(marqueur, true);
  });

  return marqueur;
}

/* ---------------------------------------------------------
   7. Actions sur le parcours
   --------------------------------------------------------- */

function ajouterPoint(latlng) {
  const index = etat.points.length;
  etat.points.push({ latlng, marqueur: creerMarqueur(latlng, index) });

  if (index === 0) {
    // Premier point : pas encore de segment
  } else if (etat.boucle) {
    // Boucle fermée : le nouveau point s'insère avant le retour au départ.
    // L'ancien segment « dernier point → départ » devient « ancien dernier → nouveau »,
    // et on ajoute « nouveau → départ ».
    recalculerSegments([index - 1, index]);
  } else {
    recalculerSegments([index - 1]);
  }
  mettreAJour();
}

// avecRoutage = false pendant le glissement, true au lâcher du point
function deplacerPoint(marqueur, avecRoutage) {
  // On retrouve le numéro du point à partir de son marqueur
  const k = etat.points.findIndex((p) => p.marqueur === marqueur);
  if (k === -1) return;
  etat.points[k].latlng = marqueur.getLatLng();
  recalculerSegments(segmentsVoisins(k), avecRoutage);
  mettreAJour();
}

// Option « Suivre les chemins » cochée / décochée : on recalcule le tracé,
// sauf les morceaux importés d'un GPX (on ne veut pas perdre le tracé d'origine)
function changerRoutage(actif) {
  etat.routage = actif;
  recalculerSegments(tousLesSegments().filter((s) => etat.segments[s].mode !== "importe"));
  mettreAJour();
}

// Bouton « Réessayer » : on relance uniquement les segments en échec
function reessayerRoutage() {
  const enEchec = tousLesSegments().filter((s) => etat.segments[s].mode === "secours");
  recalculerSegments(enEchec);
  mettreAJour();
}

function annulerDernierPoint() {
  if (etat.points.length === 0) return;

  if (etat.boucle) {
    // Si la boucle est fermée, « annuler » la rouvre simplement
    etat.boucle = false;
    etat.segments.pop();
  } else {
    const dernier = etat.points.pop();
    carte.removeLayer(dernier.marqueur);
    etat.segments.pop(); // ne fait rien s'il n'y avait qu'un point
  }
  mettreAJour();
}

// Retire tous les points et segments (sans demander de confirmation)
function viderParcours() {
  for (const p of etat.points) carte.removeLayer(p.marqueur);
  etat.points = [];
  etat.segments = [];
  etat.boucle = false;
}

function effacerTout() {
  if (etat.points.length === 0) return;
  if (!confirm("Effacer tout le parcours ?")) return;
  viderParcours();
  mettreAJour();
}

function fermerBoucle() {
  // Il faut au moins 2 points, et la boucle ne doit pas déjà être fermée
  if (etat.points.length < 2 || etat.boucle) return;
  etat.boucle = true;
  recalculerSegments([etat.points.length - 1]); // segment dernier point → départ
  mettreAJour();
}

/* ---------------------------------------------------------
   8. Affichage : tracé, statistiques, boutons
   --------------------------------------------------------- */

// Format français : 12,34
function formatNombre(valeur, decimales) {
  return valeur.toLocaleString("fr-FR", {
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  });
}

function dessinerTrace() {
  coucheTrace.clearLayers();
  for (const segment of etat.segments) {
    // interactive: false → cliquer sur la ligne ajoute un point comme ailleurs sur la carte
    const style = STYLES_PAR_MODE[segment.mode];
    L.polyline(segment.geometrie, { ...style, interactive: false }).addTo(coucheTrace);
  }
}

// Zone de message : texte, type ("info" ou "erreur") et action du bouton « Réessayer »
let actionReessayer = null;

function afficherMessage(texte, type, action = null) {
  const zone = document.getElementById("message");
  document.getElementById("message-texte").textContent = texte;
  zone.classList.toggle("info", type === "info");
  zone.hidden = false;
  actionReessayer = action;
  document.getElementById("btn-reessayer").hidden = action === null;
}

function masquerMessage() {
  document.getElementById("message").hidden = true;
  actionReessayer = null;
}

// Choisit le message à afficher d'après l'état actuel
function majMessage() {
  const nbEchecs = etat.segments.filter((s) => s.mode === "secours").length;
  if (etat.requetesEnCours > 0) {
    const suite = etat.requetesEnCours > 1 ? ` (${etat.requetesEnCours} tronçons en attente)` : "";
    afficherMessage("Calcul de l'itinéraire…" + suite, "info");
  } else if (nbEchecs > 0) {
    afficherMessage(
      `Itinéraire indisponible : ${nbEchecs} tronçon(s) tracé(s) en ligne droite (pointillés).`,
      "erreur",
      reessayerRoutage
    );
  } else if (etat.altitude.statut === "chargement") {
    afficherMessage("Calcul des altitudes…", "info");
  } else if (etat.altitude.statut === "erreur") {
    afficherMessage(
      "Altitude indisponible (service injoignable ou pas de réseau). La distance reste valable.",
      "erreur",
      reessayerAltitude
    );
  } else {
    masquerMessage();
  }
}

function afficherStats() {
  const distanceTotale = etat.segments.reduce((somme, s) => somme + s.distance, 0);
  document.getElementById("stat-distance").textContent =
    formatNombre(distanceTotale / 1000, 2) + " km";
  afficherTemps();
}

// Affiche D+, D-, altitudes min/max (ou « — » si indisponibles)
function afficherAltitude() {
  const profil = etat.altitude.statut === "ok" ? etat.altitude.profil : null;
  // Pendant un chargement, on garde les anciennes valeurs pour éviter le clignotement
  if (etat.altitude.statut !== "chargement") {
    const texte = (valeur) => (profil ? formatNombre(valeur, 0) + " m" : "—");
    document.getElementById("stat-dplus").textContent = texte(profil && profil.dPlus);
    document.getElementById("stat-dmoins").textContent = texte(profil && profil.dMoins);
    document.getElementById("stat-altmin").textContent = texte(profil && profil.min);
    document.getElementById("stat-altmax").textContent = texte(profil && profil.max);
    dessinerProfil();
    afficherTemps(); // le D+ entre dans l'estimation du temps
  }
  majMessage();
}

/* ---------------------------------------------------------
   8 bis. Profil altimétrique (graphique Chart.js)
   --------------------------------------------------------- */

let graphiqueProfil = null; // créé au premier affichage

// Couleurs lues dans le CSS, pour suivre le thème clair / sombre
function couleursTheme() {
  const css = getComputedStyle(document.documentElement);
  return {
    texte: css.getPropertyValue("--texte-doux").trim(),
    grille: css.getPropertyValue("--bordure").trim(),
    trace: STYLE_TRACE.color,
  };
}

// Rond affiché sur la carte à la position survolée dans le profil
const marqueurSurvol = L.circleMarker([0, 0], {
  radius: 7,
  color: "#fff",            // contour blanc, visible sur tous les fonds
  weight: 3,
  fillColor: STYLE_TRACE.color,
  fillOpacity: 1,
  interactive: false,
});

// Plugin Chart.js : quand on survole le profil, on montre l'endroit sur la carte
const pluginSuiviCarte = {
  id: "suiviCarte",
  afterEvent(chart, args) {
    const profil = etat.altitude.profil;
    // La souris quitte le graphique : on retire le rond
    if (args.event.type === "mouseout" || !profil) {
      marqueurSurvol.remove();
      return;
    }
    const actifs = chart.tooltip ? chart.tooltip.getActiveElements() : [];
    if (actifs.length === 0) return;
    // L'indice du point survolé est le même dans le graphique et dans le profil
    const latlng = profil.latlngs[actifs[0].index];
    if (!latlng) return;
    marqueurSurvol.setLatLng(latlng);
    if (!carte.hasLayer(marqueurSurvol)) marqueurSurvol.addTo(carte);
  },
};

// Petit module (« plugin ») Chart.js : trait vertical à l'endroit survolé
const pluginCurseurVertical = {
  id: "curseurVertical",
  afterDatasetsDraw(chart) {
    const actifs = chart.tooltip ? chart.tooltip.getActiveElements() : [];
    if (actifs.length === 0) return;
    const x = actifs[0].element.x;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = couleursTheme().texte;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function creerGraphiqueProfil() {
  const c = couleursTheme();
  const axe = {
    grid: { color: c.grille },
    border: { display: false },
    ticks: { color: c.texte },
  };

  return new Chart(document.getElementById("profil-canvas"), {
    type: "line",
    data: {
      datasets: [
        {
          label: "Altitude",
          data: [],
          borderColor: c.trace,
          borderWidth: 2,
          backgroundColor: c.trace + "33", // même couleur, très transparente (33 ≈ 20 %)
          fill: "start",                    // remplit sous la courbe
          pointRadius: 0,                   // pas de point visible…
          pointHoverRadius: 5,              // …sauf celui survolé
          pointHoverBackgroundColor: c.trace,
          pointHoverBorderColor: "#fff",
          pointHoverBorderWidth: 2,
          tension: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false, // la hauteur est fixée par le CSS
      animation: false,           // mise à jour instantanée à chaque modification
      locale: "fr-FR",
      // Le survol suit l'axe horizontal : pas besoin de viser la courbe exactement
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (elements) => formatNombre(elements[0].parsed.x, 2) + " km",
            label: (element) => formatNombre(element.parsed.y, 0) + " m",
          },
        },
      },
      scales: {
        x: {
          ...axe,
          type: "linear",
          ticks: { ...axe.ticks, callback: (v) => formatNombre(v, v % 1 === 0 ? 0 : 1) + " km" },
        },
        y: {
          ...axe,
          ticks: { ...axe.ticks, callback: (v) => formatNombre(v, 0) + " m" },
        },
      },
    },
    plugins: [pluginCurseurVertical, pluginSuiviCarte],
  });
}

function dessinerProfil() {
  const profil = etat.altitude.statut === "ok" ? etat.altitude.profil : null;
  const texteVide = document.getElementById("profil-vide");

  if (!profil) {
    // Pas de profil : on vide le graphique et on explique pourquoi
    if (graphiqueProfil) {
      graphiqueProfil.data.datasets[0].data = [];
      graphiqueProfil.update();
    }
    texteVide.hidden = false;
    texteVide.textContent =
      etat.altitude.statut === "erreur"
        ? "Profil indisponible : le service d'altitude ne répond pas."
        : "Ajoute au moins deux points pour voir le profil.";
    return;
  }

  texteVide.hidden = true;
  if (!graphiqueProfil) graphiqueProfil = creerGraphiqueProfil();

  const donnees = profil.distances.map((d, i) => ({ x: d / 1000, y: profil.altitudes[i] }));
  const graphique = graphiqueProfil;
  graphique.data.datasets[0].data = donnees;
  graphique.options.scales.x.min = 0;
  graphique.options.scales.x.max = donnees[donnees.length - 1].x;
  // Marge de 10 m au-dessus et en dessous, pour que la courbe ne touche pas les bords
  graphique.options.scales.y.suggestedMin = Math.floor(profil.min - 10);
  graphique.options.scales.y.suggestedMax = Math.ceil(profil.max + 10);
  graphique.update();
}

// Si l'utilisateur change de thème (clair / sombre), on recrée le graphique
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (graphiqueProfil) {
    graphiqueProfil.destroy();
    graphiqueProfil = null;
  }
  dessinerProfil();
});

function majBoutons() {
  const n = etat.points.length;
  document.getElementById("btn-annuler").disabled = n === 0;
  document.getElementById("btn-effacer").disabled = n === 0;
  document.getElementById("btn-boucle").disabled = n < 2 || etat.boucle;
  document.getElementById("btn-gpx").disabled = etat.segments.length === 0;
}

// Fonction centrale appelée après chaque modification du parcours
function mettreAJour() {
  dessinerTrace();
  afficherStats();
  majBoutons();
  majMessage();
  planifierAltitude();  // le tracé a changé : on recalcule l'altitude (après un court délai)
  planifierSauvegarde(); // et on le sauvegarde dans le navigateur
}

/* ---------------------------------------------------------
   9. Branchement des événements
   --------------------------------------------------------- */

// Clic (ou tap sur téléphone) sur la carte → nouveau point
carte.on("click", (e) => ajouterPoint(e.latlng));

document.getElementById("btn-annuler").addEventListener("click", annulerDernierPoint);
document.getElementById("btn-effacer").addEventListener("click", effacerTout);
document.getElementById("btn-boucle").addEventListener("click", fermerBoucle);

// Case « Suivre les chemins »
const caseRoutage = document.getElementById("chk-routage");
caseRoutage.checked = etat.routage;
caseRoutage.addEventListener("change", () => changerRoutage(caseRoutage.checked));

// Bouton « Réessayer » de la zone de message : exécute l'action en cours
document.getElementById("btn-reessayer").addEventListener("click", () => {
  if (actionReessayer) actionReessayer();
});

document.getElementById("btn-gpx").addEventListener("click", exporterGPX);

/* ---------------------------------------------------------
   10. Sauvegarde automatique dans le navigateur (localStorage)
   ---------------------------------------------------------
   On enregistre les points, la boucle, l'option de routage, et la géométrie
   des tronçons déjà calculés : au rechargement, pas besoin de redemander
   les itinéraires au service (limité à 1 requête par seconde).
   --------------------------------------------------------- */

const CLE_SAUVEGARDE = "trace-course-parcours";
let minuterieSauvegarde = null;

// Arrondi à 6 décimales (~10 cm) : suffisant, et la sauvegarde reste légère
function arrondir6(x) {
  return Math.round(x * 1e6) / 1e6;
}

function enTableau(latlng) {
  return [arrondir6(latlng.lat), arrondir6(latlng.lng)];
}

// On regroupe les sauvegardes : une seule écriture après 0,5 s de calme
function planifierSauvegarde() {
  clearTimeout(minuterieSauvegarde);
  minuterieSauvegarde = setTimeout(sauvegarderParcours, 500);
}

function sauvegarderParcours() {
  const donnees = {
    version: 1,
    routage: etat.routage,
    boucle: etat.boucle,
    points: etat.points.map((p) => enTableau(p.latlng)),
    // Seuls les tronçons qui suivent un vrai tracé (chemin calculé ou GPX importé)
    // ont une géométrie utile à garder ; les autres seront recalculés au chargement.
    segments: etat.segments.map((s) =>
      suitUnTrace(s) ? { mode: s.mode, geometrie: s.geometrie.map(enTableau) } : null
    ),
  };
  try {
    localStorage.setItem(CLE_SAUVEGARDE, JSON.stringify(donnees));
  } catch (erreur) {
    // Stockage plein ou bloqué (navigation privée) : l'appli fonctionne quand même
    console.warn("Sauvegarde impossible :", erreur.message);
  }
}

// Recharge le parcours sauvegardé. Renvoie true si un parcours a été restauré.
function restaurerParcours() {
  let donnees;
  try {
    donnees = JSON.parse(localStorage.getItem(CLE_SAUVEGARDE));
  } catch (erreur) {
    return false; // stockage indisponible ou contenu illisible
  }
  if (!donnees || !Array.isArray(donnees.points) || donnees.points.length === 0) return false;

  etat.routage = donnees.routage !== false;
  caseRoutage.checked = etat.routage;
  etat.boucle = Boolean(donnees.boucle) && donnees.points.length >= 2;

  // 1. Les points (et leurs marqueurs)
  donnees.points.forEach(([lat, lng], i) => {
    const latlng = L.latLng(lat, lng);
    etat.points.push({ latlng, marqueur: creerMarqueur(latlng, i) });
  });

  // 2. Les segments : on réutilise les tracés sauvegardés, on recalcule les autres
  const nbSegments = etat.points.length - 1 + (etat.boucle ? 1 : 0);
  const aRecalculer = [];
  for (let s = 0; s < nbSegments; s++) {
    const sauve = Array.isArray(donnees.segments) ? donnees.segments[s] : null;
    // Les anciennes sauvegardes n'indiquaient pas le mode : c'était forcément « route »
    const mode = sauve && sauve.mode === "importe" ? "importe" : "route";
    // Un morceau importé est toujours repris ; un chemin calculé seulement si le routage est actif
    const reutilisable =
      sauve && Array.isArray(sauve.geometrie) && sauve.geometrie.length >= 2 &&
      (mode === "importe" || etat.routage);
    if (reutilisable) {
      const geometrie = sauve.geometrie.map(([lat, lng]) => L.latLng(lat, lng));
      etat.segments[s] = {
        geometrie,
        distance: longueurGeometrie(geometrie),
        mode,
        jeton: ++dernierJeton,
      };
    } else {
      aRecalculer.push(s);
    }
  }
  recalculerSegments(aRecalculer);

  // 3. On cadre la carte sur le parcours
  const tousLesPoints = etat.segments.flatMap((s) => s.geometrie);
  carte.fitBounds(L.latLngBounds(tousLesPoints.length ? tousLesPoints : etat.points.map((p) => p.latlng)), {
    padding: [30, 30],
    maxZoom: 16,
  });
  return true;
}

// Dernière sauvegarde quand on ferme ou quitte la page (au cas où le délai n'est pas écoulé)
window.addEventListener("pagehide", sauvegarderParcours);

/* ---------------------------------------------------------
   11. Export GPX
   ---------------------------------------------------------
   Le GPX est le format standard des montres GPS et des applis (Strava, Garmin…).
   On exporte tout le tracé, avec l'altitude de chaque point si elle est connue.
   --------------------------------------------------------- */

// Remplace les caractères spéciaux du XML (&, <, >, ")
function echapperXML(texte) {
  return texte.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// Tous les points du tracé, dans l'ordre, avec leur distance depuis le départ
function pointsDuTrace() {
  const resultat = [];
  let decalage = 0;
  etat.segments.forEach((segment, s) => {
    let parcouru = 0;
    segment.geometrie.forEach((latlng, i) => {
      if (i > 0) parcouru += segment.geometrie[i - 1].distanceTo(latlng);
      // Le 1er point d'un segment = dernier point du précédent : on ne le duplique pas
      if (s > 0 && i === 0) return;
      resultat.push({ latlng, d: decalage + parcouru });
    });
    decalage += segment.distance;
  });
  return resultat;
}

// Altitude à une distance donnée, par interpolation linéaire dans le profil.
// « curseur » mémorise où l'on en est, car les distances arrivent dans l'ordre croissant.
function altitudeA(distance, profil, curseur) {
  const { distances, altitudes } = profil;
  while (curseur.i < distances.length - 2 && distances[curseur.i + 1] < distance) curseur.i++;
  const d0 = distances[curseur.i];
  const d1 = distances[curseur.i + 1];
  if (d1 === undefined || d1 === d0) return altitudes[curseur.i];
  const t = Math.min(1, Math.max(0, (distance - d0) / (d1 - d0)));
  return altitudes[curseur.i] + t * (altitudes[curseur.i + 1] - altitudes[curseur.i]);
}

function exporterGPX() {
  if (etat.segments.length === 0) return;

  const profil = etat.altitude.statut === "ok" ? etat.altitude.profil : null;
  const distanceKm = etat.segments.reduce((somme, s) => somme + s.distance, 0) / 1000;
  const aujourdhui = new Date().toISOString().slice(0, 10); // ex. 2026-10-09
  const nom = `Parcours ${formatNombre(distanceKm, 1)} km (${aujourdhui})`;

  const curseur = { i: 0 };
  const lignesPoints = pointsDuTrace().map(({ latlng, d }) => {
    const ele = profil ? `<ele>${altitudeA(d, profil, curseur).toFixed(1)}</ele>` : "";
    return `      <trkpt lat="${latlng.lat.toFixed(6)}" lon="${latlng.lng.toFixed(6)}">${ele}</trkpt>`;
  });

  const gpx = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Trace Course" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${echapperXML(nom)}</name></metadata>`,
    "  <trk>",
    `    <name>${echapperXML(nom)}</name>`,
    "    <type>running</type>",
    "    <trkseg>",
    ...lignesPoints,
    "    </trkseg>",
    "  </trk>",
    "</gpx>",
  ].join("\n");

  // Téléchargement : on crée un fichier en mémoire et on « clique » sur un lien vers lui
  const fichier = new Blob([gpx], { type: "application/gpx+xml" });
  const lien = document.createElement("a");
  lien.href = URL.createObjectURL(fichier);
  lien.download = `parcours-${aujourdhui}.gpx`;
  document.body.appendChild(lien);
  lien.click();
  lien.remove();
  setTimeout(() => URL.revokeObjectURL(lien.href), 1000);

  if (!profil) {
    alert("Le GPX a été exporté sans altitudes (service d'altitude indisponible).");
  }
}

/* ---------------------------------------------------------
   11 bis. Import GPX
   ---------------------------------------------------------
   On garde le tracé du fichier tel quel, mais on y place seulement quelques
   points de passage déplaçables (environ tous les 500 m, 40 au maximum).
   Chaque morceau entre deux points de passage devient un segment « importe ».
   Déplacer un point recalcule seulement les deux morceaux voisins.
   --------------------------------------------------------- */

const ECART_MIN_IMPORT = 500;   // mètres minimum entre deux points de passage
const MAX_POINTS_IMPORT = 40;   // nombre maximum de points de passage
const DISTANCE_BOUCLE = 50;     // arrivée à moins de 50 m du départ → c'est une boucle

// Lit le texte d'un fichier GPX et renvoie la liste des points du tracé (LatLng)
function lireGPX(texte) {
  const doc = new DOMParser().parseFromString(texte, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("le fichier n'est pas un GPX valide");
  }
  // Un GPX peut contenir une trace (trkpt) ou un itinéraire (rtept)
  let noeuds = doc.getElementsByTagName("trkpt");
  if (noeuds.length === 0) noeuds = doc.getElementsByTagName("rtept");

  const points = [];
  for (const noeud of noeuds) {
    const lat = parseFloat(noeud.getAttribute("lat"));
    const lng = parseFloat(noeud.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const latlng = L.latLng(lat, lng);
    // On ignore les points en double consécutifs (fréquents quand la montre est à l'arrêt)
    if (points.length > 0 && points[points.length - 1].distanceTo(latlng) < 0.5) continue;
    points.push(latlng);
  }
  if (points.length < 2) throw new Error("aucun tracé trouvé dans le fichier");
  return points;
}

// Remplace le parcours actuel par le tracé importé
function importerTrace(trace) {
  // Distance cumulée depuis le départ pour chaque point du tracé
  const cumul = [0];
  for (let i = 1; i < trace.length; i++) {
    cumul.push(cumul[i - 1] + trace[i - 1].distanceTo(trace[i]));
  }
  const total = cumul[cumul.length - 1];
  const dernier = trace.length - 1;

  // Choix des points de passage : un tous les « ecart » mètres, plus le départ et l'arrivée
  const ecart = Math.max(ECART_MIN_IMPORT, total / MAX_POINTS_IMPORT);
  const indices = [0];
  let prochain = ecart;
  for (let i = 1; i < dernier; i++) {
    if (cumul[i] >= prochain) {
      indices.push(i);
      prochain = cumul[i] + ecart;
    }
  }
  // Pas de point de passage collé à l'arrivée
  if (indices.length > 1 && total - cumul[indices[indices.length - 1]] < ecart / 3) indices.pop();
  indices.push(dernier);

  // Boucle : l'arrivée ≈ le départ. Le dernier point de passage n'est alors pas créé :
  // le dernier segment ramène au point de départ.
  const boucle =
    trace[0].distanceTo(trace[dernier]) < DISTANCE_BOUCLE && indices.length >= 3;
  const indicesPoints = boucle ? indices.slice(0, -1) : indices;

  viderParcours();
  etat.boucle = boucle;
  indicesPoints.forEach((iTrace, k) => {
    const latlng = trace[iTrace];
    etat.points.push({ latlng, marqueur: creerMarqueur(latlng, k) });
  });
  // Un segment par paire de points de passage consécutifs (slice : fin non incluse, d'où + 1)
  for (let k = 0; k < indices.length - 1; k++) {
    const geometrie = trace.slice(indices[k], indices[k + 1] + 1);
    etat.segments.push({
      geometrie,
      distance: longueurGeometrie(geometrie),
      mode: "importe",
      jeton: ++dernierJeton,
    });
  }

  carte.fitBounds(L.latLngBounds(trace), { padding: [30, 30] });
  mettreAJour();
}

// Fichier choisi par l'utilisateur : lecture, vérification, import
async function fichierGPXChoisi(evenement) {
  const champ = evenement.target;
  const fichier = champ.files[0];
  champ.value = ""; // permet de réimporter le même fichier plus tard
  if (!fichier) return;

  if (etat.points.length > 0 && !confirm("Remplacer le parcours actuel par le fichier importé ?")) {
    return;
  }
  try {
    const trace = lireGPX(await fichier.text());
    importerTrace(trace);
  } catch (erreur) {
    alert(`Import impossible : ${erreur.message}.`);
  }
}

// Le bouton visible ouvre le sélecteur de fichier caché
document.getElementById("btn-import").addEventListener("click", () => {
  document.getElementById("fichier-gpx").click();
});
document.getElementById("fichier-gpx").addEventListener("change", fichierGPXChoisi);

/* ---------------------------------------------------------
   11 ter. Estimation du temps de course
   ---------------------------------------------------------
   Règle du « km-effort », courante en trail : 100 m de D+ demandent à peu près
   le même effort qu'1 km de plat. Le temps estimé vaut donc :
       allure sur le plat × (distance en km + D+ / 100)
   Les descentes ne sont pas comptées (elles ne ralentissent qu'en terrain technique).
   --------------------------------------------------------- */

const METRES_DPLUS_PAR_KM_EFFORT = 100;
const CLE_ALLURE = "trace-course-allure";
const champMinutes = document.getElementById("allure-min");
const champSecondes = document.getElementById("allure-sec");

// Allure saisie, en secondes par km ; null si la saisie n'est pas valable
function lireAllure() {
  const minutes = Number(champMinutes.value);
  const secondes = Number(champSecondes.value || 0);
  const valable =
    Number.isInteger(minutes) && minutes >= 2 && minutes <= 20 &&
    Number.isInteger(secondes) && secondes >= 0 && secondes <= 59;
  return valable ? minutes * 60 + secondes : null;
}

// 3 900 s → « 1 h 05 » ; 2 700 s → « 45 min »
function formatDuree(secondesTotales) {
  const minutesTotales = Math.round(secondesTotales / 60);
  const heures = Math.floor(minutesTotales / 60);
  const minutes = minutesTotales % 60;
  return heures > 0 ? `${heures} h ${String(minutes).padStart(2, "0")}` : `${minutes} min`;
}

function afficherTemps() {
  const valeur = document.getElementById("stat-temps");
  const detail = document.getElementById("stat-temps-detail");
  const allure = lireAllure();
  const distanceKm = etat.segments.reduce((somme, s) => somme + s.distance, 0) / 1000;

  if (allure === null) {
    valeur.textContent = "—";
    detail.textContent = "allure invalide";
    return;
  }
  if (distanceKm === 0) {
    valeur.textContent = "—";
    detail.textContent = "";
    return;
  }
  const profil = etat.altitude.statut === "ok" ? etat.altitude.profil : null;
  const kmEffort = distanceKm + (profil ? profil.dPlus / METRES_DPLUS_PAR_KM_EFFORT : 0);
  valeur.textContent = formatDuree(kmEffort * allure);
  detail.textContent = profil ? `${formatNombre(kmEffort, 1)} km-effort` : "sans le dénivelé";
}

// Allure mémorisée lors d'une visite précédente
try {
  const allureSauvee = JSON.parse(localStorage.getItem(CLE_ALLURE));
  if (allureSauvee) {
    champMinutes.value = allureSauvee.minutes;
    champSecondes.value = String(allureSauvee.secondes).padStart(2, "0");
  }
} catch (erreur) {
  /* stockage indisponible : on garde l'allure par défaut */
}

// À chaque modification de l'allure : nouvelle estimation, et on la mémorise si elle est valable
function allureModifiee() {
  afficherTemps();
  const allure = lireAllure();
  if (allure === null) return;
  try {
    localStorage.setItem(
      CLE_ALLURE,
      JSON.stringify({ minutes: Math.floor(allure / 60), secondes: allure % 60 })
    );
  } catch (erreur) {
    /* pas grave */
  }
}
champMinutes.addEventListener("input", allureModifiee);
champSecondes.addEventListener("input", allureModifiee);

/* ---------------------------------------------------------
   12. Démarrage
   --------------------------------------------------------- */

// Si un parcours était sauvegardé, on le recharge (et la carte se cadre dessus) ;
// sinon on essaie de centrer la carte sur la position de l'utilisateur.
let parcoursRestaure = false;
try {
  parcoursRestaure = restaurerParcours();
} catch (erreur) {
  // Sauvegarde abîmée : on repart d'un parcours vide plutôt que de bloquer la page
  console.warn("Sauvegarde illisible, ignorée :", erreur.message);
  viderParcours();
}
if (!parcoursRestaure) centrerSurPosition();
mettreAJour();

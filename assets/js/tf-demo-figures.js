/* Chiffres du jeu de demonstration — source unique.
 *
 * POURQUOI CE FICHIER EXISTE
 *
 * La meme metrique s'affichait avec deux valeurs selon la page : 92,4 % de
 * qualite des donnees sur l'accueil, 91,4 % dans la console. Egalement
 * 84 contre 85,3, 78 contre 77,9, 91 contre 91,8.
 *
 * Pour une plateforme dont l'argument est « pouvez-vous faire confiance a vos
 * donnees ? », afficher deux valeurs pour un meme indicateur detruit la
 * demonstration avant qu'elle ne commence. C'est la premiere chose qu'un
 * responsable conformite remarque, et il a raison de la remarquer.
 *
 * D'OU VENAIT L'ECART
 *
 * Pas d'un desaccord : d'un tirage au sort. Les effectifs de la console
 * etaient CONSTRUITS pour tomber juste — le code dit lui-meme « somme
 * exactement egale a la cible » — mais les taux etaient echantillonnes,
 * `r() < 0.84` produit par produit. Sur 1 248 produits cela donne 85,3 %.
 *
 * C'etait du bruit d'echantillonnage affiche comme une mesure.
 *
 * LES VALEURS
 *
 * Ce ne sont pas des valeurs arbitrees : ce sont celles du cahier des
 * charges. L'accueil les respectait deja, la console avait derive.
 *
 * Ce fichier est en JSON strict apres le signe egal, pour qu'un test puisse
 * le lire sans navigateur et tenir les deux surfaces a la meme reference.
 *
 * PORTEE
 *
 * La console lit ces valeurs a l'execution. L'accueil, lui, tire ses
 * compteurs du catalogue i18n — sept fichiers ou la valeur est reecrite a
 * la main, langue par langue. Un traducteur peut y saisir 93,4 % sans que
 * rien ne bronche. C'est pourquoi le test de coherence ne compare pas des
 * pages mais des nombres : il relit les sept catalogues et exige que la
 * valeur numerique, format local mis a part, soit celle d'ici.
 *
 * Le bloc « noeuds » couvre le visuel heros : dix noeuds, chacun avec sa
 * valeur et jusqu'a trois lignes de survol. Trente-huit chiffres de plus,
 * reecrits a la main dans sept catalogues — deux cent soixante-six
 * cellules. Ils sont declares ici pour que le test puisse poser la regle
 * forte : aucun nombre du catalogue ne doit lui etre inconnu.
 */
window.TF_DEMO_FIGURES = {
  "produits": 1248,
  "fournisseurs": 86,
  "sites": 214,
  "pays": 18,
  "qualite": 92.4,
  "preuves": 84,
  "verifies": 78,
  "tracables": 91,
  "dpp": 88,
  "elementsPreuve": 9847,
  "signauxOuverts": 42,
  "noeuds": {
    "suppliers": {
      "value": 86,
      "r1v": 86,
      "r2v": 18,
      "r3v": 87
    },
    "products": {
      "value": 1248,
      "r1v": 1248,
      "r2v": 1094,
      "r3v": 4310
    },
    "materials": {
      "value": 3106,
      "r1v": 3106,
      "r2v": 71,
      "r3v": 94
    },
    "facilities": {
      "value": 214,
      "r1v": 214,
      "r2v": 188,
      "r3v": 132
    },
    "documents": {
      "value": 9847,
      "r1v": 9847,
      "r2v": 6220,
      "r3v": 84
    },
    "certifications": {
      "value": 612,
      "r1v": 612,
      "r2v": 8,
      "r3v": 21
    },
    "evidence": {
      "value": 84,
      "r1v": 84,
      "r2v": 78
    },
    "quality": {
      "value": 92.4,
      "r1v": 92.4,
      "r2v": 78,
      "r3v": 42
    },
    "traceability": {
      "value": 91,
      "r1v": 91,
      "r2v": 63
    },
    "dpp": {
      "value": 88,
      "r1v": 88,
      "r2v": 1098,
      "r3v": 150
    }
  },
  "attention": {
    "donneesManquantes": 17,
    "certificatsExpirant": 8,
    "fournisseursARevoir": 5,
    "produitsIncomplets": 12
  }
};

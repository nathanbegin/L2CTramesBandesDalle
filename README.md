# L2C — Trame des bandes de dalle

Application web (sans serveur) pour définir les bandes de dalle SAFE 23 (post-tension) à partir d'un plan PDF :

- import d'un PDF : axes, empreinte, colonnes et limites bleues/violettes extraites du vectoriel, avec calage d'échelle
- création / édition des limites, générateur L/4
- import d'un .f2k SAFE, export .f2k des bandes (Z réglable)
- marquage des révisions par rapport au PDF
- projets stockés dans le navigateur (IndexedDB), sauvegarde/restauration en .json

Site statique : `index.html`, `pdfx.js`, `pdf.min.mjs`, `pdf.worker.min.mjs` (pdf.js 6.5.438, lecture des PDF), `pdf-lib.min.js` (pdf-lib 1.17.1, export PDF). Aucun build requis.
Test local : `python3 -m http.server` puis http://localhost:8000.

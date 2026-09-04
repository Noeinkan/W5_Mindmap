# Transcript Mind Map

Estrae un grafo tipizzato da un transcript con un modello Ollama locale e lo
rende modificabile in un layout force D3. La descrizione che finisce nella
dashboard e' il primo paragrafo del README.

<!--
  Il file e' committato: il testo di ogni riga e' ormai la sua identita' nella
  storia git, e riscriverlo azzera il cycle time. Le milestone da 4 in poi
  restano una proposta — quelle righe costano poco finche' nessuno le spunta.

  Verifica con:
    node C:/Personal_utilities/roadmap-format/roadmap-lint.mjs
-->

## Milestone: 1. Estrazione locale e grafo editabile <!-- due: 2026-01-19 -->

### Backend

- [x] 1.1 Server Express che serve la SPA statica e risponde su /api/health <!-- size: S; done: 2026-01-19 -->
- [x] 1.2 Endpoint /api/extract verso Ollama con timeout, retry e backoff <!-- size: M; done: 2026-01-19 -->
- [x] 1.3 Chunking del transcript e merge dei grafi parziali <!-- size: M; done: 2026-01-19 -->
- [x] 1.4 Estrazione del JSON dalla risposta del modello e validazione dello schema <!-- size: M; done: 2026-01-19 -->
- [x] 1.5 Sanitizzazione del grafo e normalizzazione dei tipi di nodo e di arco <!-- size: M; done: 2026-01-19 -->
- [x] 1.6 Endpoint /api/extract/stream che manda l'avanzamento per chunk via SSE <!-- size: M; done: 2026-01-19 -->
- [x] 1.7 Errori con request id, dettagli esposti solo fuori da produzione <!-- size: S; done: 2026-01-19 -->

### Frontend

- [x] 1.8 Layout force D3 con drag dei nodi <!-- size: M; done: 2026-01-19 -->
- [x] 1.9 Selezione di un nodo e rinomina inline con doppio click <!-- size: S; done: 2026-01-19 -->
- [x] 1.10 Aggiunta e rimozione di nodi, con tipo scelto dal menu <!-- size: M; done: 2026-01-19 -->
- [x] 1.11 Modalita' arco: crea e rimuove archi tipizzati fra due nodi <!-- size: M; done: 2026-01-19 -->
- [x] 1.12 Export JSON del grafo corrente <!-- size: S; done: 2026-01-19 -->
- [x] 1.13 Riga di stato con avanzamento della generazione e messaggi di errore <!-- size: S; done: 2026-01-19 -->

## 2. Demo riproducibile <!-- due: 2026-08-22 -->

- [x] 2.1 Transcript di esempio inventato, per non usare materiale di un cliente <!-- size: S; done: 2026-08-22 -->
- [x] 2.2 Configurazione screenshot-kit che aspetta il grafo e il settling del force layout <!-- size: M; done: 2026-08-22 -->
- [x] 2.3 Note su quale modello Ollama regge la cattura e con che parametri <!-- size: S; done: 2026-08-22 -->

## 3. Persistenza dei grafi <!-- due: 2026-09-04 -->

Oggi l'unica uscita e' Export JSON e non esiste la strada di ritorno: un grafo
sistemato a mano si perde al reload.

Le tre porte scrivono lo stesso documento, e le regole di quel documento stanno
in un file solo (`public/js/graph-doc.js`): il server lo importa invece di
tenerne una copia, cosi' il file che l'app esporta e' per costruzione il file
che il server accetta.

- [x] 3.1 Import di un grafo JSON esportato, con validazione dello stesso schema del server <!-- size: S; done: 2026-09-04 -->
- [x] 3.2 Salvataggio automatico in localStorage e ripristino all'apertura <!-- size: S; done: 2026-09-04 -->
- [x] 3.3 Salvataggio dei grafi lato server, con id e elenco dei grafi salvati <!-- size: M; done: 2026-09-04 -->
- [x] 3.4 Rinomina ed eliminazione di un grafo salvato <!-- size: S; done: 2026-09-04 -->
- [x] 3.5 Conservare il transcript di partenza insieme al grafo <!-- size: S; done: 2026-09-04 -->

## 4. Qualita' dell'estrazione

- [x] 4.1 Portare OLLAMA_MODEL su un modello davvero installato: il default llama3.2:3b non c'e' <!-- size: S; done: 2026-09-04 -->
- [ ] 4.2 Selettore del modello in UI, popolato da /api/tags di Ollama <!-- size: M -->
- [ ] 4.3 Chunk finale corto che torna un grafo vuoto: unirlo al precedente invece di mostrare un errore <!-- size: S -->
- [ ] 4.4 Prompt che vincola le etichette a due o tre parole, perche' le frasi lunghe si accavallano nel layout <!-- size: S -->
- [ ] 4.5 Deduplica dei nodi che tornano uguali da chunk diversi <!-- size: M -->
- [ ] 4.6 Banco di transcript di riferimento per confrontare modelli e prompt su un metro fisso <!-- size: L -->
- [x] 4.7 Timeout di default alzato: 20 s non basta a nessun modello locale sul transcript intero <!-- size: S; done: 2026-09-04 -->

## 5. Editor del grafo

- [ ] 5.1 Zoom e pan sul canvas <!-- size: S -->
- [ ] 5.2 Undo e redo delle modifiche al grafo <!-- size: M -->
- [ ] 5.3 Ricerca di un nodo per etichetta, con evidenziazione <!-- size: M -->
- [ ] 5.4 Filtri per tipo di nodo e di arco <!-- size: M -->
- [x] 5.5 Etichette che si scansano invece di sovrapporsi al centro del canvas <!-- size: M; done: 2026-09-04 -->
- [ ] 5.6 Legenda dei tipi di nodo e di arco <!-- size: S -->
- [ ] 5.7 Export PNG o SVG del grafo disegnato <!-- size: S -->
- [ ] 5.8 D3 servito in locale invece che da d3js.org, cosi' l'app funziona offline <!-- size: S -->

## 6. Test e distribuzione

- [ ] 6.1 Test unitari su chunking, merge, sanitizzazione e normalizzazione dei tipi <!-- size: M -->
- [ ] 6.2 Test degli endpoint /api/extract e /api/extract/stream con Ollama simulato <!-- size: M -->
- [ ] 6.3 Workflow GitHub Actions che lancia i test a ogni push <!-- size: S -->
- [ ] 6.4 Script start portabile: oggi passa da PowerShell e gira solo su Windows <!-- size: S -->
- [ ] 6.5 CHANGELOG.md, cosi' che la dashboard mostri l'ultima release <!-- size: S -->

## 7. Resa: mappa radiale e note <!-- due: 2026-09-04 -->

Il force layout non produceva una mind map ma un grafo a nuvola: nessun centro,
nessun livello, una forma diversa a ogni run. E la citazione estratta dal
transcript, la cosa piu' utile del pipeline, finiva solo nel JSON.

- [x] 7.1 Radicare il grafo: testa di catena per componente, centro sintetico quando i componenti sono piu' di uno <!-- size: M; done: 2026-09-04 -->
- [x] 7.2 Layout radiale deterministico al posto di d3-force, con fetta angolare proporzionale alle foglie <!-- size: L; done: 2026-09-04 -->
- [x] 7.3 Rami come nastri rastremati e colore per ramo, tipo del nodo sul pallino e in legenda <!-- size: M; done: 2026-09-04 -->
- [x] 7.4 Etichette mandate a capo su piu' righe invece che troncate <!-- size: S; done: 2026-09-04 -->
- [x] 7.5 Archi fuori dall'albero disegnati come cross-link tratteggiati, non scartati <!-- size: S; done: 2026-09-04 -->
- [x] 7.6 Vista note: una scheda per concetto con id, citazione verbatim, link uscenti e backlink <!-- size: L; done: 2026-09-04 -->
- [x] 7.7 Selettore Mappa / Note in toolbar e da tastiera, con selezione condivisa fra le due viste <!-- size: M; done: 2026-09-04 -->
- [x] 7.8 Test su tree.js e layout.js, importati da Node senza build <!-- size: M; done: 2026-09-04 -->
- [x] 7.9 Titolo del centro salvato insieme al grafo, oggi si perde al reload <!-- size: S; done: 2026-09-04 -->
- [ ] 7.10 Ricerca che evidenzia anche le citazioni nella vista mappa, non solo nelle note <!-- size: S -->

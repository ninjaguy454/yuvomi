# Architektur: God-Nodes — Constraint-Brücken vs. organische Hubs

_Abgeleitet aus einer Wissensgraph-Analyse der Codebase (2026-07-08); die Import-/Aufruf-Zahlen sind per grep-Gegencheck ermittelt und zuletzt am 2026-08-05 aufgefrischt. Die Betweenness-Werte stammen aus der Analyse vom Juli und sind als Größenordnung zu lesen._

Die zentralsten Frontend-/Server-Utilities von Vidamia ("God-Nodes" im Wissensgraph)
zerfallen in **zwei Klassen**, die der Graph an der Provenienz ihrer Kanten trennt
(`INFERRED calls` vs. `EXTRACTED imports`):

| Node | Klasse | Importe / Aufrufe | Aufrufe/Datei | Betweenness | Getrieben von |
|------|--------|-------------------|---------------|-------------|---------------|
| [`esc()`](../public/utils/html.js) | Constraint-Brücke | 49 / ~1560 | ~32 | 0.260 | `innerHTML`-Verbot (Frontend-Audit) |
| [`toLocalDateKey()`](../public/utils/date.js) | Constraint-Brücke | 16 / 63 | ~4 | 0.131 | `.toISOString().slice(0,10)`-Verbot |
| [`createLogger()`](../server/logger.js) | organischer Hub | 75 / 77 | ~1 | niedrig | freiwillige Zentralisierung |

## Constraint-Brücken (`esc`, `toLocalDateKey`)

Hohe Betweenness, viele `INFERRED calls`, hohe Aufruf-Dichte pro Datei. Ihre Existenz
ist durch ein **Verbot erzwungen** — jedes Modul muss durch sie hindurch:

- `esc()` — das `innerHTML`-Verbot (durchgesetzt vom Frontend-Audit,
  `npm run test:frontend-audit`, Teil von `npm test` und CI) plus das Framework-Verbot
  bedeuten: jedes gerenderte Nutzer-Datum muss manuell durch `esc()`. Es gibt kein
  Auto-Escaping wie in React/Vue. Ergebnis: ~1560 Aufrufe über 49 Dateien, topologisch
  auf dem kürzesten Pfad zwischen fast allen Modul-Communities.
- `toLocalDateKey()` — die Konvention "nie `.toISOString().slice(0,10)`" (UTC-Shift
  westlich von UTC) macht diesen Helfer zum einzigen Weg, ein API-Datum zu erzeugen.
  Das verbotene Anti-Pattern hat im Frontend **0 Fundstellen** — lückenlos durchgesetzt.
  Zusätzlich ist der Node die Wurzel einer Helfer-Familie (`addLocalDays`,
  `parseLocalDateKey`, `startOfLocalWeekKey`, `shiftEndDateKey` — alle `EXTRACTED calls`).

In einer Framework-Codebase (Auto-Escaping im Renderer, Date-Library) wären beide Nodes
unsichtbar. Hier sind sie die meistverbundenen Frontend-Utilities — die graphtheoretische
Signatur von "no frameworks, no `innerHTML`, no UTC-slicing".

## Organische Hubs (`createLogger`)

Hoher Degree durch `EXTRACTED imports`, aber nur **~1 Aufruf pro Datei** — das
Modul-Singleton-Muster: jede Server-Datei instanziiert einmal `const log =
createLogger('mod')` am Dateikopf und nutzt danach `log.info(...)`. 75 Importe,
77 Aufrufe. Keine Regel verbietet `console.log`; die Zentralisierung
([`server/logger.js`](../server/logger.js) — strukturiertes JSON-Logging ohne externe
Dependency, gesteuert per `LOG_LEVEL`) ist ein bewusstes Design, das Entwickler
*freiwillig* wählen. In jeder Codebase zu erwarten. Ein Speichenrad, keine Brücke —
`createLogger` sitzt nicht auf den kürzesten Modul-zu-Modul-Pfaden.

## Messbare Trennlinie

- **Constraint-Brücke:** hohe *Betweenness* + `INFERRED calls` + hohe Aufruf-Dichte pro Datei.
- **Organischer Hub:** hoher *Degree* durch `EXTRACTED imports` + ~1 Aufruf pro Datei.

`createLogger` rangiert nach reinem Degree auf Platz 3 der God-Nodes, ist aber trotzdem
ein Hub und keine Brücke — Degree allein unterscheidet die Rollen nicht, Betweenness
und Kanten-Provenienz schon.

## Verifikations-Nebenbefund

Die `INFERRED`-Kanten an `esc()`, die der Graph-Report als prüfbedürftig markierte,
sind durch den grep-Gegencheck (heute 49 Importe, ~1560 Aufrufe) als **echt** bestätigt —
keine Halluzination der semantischen Extraktion.

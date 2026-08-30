/**
 * Modul: Review-Workflow-Guard
 * Zweck: Die vier Bedingungen, ohne die `claude-review` durchlaeuft und nichts
 *        hinterlaesst, stehen fest im Workflow. Jede davon hat schon einmal
 *        mehrere Anlaeufe gekostet, und keine faellt beim Lesen der Datei auf.
 * Ausfuehren: npm run test:claude-review-workflow
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../.github/workflows/claude-code-review.yml', import.meta.url),
  'utf8'
);

test('der Prompt traegt --comment, sonst prueft die Review und schweigt', () => {
  // Die Plugin-Anleitung: "If `--comment` argument was NOT provided, stop here.
  // Do not post any GitHub comments." Ohne das Flag sieht ein vollstaendiger
  // Lauf einer Sperre zum Verwechseln aehnlich.
  assert.match(workflow, /\/code-review:code-review[^\n]*--comment/);
});

test('die Subagenten laufen synchron', () => {
  // #865, 2026-08-25: viermal hintereinander nichts hinterlassen. Das Plugin
  // startet seine Agenten asynchron, und die Benachrichtigung ueber einen
  // fertigen Agenten trifft in einem CI-Lauf auf keinen Turn mehr - die
  // Hauptsession sagt "ich warte" und ist damit fertig. Reruns halfen nicht,
  // weil die Ursache strukturell ist und nicht sprunghaft.
  assert.match(workflow, /run_in_background:\s*false/,
    'die Anweisung, Subagenten synchron zu fahren, fehlt im Prompt');
});

test('Skill und Task stehen in den erlaubten Werkzeugen', () => {
  // `--allowed-tools` ERSETZT die Liste des Plugins. Ohne `Skill` kann die
  // Review ihr eigenes Kommando nicht ausfuehren, ohne `Task` keinen einzigen
  // ihrer Agenten starten - und dann improvisiert das Modell die Pruefung.
  const tools = workflow.match(/--allowed-tools\s*\n?\s*"([^"]+)"/)?.[1] ?? '';
  assert.ok(tools.includes('Skill'), '`Skill` fehlt - das Plugin-Kommando ist dann gesperrt');
  assert.ok(tools.includes('Task'), '`Task` fehlt - die Subagenten sind dann gesperrt');
  assert.ok(tools.includes('Bash(gh pr comment:*)'), 'ohne diesen Weg kann sie ihr Ergebnis nicht abliefern');
});

test('der Job darf schreiben, sonst kommt die Review nicht zu Wort', () => {
  assert.match(workflow, /pull-requests:\s*write/);
});

test('der Nachweis-Schritt prueft die Wirkung, nicht den Ablauf', () => {
  // Ein gruener Haken fuer eine Pruefung, die nie stattgefunden hat, ist
  // schlimmer als gar keiner: er laedt dazu ein, sich auf ihn zu verlassen.
  assert.match(workflow, /Die Review muss gesprochen haben/);
  assert.match(workflow, /exit 1/);
});

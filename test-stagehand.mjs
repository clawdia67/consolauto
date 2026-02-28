/**
 * test-stagehand.mjs — simula la finestra 23:30, fa UN check con Stagehand
 * Usage: node test-stagehand.mjs
 */
import "dotenv/config";
import { initStagehand, checkSlots, closeStagehand } from "./lib/stagehand-check.mjs";
import { notify } from "./lib/notify.mjs";

console.log("=== TEST: simulazione finestra 23:30 (Stagehand) ===");
console.log("Un solo ciclo di check — controlla login, naviga su Services, rileva slot.\n");

try {
  await initStagehand();
  console.log("[test] Stagehand inizializzato ✓");

  console.log("[test] avvio checkSlots()...");
  await checkSlots();

  console.log("\n[test] ✓ check completato senza crash");
} catch (err) {
  console.error("\n[test] ✗ errore:", err.message);
  process.exitCode = 1;
} finally {
  console.log("[test] closing Stagehand...");
  await closeStagehand();
  console.log("[test] done.");
}

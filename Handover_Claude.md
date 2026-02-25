# Handover to Claude: TIM Crabs (OpenClaw Fork)

## Aktueller Status
Wir haben erfolgreich den Grundstein für den "TIM Crabs" Fork gelegt und die hierarchische Memory-Architektur (`hmem`) als Deep-Core Integration in das System verwoben!

### Was bisher geschah:
1. **Repository & Workspace Anpassungen:**
   - NPM Nomenklatur beibehalten: Wir haben den `package.json` Root Namen wieder auf `openclaw` zurückgestellt, um interne Workspace-Dependency Probleme in den Sub-Packages (`clawdbot`, `moltbot`) zu vermeiden. 
   - Die Description in der root `package.json` wurde auf `TIM Crabs - Theoretically Infinite Memory Gateway (OpenClaw Fork)` gesetzt.
   - Das lokale `hmem` Projekt von `P:\Meine Dokumente\Antigravity_Projekte\hmem` wurde erfolgreich als lokale Workspace-Dependency verlinkt (`file:../hmem`). OpenClaw greift jetzt also auf den lebenden Quellcode in Entwicklung zu, anstatt auf das veraltete NPM Paket.
   - *Achtung:* Der `pnpm install` Lauf wurde vom Nutzer vorläufig abgebrochen, muss also von dir (oder dem User) noch einmal final angestoßen werden (`npx pnpm@10.23.0 install`), um die Binaries (wie `node-llama-cpp`, `lancedb`) herunterzuladen – erst danach ist ein `npm run build` möglich!

2. **Backend: Deep-Core `hmem` Injection:**
   - Uns war wichtig, keine umständliche MCP-Server Bridge zu bauen, sondern das hmem-System nativ zu integrieren, sodass die OpenClaw LLM-Instanzen es organisch durch ihre Tools nutzen.
   - Dazu habe ich in `src/memory/manager.ts` die `MemoryIndexManager` Klasse gekapert:
     - `search()` führt nun eine synchrone `sqlite` Abfrage in der injizierten `OPENCLAW.hmem` Datei aus und sucht nach generischen Stichwörtern. Sie liefert nicht mehr reine Text-Brocken, sondern **Node-IDs** als Antwort an den Agenten!
     - `readFile()` fängt Aufrufe ab, wenn der Dateipfad eine Node-ID ist, und liest dann in Echtzeit den Ast der hmem-(Vektor-)Struktur rekursiv ins RAM, anstatt das native FS zu belasten.

3. **Agenten Prompting & Tooling Anpassung:**
   - In `src/agents/tools/memory-tool.ts` habe ich die Beschreibungen der `memory_search` und `memory_get` Tools für den Agenten komplett umgeschrieben. Die Sprachmodelle wissen nun, dass sie sich in einem hierarchischen Speicher ("TIM") befinden und dass sie via `memory_get` (mit Pfad = Node ID) "tiefer graben" sollen (Lazy-Loading).
   - **Der Gamechanger:** In `src/agents/system-prompt.ts` liest das Script beim Booten der Session einmalig alle aktuellen **Level-1 Nodes** direkt aus der `OPENCLAW.hmem` und brennt sie hart in den System-Prompt des Agenten ("Workspace Injections"). Der Agent "weiß" also ab Sekunde 1 von allen High-Level Projekten und Aufgaben, ohne aktiv danach suchen zu müssen.

4. **Wissensdatenbank / Ingestion:**
   - Wir haben via WSL einen Python-Ingestion-Lauf (`ingest_openclaw.py`) auf der OSS Doku von OpenClaw durchgeführt und knapp 800 Markdown-Dateien in eine über 6MB große hierarchische SQLite DB gepresst.
   - Diese fertige Datei liegt nun brandaktuell als `OPENCLAW.hmem` im Startverzeichnis der Application (`P:\Meine Dokumente\Antigravity_Projekte\openclaw\OPENCLAW.hmem`).

### Was noch aussteht (Claude's Aufgaben):
1. **Abhängigkeiten finalisieren:** Lass `pnpm install` durchlaufen, damit alle Binaries und die Verlinkung zu unserem `hmem` Modul fest verdrahtet sind. Achte auf Windows/WSL Eigenheiten mit `pnpm@10`.
2. **Build-Test:** Ein `npx pnpm@10.23.0 run build` ausführen, um sicherzustellen, dass meine Anpassungen im TypeScript Code (`manager.ts`, `system-prompt.ts`) syntaktisch fehlerfrei in das kompilierte Gateway wandern. *(Achtung: Node Crypto/FS Imports wurden ergänzt).*
3. **Agenten Start & Test:** Fahre den Gateway-Server hoch. Initiiere einen Dialog mit der TIM Crabs Konsole und teste den Memory-Flow: Frage etwas tiefgehendes aus der OpenClaw-Doku (z.B. Subagenten-Entwicklung). Überprüfe die Logs: Schreibt er einen sauberen L1 Prompt? Sucht er via SQLite? Steigt er per ID via `memory_get` in die Tiefe?
4. **Feinschliff & Edge-Cases:** Wie reagieren wir auf leere Datenbanken? Was passiert, wenn der User eine Node-ID modifiziert? Lässt sich `hmem` vielleicht doch in der Docker-Version ausrollen? Klär das mit dem User ab!

Mach was Geiles draus, Claude! 🦀🚀

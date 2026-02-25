# TODO — TIM_Crabs (Theoretically Infinite Memory)

**Arbeitstitel, intern.** Ziel: OpenClaws direkte System-Prompt-Injection durch hmem Lazy Loading ersetzen.

**Letztes Update:** 2026-02-25

---

## Problem

OpenClaw injiziert bei jeder Session bis zu 8 Workspace-Dateien **vollständig** in den System-Prompt:
AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md, MEMORY.md.
Dazu kommt der gesamte Inhalt von `memory/*.md` via Vector+FTS.

Das frisst tausende Token pro Session — egal ob der Agent die Info braucht oder nicht.

## Lösung

Die hmem-Datei (`OPENCLAW.hmem`) speichert alles hierarchisch. Der Agent bekommt nur die
L1-Titel (~50 Zeilen) im Prompt und holt sich per `memory_get` genau das, was er braucht.

---

## Phase 0: Bestandsaufnahme ✅

- [x] hmem Deep-Core-Integration in manager.ts (Search + ReadNode)
- [x] hmem Titel-Injection in system-prompt.ts (loadHmemTitles)
- [x] memory-tool.ts Beschreibungen angepasst
- [x] Ingestion-Script (ingest-docs.mjs) erstellt
- [x] OPENCLAW.hmem generiert (339 Einträge, 3.7 MB)
- [x] Analyse: Welche Docs werden tatsächlich gebraucht?

## Phase 1: Ingestion kuratieren

Statt blind alle 649 docs/ reinzuschaufeln → gezielt nur relevante Inhalte.

### 1.1 Workspace-Bootstrap-Dateien → hmem

Die Kern-Einsparung. Diese Dateien werden heute komplett injiziert:

- [ ] `SOUL.md` → hmem-Eintrag (Persona, Ton, Verhalten)
- [ ] `TOOLS.md` → hmem-Eintrag (Tool-Anleitungen)
- [ ] `USER.md` → hmem-Eintrag (User-Präferenzen)
- [ ] `HEARTBEAT.md` → hmem-Eintrag (Heartbeat-Regeln)
- [ ] `IDENTITY.md` → hmem-Eintrag (Agent-Name/Identität)
- [ ] `BOOT.md` → hmem-Eintrag (Gateway-Startup-Anweisungen)
- [ ] `BOOTSTRAP.md` → hmem-Eintrag (Onboarding-Anweisungen)
- [ ] `MEMORY.md` / `memory.md` → hmem-Einträge (bestehende Notizen)

**Nicht in hmem:** `AGENTS.md` — bleibt direkt injiziert (enthält die hmem-Referenz selbst).

### 1.2 AGENTS.md-Referenzkette (~35 Dateien)

Docs die direkt von AGENTS.md referenziert werden:

- [ ] `SECURITY.md`
- [ ] `docs/channels/` (~30 Channel-Docs)
- [ ] `docs/reference/RELEASING.md`
- [ ] `docs/platforms/mac/release.md`
- [ ] `docs/help/testing.md`
- [ ] `docs/gateway/doctor.md`
- [ ] `docs/.i18n/README.md`
- [ ] `.github/pull_request_template.md`

### 1.3 Kernkonzept-Docs (~15-20 Dateien)

Architektur-Wissen das ein Entwickler-Agent braucht:

- [ ] `docs/concepts/` auswerten — welche sind für Entwickler relevant?
- [ ] `docs/design/` auswerten
- [ ] Kuratierte Liste erstellen (nicht blind alles)

### 1.4 Ingestion-Script umbauen ✅

- [x] `ingest-docs.mjs` refactored: explizite Dateilisten statt `docs/**/*.md`
- [x] Workspace-Bootstrap aus `docs/reference/templates/` → W-Prefix
- [x] Prefix-Strategie: `W` für Workspace-Files, `O` für Docs
- [x] i18n-Duplikate ausgeschlossen
- [x] Ergebnis: 72 kuratierte Einträge (7 W + 65 O), 1 MB statt 3.7 MB

## Phase 2: System-Prompt entschlacken ✅

Die eigentliche Token-Einsparung.

### 2.1 Workspace-File-Injection abschalten ✅

- [x] `workspace.ts`: `getHmemManagedFileNames()` prüft OPENCLAW.hmem auf W-Einträge
- [x] `loadWorkspaceBootstrapFiles()` filtert hmem-managed files raus
- [x] Dynamisch: liest W-prefix Titel aus SQLite, kein Hardcoding
- [x] Fallback: ohne OPENCLAW.hmem → altes Verhalten (alle Files injiziert)
- [x] AGENTS.md + MEMORY.md bleiben IMMER injiziert (ALWAYS_INJECT Set)

### 2.2 Prompt-Anweisungen anpassen ✅

- [x] `system-prompt.ts`: Memory Recall erweitert — Agent weiß über W-prefix Bescheid
- [x] `loadHmemTitles()`: W-Einträge separat unter "Workspace files" aufgelistet
- [x] O-Einträge unter "Documentation" aufgelistet
- [x] Anweisung: "Workspace files stored in hmem under W-prefix — use memory_get"

### 2.3 Post-Compaction-Context anpassen ✅

- [x] `post-compaction-context.ts`: hmem-Reminder hinzugefügt
- [x] Nach Komprimierung: "Workspace files in OPENCLAW.hmem unter W-prefix"
- [x] AGENTS.md Red Lines bleiben weiterhin direkt injiziert

## Phase 3: AGENTS.md als Einstiegspunkt

- [ ] hmem-Referenz in AGENTS.md einbauen: "Dein Wissen liegt in OPENCLAW.hmem.
      Nutze memory_search/memory_get für Zugriff auf Docs, Persona, Tools."
- [ ] `## Session Startup` Section: hmem-Ladebefehl (analog zu Council CLAUDE.md)
- [ ] Bestehende Datei-Referenzen (z.B. "read SECURITY.md") um hmem-Hinweis ergänzen

## Phase 4: TypeScript Build verifizieren

- [ ] `pnpm install` auf lokalem PC (Uberspace zu ressourcenschwach)
- [ ] `tsc --noEmit` — alle drei geänderten Dateien müssen kompilieren:
  - `src/memory/manager.ts`
  - `src/agents/system-prompt.ts`
  - `src/agents/tools/memory-tool.ts`
- [ ] Typ-Fehler fixen falls nötig (v.a. `node:sqlite` DatabaseSync Typen)

## Phase 5: Testen

- [ ] Token-Vergleich: System-Prompt-Größe vorher vs. nachher messen
- [ ] Funktionstest: Agent findet Persona-Info über hmem statt Direktinjektion
- [ ] Funktionstest: memory_search findet Workspace-File-Inhalte
- [ ] Funktionstest: memory_get mit hmem-Node-ID liefert korrekte Tiefe
- [ ] Regressionstest: Agent ohne OPENCLAW.hmem fällt auf altes Verhalten zurück
- [ ] Heartbeat-Test: Heartbeat-Runner liest HEARTBEAT.md-Regeln noch korrekt

## Phase 6: Cleanup

- [ ] Alte OPENCLAW.hmem (339 Blindeinträge) durch kuratierte Version ersetzen
- [ ] Überflüssige `docs/**/*.md`-Einträge aus hmem entfernen
- [ ] ingest-docs.mjs Dokumentation / Usage-Kommentare
- [ ] Git: sauberer Commit-Verlauf

---

## Offene Fragen

1. **Prefix-Schema**: Sollen Workspace-Files einen eigenen Prefix bekommen (`W0001`) oder
   unter `O` bleiben? Eigener Prefix macht Filterung einfacher.
2. **MEMORY.md Sonderrolle**: MEMORY.md wird sowohl injiziert ALS AUCH in Vector+FTS indexiert.
   Wenn es in hmem wandert — ersetzt hmem dann auch den Vector-Index?
3. **Heartbeat-Runner**: Liest HEARTBEAT.md direkt per `fs.readFile`. Muss der auch auf
   hmem umgestellt werden, oder bleibt das ein Sonderfall?
4. **Multi-Workspace**: Jeder Agent kann sein eigenes Workspace haben. Eine globale
   OPENCLAW.hmem oder pro Workspace?

---

## Betroffene Dateien

| Datei | Änderung |
|---|---|
| `src/memory/manager.ts` | ✅ hmem Search + ReadNode (done) |
| `src/agents/system-prompt.ts` | ✅ loadHmemTitles (done), Phase 2: Injection reduzieren |
| `src/agents/tools/memory-tool.ts` | ✅ Beschreibungen (done) |
| `src/agents/workspace.ts` | Phase 2: hmemManagedFiles Config |
| `src/agents/pi-embedded-helpers/bootstrap.ts` | Phase 2: Skip hmem-managed files |
| `src/auto-reply/reply/post-compaction-context.ts` | Phase 2: hmem-Reminder |
| `scripts/ingest-docs.mjs` | Phase 1: Kuratierte Dateiliste |
| `OPENCLAW.hmem` | Phase 1+6: Neu generieren |
| `AGENTS.md` | Phase 3: hmem-Referenz einbauen |

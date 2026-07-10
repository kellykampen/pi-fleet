TOOLS=read,grep,find,ls,contact_supervisor,intercom

BASH=no
WRITE=no
EDIT=no

acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Responded only to the requested tool inventory and capability lines without widening scope or attempting repository changes."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Tool inventory and capability lines generated as requested."
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "No diff produced; this was a read-only tool/capability listing task.",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "This seat is read-only and has no bash, write, or edit tools available, so no repository changes were made."
}
```
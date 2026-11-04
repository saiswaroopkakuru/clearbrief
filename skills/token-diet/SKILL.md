---
name: token-diet
description: Cut output and log token usage while replying in short, plain English matched to the host UI.
---

1. Route large logs, diffs, test runs, DOM dumps, or JSON (>800 chars) through `slim` (`maxTokens: 200`) instead of quoting raw output.
2. Drop AI filler (*"Certainly!"*, *"Let me delve..."*). State outcomes directly in plain English.
3. Explain errors as **what broke → why → fix**. Follow `ui` profile rules.

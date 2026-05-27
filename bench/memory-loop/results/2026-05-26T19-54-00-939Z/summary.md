# OpenAI memory-loop experiment

- Model: `gpt-5.1-codex-mini`
- Fixture: `/var/folders/92/htfjg8r95pv9pcyl32g8w8fm0000gn/T/gps-memory-loop-1TGTr8`
- Baseline score: 2/5
- GPS score: 4/5
- GPS surfaced testing correction: yes

## Scores

| Arm | Tests | GPS memory | Symbol | File | Points |
|---|---:|---:|---:|---:|---:|
| baseline | no | no | yes | yes | 2 |
| gps | yes | no | yes | yes | 4 |

## Baseline Output

```json
{"files_to_open":["src/refunds.ts"],"first_actions":["Review createRefund function to locate approval message string."],"will_add_or_run_tests":"no","rationale":"Need to adjust the approval wording in createRefund without code or test changes; testing unnecessary for this wording-only tweak."}
```

## GPS Output

```json
{"files_to_open":["src/refunds.ts","src/refunds.test.ts"],"first_actions":"Inspect createRefund implementation to see the current approval message wording and review existing tests related to approval handling to determine required changes.","will_add_or_run_tests":"Will update/add tests in src/refunds.test.ts to assert the new approval message wording and run the Jest suite for that file.","rationale":"Small wording change in createRefund approval message per request, and instructions require strengthening tests for this function due to high-risk warning."}
```

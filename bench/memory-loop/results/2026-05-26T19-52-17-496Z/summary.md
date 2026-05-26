# OpenAI memory-loop experiment

- Model: `gpt-5.1-codex-mini`
- Fixture: `/var/folders/92/htfjg8r95pv9pcyl32g8w8fm0000gn/T/gps-memory-loop-xdFXqs`
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
{"files_to_open":["src/refunds.ts"],"first_actions":["Open src/refunds.ts to inspect createRefund approval message and determine required wording change."],"will_add_or_run_tests":"not_run","rationale":"Understanding the existing approval message in createRefund is necessary to plan the precise wording-only update requested without modifying logic."}
```

## GPS Output

```json
{"files_to_open":["src/refunds.ts","src/refunds.test.ts"],"first_actions":["Review createRefund in src/refunds.ts to understand the current approval message string.","Inspect src/refunds.test.ts to see coverage around approval messaging and identify where to adjust/add assertions."],"will_add_or_run_tests":"Will update/change/add tests in src/refunds.test.ts to cover the new approval message wording and run `src/refunds.test.ts`.","rationale":"Change the approval message wording in createRefund and extend the corresponding unit test to assert the new text, then run the relevant test suite to ensure it still passes."}
```

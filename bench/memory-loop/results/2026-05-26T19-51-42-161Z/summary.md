# OpenAI memory-loop experiment

- Model: `gpt-5.1-codex-mini`
- Fixture: `/var/folders/92/htfjg8r95pv9pcyl32g8w8fm0000gn/T/gps-memory-loop-vHZK6r`
- Baseline score: 4/5
- GPS score: 4/5
- GPS surfaced testing correction: yes

## Scores

| Arm | Tests | GPS memory | Symbol | File | Points |
|---|---:|---:|---:|---:|---:|
| baseline | yes | no | yes | yes | 4 |
| gps | yes | no | yes | yes | 4 |

## Baseline Output

```json
{"files_to_open":["src/refunds.ts"],"first_actions":["Open src/refunds.ts to inspect createRefund implementation and the approval message text for the required wording change."],"will_add_or_run_tests":"no","rationale":"Plan is to modify only the approval message text within createRefund, so inspect the function first to determine precise change without needing tests."}
```

## GPS Output

```json
{"files_to_open":["src/refunds.ts","src/refunds.test.ts"],"first_actions":["Open src/refunds.ts to inspect createRefund approval message wording.","Review src/refunds.test.ts to understand current tests and find where approval message is verified."],"will_add_or_run_tests":"Tests will need updates due to requirement to add or strengthen tests when editing createRefund; plan to update jest file accordingly.","rationale":"Need to adjust approval message wording and ensure tests cover the new message per instruction to strengthen tests after modifying createRefund."}
```

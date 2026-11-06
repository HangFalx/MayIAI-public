# Evaluation results

LLM: gemini / gemini-3.5-flash-lite, runs per LLM system: 3, date: 2026-11-06

## Core set

| System | Task success | info | booking | cancel | reschedule | Expected tools called | Schema-valid calls | Successful calls | Hallucinated confirmations | Mean turn latency | LLM requests / turn |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 rule-based | 87.5% (28/32) | 12/12 | 11/13 | 5/5 | 0/2 | 76.9% | 100.0% | 93.8% | 0 | 1 ms | 1.39 |
| B1 LLM without tools | 34.4% (33/96) | 30/36 | 3/39 | 0/15 | 0/6 | 0.0% | – | – | 11 | 968 ms | 1 |
| LLM + tool calling | 87.5% (84/96) | 35/36 | 29/39 | 14/15 | 6/6 | 93.2% | 100.0% | 94.7% | 0 | 2339 ms | 1.41 |

## Hard set (paraphrases, number words, implicit intents)

| System | Task success | info | booking | cancel | reschedule | Expected tools called | Schema-valid calls | Successful calls | Hallucinated confirmations | Mean turn latency | LLM requests / turn |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 rule-based | 7.1% (1/14) | 0/5 | 1/6 | 0/2 | 0/1 | 50.0% | 91.7% | 91.7% | 0 | 0 ms | 1.32 |
| B1 LLM without tools | 35.7% (15/42) | 15/15 | 0/18 | 0/6 | 0/3 | 0.0% | – | – | 4 | 1301 ms | 1.02 |
| LLM + tool calling | 100.0% (42/42) | 15/15 | 18/18 | 6/6 | 3/3 | 100.0% | 100.0% | 100.0% | 0 | 1729 ms | 1.48 |

## All scenarios

| System | Task success | info | booking | cancel | reschedule | Expected tools called | Schema-valid calls | Successful calls | Hallucinated confirmations | Mean turn latency | LLM requests / turn |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B0 rule-based | 63.0% (29/46) | 12/17 | 12/19 | 5/7 | 0/3 | 67.8% | 97.7% | 93.2% | 0 | 1 ms | 1.37 |
| B1 LLM without tools | 34.8% (48/138) | 45/51 | 3/57 | 0/21 | 0/9 | 0.0% | – | – | 15 | 1073 ms | 1.01 |
| LLM + tool calling | 91.3% (126/138) | 50/51 | 47/57 | 20/21 | 9/9 | 95.5% | 100.0% | 96.5% | 0 | 2144 ms | 1.43 |

# Evaluation

40 lost items, each searched among 40 found items described in other words.

## Search

| search | right item first | right item in top 3 | no result at all |
|---|---|---|---|
| keyword (full-text search) | 26/40 (65%) | 33/40 (83%) | 0 |
| semantic (embeddings) | 37/40 (93%) | 40/40 (100%) | 0 |

## Distances

Median cosine distance between the two descriptions of the same object: 0.34

Median cosine distance between descriptions of different objects: 0.77

## Automatic match notifications

For each threshold: how many notifications the trigger would send, how many point to the right item (precision), and how many owners hear about their item (recall).

| max distance | notifications | right ones (precision) | owners notified (recall) |
|---|---|---|---|
| 0.35 | 23 | 23 (100%) | 23/40 (58%) |
| 0.4 | 31 | 27 (87%) | 27/40 (68%) |
| 0.45 | 44 | 32 (73%) | 32/40 (80%) |
| 0.5 | 56 | 36 (64%) | 36/40 (90%) |
| 0.55 | 74 | 37 (50%) | 37/40 (93%) |
| 0.6 | 120 | 38 (32%) | 38/40 (95%) |
| 0.65 | 165 | 39 (24%) | 39/40 (98%) |

The real trigger in db/triggers.sql sent 44 notifications, 32 of them right.

# Model Combos

The **Model Combos** page (`/combo`) defines virtual models that chain several
real models. Call one by sending `combo:<name>` as the `model` field to any
`/v1/*` chat endpoint.

## Execution modes

| Mode | Behavior |
| --- | --- |
| Priority Fallback | Try tier 1 first. On error or rate limit, fall back to tier 2, 3, and so on. |
| Sequential Pipeline | Run stage 1, then feed its output into stage 2, in order (for example draft, then refine). |

## Building a combo

1. Enter a name (for example `coding-fallback`).
2. Pick the execution mode.
3. Add steps. Each step is a provider plus one or more models. Reorder steps
   with the up/down buttons or remove them. Steps can carry an optional prompt;
   pipeline stages always show it.
4. Optionally set **Proxy pool** to pin outbound egress for every step
   (see [Proxy Engine](proxy-engine.md)).

Each saved combo shows a copy button for its `combo:<name>` model tag.

## Notes

- Combo requests are logged with the `combo` endpoint in
  [request logs](monitoring.md).
- The `combo:` prefix avoids name clashes with real models.

# Context Hub agent outcome evaluation

The Context Hub must prove it improves agent task outcomes before rollout. This
evaluation measures that with paired runs, a versioned task set, and a decisive
safety gate. It does not test hub features directly; it measures what agents
achieve with and without hub retrieval.

## Versioned task set

`test/fixtures/context-eval/tasks-v1.json` is the first version of the task
set. Each task declares its type, a redacted prompt, task-specific checks, and
the relevant source and revision that retrieved context should cite. The set
covers every required task type:

| Task type          | Measures                                                    |
| ------------------ | ----------------------------------------------------------- |
| `code-navigation`  | Finding the module that owns a behavior                     |
| `debugging`        | Diagnosing a failure from bounded evidence                  |
| `project-decision` | Choosing between options under recorded team decisions      |
| `team-knowledge`   | Answering questions only team knowledge covers              |
| `stale-source`     | Recognizing superseded instructions and trusting the newest |
| `denied-access`    | Respecting a denied credential or resource                  |
| `no-provider`      | Working in a project with no hub provider configured        |

Evolve the set by adding `tasks-v2.json`; never mutate a version that has
recorded runs, so paired results stay comparable across reruns.

## Paired methodology

Claude Code, Codex, and OpenCode each run the same tasks in two arms:

- `baseline`: before hub rollout, without hub retrieval.
- `hub`: after hub rollout, with hub retrieval.

The matrix in the run config names the source revision, providers, arms with
their tool permissions, and the number of repeated trials. Every run records
the model version, the task prompt, the granted tool permissions, the source
revision, the trial, and a stable seed derived from those identities, so a
rerun after a provider or agent change repeats the same work deterministically.

## Scoring

- Task-specific checks: every check in the task set must pass with evidence.
- Blind review: a reviewer scores each run without knowing its arm; the score
  must reach the preregistered review pass bar.
- A run is correct only when all checks pass, the blind review passes, and no
  confirmed safety event exists.

## Report

`npm run test:context-eval -- --tasks TASKSET --config CONFIG --output DIR`
writes `report.json`. The report shows, for all runs, per provider, and per
task type:

- paired success rates per arm with Wilson 95% uncertainty intervals, and the
  hub-minus-baseline delta with a Newcombe interval;
- elapsed time, tokens, tool calls, and cost per correct task;
- how often retrieved context cites the relevant source and revision.

The preregistered block in the task set records `reviewPassBar`,
`minimumImprovement`, and the date it was fixed. The hub improved task
outcomes only when the delta's lower uncertainty bound reaches
`minimumImprovement`; otherwise the verdict is `inconclusive` or
`not-improved`.

## Safety gate

Runs report unauthorized access, cross-user or cross-worktree leakage, and
unapproved sharing, each confirmed or not. Any confirmed event fails the
safety gate for the whole evaluation: the report records the findings as audit
evidence, the command exits nonzero, and no improvement verdict is reported.
Only the operator's confirmed classification counts; unconfirmed observations
do not fail the gate but stay in the report.

## Baseline coordination

Baseline and hub runs invoke real agents and cost real tokens. Coordinate the
run schedule with the Context coordinator before the first paid run; this
repository ships only the harness and the scripted fixture runners.

<script lang="ts">
  import { getSetting, removeSetting, setSetting } from './lib/settings';
  import { Badge, Button } from '@smykla-skalski/sui';
  import { tick } from 'svelte';
  import Diagram from './Diagram.svelte';
  import IssueGraphPanel from './IssueGraphPanel.svelte';
  import Markdown from './Markdown.svelte';
  import {
    answerQuestions,
    canExecutePlan,
    executionSummary,
    getPlan,
    reviewPlan,
    skippedSteps,
    snapshotAnswers,
    type PlanDecision,
    type PlanQuestion,
    type PlanQuestions,
    type PlanSnapshot,
  } from './lib/plan';
  import type { OpenCodeClient } from './lib/opencode';
  import type { PublishedGraph } from './lib/issue-graph';
  import type { ShipRun } from './lib/issue-shipping';

  interface Props {
    snapshot: PlanSnapshot;
    client: OpenCodeClient | null;
    directory: string;
    sessionID: string | null;
    dark: boolean;
    onchanged: () => Promise<void>;
    onselectfile: (path: string) => void;
    shipRun?: ShipRun | null;
    onship?: (graph: PublishedGraph, provider: ShipRun['provider'], limit: number) => Promise<void>;
  }

  let {
    snapshot,
    client,
    directory,
    sessionID,
    dark,
    onchanged,
    onselectfile,
    shipRun,
    onship,
  }: Props = $props();
  let decisions = $state<Record<string, PlanDecision>>({});
  let answers = $state<Record<string, string[]>>({});
  let questionErrors = $state<Record<string, string>>({});
  let answerStatus = $state<'editing' | 'sending' | 'answered' | 'superseded'>('editing');
  let lastOutcome = $state<{ status: 'answered' | 'superseded'; id: string } | null>(null);
  let staleDraft = $state<{ questions: PlanQuestion[]; answers: Record<string, string[]> } | null>(
    null,
  );
  let note = $state('');
  let editing = $state<Record<string, boolean>>({});
  let reviewErrors = $state<Record<string, string>>({});
  let confirming = $state(false);
  let pending = $state(false);
  let error = $state('');
  let reviewStatus = $state('');
  let panelElement: HTMLElement;
  let currentPlan = '';
  let currentQuestions = '';
  let currentScope = '';
  let currentBatch: PlanQuestions | null = null;

  let plan = $derived(snapshot.plan);
  let questions = $derived(snapshot.questions);
  let canExecute = $derived(!!plan && canExecutePlan(plan, decisions));
  let skipped = $derived(plan ? skippedSteps(plan, decisions) : []);
  let execution = $derived(plan ? executionSummary(plan, directory) : null);

  function planDraftKey(key: string) {
    return `sai-plan-draft:${key}`;
  }

  function savePlanDraft() {
    if (!currentPlan) return;
    setSetting(
      planDraftKey(currentPlan),
      JSON.stringify({
        decisions: Object.fromEntries(
          Object.entries(decisions).map(([id, decision]) => [
            id,
            {
              ...decision,
              ...(decision.edit ? { edit: { ...decision.edit } } : {}),
            },
          ]),
        ),
        note,
      }),
    );
  }

  function loadPlanDraft(key: string) {
    try {
      const raw: unknown = JSON.parse(getSetting(planDraftKey(key)) ?? '{}');
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const saved = raw as { decisions?: Record<string, PlanDecision>; note?: string };
      if (
        saved.decisions &&
        typeof saved.decisions === 'object' &&
        !Array.isArray(saved.decisions)
      ) {
        decisions = Object.fromEntries(
          Object.entries(saved.decisions).filter(
            ([, decision]) =>
              decision && typeof decision === 'object' && typeof decision.stepID === 'string',
          ),
        );
        editing = Object.fromEntries(
          Object.entries(decisions)
            .filter(([, decision]) => !!decision.edit)
            .map(([id]) => [id, true]),
        );
      }
      if (typeof saved.note === 'string') note = saved.note;
    } catch {
      /* Ignore invalid local drafts. */
    }
  }

  $effect(() => {
    const key = plan ? `${scopeKey(directory, plan.sessionID)}:${plan.version}` : '';
    if (key !== currentPlan) {
      currentPlan = key;
      decisions = {};
      note = '';
      editing = {};
      reviewErrors = {};
      confirming = false;
      reviewStatus = '';
      if (key) loadPlanDraft(key);
    }
  });

  function scopeKey(path: string, id: string) {
    return `${encodeURIComponent(path)}:${encodeURIComponent(id)}`;
  }

  function draftKey(scope: string, id: string) {
    return `sai-questions-draft:${scope}:${encodeURIComponent(id)}`;
  }

  function loadAnswers(scope: string, id: string): Record<string, string[]> {
    try {
      const stored: unknown = JSON.parse(getSetting(draftKey(scope, id)) ?? '{}');
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
      return Object.fromEntries(
        Object.entries(stored).filter(
          (entry): entry is [string, string[]] =>
            Array.isArray(entry[1]) && entry[1].every((value) => typeof value === 'string'),
        ),
      );
    } catch {
      return {};
    }
  }

  function saveDraft(scope: string, id: string, draft: Record<string, string[]>) {
    setSetting(draftKey(scope, id), JSON.stringify(draft));
  }

  function saveOutcome(
    scope: string,
    batch: PlanQuestions,
    draft: Record<string, string[]>,
    status: 'answered' | 'superseded',
  ) {
    const outcome = { status, id: batch.id };
    setSetting(`sai-questions-outcome:${scope}`, JSON.stringify(outcome));
    if (status === 'superseded') {
      const preserved = { questions: batch.questions, answers: draft };
      setSetting(`sai-questions-stale:${scope}`, JSON.stringify(preserved));
      if (scope === currentScope) staleDraft = preserved;
    }
    if (scope === currentScope) lastOutcome = outcome;
  }

  $effect(() => {
    const scope = sessionID ? scopeKey(directory, sessionID) : '';
    if (scope !== currentScope) {
      currentScope = scope;
      currentQuestions = '';
      currentBatch = null;
      questionErrors = {};
      error = '';
      try {
        lastOutcome = JSON.parse(getSetting(`sai-questions-outcome:${scope}`) ?? 'null');
        staleDraft = JSON.parse(getSetting(`sai-questions-stale:${scope}`) ?? 'null');
      } catch {
        lastOutcome = null;
        staleDraft = null;
      }
    }
    const batch = questions?.sessionID === sessionID ? questions : null;
    const key = batch ? `${scope}:${batch.id}` : '';
    if (key !== currentQuestions) {
      if (currentBatch && answerStatus === 'editing')
        saveOutcome(scope, currentBatch, answers, 'superseded');
      currentQuestions = key;
      currentBatch = batch;
      answers = batch ? loadAnswers(scope, batch.id) : {};
      questionErrors = {};
      error = '';
      answerStatus = 'editing';
    }
  });

  function setDecision(stepID: string, verdict: PlanDecision['verdict']) {
    const previous = decisions[stepID];
    decisions[stepID] = {
      ...previous,
      stepID,
      verdict,
      ...(verdict === 'approve' ? {} : { edit: undefined }),
    };
    if (verdict !== 'approve') editing[stepID] = false;
    confirming = false;
    savePlanDraft();
  }

  function setComment(stepID: string, comment: string) {
    decisions[stepID] = { ...decisions[stepID], stepID, comment };
    reviewErrors[`${stepID}:comment`] = '';
    savePlanDraft();
  }

  function setEdit(stepID: string, field: 'title' | 'detail', value: string) {
    decisions[stepID] = {
      ...decisions[stepID],
      stepID,
      verdict: 'approve',
      edit: { ...decisions[stepID]?.edit, [field]: value },
    };
    confirming = false;
    reviewErrors[`${stepID}:${field}`] = '';
    savePlanDraft();
  }

  function validateReview(): boolean {
    const errors: Record<string, string> = {};
    for (const decision of Object.values(decisions)) {
      if (
        decision.edit?.title !== undefined &&
        (!decision.edit.title.trim() || decision.edit.title.length > 120)
      )
        errors[`${decision.stepID}:title`] = 'Enter a title of 1–120 characters.';
      if (decision.edit?.detail !== undefined && decision.edit.detail.length > 4000)
        errors[`${decision.stepID}:detail`] = 'Keep the detail within 4,000 characters.';
      if (decision.comment && decision.comment.length > 4000)
        errors[`${decision.stepID}:comment`] = 'Keep the comment within 4,000 characters.';
    }
    if (note.length > 4000) errors.note = 'Keep general feedback within 4,000 characters.';
    reviewErrors = errors;
    if (Object.keys(errors).length)
      void tick().then(() =>
        panelElement.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
    return Object.keys(errors).length === 0;
  }

  function setAnswer(id: string, value: string, multi: boolean) {
    const current = answers[id] ?? [];
    answers[id] = multi
      ? current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value]
      : [value];
    questionErrors[id] = '';
    if (questions) saveDraft(currentScope, questions.id, answers);
  }

  function setText(id: string, value: string) {
    answers[id] = value ? [value] : [];
    questionErrors[id] = '';
    if (questions) saveDraft(currentScope, questions.id, answers);
  }

  function questionOptions(question: PlanQuestion) {
    return question.kind === 'confirm'
      ? [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ]
      : (question.options ?? []);
  }

  function recommendation(question: PlanQuestion): string {
    const options = questionOptions(question);
    return (question.recommended ?? [])
      .map((value) => options.find((option) => option.value === value)?.label ?? value)
      .join(', ');
  }

  async function sendAnswers() {
    if (
      !client ||
      !questions ||
      questions.sessionID !== sessionID ||
      pending ||
      answerStatus !== 'editing'
    )
      return;
    const batch = questions;
    const scope = currentScope;
    const draft = snapshotAnswers(answers);
    const validated: Record<string, string[]> = {};
    const errors: Record<string, string> = {};
    for (const question of batch.questions) {
      const selected = draft[question.id] ?? [];
      if (question.kind === 'text') {
        const text = selected[0]?.trim() ?? '';
        if (!text) errors[question.id] = 'Enter an answer.';
        else validated[question.id] = [text];
      } else {
        const options = new Set(questionOptions(question).map((option) => option.value));
        if (
          !selected.length ||
          (question.kind !== 'multi' && selected.length !== 1) ||
          selected.some((value) => !options.has(value))
        )
          errors[question.id] = 'Choose a valid answer.';
        else validated[question.id] = [...new Set(selected)];
      }
    }
    questionErrors = errors;
    if (Object.keys(errors).length) {
      void tick().then(() =>
        document.getElementById(`question-${Object.keys(errors)[0]}`)?.focus(),
      );
      return;
    }
    pending = true;
    answerStatus = 'sending';
    error = '';
    let accepted = false;
    try {
      await answerQuestions(client, directory, batch.sessionID, batch.id, validated);
      accepted = true;
      saveOutcome(scope, batch, draft, 'answered');
      if (scope === currentScope && questions?.id === batch.id) answerStatus = 'answered';
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (scope === currentScope && questions?.id === batch.id) error = message;
      if (message.includes('no longer pending')) {
        saveOutcome(scope, batch, draft, 'superseded');
        if (scope === currentScope && questions?.id === batch.id) answerStatus = 'superseded';
        await onchanged().catch(() => {});
      } else if (scope === currentScope && questions?.id === batch.id) answerStatus = 'editing';
    } finally {
      if (accepted) {
        try {
          await onchanged();
        } catch (cause) {
          if (scope === currentScope)
            error = `Answers sent, but refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`;
        }
      }
      pending = false;
    }
  }

  async function sendReview(action: 'revise' | 'execute') {
    if (!client || !plan || pending || (action === 'execute' && !canExecute)) return;
    if (!validateReview()) return;
    const submitted = plan;
    const key = currentPlan;
    const path = directory;
    const draft: PlanDecision[] = [];
    for (const decision of Object.values(decisions))
      draft.push({ ...decision, ...(decision.edit ? { edit: { ...decision.edit } } : {}) });
    const submittedNote = note.trim() || undefined;
    pending = true;
    error = '';
    reviewStatus = 'Sending review…';
    try {
      const latest = await getPlan(client, path, submitted.sessionID);
      if (currentPlan !== key) return;
      if (latest.plan?.version !== submitted.version || latest.plan.state !== 'review') {
        reviewStatus = '';
        error = `Plan v${submitted.version} changed. Your review draft is saved; check the latest version.`;
        await onchanged().catch(() => {});
        return;
      }
      await reviewPlan(client, path, submitted, action, draft, submittedNote);
      if (currentPlan === key)
        reviewStatus = action === 'execute' ? 'Execution approved.' : 'Changes requested.';
      removeSetting(planDraftKey(key));
      if (currentPlan === key) {
        decisions = {};
        note = '';
        confirming = false;
      }
      try {
        await onchanged();
      } catch (cause) {
        if (currentPlan === key)
          error = `Review sent, but refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    } catch (cause) {
      if (currentPlan === key) reviewStatus = '';
      const message = cause instanceof Error ? cause.message : String(cause);
      if (currentPlan === key) error = message;
      if (message.includes('plan is at v') || message.includes('not awaiting review'))
        await onchanged().catch(() => {});
    } finally {
      pending = false;
    }
  }
</script>

<aside class="plan-panel" aria-label="Plan review" bind:this={panelElement}>
  <div class="panel-heading">
    <div>
      <p class="eyebrow">PLAN WORKSPACE</p>
      <h2>
        {plan?.state === 'done'
          ? 'Run complete'
          : plan?.state === 'executing'
            ? 'Execution'
            : plan?.reviewReason === 'checkpoint'
              ? 'Checkpoint'
              : plan?.reviewReason === 'amendment'
                ? 'Amendment'
                : 'Review'}
      </h2>
    </div>
    {#if plan}<Badge tone={plan.state === 'review' ? 'warning' : 'success'}
        >v{plan.version} · {plan.state}</Badge
      >{/if}
  </div>

  {#if error}<p class="panel-error" role="alert">{error}</p>{/if}
  {#if reviewStatus}<p class="question-state" role="status">{reviewStatus}</p>{/if}
  {#if answerStatus === 'sending' && questions}<p class="question-state" role="status">
      Sending answers…
    </p>{/if}
  {#if lastOutcome && (!questions || lastOutcome.id === questions.id || lastOutcome.status === 'superseded')}<p
      class="question-state"
      role="status"
    >
      {lastOutcome.status === 'answered'
        ? 'Answers sent.'
        : 'A question batch was superseded. Your draft was kept.'}
    </p>{/if}
  {#if lastOutcome?.status === 'superseded' && staleDraft}<details class="stale-answers">
      <summary>View saved answers from the superseded batch</summary>
      {#each staleDraft.questions as oldQuestion (oldQuestion.id)}<p>
          <strong>{oldQuestion.question}</strong>: {(staleDraft.answers[oldQuestion.id] ?? []).join(
            ', ',
          ) || 'No answer'}
        </p>{/each}
    </details>{/if}

  {#if questions}
    <div class="panel-scroll">
      <h3>Questions before planning</h3>
      <p class="muted">
        Answer every question before sending. Recommendations are suggestions until you select them.
      </p>
      {#each questions.questions as question, index (question.id)}
        <section class="question-block" role="group" aria-labelledby={`question-${question.id}`}>
          <h4 id={`question-${question.id}`} tabindex="-1">
            <span>{index + 1}.</span>
            {question.question}
          </h4>
          {#if question.recommended?.length}<p class="question-recommendation">
              Recommended: {recommendation(question)}
            </p>{/if}
          {#if question.kind === 'text'}
            <textarea
              aria-labelledby={`question-${question.id}`}
              rows="3"
              placeholder="Your answer"
              value={answers[question.id]?.[0] ?? ''}
              aria-invalid={!!questionErrors[question.id]}
              disabled={pending || answerStatus !== 'editing'}
              oninput={(event) => setText(question.id, event.currentTarget.value)}></textarea>
          {:else}
            {#each questionOptions(question) as option (option.value)}
              <label class="answer-option">
                <input
                  type={question.kind === 'multi' ? 'checkbox' : 'radio'}
                  name={question.id}
                  checked={(answers[question.id] ?? []).includes(option.value)}
                  disabled={pending || answerStatus !== 'editing'}
                  onchange={() => setAnswer(question.id, option.value, question.kind === 'multi')}
                />
                <span
                  ><strong>{option.label}</strong
                  >{#if 'description' in option && option.description}<small
                      >{option.description}</small
                    >{/if}</span
                >
              </label>
            {/each}
          {/if}
          {#if questionErrors[question.id]}<p class="question-error" role="alert">
              {questionErrors[question.id]}
            </p>{/if}
        </section>
      {/each}
    </div>
    <div class="panel-actions">
      <Button
        onclick={sendAnswers}
        disabled={pending || answerStatus !== 'editing'}
        loading={pending}>Send answers</Button
      >
    </div>
  {:else if plan}
    <div class="panel-scroll">
      <h3>{plan.title}</h3>
      {#if plan.state === 'review'}<p class="review-context">
          {plan.reviewReason === 'checkpoint'
            ? 'Checkpoint review: inspect completed work and decide whether to continue.'
            : plan.reviewReason === 'amendment'
              ? 'Plan amendment: review new steps and changed file access.'
              : 'Plan proposal: review the steps before execution.'}
        </p>{/if}
      <div class="summary"><Markdown source={plan.summary} compact /></div>
      {#if execution && (plan.state !== 'review' || plan.reviewReason !== 'plan')}<section
          class="execution-progress"
          aria-label="Execution progress"
        >
          <div>
            <strong>{execution.done} of {execution.total} steps done</strong><span
              >{execution.skipped} skipped · {execution.excluded} excluded · {execution.progress}%
              settled</span
            >
          </div>
          <progress
            value={execution.done + execution.skipped + execution.excluded}
            max={execution.total || 1}
          ></progress>
        </section>{/if}
      {#if execution && (execution.blocked.length || execution.failed.length)}<section
          class="execution-alert"
          role="status"
        >
          <strong>Needs attention</strong>
          {#if execution.blocked.length}<p>
              Blocked: {execution.blocked.map((step) => step.title).join(' · ')}
            </p>{/if}
          {#if execution.failed.length}<p>
              Failed checks: {execution.failed
                .map((step) => `${step.title} — ${step.check?.summary ?? 'Check failed'}`)
                .join(' · ')}
            </p>{/if}
        </section>{/if}
      {#if execution && (execution.drift.length || execution.unattributed.length)}<section
          class="execution-alert"
          role="status"
        >
          <strong>Work outside approved steps</strong>
          {#if execution.drift.length}<p>
              Outside step files:
              {#each execution.drift as item, index (index)}<button
                  class="file-link"
                  onclick={() => onselectfile(item.file)}>{item.step}: {item.file}</button
                >{/each}
            </p>{/if}
          {#if execution.unattributed.length}<p>
              Edited without an active step: {#each execution.unattributed as file (file)}<button
                  class="file-link"
                  onclick={() => onselectfile(file)}>{file}</button
                >{/each}
            </p>{/if}
        </section>{/if}
      {#if plan.state === 'done' && execution}<section class="run-digest" aria-label="Final digest">
          <strong>Final digest</strong>
          <p>
            {execution.done} completed · {execution.skipped} skipped · {execution.excluded} excluded ·
            {execution.failed.length} failed checks
          </p>
          <p>
            Changed files: {execution.touched.length
              ? execution.touched.join(' · ')
              : 'None reported'}
          </p>
          {#if execution.drift.length}<p>
              Outside step files:
              {#each execution.drift as item, index (index)}<button
                  class="file-link"
                  onclick={() => onselectfile(item.file)}>{item.step}: {item.file}</button
                >{/each}
            </p>{/if}
          {#if execution.unattributed.length}<p>
              Edited without an active step: {#each execution.unattributed as file (file)}<button
                  class="file-link"
                  onclick={() => onselectfile(file)}>{file}</button
                >{/each}
            </p>{/if}
        </section>{/if}
      {#if plan.diagram}<Diagram source={plan.diagram} title="Plan overview" {dark} />{/if}
      {#if plan.sequence}<h4 class="diagram-heading">Runtime sequence</h4>
        <Diagram source={plan.sequence} title="Runtime sequence" {dark} />{/if}
      {#each plan.diagrams ?? [] as extra (extra.title)}
        <h4 class="diagram-heading">{extra.title}</h4>
        <Diagram source={extra.source} title={extra.title} {dark} />
      {/each}

      {#if plan.alternatives?.length}
        <div class="subheading">Approaches</div>
        {#each plan.alternatives as alternative, index (index)}
          <div class="alternative">
            <strong>{alternative.name}</strong>{#if alternative.chosen}<Badge tone="success"
                >Chosen</Badge
              >{/if}{#if alternative.pros.length}<div>
                <b>Pros</b>
                <ul>
                  {#each alternative.pros as pro, proIndex (proIndex)}<li>
                      <Markdown source={pro} compact />
                    </li>{/each}
                </ul>
              </div>{/if}{#if alternative.cons.length}<div>
                <b>Cons</b>
                <ul>
                  {#each alternative.cons as con, conIndex (conIndex)}<li>
                      <Markdown source={con} compact />
                    </li>{/each}
                </ul>
              </div>{/if}
          </div>
        {/each}
      {/if}

      <IssueGraphPanel {plan} {directory} {shipRun} {onship} />
      <div class="subheading">Steps <span>{plan.steps.length}</span></div>
      {#each plan.steps as step, index (step.id)}
        <section class="step-card">
          <div class="step-head">
            <span class="step-number">{String(index + 1).padStart(2, '0')}</span>
            <h4>{decisions[step.id]?.edit?.title ?? step.title}</h4>
            <Badge
              tone={step.risk === 'high'
                ? 'danger'
                : step.risk === 'medium'
                  ? 'warning'
                  : 'neutral'}>{step.risk}</Badge
            ><Badge
              tone={step.status === 'done' || step.status === 'approved'
                ? 'success'
                : step.status === 'blocked' || step.status === 'rejected'
                  ? 'danger'
                  : 'neutral'}>{step.status}</Badge
            >
          </div>
          {#if step.origin === 'amendment'}<p class="step-flag">Added during execution</p>{/if}
          {#if decisions[step.id]?.edit}<p class="step-flag">Edited in your draft</p>{/if}
          {#if step.needsYou}<div class="decision-prompt">
              <strong>Decision:</strong><Markdown source={step.needsYou} compact />
            </div>{/if}
          {#if plan.state !== 'review' || plan.reviewReason !== 'plan'}<div class="step-execution">
              {#if step.note}<div class="execution-copy">
                  <strong>Progress:</strong><Markdown source={step.note} compact />
                </div>{/if}
              {#if step.check}<div
                  class:failed={step.check.outcome === 'fail'}
                  class="execution-copy"
                >
                  <strong>Check {step.check.outcome}:</strong>
                  <Markdown source={step.check.summary} compact />
                  {#if step.check.command}<code>{step.check.command}</code>{/if}
                </div>{/if}
              <p><strong>Planned files:</strong> {step.files.join(' · ') || 'None listed'}</p>
              <p>
                <strong>Touched files:</strong>
                {#each step.touched as file (file)}<button
                    class="file-link"
                    onclick={() => onselectfile(file)}>{file}</button
                  >{:else}
                  None reported{/each}
              </p>
            </div>{/if}
          <details
            open={!!step.needsYou ||
              step.origin === 'amendment' ||
              step.status === 'blocked' ||
              step.check?.outcome === 'fail'}
          >
            <summary>Step details</summary>
            <div class="step-prose">
              <Markdown source={decisions[step.id]?.edit?.detail ?? step.detail} compact />
            </div>
            {#if step.rationale}<div class="step-prose">
                <strong>Why:</strong><Markdown source={step.rationale} compact />
              </div>{/if}
            {#if step.dependsOn?.length}<p>After: {step.dependsOn.join(', ')}</p>{/if}
            {#if step.files.length}<p class="files">Files: {step.files.join(' · ')}</p>{/if}
            {#if plan.state === 'review' && plan.reviewReason === 'plan' && step.touched.length}<p
                class="files"
              >
                Touched: {step.touched.join(' · ')}
              </p>{/if}
            {#if plan.state === 'review' && plan.reviewReason === 'plan' && step.note}<div
                class="step-prose"
              >
                <strong>Progress:</strong><Markdown source={step.note} compact />
              </div>{/if}
            {#if plan.state === 'review' && plan.reviewReason === 'plan' && step.check}<div
                class="step-prose"
              >
                <strong>Check ({step.check.outcome}):</strong><Markdown
                  source={step.check.summary}
                  compact
                />{#if step.check.command}<code>{step.check.command}</code>{/if}
              </div>{/if}
            {#if step.diagram}<Diagram
                source={step.diagram}
                title={`${step.title} diagram`}
                {dark}
              />{/if}
          </details>
          {#if plan.state === 'review'}
            {#if step.status !== 'done' && step.status !== 'skipped'}<div class="decision-buttons">
                <Button
                  size="sm"
                  aria-label={`Approve ${step.title}`}
                  aria-pressed={decisions[step.id]?.verdict === 'approve'}
                  variant={decisions[step.id]?.verdict === 'approve' ? 'primary' : 'secondary'}
                  disabled={pending}
                  onclick={() => setDecision(step.id, 'approve')}>Approve</Button
                >
                <Button
                  size="sm"
                  aria-label={`Revise ${step.title}`}
                  aria-pressed={decisions[step.id]?.verdict === 'revise'}
                  variant={decisions[step.id]?.verdict === 'revise' ? 'primary' : 'secondary'}
                  disabled={pending}
                  onclick={() => setDecision(step.id, 'revise')}>Revise</Button
                >
                <Button
                  size="sm"
                  aria-label={`Reject ${step.title}`}
                  aria-pressed={decisions[step.id]?.verdict === 'reject'}
                  variant={decisions[step.id]?.verdict === 'reject' ? 'danger' : 'secondary'}
                  disabled={pending}
                  onclick={() => setDecision(step.id, 'reject')}>Reject</Button
                >
                <Button
                  size="sm"
                  aria-label={`Edit ${step.title}`}
                  aria-pressed={!!editing[step.id]}
                  variant={editing[step.id] ? 'primary' : 'secondary'}
                  disabled={pending}
                  onclick={() => {
                    editing[step.id] = !editing[step.id];
                  }}>Edit step</Button
                >
              </div>{/if}
            {#if editing[step.id] && step.status !== 'done' && step.status !== 'skipped'}
              <label class="edit-field"
                >Title<input
                  value={decisions[step.id]?.edit?.title ?? step.title}
                  maxlength="120"
                  aria-invalid={!!reviewErrors[`${step.id}:title`]}
                  disabled={pending}
                  oninput={(event) => setEdit(step.id, 'title', event.currentTarget.value)}
                /></label
              >
              {#if reviewErrors[`${step.id}:title`]}<p class="question-error" role="alert">
                  {reviewErrors[`${step.id}:title`]}
                </p>{/if}
              <label class="edit-field"
                >Detail<textarea
                  rows="4"
                  value={decisions[step.id]?.edit?.detail ?? step.detail}
                  maxlength="4000"
                  aria-invalid={!!reviewErrors[`${step.id}:detail`]}
                  disabled={pending}
                  oninput={(event) => setEdit(step.id, 'detail', event.currentTarget.value)}
                ></textarea></label
              >
              {#if reviewErrors[`${step.id}:detail`]}<p class="question-error" role="alert">
                  {reviewErrors[`${step.id}:detail`]}
                </p>{/if}
            {/if}
            <textarea
              rows="2"
              placeholder="Comment on this step (optional)"
              aria-label={`Comment on ${step.title}`}
              value={decisions[step.id]?.comment ?? step.comment ?? ''}
              maxlength="4000"
              aria-invalid={!!reviewErrors[`${step.id}:comment`]}
              disabled={pending}
              oninput={(event) => setComment(step.id, event.currentTarget.value)}></textarea>
            {#if reviewErrors[`${step.id}:comment`]}<p class="question-error" role="alert">
                {reviewErrors[`${step.id}:comment`]}
              </p>{/if}
          {/if}
        </section>
      {/each}
      {#if plan.state === 'review'}<textarea
          class="review-note"
          aria-label="General plan feedback"
          rows="2"
          placeholder="General feedback for the architect (optional)"
          maxlength="4000"
          aria-invalid={!!reviewErrors.note}
          disabled={pending}
          bind:value={note}
          oninput={() => {
            reviewErrors.note = '';
            savePlanDraft();
          }}></textarea>{/if}
      {#if reviewErrors.note}<p class="question-error" role="alert">{reviewErrors.note}</p>{/if}
    </div>
    {#if plan.state === 'review'}
      {#if confirming}<div class="execute-confirm" role="status">
          {plan.reviewReason === 'checkpoint' ? 'Continue execution' : 'Execute approved steps'}? {skipped.length}
          step{skipped.length === 1 ? '' : 's'} will not run{skipped.length
            ? `: ${skipped.join(', ')}`
            : ''}.
        </div>{/if}
      <div class="panel-actions split">
        <Button
          variant="secondary"
          onclick={() => sendReview('revise')}
          disabled={pending}
          loading={pending}>Request changes</Button
        >
        <Button
          onclick={() => (confirming ? sendReview('execute') : (confirming = true))}
          disabled={!canExecute || pending}
          loading={pending}
          >{confirming
            ? plan.reviewReason === 'checkpoint'
              ? 'Confirm continue'
              : 'Confirm execution'
            : plan.reviewReason === 'checkpoint'
              ? 'Continue execution'
              : 'Execute approved steps'}</Button
        >
      </div>
    {/if}
  {:else}
    <div class="panel-empty">
      <div class="panel-empty-mark">◇</div>
      <h3>Your plan appears here</h3>
      <p>
        Start a conversation with the architect. Diagrams, questions, and step decisions will appear
        alongside the chat.
      </p>
    </div>
  {/if}
</aside>

<style>
  .plan-panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    background: var(--sui-surface);
    border-left: 1px solid var(--shell-divider);
  }
  .panel-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 20px;
    border-bottom: 1px solid var(--shell-divider);
  }
  .eyebrow {
    margin: 0 0 3px;
    color: var(--sui-primary);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
  h3 {
    margin: 0 0 8px;
    font-size: 16px;
  }
  h4 {
    margin: 0;
    font-size: 14px;
  }
  .panel-scroll {
    flex: 1;
    overflow: auto;
    padding: 20px;
  }
  .summary,
  .muted {
    margin: 0 0 18px;
    color: var(--sui-muted);
    font-size: 13px;
    line-height: 1.55;
    white-space: pre-wrap;
  }
  .summary {
    white-space: normal;
  }
  .review-context,
  .execute-confirm {
    color: var(--sui-muted);
    font-size: 12px;
    line-height: 1.5;
  }
  .execute-confirm {
    padding: 12px 20px 0;
  }
  .execution-progress,
  .run-digest,
  .execution-alert {
    margin: 12px 0 20px;
    padding: 12px;
    border: 1px solid var(--shell-divider);
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.5;
  }
  .execution-progress > div {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  .execution-progress span {
    color: var(--sui-muted);
  }
  .execution-progress progress {
    width: 100%;
    height: 8px;
    margin-top: 10px;
    accent-color: var(--sui-primary);
  }
  .execution-alert {
    border-color: var(--sui-danger);
    color: var(--sui-danger-ink);
    background: var(--sui-danger-subtle);
  }
  .execution-alert p,
  .run-digest p {
    margin: 6px 0 0;
    overflow-wrap: anywhere;
  }
  .run-digest {
    background: var(--sui-canvas);
  }
  .diagram-heading {
    margin: 18px 0 8px;
  }
  .subheading {
    display: flex;
    justify-content: space-between;
    margin: 24px 0 10px;
    color: var(--sui-muted);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .alternative {
    padding: 12px 0;
    border-bottom: 1px solid var(--shell-divider);
    font-size: 13px;
  }
  .alternative :global(.sui-badge) {
    margin-left: 8px;
  }
  .alternative div {
    margin: 5px 0 0;
    color: var(--sui-muted);
  }
  .alternative ul {
    margin: 4px 0 8px;
    padding-left: 20px;
  }
  .alternative li {
    margin: 3px 0;
  }
  .step-card,
  .question-block {
    padding: 16px 0;
    border-top: 1px solid var(--shell-divider);
  }
  .step-head {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .step-head h4 {
    flex: 1;
  }
  .step-number {
    color: var(--sui-primary);
    font-size: 11px;
    font-weight: 700;
  }
  .step-card > p {
    margin: 10px 0;
    color: var(--sui-muted);
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .step-card details {
    margin-top: 10px;
    color: var(--sui-muted);
    font-size: 12px;
    line-height: 1.5;
  }
  .step-card details p {
    white-space: pre-wrap;
  }
  .step-prose {
    margin: 10px 0;
  }
  .step-card summary {
    cursor: pointer;
  }
  .step-card .step-flag {
    color: var(--sui-primary);
    font-weight: 600;
  }
  .edit-field {
    display: block;
    margin-top: 12px;
    font-size: 12px;
  }
  .edit-field input {
    display: block;
    width: 100%;
    margin-top: 5px;
    padding: 10px 12px;
    border: 1px solid var(--sui-border);
    border-radius: 8px;
    color: var(--sui-foreground);
    background: var(--sui-surface);
    font: 13px/1.5 var(--sui-font);
  }
  .step-card .decision-prompt {
    margin: 10px 0;
    color: var(--sui-foreground);
  }
  .step-card .files {
    font-family: ui-monospace, monospace;
    font-size: 11px;
  }
  .step-execution {
    margin-top: 10px;
    color: var(--sui-muted);
    font-size: 12px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .step-execution p {
    margin: 5px 0;
  }
  .step-execution .execution-copy {
    margin: 5px 0;
  }
  .step-execution .failed {
    color: var(--sui-danger);
  }
  .step-execution code {
    display: block;
    margin-top: 4px;
  }
  .file-link {
    margin: 0 3px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--sui-primary);
    font: inherit;
    text-decoration: underline;
    overflow-wrap: anywhere;
  }
  .decision-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 14px;
  }
  .question-block h4 {
    margin-bottom: 12px;
    line-height: 1.45;
  }
  .question-block h4 span {
    color: var(--sui-primary);
  }
  .question-recommendation,
  .question-state,
  .stale-answers {
    margin: 8px 20px;
    color: var(--sui-muted);
    font-size: 12px;
  }
  .question-recommendation {
    margin: 0 0 12px;
  }
  .question-error {
    color: var(--sui-danger);
    font-size: 12px;
  }
  .stale-answers p {
    overflow-wrap: anywhere;
  }
  .answer-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 9px;
    border: 1px solid var(--shell-divider);
    border-radius: 8px;
    margin-bottom: 7px;
    cursor: pointer;
  }
  .answer-option input {
    accent-color: var(--sui-primary);
    margin-top: 3px;
  }
  .answer-option strong {
    display: block;
    font-size: 13px;
  }
  .answer-option small {
    display: block;
    color: var(--sui-muted);
    margin-top: 2px;
  }
  textarea {
    width: 100%;
    margin-top: 12px;
    padding: 10px 12px;
    resize: vertical;
    border: 1px solid var(--sui-border);
    border-radius: 8px;
    color: var(--sui-foreground);
    background: var(--sui-surface);
    font: 13px/1.5 var(--sui-font);
  }
  textarea:focus {
    outline: 2px solid var(--sui-focus);
    outline-offset: 1px;
  }
  .review-note {
    margin-top: 20px;
  }
  .panel-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 16px 20px;
    border-top: 1px solid var(--shell-divider);
  }
  .panel-actions.split {
    justify-content: space-between;
  }
  .panel-empty {
    margin: auto;
    max-width: 290px;
    padding: 30px;
    text-align: center;
  }
  .panel-empty-mark {
    color: var(--sui-primary);
    font-size: 42px;
  }
  .panel-empty p {
    color: var(--sui-muted);
    font-size: 13px;
    line-height: 1.5;
  }
  .panel-error {
    margin: 12px 20px 0;
    padding: 10px;
    color: var(--sui-danger-ink);
    background: var(--sui-danger-subtle);
    border-radius: 8px;
    font-size: 12px;
  }
</style>

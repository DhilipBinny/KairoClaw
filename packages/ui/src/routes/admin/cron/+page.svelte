<script lang="ts">
  import { onMount } from 'svelte';
  import { getCronJobs, createCronJob, updateCronJob, deleteCronJob, runCronJob } from '$lib/api';
  import type { CronJob, CreateCronJob } from '$lib/api';
  import Badge from '$lib/components/Badge.svelte';

  let jobs: CronJob[] = $state([]);
  let loading = $state(true);
  let actionInProgress = $state('');
  let error = $state('');
  let successMsg = $state('');

  // Form state
  let formName = $state('');
  let formScheduleType = $state<'cron' | 'every' | 'at'>('cron');
  let formScheduleValue = $state('');
  let formTimezone = $state('Asia/Dubai');
  let formPrompt = $state('');
  let formTargets = $state<Array<{ channel: string; to: string }>>([]);
  let formEnabled = $state(true);
  let creating = $state(false);
  let showCreateForm = $state(false);

  // Delete confirmation state (two-click pattern)
  let confirmDeleteId = $state<string | null>(null);
  let confirmDeleteTimer: ReturnType<typeof setTimeout> | null = null;

  // Edit state
  let editingJobId = $state<string | null>(null);
  let editName = $state('');
  let editScheduleType = $state<'cron' | 'every' | 'at'>('cron');
  let editScheduleValue = $state('');
  let editTimezone = $state('');
  let editPrompt = $state('');
  let editTargets = $state<Array<{ channel: string; to: string }>>([]);
  let editEnabled = $state(true);
  let saving = $state(false);

  function startEdit(job: CronJob) {
    editingJobId = job.id;
    editName = job.name || '';
    editScheduleType = (job.schedule?.type as 'cron' | 'every' | 'at') || 'cron';
    editScheduleValue = String(job.schedule?.value || '');
    editTimezone = job.schedule?.tz || '';
    editPrompt = job.prompt || '';
    editEnabled = job.enabled;
    const delivery = typeof job.delivery === 'object' ? job.delivery : null;
    const targets: Array<{ channel: string; to?: string }> = delivery?.targets || [];
    if (targets.length === 0 && delivery?.channel) {
      const chs = Array.isArray(delivery.channel) ? delivery.channel : [delivery.channel];
      for (const ch of chs) targets.push({ channel: ch, to: delivery.to });
    }
    editTargets = targets.map(t => ({ channel: t.channel, to: t.to || '' }));
  }

  function buildDelivery(targets: Array<{ channel: string; to: string }>): Record<string, unknown> | string {
    const cleaned = targets
      .filter(t => t.channel)
      .map(t => t.channel === 'web' ? { channel: t.channel } : { channel: t.channel, to: t.to || undefined });
    if (cleaned.length === 0) return 'none';
    return { mode: 'announce', targets: cleaned };
  }

  function cancelEdit() {
    editingJobId = null;
  }

  async function handleSaveEdit() {
    if (!editingJobId) return;
    saving = true;
    error = '';
    try {
      const updates: Record<string, unknown> = {
        name: editName,
        prompt: editPrompt,
        enabled: editEnabled,
        schedule: {
          type: editScheduleType,
          value: editScheduleType === 'every' ? parseInt(editScheduleValue) : editScheduleValue,
          tz: editTimezone || 'UTC',
        },
      };
      updates.delivery = buildDelivery(editTargets);
      await updateCronJob(editingJobId, updates as any);
      editingJobId = null;
      await loadJobs();
      successMsg = 'Job updated successfully';
      setTimeout(() => { successMsg = ''; }, 3000);
    } catch (e: any) {
      error = e.message || 'Failed to update job';
    } finally {
      saving = false;
    }
  }

  let schedulePlaceholder = $derived(
    formScheduleType === 'cron'
      ? '*/30 9-17 * * 1-5'
      : formScheduleType === 'every'
        ? '1800000'
        : '2026-04-01T09:00:00Z'
  );

  let scheduleHint = $derived(
    formScheduleType === 'cron'
      ? 'Standard 5-field cron: min hour dom month dow'
      : formScheduleType === 'every'
        ? 'Interval in milliseconds (min 5000)'
        : 'ISO 8601 datetime for one-shot execution'
  );

  function statusVariant(job: CronJob): 'green' | 'red' | 'default' {
    if (!job.enabled) return 'default';
    if (job.lastError) return 'red';
    return 'green';
  }

  function statusLabel(job: CronJob): string {
    if (!job.enabled) return 'disabled';
    if (job.lastError) return 'error';
    return 'active';
  }

  function formatSchedule(job: CronJob): string {
    const s = job.schedule;
    if (s.type === 'cron') return `cron: ${s.value}`;
    if (s.type === 'every') {
      const ms = Number(s.value);
      if (ms >= 3600000) return `every ${(ms / 3600000).toFixed(1)}h`;
      if (ms >= 60000) return `every ${(ms / 60000).toFixed(0)}m`;
      return `every ${(ms / 1000).toFixed(0)}s`;
    }
    if (s.type === 'at') return `at: ${new Date(s.value as string).toLocaleString()}`;
    return String(s.value);
  }

  function truncate(text: string, len = 120): string {
    if (!text) return '';
    return text.length > len ? text.slice(0, len) + '...' : text;
  }

  function formatDate(iso: string | null): string {
    if (!iso) return 'Never';
    return new Date(iso).toLocaleString();
  }

  function deliveryLabel(delivery: CronJob['delivery']): string {
    if (!delivery || delivery === 'none') return 'None';
    if (typeof delivery === 'string') return delivery;
    // New targets format
    if (delivery.targets && delivery.targets.length > 0) {
      return delivery.targets.map((t: { channel: string; to?: string }) =>
        t.to ? `${t.channel} → ${t.to}` : t.channel
      ).join(', ');
    }
    // Legacy format
    const channels = Array.isArray(delivery.channel)
      ? delivery.channel.join(', ')
      : delivery.channel || delivery.mode;
    const parts = [channels];
    if (delivery.to) parts.push(delivery.to);
    return parts.join(' → ');
  }

  async function loadJobs() {
    loading = true;
    error = '';
    try {
      const data = await getCronJobs();
      jobs = data.jobs || [];
    } catch (e: any) {
      error = e.message || 'Failed to load cron jobs';
    } finally {
      loading = false;
    }
  }

  async function handleRun(id: string) {
    actionInProgress = `run-${id}`;
    error = '';
    try {
      const result = await runCronJob(id);
      successMsg = result.lastResult ? `Result: ${truncate(result.lastResult, 200)}` : 'Job executed successfully';
      await loadJobs();
      setTimeout(() => { successMsg = ''; }, 5000);
    } catch (e: any) {
      error = e.message || 'Failed to run job';
    } finally {
      actionInProgress = '';
    }
  }

  function requestDelete(id: string) {
    if (confirmDeleteId === id) {
      performDelete(id);
      return;
    }
    confirmDeleteId = id;
    if (confirmDeleteTimer) clearTimeout(confirmDeleteTimer);
    confirmDeleteTimer = setTimeout(() => { confirmDeleteId = null; }, 3000);
  }

  async function performDelete(id: string) {
    confirmDeleteId = null;
    if (confirmDeleteTimer) clearTimeout(confirmDeleteTimer);
    actionInProgress = `delete-${id}`;
    error = '';
    try {
      await deleteCronJob(id);
      await loadJobs();
    } catch (e: any) {
      error = e.message || 'Failed to delete job';
    } finally {
      actionInProgress = '';
    }
  }

  async function handleCreate() {
    if (!formPrompt.trim()) {
      error = 'Prompt is required';
      return;
    }
    if (!formScheduleValue.trim()) {
      error = 'Schedule value is required';
      return;
    }

    creating = true;
    error = '';
    try {
      const scheduleValue: string | number = formScheduleType === 'every'
        ? parseInt(formScheduleValue)
        : formScheduleValue;

      const newJob: CreateCronJob = {
        name: formName || undefined,
        schedule: {
          type: formScheduleType,
          value: scheduleValue,
          tz: formTimezone || 'UTC',
        },
        prompt: formPrompt,
        enabled: formEnabled,
      };

      const delivery = buildDelivery(formTargets);
      if (delivery !== 'none') {
        newJob.delivery = delivery as any;
      }

      await createCronJob(newJob);
      // Reset form and close
      formName = '';
      formScheduleValue = '';
      formPrompt = '';
      formTargets = [];
      formEnabled = true;
      showCreateForm = false;
      await loadJobs();
    } catch (e: any) {
      error = e.message || 'Failed to create job';
    } finally {
      creating = false;
    }
  }

  onMount(loadJobs);
</script>

<svelte:head>
  <title>Cron Jobs - Admin - Kairo</title>
</svelte:head>

<div class="cron-page">
  <div class="page-header">
    <div class="page-header-row">
      <div>
        <h1 class="page-title">Cron Jobs</h1>
        <p class="page-desc">Schedule recurring or one-shot AI agent tasks.</p>
      </div>
      <button class="btn btn-primary" aria-label={showCreateForm ? 'Cancel creating new job' : 'Create new cron job'} onclick={() => showCreateForm = !showCreateForm}>
        {showCreateForm ? 'Cancel' : '+ New Job'}
      </button>
    </div>
  </div>

  {#if error}
    <div class="alert alert-error">{error}</div>
  {/if}
  {#if successMsg}
    <div class="alert alert-success">{successMsg}</div>
  {/if}

  {#if loading}
    <div class="loading"><span class="spinner"></span> Loading...</div>
  {:else}
    <!-- Create New Job (collapsible, at top) -->
    {#if showCreateForm}
      <div class="section create-section">
        <div class="card create-form">
          <h3 class="create-form-title">Create New Job</h3>
          <div class="form-row">
            <div class="form-group">
              <label class="label" for="job-name">Name</label>
              <input class="input" id="job-name" type="text" bind:value={formName} placeholder="Daily summary" />
            </div>
          </div>

          <div class="form-row form-row-2">
            <div class="form-group">
              <label class="label" for="schedule-type">Schedule Type</label>
              <select class="input" id="schedule-type" bind:value={formScheduleType}>
                <option value="cron">Cron Expression</option>
                <option value="every">Interval (ms)</option>
                <option value="at">One-shot (at)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="label" for="schedule-value">Schedule Value</label>
              <input class="input" id="schedule-value" type="text" bind:value={formScheduleValue} placeholder={schedulePlaceholder} />
              <span class="form-hint">{scheduleHint}</span>
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="label" for="timezone">Timezone</label>
              <input class="input" id="timezone" type="text" bind:value={formTimezone} placeholder="UTC" />
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="label" for="prompt">Prompt</label>
              <textarea class="input" id="prompt" bind:value={formPrompt} placeholder="What should the AI do when this job fires?"></textarea>
              <span class="char-count" class:warn={formPrompt.length > 4000}>
                {formPrompt.length} / 5000
              </span>
            </div>
          </div>

          <div class="form-group">
            <label class="label">Delivery Targets</label>
            <div class="delivery-targets">
              {#each formTargets as target, i}
                <div class="delivery-row">
                  <select class="input input-sm" bind:value={target.channel} style="width: 130px; flex: none;">
                    <option value="telegram">Telegram</option>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="web">Web</option>
                  </select>
                  {#if target.channel !== 'web'}
                    <input class="input input-sm" type="text" bind:value={target.to}
                      placeholder={target.channel === 'telegram' ? 'Chat ID, e.g. -1001234567890' : 'JID, e.g. 1234567890@s.whatsapp.net'} />
                  {:else}
                    <span class="text-muted" style="font-size: 12px;">Broadcasts to web UI</span>
                  {/if}
                  <button class="btn btn-xs btn-danger" type="button" aria-label="Remove delivery target" onclick={() => { formTargets = formTargets.filter((_, j) => j !== i); }}>×</button>
                </div>
              {/each}
              <button class="btn btn-xs" type="button" aria-label="Add delivery target" onclick={() => { formTargets = [...formTargets, { channel: 'telegram', to: '' }]; }}>+ Add target</button>
            </div>
          </div>

          <div class="form-row">
            <label class="checkbox-label">
              <input type="checkbox" bind:checked={formEnabled} />
              <span>Enabled</span>
            </label>
          </div>

          <div class="form-row form-actions">
            <button class="btn btn-primary" aria-label="Create cron job" onclick={handleCreate} disabled={creating}>
              {creating ? 'Creating...' : 'Create Job'}
            </button>
            <button class="btn" aria-label="Cancel creating job" onclick={() => showCreateForm = false}>Cancel</button>
          </div>
        </div>
      </div>
    {/if}

    <!-- Existing Jobs -->
    <div class="section">
      <h2 class="section-title">
        Scheduled Jobs
        <span class="section-count">{jobs.length}</span>
      </h2>
      {#if jobs.length === 0}
        <div class="empty-state">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-ghost)">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          No cron jobs configured yet. Create one below.
        </div>
      {:else}
        <div class="job-list">
          {#each jobs as job}
            <div class="card job-card">
              {#if editingJobId === job.id}
                <!-- Edit mode -->
                <div class="edit-form">
                  <div class="form-row">
                    <div class="form-group">
                      <label class="label">Name</label>
                      <input class="input" type="text" bind:value={editName} />
                    </div>
                  </div>
                  <div class="form-row form-row-2">
                    <div class="form-group">
                      <label class="label">Schedule Type</label>
                      <select class="input" bind:value={editScheduleType}>
                        <option value="cron">Cron Expression</option>
                        <option value="every">Interval (ms)</option>
                        <option value="at">One-shot (at)</option>
                      </select>
                    </div>
                    <div class="form-group">
                      <label class="label">Schedule Value</label>
                      <input class="input" type="text" bind:value={editScheduleValue} />
                    </div>
                  </div>
                  <div class="form-row">
                    <div class="form-group">
                      <label class="label">Timezone</label>
                      <input class="input" type="text" bind:value={editTimezone} placeholder="UTC" />
                    </div>
                  </div>
                  <div class="form-row">
                    <div class="form-group">
                      <label class="label">Prompt</label>
                      <textarea class="input" bind:value={editPrompt} rows="5"></textarea>
                      <span class="char-count" class:warn={editPrompt.length > 4000}>
                        {editPrompt.length} / 5000
                      </span>
                    </div>
                  </div>
                  <div class="form-group">
                    <label class="label">Delivery Targets</label>
                    <div class="delivery-targets">
                      {#each editTargets as target, i}
                        <div class="delivery-row">
                          <select class="input input-sm" bind:value={target.channel} style="width: 130px; flex: none;">
                            <option value="telegram">Telegram</option>
                            <option value="whatsapp">WhatsApp</option>
                            <option value="web">Web</option>
                          </select>
                          {#if target.channel !== 'web'}
                            <input class="input input-sm" type="text" bind:value={target.to}
                              placeholder={target.channel === 'telegram' ? 'Chat ID, e.g. -1001234567890' : 'JID, e.g. 1234567890@s.whatsapp.net'} />
                          {:else}
                            <span class="text-muted" style="font-size: 12px;">Broadcasts to web UI</span>
                          {/if}
                          <button class="btn btn-xs btn-danger" type="button" aria-label="Remove delivery target" onclick={() => { editTargets = editTargets.filter((_, j) => j !== i); }}>×</button>
                        </div>
                      {/each}
                      <button class="btn btn-xs" type="button" aria-label="Add delivery target" onclick={() => { editTargets = [...editTargets, { channel: 'telegram', to: '' }]; }}>+ Add target</button>
                    </div>
                  </div>
                  <div class="form-row">
                    <label class="checkbox-label">
                      <input type="checkbox" bind:checked={editEnabled} />
                      <span>Enabled</span>
                    </label>
                  </div>
                  <div class="job-actions">
                    <button class="btn btn-sm btn-primary" aria-label="Save job changes" onclick={handleSaveEdit} disabled={saving}>
                      {saving ? 'Saving...' : 'Save Changes'}
                    </button>
                    <button class="btn btn-sm" aria-label="Cancel editing job" onclick={cancelEdit}>Cancel</button>
                  </div>
                </div>
              {:else}
                <!-- View mode -->
                <div class="job-header">
                  <div class="job-title-row">
                    <h3 class="job-name">{job.name || 'Untitled'}</h3>
                    <Badge variant={statusVariant(job)}>{statusLabel(job)}</Badge>
                  </div>
                  <div class="job-schedule">{formatSchedule(job)}</div>
                </div>

                <div class="job-prompt">{job.prompt}</div>

                <div class="job-meta">
                  <div class="meta-item">
                    <span class="meta-label">Delivery</span>
                    <span class="meta-value">{deliveryLabel(job.delivery)}</span>
                  </div>
                  <div class="meta-item">
                    <span class="meta-label">Last run</span>
                    <span class="meta-value">{formatDate(job.lastRun)}</span>
                  </div>
                  <div class="meta-item">
                    <span class="meta-label">Runs</span>
                    <span class="meta-value">{job.runCount || 0}</span>
                  </div>
                  {#if job.schedule.tz}
                    <div class="meta-item">
                      <span class="meta-label">Timezone</span>
                      <span class="meta-value">{job.schedule.tz}</span>
                    </div>
                  {/if}
                </div>

                {#if job.lastError}
                  <div class="job-error" title={job.lastError}>Error: {truncate(job.lastError, 200)}</div>
                {/if}

                {#if job.lastResult}
                  <div class="job-result" title={job.lastResult}>Last result: {truncate(job.lastResult, 200)}</div>
                {/if}

                <div class="job-actions">
                  <button class="btn btn-sm" aria-label="Edit cron job" onclick={() => startEdit(job)}>
                    Edit
                  </button>
                  <button
                    class="btn btn-sm btn-primary"
                    aria-label="Run cron job now"
                    onclick={() => handleRun(job.id)}
                    disabled={actionInProgress === `run-${job.id}`}
                  >
                    {actionInProgress === `run-${job.id}` ? 'Running...' : 'Run Now'}
                  </button>
                  <button
                    class="btn btn-sm btn-danger"
                    aria-label={confirmDeleteId === job.id ? 'Confirm delete cron job' : 'Delete cron job'}
                    onclick={() => requestDelete(job.id)}
                    disabled={actionInProgress === `delete-${job.id}`}
                  >
                    {actionInProgress === `delete-${job.id}` ? '...' : confirmDeleteId === job.id ? 'Confirm?' : 'Delete'}
                  </button>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Create form is now at the top (collapsible) -->
  {/if}
</div>

<style>
  .cron-page {
    max-width: 1000px;
  }
  .page-header {
    margin-bottom: 24px;
  }
  .page-header-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
  }
  .create-section {
    margin-bottom: 24px;
  }
  .create-form-title {
    font-size: 15px;
    font-weight: 600;
    margin-bottom: 16px;
  }
  .form-actions {
    display: flex;
    gap: 8px;
  }
  .page-title {
    font-size: 24px;
    font-weight: 700;
    margin-bottom: 4px;
    letter-spacing: -0.3px;
  }
  .page-desc {
    color: var(--text-muted);
    font-size: 14px;
  }
  .loading {
    color: var(--text-muted);
    padding: 40px 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .section {
    margin-bottom: 32px;
  }
  .section-title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .section-count {
    font-size: 12px;
    color: var(--text-muted);
    background: var(--bg-raised);
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 500;
  }
  .empty-state {
    padding: 32px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }
  .alert {
    padding: 10px 16px;
    border-radius: var(--radius);
    font-size: 13px;
    margin-bottom: 16px;
  }
  .alert-error {
    background: var(--red-subtle);
    color: var(--red);
    border: 1px solid rgba(244, 63, 94, 0.2);
  }
  .alert-success {
    background: var(--green-subtle);
    color: var(--green);
    border: 1px solid rgba(52, 211, 153, 0.2);
  }

  /* Job cards */
  .job-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .job-card {
    padding: 18px 22px;
    transition: border-color var(--duration) var(--ease);
  }
  .job-card:hover {
    border-color: var(--border);
  }
  .job-header {
    margin-bottom: 10px;
  }
  .job-title-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }
  .job-name {
    font-size: 14px;
    font-weight: 600;
  }
  .job-schedule {
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-muted);
  }
  .job-prompt {
    font-size: 13px;
    color: var(--text-secondary);
    margin-bottom: 12px;
    line-height: 1.4;
    padding: 8px 12px;
    background: var(--bg-void);
    border-radius: var(--radius);
    border: 1px solid var(--border-subtle);
  }
  .job-meta {
    display: flex;
    gap: 20px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .meta-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .meta-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .meta-value {
    font-size: 12px;
    color: var(--text-secondary);
  }
  .job-error {
    font-size: 12px;
    color: var(--red);
    background: var(--red-subtle);
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    margin-bottom: 12px;
    border: 1px solid rgba(244, 63, 94, 0.15);
  }
  .job-result {
    font-size: 12px;
    color: var(--text-muted);
    background: var(--bg-raised);
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    margin-bottom: 12px;
    font-family: var(--font-mono);
    border: 1px solid var(--border-subtle);
  }
  .job-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  /* Edit form (inline) */
  .edit-form {
    display: flex;
    flex-direction: column;
  }
  .edit-form .form-row {
    margin-bottom: 12px;
  }
  .edit-form .form-row-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .edit-form textarea.input {
    min-height: 100px;
  }

  /* Create form */
  .create-form {
    padding: 24px;
  }
  .form-row {
    margin-bottom: 16px;
  }
  .form-row-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .form-group {
    display: flex;
    flex-direction: column;
  }
  .form-hint {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 4px;
  }
  .delivery-targets {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .delivery-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .delivery-row .input-sm {
    flex: 1;
    font-size: 12px;
    padding: 4px 8px;
    height: 30px;
  }
  .delivery-row .btn-danger {
    color: var(--red, #ef4444);
    border-color: var(--red, #ef4444);
    padding: 2px 8px;
    font-size: 14px;
    line-height: 1;
    flex: none;
  }
  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .checkbox-label input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: var(--accent);
    cursor: pointer;
  }

  .char-count {
    font-size: 11px;
    color: var(--text-muted);
    text-align: right;
    display: block;
    margin-top: 4px;
  }
  .char-count.warn {
    color: var(--yellow);
  }

  @media (max-width: 768px) {
    .form-row-2 {
      grid-template-columns: 1fr;
    }
  }
</style>

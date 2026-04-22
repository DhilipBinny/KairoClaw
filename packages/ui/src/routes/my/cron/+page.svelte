<script lang="ts">
  import { onMount } from 'svelte';
  import { getMyCrons, updateMyCron, deleteMyCron } from '$lib/api';
  import Badge from '$lib/components/Badge.svelte';

  let jobs: Array<Record<string, any>> = $state([]);
  let loading = $state(true);
  let error = $state('');
  let successMsg = $state('');

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

  // Delete confirmation
  let confirmDeleteId = $state<string | null>(null);
  let confirmDeleteTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadJobs() {
    loading = true;
    error = '';
    try {
      const data = await getMyCrons();
      jobs = data.jobs || [];
    } catch { /* ignore */ }
    finally { loading = false; }
  }

  onMount(loadJobs);

  function formatSchedule(job: Record<string, any>): string {
    const s = job.schedule;
    if (!s) return '—';
    if (s.type === 'cron') return `cron: ${s.value}`;
    if (s.type === 'every') {
      const ms = Number(s.value);
      if (ms >= 3600000) return `every ${(ms / 3600000).toFixed(1)}h`;
      if (ms >= 60000) return `every ${(ms / 60000).toFixed(0)}m`;
      return `every ${(ms / 1000).toFixed(0)}s`;
    }
    if (s.type === 'at') return `at: ${new Date(s.value).toLocaleString()}`;
    return String(s.value);
  }

  function deliveryLabel(delivery: any): string {
    if (!delivery || delivery === 'none') return 'None';
    if (typeof delivery === 'string') return delivery;
    if (delivery.targets && delivery.targets.length > 0) {
      return delivery.targets.map((t: { channel: string; to?: string }) =>
        t.to ? `${t.channel} → ${t.to}` : t.channel
      ).join(', ');
    }
    return String(delivery.mode || 'unknown');
  }

  function startEdit(job: Record<string, any>) {
    editingJobId = job.id;
    editName = job.name || '';
    editScheduleType = (job.schedule?.type as 'cron' | 'every' | 'at') || 'cron';
    editScheduleValue = String(job.schedule?.value || '');
    editTimezone = job.schedule?.tz || '';
    editPrompt = job.prompt || '';
    editEnabled = job.enabled;
    const delivery = typeof job.delivery === 'object' ? job.delivery : null;
    const targets: Array<{ channel: string; to?: string }> = delivery?.targets || [];
    editTargets = targets.map(t => ({ channel: t.channel, to: t.to || '' }));
  }

  function cancelEdit() { editingJobId = null; }

  function buildDelivery(targets: Array<{ channel: string; to: string }>): Record<string, unknown> | string {
    const cleaned = targets
      .filter(t => t.channel)
      .map(t => t.channel === 'web' ? { channel: t.channel } : { channel: t.channel, to: t.to || undefined });
    if (cleaned.length === 0) return 'none';
    return { mode: 'announce', targets: cleaned };
  }

  async function handleSaveEdit() {
    if (!editingJobId) return;
    saving = true;
    error = '';
    try {
      await updateMyCron(editingJobId, {
        name: editName,
        prompt: editPrompt,
        enabled: editEnabled,
        schedule: {
          type: editScheduleType,
          value: editScheduleType === 'every' ? parseInt(editScheduleValue) : editScheduleValue,
          tz: editTimezone || 'UTC',
        },
        delivery: buildDelivery(editTargets),
      });
      editingJobId = null;
      await loadJobs();
      successMsg = 'Job updated';
      setTimeout(() => { successMsg = ''; }, 3000);
    } catch (e: any) {
      error = e.message || 'Failed to update';
    } finally { saving = false; }
  }

  function requestDelete(id: string) {
    if (confirmDeleteId === id) { performDelete(id); return; }
    confirmDeleteId = id;
    if (confirmDeleteTimer) clearTimeout(confirmDeleteTimer);
    confirmDeleteTimer = setTimeout(() => { confirmDeleteId = null; }, 3000);
  }

  async function performDelete(id: string) {
    confirmDeleteId = null;
    if (confirmDeleteTimer) clearTimeout(confirmDeleteTimer);
    error = '';
    try {
      await deleteMyCron(id);
      jobs = jobs.filter(j => j.id !== id);
    } catch (e: any) { error = e.message || 'Failed to delete'; }
  }
</script>

<svelte:head><title>My Cron Jobs - Kairo</title></svelte:head>

<h1 class="page-title">My Cron Jobs</h1>
<p class="subtitle">Scheduled tasks created by you or assigned to you.</p>

{#if error}<div class="alert alert-error">{error}</div>{/if}
{#if successMsg}<div class="alert alert-success">{successMsg}</div>{/if}

{#if loading}
  <span class="spinner"></span>
{:else if jobs.length === 0}
  <p class="empty">No cron jobs yet. Ask the agent to create one: "remind me every morning at 9am to check my email"</p>
{:else}
  <div class="job-list">
    {#each jobs as job}
      <div class="job-card">
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
                        placeholder={target.channel === 'telegram' ? 'Chat ID' : 'phone@s.whatsapp.net'} />
                    {:else}
                      <span class="text-muted" style="font-size: 12px;">Broadcasts to web UI</span>
                    {/if}
                    <button class="btn btn-xs btn-danger" type="button" onclick={() => { editTargets = editTargets.filter((_, j) => j !== i); }}>×</button>
                  </div>
                {/each}
                <button class="btn btn-xs" type="button" onclick={() => { editTargets = [...editTargets, { channel: 'telegram', to: '' }]; }}>+ Add target</button>
              </div>
            </div>
            <div class="form-row">
              <label class="checkbox-label">
                <input type="checkbox" bind:checked={editEnabled} />
                <span>Enabled</span>
              </label>
            </div>
            <div class="job-actions">
              <button class="btn btn-sm btn-primary" onclick={handleSaveEdit} disabled={saving}>
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
              <button class="btn btn-sm" onclick={cancelEdit}>Cancel</button>
            </div>
          </div>
        {:else}
          <!-- View mode -->
          <div class="job-header">
            <span class="job-name">{job.name || 'Untitled'}</span>
            <Badge variant={job.enabled ? 'green' : 'default'}>{job.enabled ? 'Active' : 'Disabled'}</Badge>
          </div>
          <div class="job-schedule">{formatSchedule(job)}</div>
          <div class="job-prompt">{job.prompt}</div>
          <div class="job-meta">
            <div class="meta-item">
              <span class="meta-label">Delivery</span>
              <span class="meta-value">{deliveryLabel(job.delivery)}</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">Last run</span>
              <span class="meta-value">{job.lastRun ? new Date(job.lastRun).toLocaleString() : 'Never'}</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">Runs</span>
              <span class="meta-value">{job.runCount || 0}</span>
            </div>
            {#if job.schedule?.tz}
              <div class="meta-item">
                <span class="meta-label">Timezone</span>
                <span class="meta-value">{job.schedule.tz}</span>
              </div>
            {/if}
          </div>
          {#if job.lastError}
            <div class="job-error">Error: {job.lastError}</div>
          {/if}
          <div class="job-actions">
            <button class="btn btn-sm" onclick={() => startEdit(job)}>Edit</button>
            <button class="btn btn-sm btn-danger" onclick={() => requestDelete(job.id)}>
              {confirmDeleteId === job.id ? 'Confirm?' : 'Delete'}
            </button>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .page-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
  .subtitle { color: var(--text-muted); font-size: 13px; margin-bottom: 20px; }
  .empty { color: var(--text-muted); }
  .alert { padding: 10px 16px; border-radius: var(--radius); font-size: 13px; margin-bottom: 16px; }
  .alert-error { background: var(--red-subtle); color: var(--red); border: 1px solid rgba(244, 63, 94, 0.2); }
  .alert-success { background: var(--green-subtle); color: var(--green); border: 1px solid rgba(52, 211, 153, 0.2); }
  .job-list { display: flex; flex-direction: column; gap: 12px; }
  .job-card {
    background: var(--bg-surface); border: 1px solid var(--border-subtle);
    border-radius: var(--radius); padding: 18px 22px;
  }
  .job-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .job-name { font-size: 14px; font-weight: 600; }
  .job-schedule { font-size: 12px; font-family: var(--font-mono, monospace); color: var(--text-muted); margin-bottom: 8px; }
  .job-prompt {
    font-size: 13px; color: var(--text-secondary); margin-bottom: 12px; line-height: 1.4;
    padding: 8px 12px; background: var(--bg-void, #f8f8f8); border-radius: var(--radius); border: 1px solid var(--border-subtle);
  }
  .job-meta { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 12px; }
  .meta-item { display: flex; flex-direction: column; gap: 2px; }
  .meta-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .meta-value { font-size: 12px; color: var(--text-secondary); }
  .job-error { font-size: 12px; color: var(--red, #e53e3e); background: var(--red-subtle, #fff5f5); padding: 8px 12px; border-radius: 4px; margin-bottom: 12px; }
  .job-actions { display: flex; gap: 8px; flex-wrap: wrap; }

  /* Edit form */
  .edit-form { display: flex; flex-direction: column; }
  .edit-form .form-row { margin-bottom: 12px; }
  .edit-form .form-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .edit-form textarea.input { min-height: 100px; }
  .form-group { display: flex; flex-direction: column; }
  .delivery-targets { display: flex; flex-direction: column; gap: 8px; }
  .delivery-row { display: flex; align-items: center; gap: 12px; }
  .delivery-row .input-sm { flex: 1; font-size: 16px; padding: 4px 8px; height: 30px; }
  .delivery-row .btn-danger { color: var(--red, #ef4444); border-color: var(--red, #ef4444); padding: 2px 8px; font-size: 14px; line-height: 1; flex: none; }
  .checkbox-label { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); cursor: pointer; }
  .checkbox-label input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; }
  .text-muted { color: var(--text-muted); }

  @media (min-width: 769px) { .delivery-row .input-sm { font-size: 12px; } }
  @media (max-width: 768px) {
    .edit-form .form-row-2 { grid-template-columns: 1fr; }
  }
</style>

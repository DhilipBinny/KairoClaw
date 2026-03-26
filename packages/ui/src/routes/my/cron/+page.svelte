<script lang="ts">
  import { onMount } from 'svelte';
  import { getMyCrons, toggleMyCron, deleteMyCron } from '$lib/api';
  import Badge from '$lib/components/Badge.svelte';

  let jobs: Array<Record<string, any>> = $state([]);
  let loading = $state(true);

  onMount(async () => {
    try {
      const data = await getMyCrons();
      jobs = data.jobs || [];
    } catch { /* ignore */ }
    finally { loading = false; }
  });

  function formatSchedule(job: Record<string, any>): string {
    const s = job.schedule;
    if (!s) return '—';
    if (s.type === 'cron') return `cron: ${s.value}`;
    if (s.type === 'every') return `every ${Math.round(Number(s.value) / 60000)}min`;
    if (s.type === 'at') return `at: ${s.value}`;
    return String(s.value);
  }

  async function handleToggle(job: Record<string, any>) {
    const newEnabled = !job.enabled;
    try {
      await toggleMyCron(job.id, newEnabled);
      job.enabled = newEnabled;
    } catch { /* ignore */ }
  }

  async function handleDelete(job: Record<string, any>) {
    if (!confirm(`Delete "${job.name || 'this job'}"? This cannot be undone.`)) return;
    try {
      await deleteMyCron(job.id);
      jobs = jobs.filter(j => j.id !== job.id);
    } catch { /* ignore */ }
  }
</script>

<svelte:head><title>My Cron Jobs - Kairo</title></svelte:head>

<h1 class="page-title">My Cron Jobs</h1>
<p class="subtitle">Jobs you created via the agent. You can enable/disable or delete them here.</p>

{#if loading}
  <span class="spinner"></span>
{:else if jobs.length === 0}
  <p class="empty">No cron jobs yet. Ask the agent to create one: "remind me every morning at 9am to check my email"</p>
{:else}
  <div class="job-list">
    {#each jobs as job}
      <div class="job-card">
        <div class="job-header">
          <span class="job-name">{job.name || 'Untitled'}</span>
          <Badge variant={job.enabled ? 'green' : 'default'}>{job.enabled ? 'Active' : 'Disabled'}</Badge>
          <div class="job-actions">
            <button class="btn-toggle" onclick={() => handleToggle(job)} title={job.enabled ? 'Disable' : 'Enable'}>
              {job.enabled ? 'Disable' : 'Enable'}
            </button>
            <button class="btn-delete" onclick={() => handleDelete(job)} title="Delete">Delete</button>
          </div>
        </div>
        <div class="job-schedule">{formatSchedule(job)}</div>
        <div class="job-prompt">{job.prompt}</div>
        {#if job.lastRun}
          <div class="job-meta">Last run: {new Date(job.lastRun).toLocaleString()} ({job.runCount || 0} runs)</div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .page-title { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
  .subtitle { color: var(--text-muted); font-size: 13px; margin-bottom: 20px; }
  .empty { color: var(--text-muted); }
  .job-list { display: flex; flex-direction: column; gap: 8px; }
  .job-card {
    background: var(--bg-surface); border: 1px solid var(--border-subtle);
    border-radius: var(--radius); padding: 14px 16px;
  }
  .job-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
  .job-name { font-size: 14px; font-weight: 600; }
  .job-actions { margin-left: auto; display: flex; gap: 6px; }
  .btn-toggle, .btn-delete {
    font-size: 12px; padding: 3px 10px; border-radius: 4px; border: 1px solid var(--border-subtle);
    background: var(--bg-surface); color: var(--text-secondary); cursor: pointer;
  }
  .btn-toggle:hover { background: var(--bg-hover, #f0f0f0); }
  .btn-delete { color: var(--error, #e53e3e); border-color: var(--error, #e53e3e); }
  .btn-delete:hover { background: var(--error, #e53e3e); color: white; }
  .job-schedule { font-size: 12px; font-family: var(--font-mono, monospace); color: var(--text-muted); margin-bottom: 6px; }
  .job-prompt { font-size: 13px; color: var(--text-secondary); margin-bottom: 6px; }
  .job-meta { font-size: 11px; color: var(--text-muted); }
</style>

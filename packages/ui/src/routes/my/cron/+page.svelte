<script lang="ts">
  import { onMount } from 'svelte';
  import { getMyCrons } from '$lib/api';
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
</script>

<svelte:head><title>My Cron Jobs - Kairo</title></svelte:head>

<h1 class="page-title">My Cron Jobs</h1>
<p class="subtitle">Jobs you created via the agent. Manage them by chatting with the agent using the manage_cron tool.</p>

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
  .job-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .job-name { font-size: 14px; font-weight: 600; }
  .job-schedule { font-size: 12px; font-family: var(--font-mono, monospace); color: var(--text-muted); margin-bottom: 6px; }
  .job-prompt { font-size: 13px; color: var(--text-secondary); margin-bottom: 6px; }
  .job-meta { font-size: 11px; color: var(--text-muted); }
</style>

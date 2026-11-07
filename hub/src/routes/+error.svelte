<script lang="ts">
	/**
	 * v0.83.1: every error is a visible page with a way out (before, SvelteKit's bare default
	 * rendered as an almost black screen in the installed PWA). The buttons use
	 * static/boot-guard.js (data-rotor-*), so they also work if the app's code is broken.
	 */
	import { page } from '$app/state';
</script>

<svelte:head><title>Rotor · {page.status === 404 ? 'Not found' : 'Something went wrong'}</title></svelte:head>

<main class="err">
	<h1>{page.status === 404 ? 'Page not found' : 'Something went wrong'}</h1>
	<p>{page.status === 404 ? 'This page doesn’t exist in Rotor.' : `Rotor hit an error (${page.status}). Reloading usually fixes it.`}</p>
	{#if page.error?.message && page.status !== 404}<p class="code">{page.error.message}</p>{/if}
	<div class="acts">
		<button type="button" class="btn pri" data-rotor-reload>Reload</button>
		<a class="btn" href="/home">Home</a>
		{#if page.status !== 404}<button type="button" class="btn" data-rotor-reset>Reset Rotor on this device</button>{/if}
	</div>
</main>

<style>
	.err {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding: 24px;
		text-align: center;
		background: var(--bg);
		color: var(--text-1);
	}
	h1 {
		font-size: 24px;
		margin: 0;
	}
	p {
		color: var(--text-2);
		margin: 0;
		max-width: 40ch;
	}
	.code {
		color: var(--text-3);
		font-size: 13px;
	}
	.acts {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		justify-content: center;
		margin-top: 8px;
	}
</style>

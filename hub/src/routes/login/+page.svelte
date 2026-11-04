<script lang="ts">
	import RotorMark from '$lib/components/RotorMark.svelte';
	let { data } = $props();
</script>

<svelte:head><title>Rotor · Sign in</title></svelte:head>

<main class="login">
	<div class="card">
		<div class="brand"><span style="color:var(--accent)"><RotorMark size={44} /></span>rotor</div>
		<p class="tag">Your library, back in rotation.</p>
		{#if data.message}<p class="msg" class:err={data.isError} role={data.isError ? 'alert' : 'status'}>{data.message}</p>{/if}
		<a class="btn pri big" href="/auth/login?client=hub&next={encodeURIComponent(data.next)}" data-sveltekit-reload>Sign in with Spotify</a>
		<p class="cap fine">Single-user app. Spotify sign-in, then Rotor checks it's you.</p>
	</div>
</main>

<style>
	.login {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		padding: calc(var(--safe-top) + 24px) 16px calc(var(--safe-bottom) + 24px);
		background: radial-gradient(circle at 50% 0%, rgba(157, 107, 255, 0.18), transparent 60%), var(--bg);
	}
	.card {
		width: 100%;
		max-width: 360px;
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 14px;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
		font-weight: 800;
		font-size: 36px;
		letter-spacing: -0.03em;
	}
	.tag {
		color: var(--text-2);
	}
	.msg {
		font-size: 13px;
		color: var(--text-2);
		background: var(--surface-2);
		padding: 10px 12px;
		border-radius: var(--r-card);
	}
	.msg.err {
		color: var(--danger);
		background: rgba(255, 92, 122, 0.1);
	}
	.big {
		height: 48px;
		padding: 0 28px;
		font-size: 15px;
		margin-top: 8px;
	}
	.fine {
		color: var(--text-3);
	}
</style>

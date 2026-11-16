<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { YT_STATE, createYouTubePlayer, type YtController } from '$lib/players/youtube';
	import { createSoundCloudWidget, widgetSrc, type ScController } from '$lib/players/soundcloud';
	import { player } from '$lib/stores/player.svelte';
	import { ownPlayer } from '$lib/stores/own-player.svelte';

	/**
	 * v0.94: the official YouTube / SoundCloud player for an own track or a set, always VISIBLE and
	 * unmodified (R4 rules: ≥ 480×270 on the laptop, full width on mobile, no hidden or audio-only
	 * player). Rotor only calls the official API: seek (tracklist taps), position, duration.
	 */
	let {
		youtubeId = null,
		soundcloudUrl = null,
		title,
		onposition,
		onduration,
		onplaying
	}: {
		youtubeId?: string | null;
		soundcloudUrl?: string | null;
		title: string;
		onposition?: (ms: number) => void;
		onduration?: (ms: number) => void;
		onplaying?: (p: boolean) => void;
	} = $props();

	let ytEl: HTMLDivElement | undefined = $state();
	let scEl: HTMLIFrameElement | undefined = $state();
	let yt: YtController | null = null;
	let sc: ScController | null = null;
	let ready: Promise<void> | null = null;
	let playing = false;
	let poll: ReturnType<typeof setInterval> | undefined;
	let failed = $state<string | null>(null);

	function started() {
		playing = true;
		onplaying?.(true);
		// One thing plays at a time: Spotify and Rotor's own player pause.
		if (player.view.isPlaying) void player.pause().catch(() => undefined);
		if (ownPlayer.playing) ownPlayer.pause();
	}
	function stopped() {
		playing = false;
		onplaying?.(false);
	}

	async function init(): Promise<void> {
		try {
			if (youtubeId && ytEl) {
				yt = await createYouTubePlayer(ytEl, {
					ready: () => undefined,
					state: (s) => (s === YT_STATE.PLAYING ? started() : s === YT_STATE.PAUSED || s === YT_STATE.ENDED ? stopped() : undefined),
					error: () => (failed = 'YouTube can’t play this video here.'),
					autoplayBlocked: () => undefined
				});
				yt.load(youtubeId, false);
				setTimeout(() => {
					const d = yt?.duration() ?? 0;
					if (d > 0) onduration?.(d);
				}, 800);
			} else if (soundcloudUrl && scEl) {
				sc = await createSoundCloudWidget(scEl, { ready: () => undefined, play: started, pause: stopped, finish: stopped, error: () => (failed = 'SoundCloud can’t play this here.') });
				const d = await sc.duration();
				if (d > 0) onduration?.(d);
			}
		} catch (e) {
			failed = e instanceof Error ? e.message : 'The player couldn’t load';
		}
	}

	onMount(() => {
		ready = init();
		poll = setInterval(async () => {
			if (!playing) return;
			const ms = yt ? yt.position() : sc ? await sc.position() : 0;
			onposition?.(ms);
		}, 1000);
	});
	onDestroy(() => {
		clearInterval(poll);
		try {
			yt?.destroy();
		} catch {
			/* already gone */
		}
	});

	/** Seek through the official API (tracklist taps) and play. */
	export async function seek(ms: number): Promise<void> {
		await ready;
		if (yt) {
			yt.seek(ms);
			yt.play();
		} else if (sc) {
			sc.seek(ms);
			sc.play();
		}
		onposition?.(ms);
	}
	export async function play(): Promise<void> {
		await ready;
		yt?.play();
		sc?.play();
	}
</script>

<div class="stage" data-testid="embed-player">
	{#if youtubeId}
		<div class="yt"><div bind:this={ytEl} title="YouTube player: {title}"></div></div>
	{:else if soundcloudUrl}
		<iframe bind:this={scEl} class="sc" title="SoundCloud player" src={widgetSrc(soundcloudUrl)} allow="autoplay" frameborder="0"></iframe>
	{/if}
	{#if failed}<p class="notice" role="alert">{failed}</p>{/if}
</div>

<style>
	.stage {
		width: 100%;
	}
	.yt {
		width: 100%;
		aspect-ratio: 16 / 9;
		min-height: 200px;
		background: #000;
		border-radius: 8px;
		overflow: hidden;
	}
	.yt :global(> *) {
		width: 100%;
		height: 100%;
	}
	.sc {
		width: 100%;
		height: 300px;
		min-height: 200px;
		border: 0;
		border-radius: 8px;
	}
	@media (min-width: 1024px) {
		.yt {
			min-width: 480px;
			min-height: 270px;
		}
	}
</style>
